import { prisma } from '../db.js';
import { PlanTier, PLAN_LIMITS } from '../types/index.js';

export { PlanTier };
import { getActiveShopById, BILLING_CYCLE_MS, reconcileBillingCycle } from './shop.server.js';
import { countActiveVariantsForCatalog } from './catalog.server.js';
import { createShopifyClient } from './shopify-client.server.js';
import { sanitizeErrorMessage } from './security.server.js';

export interface PlanFeatureDetails {
  id: PlanTier;
  name: string;
  price: number;
  annualPrice?: number;
  interval: string;
  maxLiveCatalogs: number;
  maxVariants: number;
  monthlySubmissionsLimit: number;
  features: string[];
}

/**
 * Commercial Pricing & Limits Specification:
 * - Free: $0/mo (1 live catalog, 50 variants/catalog, 5 orders/mo)
 * - Starter: $14.99/mo or $119.99/yr (3 live catalogs, 500 variants/catalog, 50 orders/mo)
 * - Growth: $29.99/mo or $239.99/yr (10 live catalogs, 5,000 variants/catalog, 250 orders/mo)
 *
 * Commercial Terms:
 * - Hard caps only: zero usage-based surprise overage.
 * - All core features available on ALL plans (zero feature-gating). Upgrades are capacity/usage based.
 */
export const PLAN_DETAILS: Record<PlanTier, PlanFeatureDetails> = {
  [PlanTier.FREE]: {
    id: PlanTier.FREE,
    name: 'Free',
    price: 0,
    annualPrice: 0,
    interval: 'month',
    maxLiveCatalogs: 1,
    maxVariants: 50,
    monthlySubmissionsLimit: 5,
    features: [
      '1 Live Wholesale Catalog',
      'Up to 50 Active Variants / Catalog',
      '5 Buyer Submissions / Month',
      'All Core B2B Features Included',
      'Shopify Draft Order Creation',
      'Automated Inventory & Price Sync',
    ],
  },
  [PlanTier.STARTER]: {
    id: PlanTier.STARTER,
    name: 'Starter',
    price: 14.99,
    annualPrice: 119.99,
    interval: 'month',
    maxLiveCatalogs: 3,
    maxVariants: 500,
    monthlySubmissionsLimit: 50,
    features: [
      '3 Live Wholesale Catalogs',
      'Up to 500 Active Variants / Catalog',
      '50 Buyer Submissions / Month',
      '$14.99/month or $119.99/year',
      'All Core B2B Features Included',
      'Shopify Draft Order Creation',
      'Automated Inventory & Price Sync',
    ],
  },
  [PlanTier.GROWTH]: {
    id: PlanTier.GROWTH,
    name: 'Growth',
    price: 29.99,
    annualPrice: 239.99,
    interval: 'month',
    maxLiveCatalogs: 10,
    maxVariants: 5000,
    monthlySubmissionsLimit: 250,
    features: [
      '10 Live Wholesale Catalogs',
      'Up to 5,000 Active Variants / Catalog',
      '250 Buyer Submissions / Month',
      '$29.99/month or $239.99/year',
      'All Core B2B Features Included',
      'Shopify Draft Order Creation',
      'Automated Inventory & Price Sync',
    ],
  },
};

export class BillingError extends Error {
  constructor(message: string, public statusCode: number = 400, public code: string = 'BILLING_ERROR') {
    super(message);
    this.name = 'BillingError';
  }
}

export type EntitlementStatus = 'VERIFIED' | 'CACHED_FALLBACK' | 'UNVERIFIED' | 'DEV_OVERRIDE';
export type EntitlementSource = 'SHOPIFY_APP_PRICING' | 'DEV_OVERRIDE' | 'CACHED_FALLBACK' | 'ACTIVE_SUBSCRIPTION_MIRROR' | 'LOCAL_MIRROR_PENDING_SHOPIFY';

export interface PlanEntitlement {
  planTier: PlanTier;
  limits: (typeof PLAN_LIMITS)[PlanTier];
  planDetails: PlanFeatureDetails;
  source: EntitlementSource;
  status: EntitlementStatus;
}

