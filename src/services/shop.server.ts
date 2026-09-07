import { prisma } from '../db.js';
import { PlanTier, PLAN_LIMITS } from '../types/index.js';

export async function installOrUpdateShop(data: {
  shopDomain: string;
  accessToken: string;
}) {
  const existingShop = await prisma.shop.findUnique({
    where: { shopDomain: data.shopDomain },
  });

  if (existingShop) {
    return prisma.shop.update({
      where: { shopDomain: data.shopDomain },
      data: {
        accessToken: data.accessToken,
        uninstalledAt: null, // Re-installation
        updatedAt: new Date(),
      },
    });
  }

  return prisma.shop.create({
    data: {
      shopDomain: data.shopDomain,
      accessToken: data.accessToken,
      plan: PlanTier.STARTER,
      billingCycleAnchor: new Date(),
      monthlySubmissionsCount: 0,
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
      accessToken: '', // Revoke active token
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
