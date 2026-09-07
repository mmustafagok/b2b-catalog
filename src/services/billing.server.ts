import { prisma } from '../db.js';
import { PlanTier, PLAN_LIMITS } from '../types/index.js';
import { getActiveShopById, BILLING_CYCLE_MS, reconcileBillingCycle } from './shop.server.js';
import { resolveCatalogAllowedProductGids } from './sync.server.js';

export interface PlanFeatureDetails {
  id: PlanTier;
  name: string;
  price: number;
  interval: string;
  maxLiveCatalogs: number;
  maxVariants: number;
  monthlySubmissionsLimit: number;
  features: string[];
}

/**
 * Commercial Pricing & Limits Specification:
 * - Starter: $14.99/mo (1 live catalog, 500 variants, 50 orders/mo)
 * - Growth: $29.99/mo (5 live catalogs, 5,000 variants, 250 orders/mo)
 * - Scale: $49.99/mo (20 live catalogs, 25,000 variants, 1,000 orders/mo)
 *
 * Commercial Terms:
 * - 7-day free trial is part of the pricing hypothesis and will be configured in
 *   Shopify App Pricing during final Partner Dashboard setup (M10).
 * - Hard caps only: zero usage-based surprise overage.
 * - No permanent free plan.
 */
export const PLAN_DETAILS: Record<PlanTier, PlanFeatureDetails> = {
  [PlanTier.STARTER]: {
    id: PlanTier.STARTER,
    name: 'Starter',
    price: 14.99,
    interval: 'month',
    maxLiveCatalogs: 1,
    maxVariants: 500,
    monthlySubmissionsLimit: 50,
    features: [
      '1 Live Wholesale Catalog',
      'Up to 500 Active Variants',
      '50 Buyer Submissions / Month',
      'Shopify Draft Order Creation',
      'Automated Inventory & Price Sync',
      'Wholesale % Discount Mode',
    ],
  },
  [PlanTier.GROWTH]: {
    id: PlanTier.GROWTH,
    name: 'Growth',
    price: 29.99,
    interval: 'month',
    maxLiveCatalogs: 5,
    maxVariants: 5000,
    monthlySubmissionsLimit: 250,
    features: [
      '5 Live Wholesale Catalogs',
      'Up to 5,000 Active Variants',
      '250 Buyer Submissions / Month',
      'Shopify Draft Order Creation',
      'Automated Inventory & Price Sync',
      'Wholesale % Discount Mode',
      'Buyer Order History Tracking',
    ],
  },
  [PlanTier.SCALE]: {
    id: PlanTier.SCALE,
    name: 'Scale',
    price: 49.99,
    interval: 'month',
    maxLiveCatalogs: 20,
    maxVariants: 25000,
    monthlySubmissionsLimit: 1000,
    features: [
      '20 Live Wholesale Catalogs',
      'Up to 25,000 Active Variants',
      '1,000 Buyer Submissions / Month',
      'Shopify Draft Order Creation',
      'Automated Inventory & Price Sync',
      'Wholesale % Discount Mode',
      'Buyer Order History Tracking',
      'Priority Support & SLAs',
    ],
  },
};

export class BillingError extends Error {
  constructor(message: string, public statusCode: number = 400, public code: string = 'BILLING_ERROR') {
    super(message);
    this.name = 'BillingError';
  }
}

export interface PlanEntitlement {
  planTier: PlanTier;
  limits: (typeof PLAN_LIMITS)[PlanTier];
  planDetails: PlanFeatureDetails;
  source: 'SHOPIFY_APP_PRICING' | 'DEV_OVERRIDE';
}

/**
 * Clean BillingProvider boundary for Shopify App Pricing integration.
 * In production, Shop.plan is an entitlement mirror/cache synchronized from
 * Shopify App Pricing active subscription status.
 */
export class BillingProvider {
  /**
   * Retrieves verified active entitlement for a shop.
   */
  async getEntitlement(shop: { id: string; plan: string }): Promise<PlanEntitlement> {
    const planTier = (shop.plan as PlanTier) || PlanTier.STARTER;
    const limits = PLAN_LIMITS[planTier] || PLAN_LIMITS[PlanTier.STARTER];
    const planDetails = PLAN_DETAILS[planTier] || PLAN_DETAILS[PlanTier.STARTER];

    return {
      planTier,
      limits,
      planDetails,
      source: process.env.NODE_ENV === 'test' ? 'DEV_OVERRIDE' : 'SHOPIFY_APP_PRICING',
    };
  }

  /**
   * Returns list of available commercial plan tiers.
   */
  getAvailablePlans(): PlanFeatureDetails[] {
    return Object.values(PLAN_DETAILS);
  }

  /**
   * Returns the selection destination URL or action for changing plans.
   * In production with Shopify App Pricing, this returns the Shopify-hosted confirmation URL.
   */
  async getPlanSelectionDestination(
    targetPlan: PlanTier,
    shopDomain: string
  ): Promise<{ destinationUrl: string | null; action: string }> {
    return {
      destinationUrl: null,
      action: 'SHOPIFY_MANAGED_PRICING_PENDING',
    };
  }
}

export const defaultBillingProvider = new BillingProvider();

/**
 * Checks whether local development plan override is permitted.
 * In production, direct self-service plan mutation is NEVER permitted.
 */
