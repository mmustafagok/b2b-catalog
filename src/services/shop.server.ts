import { prisma } from '../db.js';
import { PlanTier, PLAN_LIMITS } from '../types/index.js';
import { encryptToken, decryptToken } from './crypto.server.js';

export async function installOrUpdateShop(data: {
  shopDomain: string;
  accessToken: string;
  accessTokenExpiresAt?: Date | null;
  refreshToken?: string | null;
  refreshTokenExpiresAt?: Date | null;
  scopes?: string | null;
  currency?: string;
  initialSyncAt?: Date | null;
  plan?: PlanTier;
}) {
  const encryptedToken = encryptToken(data.accessToken);
  const encryptedRefreshToken = data.refreshToken ? encryptToken(data.refreshToken) : null;

  const existingShop = await prisma.shop.findUnique({
    where: { shopDomain: data.shopDomain },
  });

  if (existingShop) {
    const isReinstall = existingShop.uninstalledAt !== null;
    return prisma.shop.update({
      where: { shopDomain: data.shopDomain },
      data: {
        accessToken: encryptedToken,
        accessTokenExpiresAt: data.accessTokenExpiresAt !== undefined ? data.accessTokenExpiresAt : existingShop.accessTokenExpiresAt,
        refreshToken: encryptedRefreshToken !== null ? encryptedRefreshToken : existingShop.refreshToken,
        refreshTokenExpiresAt: data.refreshTokenExpiresAt !== undefined ? data.refreshTokenExpiresAt : existingShop.refreshTokenExpiresAt,
        scopes: data.scopes || existingShop.scopes,
        currency: data.currency || existingShop.currency,
        plan: data.plan || existingShop.plan,
        initialSyncAt: isReinstall ? null : (data.initialSyncAt !== undefined ? data.initialSyncAt : existingShop.initialSyncAt),
        uninstalledAt: null, // Reactivate if uninstalled
        updatedAt: new Date(),
      },
    });
  }

  return prisma.shop.create({
    data: {
      shopDomain: data.shopDomain,
      accessToken: encryptedToken,
      accessTokenExpiresAt: data.accessTokenExpiresAt || null,
      refreshToken: encryptedRefreshToken || null,
      refreshTokenExpiresAt: data.refreshTokenExpiresAt || null,
      scopes: data.scopes || null,
      currency: data.currency || 'USD',
      plan: data.plan || PlanTier.STARTER,
      billingCycleAnchor: new Date(),
      monthlySubmissionsCount: 0,
      initialSyncAt: data.initialSyncAt || null,
      installedAt: new Date(),
      uninstalledAt: null,
    },
  });
}

export async function uninstallShop(shopDomain: string) {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
  });

  if (!shop) {
    return null;
  }

  return prisma.shop.update({
    where: { shopDomain },
    data: {
      uninstalledAt: new Date(),
      accessToken: '', // Clear token at rest
      accessTokenExpiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
      initialSyncAt: null,
      updatedAt: new Date(),
    },
  });
}

export async function getActiveShopByDomain(shopDomain: string) {
  return prisma.shop.findFirst({
    where: {
      shopDomain,
      uninstalledAt: null,
    },
  });
}

export async function getActiveShopById(id: string) {
  return prisma.shop.findFirst({
    where: {
      id,
      uninstalledAt: null,
    },
  });
}

export async function getDecryptedAccessToken(shopId: string): Promise<string | null> {
  const shop = await getActiveShopById(shopId);
  if (!shop || !shop.accessToken) {
    return null;
  }
  return decryptToken(shop.accessToken);
}

export const BILLING_CYCLE_MS = 30 * 24 * 60 * 60 * 1000; // 30-day standard billing period

/**
 * Concurrency-safe atomic billing cycle rollover using Compare-And-Set (CAS).
 * Only ONE caller may perform the rollover for a given expired anchor.
 * Concurrent callers will see 0 rows updated by CAS and re-read the fresh state.
 */
export async function reconcileBillingCycle<T extends {
  id: string;
  billingCycleAnchor: Date;
  monthlySubmissionsCount: number;
}>(shopOrId: T | string): Promise<any> {
  const shopId = typeof shopOrId === 'string' ? shopOrId : shopOrId.id;
  const initialShop = typeof shopOrId === 'string' ? await getActiveShopById(shopId) : shopOrId;
  if (!initialShop) return null;

  const now = Date.now();
  const anchorTime = initialShop.billingCycleAnchor.getTime();

  if (now - anchorTime >= BILLING_CYCLE_MS) {
    const elapsedCycles = Math.floor((now - anchorTime) / BILLING_CYCLE_MS);
    const newAnchor = new Date(anchorTime + elapsedCycles * BILLING_CYCLE_MS);
    const cutoff = new Date(now - BILLING_CYCLE_MS);

    // Atomic CAS: Only update if the billingCycleAnchor is still expired (<= cutoff)
    await prisma.$executeRaw`
      UPDATE "Shop"
      SET "billingCycleAnchor" = ${newAnchor},
          "monthlySubmissionsCount" = 0,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${shopId} AND "billingCycleAnchor" <= ${cutoff}
    `;

    // Re-fetch the fresh shop record from PostgreSQL
    return getActiveShopById(shopId);
  }

  return initialShop;
}