/**
 * Strict whitelist mapping for Shopify App Pricing subscription plan handles.
 * Canonical handles:
 * - "free" -> FREE
 * - "starter" -> STARTER
 * - "growth" -> GROWTH
 * Explicit legacy aliases are strictly whitelisted without arbitrary substring matching.
 * Any unknown handle receives FREE (never grant paid or unlimited entitlement).
 */
const STRICT_PLAN_HANDLE_MAP: Record<string, PlanTier> = {
  free: PlanTier.FREE,
  catalogflow_free: PlanTier.FREE,
  'free plan': PlanTier.FREE,
  starter: PlanTier.STARTER,
  catalogflow_starter: PlanTier.STARTER,
  'starter plan': PlanTier.STARTER,
  growth: PlanTier.GROWTH,
  catalogflow_growth: PlanTier.GROWTH,
  'growth plan': PlanTier.GROWTH,
};

export function mapShopifyAppPricingHandleToPlan(handle: string): PlanTier {
  if (!handle || typeof handle !== 'string') return PlanTier.FREE;
  const normalized = handle.trim().toLowerCase();
  return STRICT_PLAN_HANDLE_MAP[normalized] ?? PlanTier.FREE;
}

/**
 * Returns canonical Shopify App Handle for URL generation.
 */
export function getShopifyAppHandle(): string {
  return process.env.SHOPIFY_APP_HANDLE || 'catalogflow-b2b-order-catalog';
}

export interface PartnerActiveSubscriptionData {
  shop?: { id: string; myshopifyDomain: string };
  billingPeriod?: string;
  cancelAtEndOfCycle?: boolean;
  trialEndsAt?: string | null;
  items?: Array<{
    handle?: string;
    description?: string;
    price?: any;
  }>;
}

export const PARTNER_ACTIVE_SUBSCRIPTION_QUERY = `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      shop {
        id
        myshopifyDomain
      }
      billingPeriod
      cancelAtEndOfCycle
      trialEndsAt
      currentBillingCycle {
        startTime
        endTime
      }
      items {
        handle
        description
        price {
          __typename
          active
          currency
          ... on FlatRatePrice {
            amount
          }
          ... on TieredPrice {
            tiersMode
            tiers {
              upTo
              amountPerUnit
              amount
            }
          }
        }
      }
    }
  }
`;

export const shopGidCache = new Map<string, string>();

/**
 * Resolves the genuine Shopify Shop GID (e.g. gid://shopify/Shop/12345678)
 * using the authenticated shop client and caches it in memory.
 */
export async function resolveShopGid(shopRecord: { id?: string; shopDomain: string; accessToken: string }): Promise<string | null> {
  if (shopRecord.id && shopGidCache.has(shopRecord.id)) {
    return shopGidCache.get(shopRecord.id)!;
  }
  if (shopRecord.shopDomain && shopGidCache.has(shopRecord.shopDomain)) {
    return shopGidCache.get(shopRecord.shopDomain)!;
  }

  try {
    const client = createShopifyClient(shopRecord as any);
    const query = `
      query GetShopId {
        shop {
          id
          myshopifyDomain
        }
      }
    `;
    const res = await client.request<{ shop?: { id: string } }>(query, undefined, 2, 5000);
    const gid = res?.shop?.id;
    if (gid) {
      if (shopRecord.id) shopGidCache.set(shopRecord.id, gid);
      if (shopRecord.shopDomain) shopGidCache.set(shopRecord.shopDomain, gid);
      return gid;
    }
  } catch (err: any) {
    console.warn(`[BillingProvider] Failed to resolve shop GID for ${shopRecord.shopDomain}: ${sanitizeErrorMessage(err)}`);
  }
  return null;
}

/**
 * Queries Shopify Partner API activeSubscription query.
 * Endpoint: https://partners.shopify.com/{orgId}/api/2026-07/graphql.json
 * Auth: X-Shopify-Access-Token (Partner API token)
 */