export function isDevPlanOverrideAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false; // Strict guarantee: never allowed in production
  }
  return process.env.NODE_ENV === 'test' || process.env.ALLOW_DEV_PLAN_OVERRIDE === 'true';
}

export async function getShopBillingInfo(shopId: string) {
  let shop = await getActiveShopById(shopId);
  if (!shop) {
    throw new BillingError('Shop not found or inactive', 404, 'SHOP_INACTIVE');
  }

  // Ensure billing cycle is up to date atomically
  shop = await reconcileBillingCycle(shop);
  if (!shop) {
    throw new BillingError('Shop not found or inactive', 404, 'SHOP_INACTIVE');
  }

  const entitlement = await defaultBillingProvider.getEntitlement(shop);
  const limits = entitlement.limits;

  // Count live published catalogs
  const liveCatalogs = await prisma.catalog.findMany({
    where: {
      shopId,
      status: 'PUBLISHED',
    },
    include: { sources: true },
  });

  const liveCatalogsCount = liveCatalogs.length;

  // Calculate maximum variants among active published catalogs
  let maxVariantsInPublishedCatalogs = 0;
  for (const cat of liveCatalogs) {
    const allowedGids = await resolveCatalogAllowedProductGids(shopId, cat.sources);
    if (allowedGids.size > 0) {
      const vCount = await prisma.variantSnapshot.count({
        where: {
          shopId,
          shopifyProductId: { in: Array.from(allowedGids) },
          product: { status: 'ACTIVE' },
        },
      });
      if (vCount > maxVariantsInPublishedCatalogs) {
        maxVariantsInPublishedCatalogs = vCount;
      }
    }
  }

  const cycleAnchor = shop.billingCycleAnchor;
  const nextBillingCycleAt = new Date(cycleAnchor.getTime() + BILLING_CYCLE_MS);

  return {
    currentPlan: entitlement.planTier,
    planDetails: entitlement.planDetails,
    limits,
    usage: {
      liveCatalogsCount,
      monthlySubmissionsCount: shop.monthlySubmissionsCount,
      maxVariantsInPublishedCatalogs,
      billingCycleAnchor: cycleAnchor,
      nextBillingCycleAt,
    },
    allowed: {
      canPublishCatalog: liveCatalogsCount < limits.maxLiveCatalogs,
      canAcceptSubmission: shop.monthlySubmissionsCount < limits.monthlySubmissionsLimit,
    },
    availablePlans: defaultBillingProvider.getAvailablePlans(),
    billingStatus: 'SHOPIFY_APP_PRICING_PENDING_M10',
  };
}

/**
 * Modifies shop plan.
 * In production: throws BILLING_NOT_CONFIGURED because self-service DB mutation is prohibited.
 * In test/dev: allows simulating plan changes while strictly validating downgrade quotas.
 */
export async function changeShopPlan(shopId: string, targetPlan: PlanTier) {
  if (!Object.values(PlanTier).includes(targetPlan)) {
    throw new BillingError(`Invalid plan tier: ${targetPlan}`, 400, 'INVALID_PLAN');
  }

  // Production safety check
  if (!isDevPlanOverrideAllowed()) {
    throw new BillingError(
      'Self-service plan changes are disabled. Subscriptions are managed through Shopify App Pricing in production.',
      403,
      'BILLING_NOT_CONFIGURED'
    );
  }

  const shop = await getActiveShopById(shopId);
  if (!shop) {
    throw new BillingError('Shop not found or inactive', 404, 'SHOP_INACTIVE');
  }

  const targetLimits = PLAN_LIMITS[targetPlan];

  // Downgrade quota validation: verify active catalogs do not exceed target limit
  const activePublishedCatalogs = await prisma.catalog.findMany({
    where: {
      shopId,
      status: 'PUBLISHED',
    },
    include: { sources: true },
  });

  if (activePublishedCatalogs.length > targetLimits.maxLiveCatalogs) {
    throw new BillingError(
      `Cannot switch to ${targetLimits.name}: You currently have ${activePublishedCatalogs.length} live catalogs, but the ${targetLimits.name} plan only allows ${targetLimits.maxLiveCatalogs}. Please unpublish excess catalogs before switching.`,
      400,
      'EXCESS_LIVE_CATALOGS'
    );
  }

  // Downgrade quota validation: verify no active catalog exceeds target variant limit
  for (const cat of activePublishedCatalogs) {
    const allowedGids = await resolveCatalogAllowedProductGids(shopId, cat.sources);
    if (allowedGids.size > 0) {
      const vCount = await prisma.variantSnapshot.count({
        where: {
          shopId,
          shopifyProductId: { in: Array.from(allowedGids) },
          product: { status: 'ACTIVE' },
        },
      });
      if (vCount > targetLimits.maxVariants) {
        throw new BillingError(
          `Cannot switch to ${targetLimits.name}: Catalog "${cat.name}" has ${vCount} variants, which exceeds the ${targetLimits.name} limit of ${targetLimits.maxVariants} variants.`,
          400,
          'EXCESS_VARIANTS'
        );
      }
    }
  }

  await prisma.shop.update({
    where: { id: shopId },
    data: {
      plan: targetPlan,
      updatedAt: new Date(),
    },
  });

  return getShopBillingInfo(shopId);
}
