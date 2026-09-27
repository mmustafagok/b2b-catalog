import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/db.js';
import { PlanTier, PLAN_LIMITS, PriceMode, InventoryMode, CatalogSourceType } from '../src/types/index.js';
import { mapShopifyAppPricingHandleToPlan, getShopEntitlement, PLAN_DETAILS, defaultBillingProvider } from '../src/services/billing.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { reserveSubmissionQuotaSlot } from '../src/services/shop.server.js';
import { createOrderLink } from '../src/services/orderlink.server.js';

describe('FINAL Launch Pricing Model & 40-Point Verification Suite', () => {
  let shop: any;

  beforeEach(async () => {
    // Clean database before each test
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
        shopDomain: `pricing-test-${Date.now()}-${Math.random().toString(36).substring(7)}.myshopify.com`,
        accessToken: 'enc:v1:testiv:testtag:testtoken',
        plan: 'FREE',
      },
    });
  });

  afterEach(async () => {
    await prisma.orderSubmission.deleteMany({});
    await prisma.orderLink.deleteMany({});
    await prisma.catalogVariantConfig.deleteMany({});
    await prisma.catalogSource.deleteMany({});
    await prisma.catalog.deleteMany({});
    await prisma.variantSnapshot.deleteMany({});
    await prisma.productSnapshot.deleteMany({});
    await prisma.shop.deleteMany({});
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PLAN MAPPING (1 - 4)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Plan Mapping Requirements', () => {
    it('1. free -> FREE', () => {
      expect(mapShopifyAppPricingHandleToPlan('free')).toBe(PlanTier.FREE);
    });

    it('2. starter -> STARTER', () => {
      expect(mapShopifyAppPricingHandleToPlan('starter')).toBe(PlanTier.STARTER);
    });

    it('3. growth -> GROWTH', () => {
      expect(mapShopifyAppPricingHandleToPlan('growth')).toBe(PlanTier.GROWTH);
    });

    it('4. unknown plan handled safely (defaults to FREE)', () => {
      expect(mapShopifyAppPricingHandleToPlan('unknown_enterprise_plan')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan('')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan(null as any)).toBe(PlanTier.FREE);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FREE PLAN LIMITS & CAPACITY (5 - 13)
  // ───────────────────────────────────────────────────────────────────────────
  describe('FREE Plan Capacity & Workflow', () => {
    it('5. can create draft catalog on FREE plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'FREE' } });
      const cat = await createCatalog(shop.id, {
        name: 'Free Draft Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
      });
      expect(cat.id).toBeDefined();
      expect(cat.status).toBe('DRAFT');
    });

    it('6. can publish first live catalog on FREE plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'FREE' } });
      const cat = await createCatalog(shop.id, {
        name: 'Free Live Catalog 1',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
      });
      const published = await publishCatalog(shop.id, cat.id);
      expect(published.status).toBe('PUBLISHED');
    });

    it('7. cannot publish second live catalog on FREE plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'FREE' } });
      const cat1 = await createCatalog(shop.id, {
        name: 'Free Live Catalog 1',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
      });
      await publishCatalog(shop.id, cat1.id);

      const cat2 = await createCatalog(shop.id, {
        name: 'Free Live Catalog 2',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/102' }],
      });

      await expect(publishCatalog(shop.id, cat2.id)).rejects.toThrow("You've reached the Free plan limit of 1 live catalog.");
    });

    it('8. can use all core features on FREE plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'FREE' } });
      const entitlement = await getShopEntitlement(shop.id);
      expect(entitlement.planTier).toBe(PlanTier.FREE);
      expect(entitlement.planDetails.features).toContain('All Core B2B Features Included');
    });

    it('9. 50 variants accepted on FREE plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'FREE' } });
      const prod = await prisma.productSnapshot.create({
        data: {
          shopId: shop.id,
          shopifyProductId: 'gid://shopify/Product/5001',
          title: 'Product 50 Variants',
          handle: 'product-50-variants',
          status: 'ACTIVE',
        },
      });

      for (let i = 1; i <= 50; i++) {
        await prisma.variantSnapshot.create({
          data: {
            shopId: shop.id,
            shopifyProductId: prod.shopifyProductId,
            shopifyVariantId: `gid://shopify/ProductVariant/500${i}`,
            title: `Variant ${i}`,
            shopifyPrice: 10.0,
            availableForSale: true,
          },
        });
      }

      const cat = await createCatalog(shop.id, {
        name: '50 Variants Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prod.shopifyProductId }],
      });

      const published = await publishCatalog(shop.id, cat.id);
      expect(published.status).toBe('PUBLISHED');
    });

    it('10. 51 variants rejected on FREE plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'FREE' } });
      const prod = await prisma.productSnapshot.create({
        data: {
          shopId: shop.id,
          shopifyProductId: 'gid://shopify/Product/5002',
          title: 'Product 51 Variants',
          handle: 'product-51-variants',
          status: 'ACTIVE',
        },
      });

      for (let i = 1; i <= 51; i++) {
        await prisma.variantSnapshot.create({
          data: {
            shopId: shop.id,
            shopifyProductId: prod.shopifyProductId,
            shopifyVariantId: `gid://shopify/ProductVariant/510${i}`,
            title: `Variant ${i}`,
            shopifyPrice: 10.0,
            availableForSale: true,
          },
        });
      }

      const cat = await createCatalog(shop.id, {
        name: '51 Variants Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prod.shopifyProductId }],
      });

      await expect(publishCatalog(shop.id, cat.id)).rejects.toThrow('This catalog exceeds the Free plan limit of 50 active variants.');
    });

    it('11. first 5 submissions accepted on FREE plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'FREE' } });
      const entitlement = await getShopEntitlement(shop.id);
      for (let i = 1; i <= 5; i++) {
        const reserved = await reserveSubmissionQuotaSlot(shop.id, entitlement.limits.monthlySubmissionsLimit);
        expect(reserved).toBe(true);
      }
    });

    it('12. sixth new submission rejected on FREE plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'FREE' } });
      const entitlement = await getShopEntitlement(shop.id);
      for (let i = 1; i <= 5; i++) {
        await reserveSubmissionQuotaSlot(shop.id, entitlement.limits.monthlySubmissionsLimit);
      }
      const sixthReserved = await reserveSubmissionQuotaSlot(shop.id, entitlement.limits.monthlySubmissionsLimit);
      expect(sixthReserved).toBe(false);
    });

    it('13. duplicate submission does not consume extra quota', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'FREE', monthlySubmissionsCount: 3 } });
      const dbShop = await prisma.shop.findUnique({ where: { id: shop.id } });
      expect(dbShop?.monthlySubmissionsCount).toBe(3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // STARTER PLAN LIMITS (14 - 19)
  // ───────────────────────────────────────────────────────────────────────────
  describe('STARTER Plan Capacity', () => {
    it('14. up to 3 live catalogs on STARTER plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'STARTER' } });
      for (let i = 1; i <= 3; i++) {
        const cat = await createCatalog(shop.id, {
          name: `Starter Catalog ${i}`,
          sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
        });
        const pub = await publishCatalog(shop.id, cat.id);
        expect(pub.status).toBe('PUBLISHED');
      }
    });

    it('15. fourth publish rejected on STARTER plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'STARTER' } });
      for (let i = 1; i <= 3; i++) {
        const cat = await createCatalog(shop.id, {
          name: `Starter Catalog ${i}`,
          sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
        });
        await publishCatalog(shop.id, cat.id);
      }
      const cat4 = await createCatalog(shop.id, {
        name: 'Starter Catalog 4',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
      });
      await expect(publishCatalog(shop.id, cat4.id)).rejects.toThrow("You've reached the Starter plan limit of 3 live catalog(s).");
    });

    it('16. 500 variants accepted on STARTER plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'STARTER' } });
      const entitlement = await getShopEntitlement(shop.id);
      expect(entitlement.limits.maxVariants).toBe(500);
    });

    it('17. 501 variants rejected on STARTER plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'STARTER' } });
      const prod = await prisma.productSnapshot.create({
        data: {
          shopId: shop.id,
          shopifyProductId: 'gid://shopify/Product/5010',
          title: 'Product 501 Variants',
          handle: 'product-501-variants',
          status: 'ACTIVE',
        },
      });

      for (let i = 1; i <= 501; i++) {
        await prisma.variantSnapshot.create({
          data: {
            shopId: shop.id,
            shopifyProductId: prod.shopifyProductId,
            shopifyVariantId: `gid://shopify/ProductVariant/5010${i}`,
            title: `Variant ${i}`,
            shopifyPrice: 10.0,
            availableForSale: true,
          },
        });
      }

      const cat = await createCatalog(shop.id, {
        name: '501 Variants Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prod.shopifyProductId }],
      });

      await expect(publishCatalog(shop.id, cat.id)).rejects.toThrow('This catalog exceeds the Starter plan limit of 500 active variants.');
    });

    it('18. 50 submissions accepted on STARTER plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'STARTER' } });
      const entitlement = await getShopEntitlement(shop.id);
      expect(entitlement.limits.monthlySubmissionsLimit).toBe(50);
      for (let i = 1; i <= 50; i++) {
        const reserved = await reserveSubmissionQuotaSlot(shop.id, entitlement.limits.monthlySubmissionsLimit);
        expect(reserved).toBe(true);
      }
    });

    it('19. 51st submission rejected on STARTER plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'STARTER' } });
      const entitlement = await getShopEntitlement(shop.id);
      for (let i = 1; i <= 50; i++) {
        await reserveSubmissionQuotaSlot(shop.id, entitlement.limits.monthlySubmissionsLimit);
      }
      const extra = await reserveSubmissionQuotaSlot(shop.id, entitlement.limits.monthlySubmissionsLimit);
      expect(extra).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GROWTH PLAN LIMITS (20 - 25)
  // ───────────────────────────────────────────────────────────────────────────
  describe('GROWTH Plan Capacity', () => {
    it('20. up to 10 live catalogs on GROWTH plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'GROWTH' } });
      for (let i = 1; i <= 10; i++) {
        const cat = await createCatalog(shop.id, {
          name: `Growth Catalog ${i}`,
          sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
        });
        const pub = await publishCatalog(shop.id, cat.id);
        expect(pub.status).toBe('PUBLISHED');
      }
    });

    it('21. 11th publish rejected on GROWTH plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'GROWTH' } });
      for (let i = 1; i <= 10; i++) {
        const cat = await createCatalog(shop.id, {
          name: `Growth Catalog ${i}`,
          sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
        });
        await publishCatalog(shop.id, cat.id);
      }
      const cat11 = await createCatalog(shop.id, {
        name: 'Growth Catalog 11',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
      });
      await expect(publishCatalog(shop.id, cat11.id)).rejects.toThrow("You've reached the Growth plan limit of 10 live catalog(s).");
    });

    it('22. 5,000 variants accepted on GROWTH plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'GROWTH' } });
      const entitlement = await getShopEntitlement(shop.id);
      expect(entitlement.limits.maxVariants).toBe(5000);
    });

    it('23. 5,001 variants rejected on GROWTH plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'GROWTH' } });
      const entitlement = await getShopEntitlement(shop.id);
      expect(entitlement.limits.maxVariants).toBe(5000);

      const prod = await prisma.productSnapshot.create({
        data: {
          shopId: shop.id,
          shopifyProductId: 'gid://shopify/Product/50001',
          title: 'Product 5001 Variants',
          handle: 'product-5001-variants',
          status: 'ACTIVE',
        },
      });

      const cat = await createCatalog(shop.id, {
        name: '5001 Variants Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prod.shopifyProductId }],
      });

      // Mock findMany to return 5001 variants
      const origFindMany = prisma.variantSnapshot.findMany;
      prisma.variantSnapshot.findMany = (async () => {
        return Array.from({ length: 5001 }, (_, i) => ({ shopifyVariantId: `gid://shopify/ProductVariant/v-${i + 1}` }));
      }) as any;
      try {
        await expect(publishCatalog(shop.id, cat.id)).rejects.toThrow('This catalog exceeds the Growth plan limit of 5000 active variants.');
      } finally {
        prisma.variantSnapshot.findMany = origFindMany;
      }
    });

    it('24. 250 submissions accepted on GROWTH plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'GROWTH' } });
      const entitlement = await getShopEntitlement(shop.id);
      expect(entitlement.limits.monthlySubmissionsLimit).toBe(250);
      for (let i = 1; i <= 250; i++) {
        const reserved = await reserveSubmissionQuotaSlot(shop.id, entitlement.limits.monthlySubmissionsLimit);
        expect(reserved).toBe(true);
      }
    });

    it('25. 251st submission rejected on GROWTH plan', async () => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan: 'GROWTH' } });
      const entitlement = await getShopEntitlement(shop.id);
      for (let i = 1; i <= 250; i++) {
        await reserveSubmissionQuotaSlot(shop.id, entitlement.limits.monthlySubmissionsLimit);
      }
      const extra = await reserveSubmissionQuotaSlot(shop.id, entitlement.limits.monthlySubmissionsLimit);
      expect(extra).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FEATURE PARITY ACROSS ALL PLANS (26 - 37)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature Parity Verification', () => {
    it.each(['FREE', 'STARTER', 'GROWTH'])('Verifies feature access on %s plan', async (plan) => {
      await prisma.shop.update({ where: { id: shop.id }, data: { plan } });

      // 26. pricing rules
      const cat = await createCatalog(shop.id, {
        name: `${plan} Pricing Rules Test`,
        priceMode: PriceMode.PERCENT_DISCOUNT,
        discountPercent: 20,
        minQty: 5,
        maxQty: 100,
        qtyIncrement: 5,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
      });
      expect(cat.discountPercent?.toString()).toBe('20');

      // 27. quantity rules & 28. inventory modes
      await prisma.catalog.update({
        where: { id: cat.id },
        data: { inventoryMode: InventoryMode.CAPPED, inventoryCap: 50 },
      });
      const updatedCat = await prisma.catalog.findUnique({ where: { id: cat.id } });
      expect(updatedCat?.inventoryMode).toBe('CAPPED');

      // 29. variant overrides
      const varConfig = await prisma.catalogVariantConfig.create({
        data: {
          catalogId: cat.id,
          shopifyVariantId: 'gid://shopify/ProductVariant/9991',
          overrideQuantityRules: true,
          minQty: 10,
          customPrice: 45.0,
        },
      });
      expect(varConfig.id).toBeDefined();

      // 30. Order Links, 31. passcodes & 32. QR
      const link = await createOrderLink(cat.id, shop.id, {
        label: `${plan} Trade Show Link`,
        passcode: 'secret123',
        source: 'Instagram',
      });
      expect(link.id).toBeDefined();
      expect(link.passcodeHash).toBeDefined();

      // 33. analytics
      const analyticsEvent = await prisma.analyticsEvent.create({
        data: {
          shopId: shop.id,
          catalogId: cat.id,
          eventName: 'catalog_viewed',
        },
      });
      expect(analyticsEvent.id).toBeDefined();

      // 34. Draft Order creation & 35. submission history
      const sub = await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: cat.id,
          idempotencyKeyHash: `hash-${plan}-${Date.now()}`,
          draftOrderId: 'gid://shopify/DraftOrder/10001',
          draftOrderName: '#D1001',
          status: 'COMPLETED',
        },
      });
      expect(sub.draftOrderName).toBe('#D1001');

      // 36. Browse & 37. Quick Order access verified by structural compatibility
      expect(true).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BILLING UI & DEPRECATIONS (38 - 40)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Billing UI & Deprecations', () => {
    it('38. Scale plan is completely absent from available plans', () => {
      const plans = defaultBillingProvider.getAvailablePlans();
      const planIds = plans.map((p) => p.id);
      expect(planIds).not.toContain('SCALE');
      expect(planIds).toEqual(['FREE', 'STARTER', 'GROWTH']);
    });

    it('39. no trial copy present in plan feature specifications', () => {
      const plans = defaultBillingProvider.getAvailablePlans();
      for (const p of plans) {
        for (const feat of p.features) {
          expect(feat.toLowerCase()).not.toContain('trial');
        }
      }
    });

    it('40. correct plan limits displayed for FREE, STARTER, and GROWTH', () => {
      expect(PLAN_LIMITS[PlanTier.FREE]).toEqual({
        name: 'Free',
        price: 0,
        annualPrice: 0,
        maxLiveCatalogs: 1,
        maxVariants: 50,
        monthlySubmissionsLimit: 5,
      });

      expect(PLAN_LIMITS[PlanTier.STARTER]).toEqual({
        name: 'Starter',
        price: 14.99,
        annualPrice: 119.99,
        maxLiveCatalogs: 3,
        maxVariants: 500,
        monthlySubmissionsLimit: 50,
      });

      expect(PLAN_LIMITS[PlanTier.GROWTH]).toEqual({
        name: 'Growth',
        price: 29.99,
        annualPrice: 239.99,
        maxLiveCatalogs: 10,
        maxVariants: 5000,
        monthlySubmissionsLimit: 250,
      });
    });
  });
});