export async function queryPartnerActiveSubscription(params: {
  appId: string;
  shopId: string;
  customFetch?: typeof fetch;
}): Promise<{ activeSubscription: PartnerActiveSubscriptionData | null }> {
  const partnerOrgId = process.env.SHOPIFY_PARTNER_ORG_ID;
  const partnerToken = process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN;

  if (!partnerOrgId || !partnerToken) {
    throw new Error('SHOPIFY_PARTNER_ORG_ID or SHOPIFY_PARTNER_API_ACCESS_TOKEN not configured');
  }

  const endpoint = `https://partners.shopify.com/${partnerOrgId}/api/2026-07/graphql.json`;
  const fetcher = params.customFetch || fetch;

  const res = await fetcher(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': partnerToken,
    },
    body: JSON.stringify({
      query: PARTNER_ACTIVE_SUBSCRIPTION_QUERY,
      variables: {
        appId: params.appId,
        shopId: params.shopId,
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Partner API HTTP error ${res.status}: ${errorText.slice(0, 100)}`);
  }

  const json = (await res.json()) as { data?: { activeSubscription: PartnerActiveSubscriptionData | null }; errors?: any[] };
  if (json.errors && json.errors.length > 0) {
    const firstMsg = json.errors[0]?.message || 'GraphQL error';
    throw new Error(`Partner API GraphQL error: ${firstMsg}`);
  }

  return json.data || { activeSubscription: null };
}

/**
 * Clean BillingProvider boundary for Shopify App Pricing integration.
 * In production, Shopify Partner API activeSubscription is the authoritative source of truth.
 * Shop.plan serves strictly as local cache / mirror.
 */
export class BillingProvider {
  private customFetch?: typeof fetch;

  setCustomFetch(fn?: typeof fetch) {
    this.customFetch = fn;
  }

  /**
   * Retrieves verified active entitlement for a shop.
   * Authoritatively queries Shopify Partner API when credentials exist.
   * Safely updates local Shop.plan mirror on verified responses.
   * Deterministically falls back to cached plan on transient API failure.
   */
  async getEntitlement(
    shopOrShopId: { id?: string; shopDomain?: string; accessToken?: string; plan?: string } | string,
    options?: { customFetch?: typeof fetch }
  ): Promise<PlanEntitlement> {
    let shopRecord: { id?: string; shopDomain?: string; accessToken?: string; plan?: string } | null = null;

    if (typeof shopOrShopId === 'string') {
      shopRecord = await prisma.shop.findUnique({
        where: { id: shopOrShopId },
        select: { id: true, shopDomain: true, accessToken: true, plan: true },
      });
    } else if (shopOrShopId) {
      if (shopOrShopId.shopDomain && shopOrShopId.accessToken) {
        shopRecord = shopOrShopId;
      } else if (shopOrShopId.id) {
        shopRecord = await prisma.shop.findUnique({
          where: { id: shopOrShopId.id },
          select: { id: true, shopDomain: true, accessToken: true, plan: true },
        });
      }
    }

    const cachedPlanStr = shopRecord?.plan || (typeof shopOrShopId === 'object' ? shopOrShopId?.plan : null) || 'FREE';
    let verifiedPlanTier: PlanTier = mapShopifyAppPricingHandleToPlan(cachedPlanStr);
    let entitlementStatus: EntitlementStatus = isDevPlanOverrideAllowed() ? 'DEV_OVERRIDE' : 'UNVERIFIED';
    let entitlementSource: EntitlementSource = isDevPlanOverrideAllowed() ? 'DEV_OVERRIDE' : 'LOCAL_MIRROR_PENDING_SHOPIFY';

    const partnerOrgId = process.env.SHOPIFY_PARTNER_ORG_ID;
    const partnerAppId = process.env.SHOPIFY_PARTNER_APP_ID || process.env.SHOPIFY_APP_ID;
    const partnerToken = process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN;

    const hasPartnerConfig = Boolean(partnerOrgId && partnerAppId && partnerToken);

    // If shop domain, access token, and Partner API config are present, query Partner API authoritatively
    if (shopRecord && shopRecord.shopDomain && shopRecord.accessToken && hasPartnerConfig) {
      try {
        const rawShopGid = await resolveShopGid(shopRecord as any);
        if (!rawShopGid) {
          throw new Error('Could not resolve Shopify Shop GID');
        }

        const formattedShopId = rawShopGid.startsWith('gid://shopify/Shop/')
          ? rawShopGid
          : `gid://shopify/Shop/${rawShopGid}`;
        const formattedAppId = partnerAppId!.startsWith('gid://shopify/App/')
          ? partnerAppId!
          : `gid://shopify/App/${partnerAppId}`;

        const fetcher = options?.customFetch || this.customFetch;
        const partnerData = await queryPartnerActiveSubscription({
          appId: formattedAppId,
          shopId: formattedShopId,
          customFetch: fetcher,
        });

        const activeSub = partnerData.activeSubscription;

        if (activeSub && Array.isArray(activeSub.items) && activeSub.items.length > 0) {
          const firstHandle = activeSub.items[0]?.handle || '';
          verifiedPlanTier = mapShopifyAppPricingHandleToPlan(firstHandle);
        } else {
          // No active subscription contract in Shopify App Pricing -> authoritative FREE
          verifiedPlanTier = PlanTier.FREE;
        }

        entitlementStatus = 'VERIFIED';
        entitlementSource = 'SHOPIFY_APP_PRICING';

        // Update local Shop.plan as cache/mirror if changed
        if (shopRecord.id && shopRecord.plan !== verifiedPlanTier) {
          await prisma.shop.update({
            where: { id: shopRecord.id },
            data: { plan: verifiedPlanTier, updatedAt: new Date() },
          }).catch((err) => {
            console.warn('[BillingProvider] Failed to mirror verified plan to DB:', sanitizeErrorMessage(err));
          });
        }
      } catch (err: any) {
        // Safe diagnostic logging without secrets
        console.warn(`[BillingProvider] Partner API subscription verification temporary failure for shop ${shopRecord.shopDomain}: ${sanitizeErrorMessage(err)}`);
        // Conservative deterministic fallback: retain safely cached plan
        verifiedPlanTier = mapShopifyAppPricingHandleToPlan(cachedPlanStr);
        entitlementStatus = 'CACHED_FALLBACK';
        entitlementSource = 'CACHED_FALLBACK';
      }
    } else if (isDevPlanOverrideAllowed()) {
      verifiedPlanTier = mapShopifyAppPricingHandleToPlan(cachedPlanStr);
      entitlementStatus = 'DEV_OVERRIDE';
      entitlementSource = 'DEV_OVERRIDE';
    } else {
      verifiedPlanTier = mapShopifyAppPricingHandleToPlan(cachedPlanStr);
      entitlementStatus = 'UNVERIFIED';
    }

    const limits = PLAN_LIMITS[verifiedPlanTier];
    const planDetails = PLAN_DETAILS[verifiedPlanTier];

    return {
      planTier: verifiedPlanTier,
      limits,
      planDetails,
      source: entitlementSource,
      status: entitlementStatus,
    };
  }

  /**
   * Authoritatively verifies an incoming plan_handle return/redirect.
   * SECURITY RULE: plan_handle from URL/query is NEVER accepted as proof of purchase.
   * It only indicates the intended plan. We perform authoritative Partner API verification,
   * and only if the verified active subscription matches, do we confirm.
   */
  async verifyPlanReturn(
    shopOrShopId: { id?: string; shopDomain?: string; accessToken?: string; plan?: string } | string,
    intendedPlanHandle?: string,
    options?: { customFetch?: typeof fetch }
  ): Promise<{
    verified: boolean;
    verifiedPlan: PlanTier;
    status: EntitlementStatus;
    mismatch: boolean;
  }> {
    const entitlement = await this.getEntitlement(shopOrShopId, options);
    if (!intendedPlanHandle) {
      return {
        verified: entitlement.status === 'VERIFIED',
        verifiedPlan: entitlement.planTier,
        status: entitlement.status,
        mismatch: false,
      };
    }

    const intendedPlan = mapShopifyAppPricingHandleToPlan(intendedPlanHandle);
    const matches = entitlement.planTier === intendedPlan;
    return {
      verified: entitlement.status === 'VERIFIED' && matches,
      verifiedPlan: entitlement.planTier,
      status: entitlement.status,
      mismatch: !matches,
    };
  }

  /**
   * Returns list of available commercial plan tiers.
   */
  getAvailablePlans(): PlanFeatureDetails[] {
    return Object.values(PLAN_DETAILS);
  }

  /**
   * Returns the selection destination URL for changing plans via official Shopify-hosted App Pricing.
   * Format: https://admin.shopify.com/store/{store_handle}/charges/{app_handle}/pricing_plans
   */
  async getPlanSelectionDestination(
    targetPlan: PlanTier,
    shopDomain: string
  ): Promise<{ destinationUrl: string | null; action: string }> {
    const storeHandle = (shopDomain || '').replace(/^https?:\/\//, '').replace(/\.myshopify\.com$/, '').replace(/\/$/, '');
    const appHandle = getShopifyAppHandle();
    return {
      destinationUrl: storeHandle ? `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans` : null,
      action: 'REDIRECT_TO_SHOPIFY_APP_PRICING',
    };
  }
}

export const defaultBillingProvider = new BillingProvider();

/**
 * Helper to resolve entitlement for a shop or shopId.
 */
export async function getShopEntitlement(
  shopOrShopId: { id?: string; plan?: string } | string,
  options?: { customFetch?: typeof fetch }
): Promise<PlanEntitlement> {
  return defaultBillingProvider.getEntitlement(shopOrShopId, options);
}

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

export async function getShopBillingInfo(
  shopId: string,
  options?: { planHandle?: string; customFetch?: typeof fetch }
) {
  let shop = await getActiveShopById(shopId);
  if (!shop) {
    throw new BillingError('Shop not found or inactive', 404, 'SHOP_INACTIVE');
  }

  // Ensure billing cycle is up to date atomically
  shop = await reconcileBillingCycle(shop);
  if (!shop) {
    throw new BillingError('Shop not found or inactive', 404, 'SHOP_INACTIVE');
  }

  let returnVerification:
    | { verified: boolean; verifiedPlan: PlanTier; status: EntitlementStatus; mismatch: boolean }
    | undefined;
  if (options?.planHandle) {
    returnVerification = await defaultBillingProvider.verifyPlanReturn(shop, options.planHandle, {
      customFetch: options.customFetch,
    });
  }

  const entitlement = await defaultBillingProvider.getEntitlement(shop, { customFetch: options?.customFetch });
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

  // Calculate maximum variants among active published catalogs using canonical countActiveVariantsForCatalog
  let maxVariantsInPublishedCatalogs = 0;
  for (const cat of liveCatalogs) {
    const vCount = await countActiveVariantsForCatalog(shopId, cat.id, cat.sources);
    if (vCount > maxVariantsInPublishedCatalogs) {
      maxVariantsInPublishedCatalogs = vCount;
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
    entitlementSource: entitlement.source,
    entitlementStatus: entitlement.status,
    billingStatus:
      entitlement.status === 'DEV_OVERRIDE'
        ? 'DEV_OVERRIDE'
        : entitlement.status === 'VERIFIED'
        ? 'ACTIVE'
        : 'FALLBACK',
    returnVerification,
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
    const shop = await getActiveShopById(shopId);
    const destination = await defaultBillingProvider.getPlanSelectionDestination(targetPlan, shop?.shopDomain || '');
    const err = new BillingError(
      'Self-service plan changes are disabled. Subscriptions are managed through Shopify App Pricing in production.',
      403,
      'BILLING_NOT_CONFIGURED'
    );
    (err as any).destinationUrl = destination.destinationUrl;
    throw err;
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

  // Downgrade quota validation: verify no active catalog exceeds target variant limit using canonical active variant count
  for (const cat of activePublishedCatalogs) {
    const vCount = await countActiveVariantsForCatalog(shopId, cat.id, cat.sources);
    if (vCount > targetLimits.maxVariants) {
      throw new BillingError(
        `Cannot switch to ${targetLimits.name}: Catalog "${cat.name}" has ${vCount} active variants, which exceeds the ${targetLimits.name} limit of ${targetLimits.maxVariants} variants.`,
        400,
        'EXCESS_VARIANTS'
      );
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