export async function checkShopQuota(shopId: string) {
  let shop = await getActiveShopById(shopId);
  if (!shop) {
    throw new Error('Shop not found or inactive');
  }

  // Reconcile billing cycle rollover with CAS before evaluating usage
  shop = await reconcileBillingCycle(shop);
  if (!shop) {
    throw new Error('Shop not found or inactive');
  }

  const planTier = (shop.plan as PlanTier) || PlanTier.STARTER;
  const limits = PLAN_LIMITS[planTier] || PLAN_LIMITS[PlanTier.STARTER];

  const liveCatalogsCount = await prisma.catalog.count({
    where: {
      shopId,
      status: 'PUBLISHED',
    },
  });

  const canPublishCatalog = liveCatalogsCount < limits.maxLiveCatalogs;
  const canAcceptSubmission = shop.monthlySubmissionsCount < limits.monthlySubmissionsLimit;

  return {
    planTier,
    limits,
    usage: {
      liveCatalogsCount,
      monthlySubmissionsCount: shop.monthlySubmissionsCount,
      billingCycleAnchor: shop.billingCycleAnchor,
    },
    allowed: {
      canPublishCatalog,
      canAcceptSubmission,
    },
  };
}

/**
 * Concurrency-safe atomic quota slot reservation before external Shopify mutation.
 * Uses atomic CAS rollover first, then conditional reservation against active period.
 * Returns true if a slot was reserved, false if hard cap has been reached.
 */
export async function reserveSubmissionQuotaSlot(shopId: string, limit: number): Promise<boolean> {
  // Reconcile billing cycle atomically with CAS
  await reconcileBillingCycle(shopId);

  const rowsUpdated = await prisma.$executeRaw`
    UPDATE "Shop"
    SET "monthlySubmissionsCount" = "monthlySubmissionsCount" + 1
    WHERE "id" = ${shopId} AND "monthlySubmissionsCount" < ${limit}
  `;

  return rowsUpdated > 0;
}

/**
 * Period-aware quota reservation release.
 * Atomically clears quotaReserved on the submission, and ONLY decrements
 * Shop.monthlySubmissionsCount if the active billing cycle still matches
 * the cycle for which the slot was reserved.
 * Returns true if usage was decremented, false if billing period already moved
 * or if slot was not reserved / already released.
 */
export async function releaseSubmissionQuotaReservation(submissionId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const submission = await tx.orderSubmission.findUnique({
      where: { id: submissionId },
      include: { shop: true },
    });

    if (!submission || !submission.quotaReserved || !submission.quotaCycleAnchor) {
      return false; // Nothing to release or already released
    }

    // Atomically clear quotaReserved on the submission
    await tx.orderSubmission.update({
      where: { id: submissionId },
      data: { quotaReserved: false },
    });

    const shopAnchor = submission.shop.billingCycleAnchor.getTime();
    const reservedAnchor = submission.quotaCycleAnchor.getTime();

    // Only decrement if active billing period matches the reserved period
    if (shopAnchor === reservedAnchor) {
      const updateRes = await tx.shop.updateMany({
        where: {
          id: submission.shopId,
          billingCycleAnchor: submission.shop.billingCycleAnchor,
          monthlySubmissionsCount: { gt: 0 },
        },
        data: {
          monthlySubmissionsCount: { decrement: 1 },
        },
      });
      return updateRes.count > 0;
    }

    return false;
  });
}

/**
 * Direct period-aware release when an initial pre-reservation database insert fails.
 */
export async function releaseSubmissionQuotaSlotDirect(shopId: string, anchor: Date): Promise<void> {
  await prisma.shop.updateMany({
    where: {
      id: shopId,
      billingCycleAnchor: anchor,
      monthlySubmissionsCount: { gt: 0 },
    },
    data: {
      monthlySubmissionsCount: { decrement: 1 },
    },
  });
}

/**
 * Releases a reserved quota slot if order creation fails before external Shopify side effects.
 */
export async function releaseSubmissionQuotaSlot(shopId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Shop"
    SET "monthlySubmissionsCount" = GREATEST(0, "monthlySubmissionsCount" - 1)
    WHERE "id" = ${shopId}
  `;
}

export async function incrementSubmissionCount(shopId: string) {
  return prisma.shop.update({
    where: { id: shopId },
    data: {
      monthlySubmissionsCount: {
        increment: 1,
      },
    },
  });
}

/**
 * Compliance redaction: completely erases a shop and all associated data.
 */
export async function redactShopData(shopDomain: string) {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
  });

  if (!shop) {
    return false;
  }

  // Cascade delete handles catalogs, products, snapshots, submissions
  await prisma.shop.delete({
    where: { id: shop.id },
  });

  return true;
}
