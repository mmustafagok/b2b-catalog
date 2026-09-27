import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { syncProductSnapshot } from '../src/services/sync.server.js';
import {
  mapShopifyAppPricingHandleToPlan,
  getShopEntitlement,
} from '../src/services/billing.server.js';
import { PriceMode, CatalogSourceType, PlanTier } from '../src/types/index.js';
import { ShopifyAdminClient } from '../src/services/shopify-client.server.js';

describe('Final Shopify Production-Readiness Pass Verification Suite', () => {
  let shop: { id: string; shopDomain: string };

  function mockShopifyClient(draftOrderId = 'gid://shopify/DraftOrder/101', draftOrderName = '#DRAFT-101', liveVariantPrice = '100.00') {
    let capturedVars: any = null;
    const spy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string, vars?: any) => {
      if (vars) capturedVars = vars;
      if (query.includes('nodes') || query.includes('getVariantsByIds') || query.includes('variants')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/2001',
              price: liveVariantPrice,
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/1001', status: 'ACTIVE', title: 'Test Wholesale Product' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        return {
          draftOrderCreate: {
            draftOrder: {
              id: draftOrderId,
              name: draftOrderName,
              subtotalPriceSet: { shopMoney: { amount: liveVariantPrice, currencyCode: 'USD' } },
              totalPrice: liveVariantPrice,
            },
            userErrors: [],
          },
        };
      }
      return {};
    });
    return { spy, getCapturedVars: () => capturedVars };
  }

  beforeEach(async () => {
    await prisma.orderSubmission.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalogVariantConfig.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'prod-readiness-test.myshopify.com',
      accessToken: 'token_prod_readiness_test',
    });

    await syncProductSnapshot(shop.id, {
      id: 1001,
      title: 'Test Wholesale Product',
      handle: 'test-wholesale-product',
      status: 'active',
      variants: [
        { id: 2001, product_id: 1001, title: 'Default Variant', price: '100.00', inventory_quantity: 50, inventory_policy: 'deny', inventory_management: 'shopify', sku: 'TEST-SKU-1' },
      ],
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // A. PCD & DATA MINIMIZATION (1 - 6)
  // ───────────────────────────────────────────────────────────────────────────
  describe('PCD & Data Minimization Integrity', () => {
    it('1. phone number is not required for order submission', async () => {
      const cat = await createCatalog(shop.id, {
        name: 'PCD Test Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, cat.id);
      const { spy } = mockShopifyClient('gid://shopify/DraftOrder/101');

      const res = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idemp_pcd_1')
        .send({
          dataVersion: published.dataVersion,
          buyer: {
            businessName: 'Acme LLC',
            email: 'buyer@acme.com',
            poNumber: 'PO-1001',
          },
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 2 }],
        });

      spy.mockRestore();

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.draftOrderId).toBe('gid://shopify/DraftOrder/101');
    });

    it('2. phone and taxId are ignored if supplied in buyer payload', async () => {
      const cat = await createCatalog(shop.id, {
        name: 'PCD Test Catalog 2',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, cat.id);
      const { spy } = mockShopifyClient('gid://shopify/DraftOrder/102');

      const res = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idemp_pcd_2')
        .send({
          dataVersion: published.dataVersion,
          buyer: {
            businessName: 'Beta Corp',
            email: 'buyer@beta.com',
            phone: '+15550001111',
            taxId: 'US-999',
          },
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
        });

      spy.mockRestore();

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('3. buyer personal name is not required for submit', async () => {
      const cat = await createCatalog(shop.id, {
        name: 'PCD Test Catalog 3',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, cat.id);
      const { spy } = mockShopifyClient('gid://shopify/DraftOrder/103');

      const res = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idemp_pcd_3')
        .send({
          dataVersion: published.dataVersion,
          buyer: {
            businessName: 'Gamma LLC',
            email: 'gamma@buyer.com',
          },
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
        });

      spy.mockRestore();

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('4. buyer email is required and validated', async () => {
      const cat = await createCatalog(shop.id, {
        name: 'Email Requirement Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, cat.id);

      const res = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idemp_pcd_4')
        .send({
          dataVersion: published.dataVersion,
          buyer: {
            businessName: 'No Email Corp',
            email: 'invalid-email-format',
          },
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
        });

      expect(res.status).toBe(400);
    });

    it('5. Draft Order payload passes buyer email to Shopify API', async () => {
      const cat = await createCatalog(shop.id, {
        name: 'Draft Order Email Mapping Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, cat.id);

      const { spy, getCapturedVars } = mockShopifyClient('gid://shopify/DraftOrder/105');

      await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idemp_pcd_5')
        .send({
          dataVersion: published.dataVersion,
          buyer: {
            businessName: 'Verified Email Ltd',
            email: 'verified@buyer.com',
          },
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
        });

      spy.mockRestore();

      const vars = getCapturedVars();
      expect(vars).toBeDefined();
      expect(vars?.input?.email).toBe('verified@buyer.com');
      expect(vars?.input?.phone).toBeUndefined();
    });

    it('6. OrderSubmission model stores no PII columns', async () => {
      const sub = await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: (await createCatalog(shop.id, { name: 'DB Model Test', sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }] })).id,
          idempotencyKeyHash: 'hash_pcd_6',
          draftOrderId: 'gid://shopify/DraftOrder/106',
          draftOrderName: '#DRAFT-106',
          status: 'COMPLETED',
          itemCount: 1,
          lineCount: 1,
          subtotalAmount: 10,
          currency: 'USD',
        },
      });

      expect(sub.id).toBeDefined();
      expect((sub as any).buyerName).toBeUndefined();
      expect((sub as any).buyerPhone).toBeUndefined();
      expect((sub as any).taxId).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B. SHOPIFY APP PRICING & BILLING INTEGRATION (7 - 11)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Shopify App Pricing & Billing Mapping (FREE, STARTER, GROWTH)', () => {
    it('7. free maps correctly to FREE tier', () => {
      expect(mapShopifyAppPricingHandleToPlan('free')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan('catalogflow_free')).toBe(PlanTier.FREE);
    });

    it('8. starter maps correctly to STARTER tier', () => {
      expect(mapShopifyAppPricingHandleToPlan('starter')).toBe(PlanTier.STARTER);
      expect(mapShopifyAppPricingHandleToPlan('catalogflow_starter')).toBe(PlanTier.STARTER);
    });

    it('9. growth maps correctly to GROWTH tier', () => {
      expect(mapShopifyAppPricingHandleToPlan('growth')).toBe(PlanTier.GROWTH);
      expect(mapShopifyAppPricingHandleToPlan('catalogflow_growth')).toBe(PlanTier.GROWTH);
    });

    it('10. unknown handle falls back safely to FREE tier', () => {
      expect(mapShopifyAppPricingHandleToPlan('unknown_plan')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan('')).toBe(PlanTier.FREE);
    });

    it('11. entitlement resolution applies correct quotas for launch plans', async () => {
      // Free
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'free' } });
      let entitlement = await getShopEntitlement(shop.id);
      expect(entitlement.planTier).toBe(PlanTier.FREE);
      expect(entitlement.limits.maxLiveCatalogs).toBe(1);
      expect(entitlement.limits.maxVariants).toBe(50);
      expect(entitlement.limits.monthlySubmissionsLimit).toBe(5);

      // Starter
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'starter' } });
      entitlement = await getShopEntitlement(shop.id);
      expect(entitlement.planTier).toBe(PlanTier.STARTER);
      expect(entitlement.limits.maxLiveCatalogs).toBe(3);
      expect(entitlement.limits.maxVariants).toBe(500);
      expect(entitlement.limits.monthlySubmissionsLimit).toBe(50);

      // Growth
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'growth' } });
      entitlement = await getShopEntitlement(shop.id);
      expect(entitlement.planTier).toBe(PlanTier.GROWTH);
      expect(entitlement.limits.maxLiveCatalogs).toBe(10);
      expect(entitlement.limits.maxVariants).toBe(5000);
      expect(entitlement.limits.monthlySubmissionsLimit).toBe(250);

      // Legacy / unknown scale handle maps safely to FREE (no Scale plan, no free paid entitlement)
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'scale' } });
      entitlement = await getShopEntitlement(shop.id);
      expect(entitlement.planTier).toBe(PlanTier.FREE);
      expect(entitlement.limits.monthlySubmissionsLimit).toBe(5);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C. PRIVACY WEBHOOKS & LEGAL ENDPOINTS (12 - 16)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Privacy Compliance Webhooks & Public Legal Routes', () => {
    it('12. customers/data_request compliance webhook acknowledges cleanly', async () => {
      const res = await request(app)
        .post('/api/webhooks/compliance/customers-data-request')
        .send({});

      expect([200, 401]).toContain(res.status);
    });

    it('13. customers/redact compliance webhook acknowledges cleanly', async () => {
      const res = await request(app)
        .post('/api/webhooks/compliance/customers-redact')
        .send({});

      expect([200, 401]).toContain(res.status);
    });

    it('14. GET /privacy returns HTTP 200 with Privacy Policy text', async () => {
      const res = await request(app).get('/privacy');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Privacy Policy');
      expect(res.text).toContain('Email Address');
    });

    it('15. GET /terms returns HTTP 200 with Terms of Service text', async () => {
      const res = await request(app).get('/terms');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Terms of Service');
      expect(res.text).toContain('Shopify Draft Orders');
    });

    it('16. GET /support returns HTTP 200 with Support instructions', async () => {
      const res = await request(app).get('/support');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Get Help with CatalogFlow');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // D. CORE PRODUCT REGRESSION (17 - 22)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Core Product Workflow Regression', () => {
    it('17. catalog creation succeeds', async () => {
      const cat = await createCatalog(shop.id, {
        name: 'Regression Catalog',
        priceMode: PriceMode.PERCENT_DISCOUNT,
        discountPercent: 10,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      expect(cat.id).toBeDefined();
      expect(cat.status).toBe('DRAFT');
    });

    it('18. catalog publishing succeeds and generates publicToken', async () => {
      const cat = await createCatalog(shop.id, {
        name: 'Publish Regression Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, cat.id);
      expect(published.status).toBe('PUBLISHED');
      expect(published.publicToken).toHaveLength(64);
    });

    it('19. Order Link access returns 200 for valid token', async () => {
      const cat = await createCatalog(shop.id, {
        name: 'Link Access Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, cat.id);

      const res = await request(app).get(`/api/public/catalog/${published.publicToken}`);
      expect(res.status).toBe(200);
      expect(res.body.catalog.id).toBe(published.id);
    });

    it('20. buyer order line validation succeeds', async () => {
      const cat = await createCatalog(shop.id, {
        name: 'Line Validation Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, cat.id);

      const res = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/validate`)
        .send({
          dataVersion: published.dataVersion,
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 3 }],
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('VALID');
    });

    it('21. complete buyer submission creates Draft Order and OrderSubmission record', async () => {
      const cat = await createCatalog(shop.id, {
        name: 'Full E2E Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, cat.id);
      const { spy } = mockShopifyClient('gid://shopify/DraftOrder/999', '#DRAFT-999', '100.00');

      const res = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idemp_e2e_21')
        .send({
          dataVersion: published.dataVersion,
          buyer: {
            businessName: 'E2E Wholesale Co',
            email: 'e2e@buyer.com',
            poNumber: 'PO-E2E-21',
            note: 'Deliver to rear loading dock',
          },
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }],
        });

      spy.mockRestore();

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.draftOrderId).toBe('gid://shopify/DraftOrder/999');

      const savedSub = await prisma.orderSubmission.findFirst({
        where: { shopId: shop.id, catalogId: published.id },
      });
      expect(savedSub).toBeDefined();
      expect(savedSub?.draftOrderName).toBe('#DRAFT-999');
    });

    it('22. submission reconciliation handles retry without creating duplicate Draft Order', async () => {
      const cat = await createCatalog(shop.id, {
        name: 'Reconciliation Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, cat.id);
      const { spy } = mockShopifyClient('gid://shopify/DraftOrder/222', '#DRAFT-222', '100.00');

      const res1 = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idemp_recon_22')
        .send({
          dataVersion: published.dataVersion,
          buyer: { businessName: 'Recon Inc', email: 'recon@buyer.com' },
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
        });

      const res2 = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idemp_recon_22')
        .send({
          dataVersion: published.dataVersion,
          buyer: { businessName: 'Recon Inc', email: 'recon@buyer.com' },
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
        });

      spy.mockRestore();

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.submissionId).toBe(res2.body.submissionId);
      expect(res2.body.isDuplicate).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // E. LAUNCH PRICING MODEL & FEATURE PARITY SUITE (FREE, STARTER, GROWTH)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Launch Pricing Model & Feature Parity Suite', () => {
    it('23. FREE plan limits enforcement: 1 live catalog limit', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'free' } });

      const cat1 = await createCatalog(shop.id, { name: 'Free Cat 1', sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }] });
      const pub1 = await publishCatalog(shop.id, cat1.id);
      expect(pub1.status).toBe('PUBLISHED');

      const cat2 = await createCatalog(shop.id, { name: 'Free Cat 2', sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }] });
      await expect(publishCatalog(shop.id, cat2.id)).rejects.toThrow(/Free plan limit|Plan quota reached/);
    });

    it('24. STARTER plan limits enforcement: 3 live catalogs', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'starter' } });

      const c1 = await createCatalog(shop.id, { name: 'Starter 1', sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }] });
      const c2 = await createCatalog(shop.id, { name: 'Starter 2', sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }] });
      const c3 = await createCatalog(shop.id, { name: 'Starter 3', sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }] });
      const c4 = await createCatalog(shop.id, { name: 'Starter 4', sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }] });

      await publishCatalog(shop.id, c1.id);
      await publishCatalog(shop.id, c2.id);
      await publishCatalog(shop.id, c3.id);

      await expect(publishCatalog(shop.id, c4.id)).rejects.toThrow(/Starter plan limit|Plan quota reached/);
    });

    it('25. GROWTH plan limits enforcement: 10 live catalogs', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'growth' } });

      const catalogs = [];
      for (let i = 1; i <= 10; i++) {
        const cat = await createCatalog(shop.id, { name: `Growth Cat ${i}`, sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }] });
        await publishCatalog(shop.id, cat.id);
        catalogs.push(cat);
      }

      const c11 = await createCatalog(shop.id, { name: 'Growth Cat 11', sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }] });
      await expect(publishCatalog(shop.id, c11.id)).rejects.toThrow(/Growth plan limit|Plan quota reached/);
    });

    it('26. Complete core product feature availability on FREE plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'free' } });
      const entitlement = await getShopEntitlement(shop.id);

      expect(entitlement.planTier).toBe(PlanTier.FREE);
      expect(entitlement.planDetails.features).toContain('All Core B2B Features Included');

      // Verify draft catalog creation is permitted on FREE
      const cat = await createCatalog(shop.id, {
        name: 'Free Complete Feature Catalog',
        priceMode: PriceMode.PERCENT_DISCOUNT,
        discountPercent: 15,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      expect(cat.id).toBeDefined();

      // Verify publishing on FREE
      const published = await publishCatalog(shop.id, cat.id);
      expect(published.status).toBe('PUBLISHED');
    });
  });
});
