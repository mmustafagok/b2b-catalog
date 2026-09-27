import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../src/db.js';
import { PlanTier } from '../src/types/index.js';
import {
  mapShopifyAppPricingHandleToPlan,
  defaultBillingProvider,
  changeShopPlan,
  BillingError,
  getShopifyAppHandle,
  getShopBillingInfo,
  shopGidCache,
} from '../src/services/billing.server.js';
import * as shopifyClientModule from '../src/services/shopify-client.server.js';

describe('Issue 1, 2, 3: Authoritative Shopify Partner API Billing & Security Test Suite', () => {
  let shop: any;
  const originalPartnerOrg = process.env.SHOPIFY_PARTNER_ORG_ID;
  const originalPartnerApp = process.env.SHOPIFY_PARTNER_APP_ID;
  const originalPartnerToken = process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN;
  const originalAppHandle = process.env.SHOPIFY_APP_HANDLE;

  beforeEach(async () => {
    process.env.SHOPIFY_PARTNER_ORG_ID = '123456';
    process.env.SHOPIFY_PARTNER_APP_ID = '987654';
    process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN = 'shppat_secret_token_12345';
    process.env.SHOPIFY_APP_HANDLE = 'catalogflow-b2b-order-catalog';

    shopGidCache.clear();

    await prisma.orderSubmission.deleteMany({});
    await prisma.orderLink.deleteMany({});
    await prisma.catalogVariantConfig.deleteMany({});
    await prisma.catalogSource.deleteMany({});
    await prisma.catalog.deleteMany({});
    await prisma.variantSnapshot.deleteMany({});
    await prisma.productSnapshot.deleteMany({});
    await prisma.shop.deleteMany({});

    shop = await prisma.shop.create({
      data: {
        shopDomain: `billing-auth-${Date.now()}-${Math.random().toString(36).substring(7)}.myshopify.com`,
        accessToken: 'enc:v1:testiv:testtag:testtoken',
        plan: 'FREE',
      },
    });

    // Mock admin client request to return shop-specific GID based on shop record
    vi.spyOn(shopifyClientModule, 'createShopifyClient').mockImplementation((record: any) => ({
      request: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes('GetShopId')) {
          const num = record?.shopDomain?.includes('isolated-b')
            ? '888888'
            : (record?.id?.replace(/[^0-9]/g, '') || '112233');
          return { shop: { id: `gid://shopify/Shop/${num}` } };
        }
        return {};
      }),
    } as any));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    defaultBillingProvider.setCustomFetch(undefined);

    if (originalPartnerOrg !== undefined) process.env.SHOPIFY_PARTNER_ORG_ID = originalPartnerOrg; else delete process.env.SHOPIFY_PARTNER_ORG_ID;
    if (originalPartnerApp !== undefined) process.env.SHOPIFY_PARTNER_APP_ID = originalPartnerApp; else delete process.env.SHOPIFY_PARTNER_APP_ID;
    if (originalPartnerToken !== undefined) process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN = originalPartnerToken; else delete process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN;
    if (originalAppHandle !== undefined) process.env.SHOPIFY_APP_HANDLE = originalAppHandle; else delete process.env.SHOPIFY_APP_HANDLE;

    await prisma.orderSubmission.deleteMany({});
    await prisma.orderLink.deleteMany({});
    await prisma.catalogVariantConfig.deleteMany({});
    await prisma.catalogSource.deleteMany({});
    await prisma.catalog.deleteMany({});
    await prisma.variantSnapshot.deleteMany({});
    await prisma.productSnapshot.deleteMany({});
    await prisma.shop.deleteMany({});
  });

  it('1. free handle → FREE', () => {
    expect(mapShopifyAppPricingHandleToPlan('free')).toBe(PlanTier.FREE);
    expect(mapShopifyAppPricingHandleToPlan('catalogflow_free')).toBe(PlanTier.FREE);
    expect(mapShopifyAppPricingHandleToPlan('free plan')).toBe(PlanTier.FREE);
  });

  it('2. starter → STARTER', () => {
    expect(mapShopifyAppPricingHandleToPlan('starter')).toBe(PlanTier.STARTER);
    expect(mapShopifyAppPricingHandleToPlan('catalogflow_starter')).toBe(PlanTier.STARTER);
    expect(mapShopifyAppPricingHandleToPlan('Starter Plan')).toBe(PlanTier.STARTER);
  });

  it('3. growth → GROWTH', () => {
    expect(mapShopifyAppPricingHandleToPlan('growth')).toBe(PlanTier.GROWTH);
    expect(mapShopifyAppPricingHandleToPlan('catalogflow_growth')).toBe(PlanTier.GROWTH);
    expect(mapShopifyAppPricingHandleToPlan('Growth Plan')).toBe(PlanTier.GROWTH);
  });

  it('4. Starter Shopify subscription activates Starter quotas', async () => {
    defaultBillingProvider.setCustomFetch(async () => {
      return new Response(
        JSON.stringify({
          data: {
            activeSubscription: {
              items: [{ handle: 'starter', description: 'Starter Plan' }],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const entitlement = await defaultBillingProvider.getEntitlement(shop.id);
    expect(entitlement.planTier).toBe(PlanTier.STARTER);
    expect(entitlement.status).toBe('VERIFIED');
    expect(entitlement.limits.maxLiveCatalogs).toBe(3);
    expect(entitlement.limits.maxVariants).toBe(500);
    expect(entitlement.limits.monthlySubmissionsLimit).toBe(50);
  });

  it('5. Growth subscription activates Growth quotas', async () => {
    defaultBillingProvider.setCustomFetch(async () => {
      return new Response(
        JSON.stringify({
          data: {
            activeSubscription: {
              items: [{ handle: 'growth', description: 'Growth Plan' }],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const entitlement = await defaultBillingProvider.getEntitlement(shop.id);
    expect(entitlement.planTier).toBe(PlanTier.GROWTH);
    expect(entitlement.status).toBe('VERIFIED');
    expect(entitlement.limits.maxLiveCatalogs).toBe(10);
    expect(entitlement.limits.maxVariants).toBe(5000);
    expect(entitlement.limits.monthlySubmissionsLimit).toBe(250);
  });

  it('6. cancelled/no active paid subscription resolves safely to FREE', async () => {
    defaultBillingProvider.setCustomFetch(async () => {
      return new Response(
        JSON.stringify({
          data: {
            activeSubscription: null,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const entitlement = await defaultBillingProvider.getEntitlement(shop.id);
    expect(entitlement.planTier).toBe(PlanTier.FREE);
    expect(entitlement.status).toBe('VERIFIED');
    expect(entitlement.limits.maxLiveCatalogs).toBe(1);
    expect(entitlement.limits.maxVariants).toBe(50);
  });

  it('7. unknown handle does not receive unlimited or paid entitlement', async () => {
    defaultBillingProvider.setCustomFetch(async () => {
      return new Response(
        JSON.stringify({
          data: {
            activeSubscription: {
              items: [{ handle: 'enterprise_unlimited_custom', description: 'Unknown Plan' }],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const entitlement = await defaultBillingProvider.getEntitlement(shop.id);
    expect(entitlement.planTier).toBe(PlanTier.FREE);
    expect(entitlement.status).toBe('VERIFIED');
  });

  it('8. local stale FREE does not override verified Shopify STARTER', async () => {
    await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'FREE' } });

    defaultBillingProvider.setCustomFetch(async () => {
      return new Response(
        JSON.stringify({
          data: {
            activeSubscription: {
              items: [{ handle: 'starter', description: 'Starter' }],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const entitlement = await defaultBillingProvider.getEntitlement(shop.id);
    expect(entitlement.planTier).toBe(PlanTier.STARTER);

    // Verify DB cache was mirrored
    const updatedShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(updatedShop?.plan).toBe('STARTER');
  });

  it('9. local stale STARTER does not override verified Shopify GROWTH', async () => {
    await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'STARTER' } });

    defaultBillingProvider.setCustomFetch(async () => {
      return new Response(
        JSON.stringify({
          data: {
            activeSubscription: {
              items: [{ handle: 'growth', description: 'Growth' }],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const entitlement = await defaultBillingProvider.getEntitlement(shop.id);
    expect(entitlement.planTier).toBe(PlanTier.GROWTH);

    // Verify DB cache was mirrored
    const updatedShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(updatedShop?.plan).toBe('GROWTH');
  });

  it('10. local stale GROWTH resolves to FREE when verified Shopify subscription is FREE', async () => {
    await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'GROWTH' } });

    defaultBillingProvider.setCustomFetch(async () => {
      return new Response(
        JSON.stringify({
          data: {
            activeSubscription: null,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const entitlement = await defaultBillingProvider.getEntitlement(shop.id);
    expect(entitlement.planTier).toBe(PlanTier.FREE);

    // Verify local DB was downgraded to verified status
    const updatedShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(updatedShop?.plan).toBe('FREE');
  });

  it('11. security: query parameter ?plan_handle=growth WITHOUT authoritative verification DOES NOT grant Growth', async () => {
    // Merchant attempts privilege escalation via ?plan_handle=growth
    // but Partner API returns no active subscription (free)
    defaultBillingProvider.setCustomFetch(async () => {
      return new Response(
        JSON.stringify({
          data: {
            activeSubscription: null,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const billingInfo = await getShopBillingInfo(shop.id, { planHandle: 'growth' });
    expect(billingInfo.currentPlan).toBe(PlanTier.FREE);
    expect(billingInfo.returnVerification?.verified).toBe(false);
    expect(billingInfo.returnVerification?.mismatch).toBe(true);

    const dbShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(dbShop?.plan).toBe('FREE');
  });

  it('12. plan change destination constructs official Shopify-hosted URL with configurable app handle', async () => {
    process.env.SHOPIFY_APP_HANDLE = 'custom-b2b-app-handle';
    expect(getShopifyAppHandle()).toBe('custom-b2b-app-handle');

    const dest = await defaultBillingProvider.getPlanSelectionDestination(
      PlanTier.GROWTH,
      'cool-store.myshopify.com'
    );
    expect(dest.action).toBe('REDIRECT_TO_SHOPIFY_APP_PRICING');
    expect(dest.destinationUrl).toBe(
      'https://admin.shopify.com/store/cool-store/charges/custom-b2b-app-handle/pricing_plans'
    );
  });

  it('13. security: Partner API auth credentials never appear in browser payload or logs', async () => {
    defaultBillingProvider.setCustomFetch(async () => {
      return new Response(
        JSON.stringify({
          data: {
            activeSubscription: { items: [{ handle: 'starter' }] },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const billingInfo = await getShopBillingInfo(shop.id);
    const serialized = JSON.stringify(billingInfo);

    expect(serialized).not.toContain(process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN);
    expect(serialized).not.toContain('shppat_');
  });

  it('14. security: one shop subscription cannot affect another shop (shop isolation)', async () => {
    const shopB = await prisma.shop.create({
      data: {
        shopDomain: `isolated-b-${Date.now()}.myshopify.com`,
        accessToken: 'enc:v1:testiv:testtag:testtokenB',
        plan: 'FREE',
      },
    });

    // Mock Partner API to respond differently per shopId variable
    defaultBillingProvider.setCustomFetch(async (url, init) => {
      const body = JSON.parse(init?.body as string);
      const requestedShopId = body.variables.shopId;
      if (requestedShopId.includes(shop.id.replace(/[^0-9]/g, '')) || requestedShopId.includes('112233')) {
        return new Response(
          JSON.stringify({
            data: { activeSubscription: { items: [{ handle: 'growth' }] } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          data: { activeSubscription: null },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const entitlementA = await defaultBillingProvider.getEntitlement(shop.id);
    expect(entitlementA.planTier).toBe(PlanTier.GROWTH);

    const entitlementB = await defaultBillingProvider.getEntitlement(shopB.id);
    expect(entitlementB.planTier).toBe(PlanTier.FREE);
  });

  it('15. temporary Partner API verification failure follows safe fallback behavior', async () => {
    // Local DB previously cached STARTER
    await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'STARTER' } });

    // Partner API returns 503 Service Unavailable
    defaultBillingProvider.setCustomFetch(async () => {
      return new Response('Shopify Partner API Down', { status: 503 });
    });

    const entitlement = await defaultBillingProvider.getEntitlement(shop.id);

    // Must NOT grant Growth
    expect(entitlement.planTier).not.toBe(PlanTier.GROWTH);
    // Must NOT wipe/downgrade to FREE permanently on transient failure
    expect(entitlement.planTier).toBe(PlanTier.STARTER);
    expect(entitlement.status).toBe('CACHED_FALLBACK');

    // DB plan must remain STARTER
    const dbShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(dbShop?.plan).toBe('STARTER');
  });
});
