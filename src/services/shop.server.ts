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
      plan: PlanTier.STARTER,
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

export async function checkShopQuota(shopId: string) {
  const shop = await getActiveShopById(shopId);
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
    },
    allowed: {
      canPublishCatalog,
      canAcceptSubmission,
    },
  };
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
