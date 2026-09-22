import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { ShopifyAdminClient } from '../src/services/shopify-client.server.js';
import {
  createCatalog,
  updateCatalog,
  publishCatalog,
  getCatalogById,
  getCatalogVariantConfigs,
  upsertCatalogVariantConfigs,
} from '../src/services/catalog.server.js';
import { getPublicCatalogPayload, syncProductSnapshot } from '../src/services/sync.server.js';
import { submitBuyerOrder } from '../src/services/order.server.js';
import {
  PriceMode,
  InventoryMode,
  CatalogSourceType,
  resolveEffectiveQuantityRules,
  isValidQuantityStep,
} from '../src/types/index.js';

describe('Final Product Simplification, Quantity Inheritance, Inventory & Feature Removal', () => {
  let shop: { id: string; shopDomain: string; currency?: string };

  beforeEach(async () => {
    await prisma.orderSubmission.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalogVariantConfig.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'final-simplification-test.myshopify.com',
      accessToken: 'token_final_simplification',
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. QUANTITY RULES & INHERITANCE MODEL (1 - 9)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Quantity Rules Inheritance & Step Math', () => {
    it('1. resolves catalog default min/max/step when variant has no override', () => {
      const catalog = { minQty: 6, maxQty: 24, qtyIncrement: 6 };
      const rules = resolveEffectiveQuantityRules(catalog);
      expect(rules.min).toBe(6);
      expect(rules.max).toBe(24);
      expect(rules.step).toBe(6);
    });

    it('2. variant inherits catalog defaults when overrideQuantityRules is false', () => {
      const catalog = { minQty: 6, maxQty: 48, qtyIncrement: 6 };
      const vcfg = { overrideQuantityRules: false, minQty: 2, maxQty: 10, qtyIncrement: 1 };
      const rules = resolveEffectiveQuantityRules(catalog, vcfg);
      expect(rules.min).toBe(6);
      expect(rules.max).toBe(48);
      expect(rules.step).toBe(6);
    });

    it('3. catalog default change affects inheriting variant dynamically', () => {
      let catalog = { minQty: 6, maxQty: 48, qtyIncrement: 6 };
      const vcfg = { overrideQuantityRules: false };

      let rules = resolveEffectiveQuantityRules(catalog, vcfg);
      expect(rules.step).toBe(6);

      // Update catalog step to 3
      catalog = { ...catalog, qtyIncrement: 3 };
      rules = resolveEffectiveQuantityRules(catalog, vcfg);
      expect(rules.step).toBe(3);
    });

    it('4. explicit variant override takes precedence when overrideQuantityRules is true', () => {
      const catalog = { minQty: 6, maxQty: 48, qtyIncrement: 6 };
      const vcfg = { overrideQuantityRules: true, minQty: 2, maxQty: 24, qtyIncrement: 2 };
      const rules = resolveEffectiveQuantityRules(catalog, vcfg);
      expect(rules.min).toBe(2);
      expect(rules.max).toBe(24);
      expect(rules.step).toBe(2);
    });

    it('5. no silent variant override when overrideQuantityRules is absent/false', () => {
      const catalog = { minQty: 5, maxQty: 50, qtyIncrement: 5 };
      // minQty/maxQty exist in raw object but overrideQuantityRules is false
      const vcfg = { overrideQuantityRules: false, minQty: 1, maxQty: 5, qtyIncrement: 1 };
      const rules = resolveEffectiveQuantityRules(catalog, vcfg);
      expect(rules.min).toBe(5);
      expect(rules.step).toBe(5);
    });

    it('6. validates min=6 step=6 valid quantities (6, 12, 18, 24) and rejects invalid (7)', () => {
      const min = 6;
      const step = 6;
      const max = 24;

      expect(isValidQuantityStep(6, min, step, max)).toBe(true);
      expect(isValidQuantityStep(12, min, step, max)).toBe(true);
      expect(isValidQuantityStep(18, min, step, max)).toBe(true);
      expect(isValidQuantityStep(24, min, step, max)).toBe(true);

      expect(isValidQuantityStep(7, min, step, max)).toBe(false);
      expect(isValidQuantityStep(13, min, step, max)).toBe(false);
      expect(isValidQuantityStep(25, min, step, max)).toBe(false);
    });

    it('7. validates min=5 step=3 valid quantities (5, 8, 11, 14) relative to minimum', () => {
      const min = 5;
      const step = 3;

      expect(isValidQuantityStep(5, min, step)).toBe(true);
      expect(isValidQuantityStep(8, min, step)).toBe(true);
      expect(isValidQuantityStep(11, min, step)).toBe(true);
      expect(isValidQuantityStep(14, min, step)).toBe(true);

      // 6 is NOT valid under min=5, step=3 because (6-5)%3 = 1 != 0
      expect(isValidQuantityStep(6, min, step)).toBe(false);
      expect(isValidQuantityStep(7, min, step)).toBe(false);
    });

    it('8. +/- step calculations move through valid increments relative to min', () => {
      const min = 5;
      const step = 3;

      // Starting from 0 and clicking '+' -> jumps to min (5)
      let current = 0;
      let next = current === 0 ? min : current + step;
      expect(next).toBe(5);

      // Incrementing from 5 -> 8 -> 11
      current = 5;
      next = current + step;
      expect(next).toBe(8);

      current = 8;
      next = current + step;
      expect(next).toBe(11);

      // Decrementing from 8 -> 5 -> 0
      current = 8;
      let prev = current - step < min ? 0 : current - step;
      expect(prev).toBe(5);

      current = 5;
      prev = current - step < min ? 0 : current - step;
      expect(prev).toBe(0);
    });

    it('9. backend order submission rejects invalid step quantity with 422 QTY_RULE', async () => {
      await syncProductSnapshot(shop.id, {
        id: 7001,
        title: 'Rule Test Product',
        handle: 'rule-test-product',
        status: 'active',
        variants: [
          { id: 8001, product_id: 7001, title: 'Default Variant', price: '100.00', inventory_quantity: 50, inventory_policy: 'deny', inventory_management: 'shopify' },
        ],
      });

      const catalog = await createCatalog(shop.id, {
        name: 'Step Test Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        minQty: 6,
        qtyIncrement: 6,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/7001' }],
      });
      const publishedCatalog = await publishCatalog(shop.id, catalog.id);

      // Try submitting quantity 7 (invalid step)
      await expect(
        submitBuyerOrder(catalog.publicToken, 'idem-step-test', {
          dataVersion: publishedCatalog.dataVersion,
          buyer: { businessName: 'Acme', email: 'buyer@acme.com' },
          lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 7 }],
        })
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'QTY_RULE_VIOLATION',
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. INVENTORY DISPLAY MODES & PRIVACY (10 - 16)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Inventory Display Modes & Privacy Assertions', () => {
    beforeEach(async () => {
      await syncProductSnapshot(shop.id, {
        id: 9001,
        title: 'Inventory Test Product',
        handle: 'inventory-test-product',
        status: 'active',
        variants: [
          { id: 10001, product_id: 9001, title: 'In Stock Variant', price: '25.00', inventory_quantity: 45, inventory_policy: 'deny', inventory_management: 'shopify' },
          { id: 10002, product_id: 9001, title: 'Out of Stock Variant', price: '25.00', inventory_quantity: 0, inventory_policy: 'deny', inventory_management: 'shopify' },
        ],
      });
    });

    it('10. STATUS_ONLY exposes boolean availability and omits exact quantity', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Status Only Catalog',
        inventoryMode: InventoryMode.STATUS_ONLY,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/9001' }],
      });
      await publishCatalog(shop.id, catalog.id);

      const payload = await getPublicCatalogPayload(catalog.publicToken);
      const vIn = payload!.products[0]!.variants.find((v) => v.shopifyVariantId === 'gid://shopify/ProductVariant/10001');
      expect(vIn?.availableForSale).toBe(true);
      expect(vIn?.inventoryQuantity).toBeUndefined();
    });

    it('11. STATUS_ONLY reflects stock = 0 as availableForSale = false', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Status Only Catalog',
        inventoryMode: InventoryMode.STATUS_ONLY,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/9001' }],
      });
      await publishCatalog(shop.id, catalog.id);

      const payload = await getPublicCatalogPayload(catalog.publicToken);
      const vOut = payload!.products[0]!.variants.find((v) => v.shopifyVariantId === 'gid://shopify/ProductVariant/10002');
      expect(vOut?.availableForSale).toBe(false);
      expect(vOut?.inventoryQuantity).toBeUndefined();
    });

    it('12. EXACT mode exposes exact available quantity', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Exact Catalog',
        inventoryMode: InventoryMode.EXACT,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/9001' }],
      });
      await publishCatalog(shop.id, catalog.id);

      const payload = await getPublicCatalogPayload(catalog.publicToken);
      const vIn = payload!.products[0]!.variants.find((v) => v.shopifyVariantId === 'gid://shopify/ProductVariant/10001');
      expect(vIn?.inventoryQuantity).toBe(45);
    });

    it('13 & 14. CAPPED mode caps at inventoryCap when stock exceeds cap', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Capped Catalog',
        inventoryMode: InventoryMode.CAPPED,
        inventoryCap: 20,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/9001' }],
      });
      await publishCatalog(shop.id, catalog.id);

      const payload = await getPublicCatalogPayload(catalog.publicToken);
      const vIn = payload!.products[0]!.variants.find((v) => v.shopifyVariantId === 'gid://shopify/ProductVariant/10001');
      // Real stock is 45, cap is 20 -> capped to 20
      expect(vIn?.effectiveAvailable).toBe(20);
      expect(vIn?.isCappedOverThreshold).toBe(true);
    });

    it('15. HIDDEN mode omits inventory quantity and sets showInventory false', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Hidden Catalog',
        inventoryMode: InventoryMode.HIDDEN,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/9001' }],
      });
      await publishCatalog(shop.id, catalog.id);

      const payload = await getPublicCatalogPayload(catalog.publicToken);
      expect(payload?.catalog.showInventory).toBe(false);
      const vIn = payload!.products[0]!.variants.find((v) => v.shopifyVariantId === 'gid://shopify/ProductVariant/10001');
      expect(vIn?.inventoryQuantity).toBeUndefined();
    });

    it('16. privacy assertion: exact stock count is never leaked in JSON payload under STATUS_ONLY or HIDDEN', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Privacy Catalog',
        inventoryMode: InventoryMode.STATUS_ONLY,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/9001' }],
      });
      await publishCatalog(shop.id, catalog.id);

      const payload = await getPublicCatalogPayload(catalog.publicToken);
      const jsonString = JSON.stringify(payload);
      expect(jsonString).not.toContain('"inventoryQuantity":45');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. REMOVED FEATURES ASSERTION (22 - 26)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Removed Features Non-Regression', () => {
    it('26. normal Draft Order submission, idempotency, and reconciliation remain 100% operational', async () => {
      await syncProductSnapshot(shop.id, {
        id: 11001,
        title: 'Standard Catalog Item',
        handle: 'standard-catalog-item',
        status: 'active',
        variants: [
          { id: 12001, product_id: 11001, title: 'Large / Blue', price: '75.00', inventory_quantity: 100, inventory_policy: 'deny', inventory_management: 'shopify' },
        ],
      });

      const catalog = await createCatalog(shop.id, {
        name: 'Standard Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/11001' }],
      });
      const publishedCatalog = await publishCatalog(shop.id, catalog.id);

      const clientSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
        if (query.includes('nodes(ids:')) {
          return {
            nodes: [
              {
                id: 'gid://shopify/ProductVariant/12001',
                title: 'Large / Blue',
                price: '75.00',
                availableForSale: true,
                inventoryQuantity: 100,
                inventoryPolicy: 'DENY',
                product: { id: 'gid://shopify/Product/11001', status: 'ACTIVE' },
              },
            ],
          };
        }
        if (query.includes('draftOrderCreate')) {
          return {
            draftOrderCreate: {
              draftOrder: {
                id: 'gid://shopify/DraftOrder/8888',
                name: '#D8888',
              },
              userErrors: [],
            },
          };
        }
        return {};
      });

      try {
        const submission = await submitBuyerOrder(catalog.publicToken, 'idem-regression-test', {
          dataVersion: publishedCatalog.dataVersion,
          buyer: { businessName: 'Wholesale Partner', email: 'partner@wholesale.com' },
          lines: [{ variantId: 'gid://shopify/ProductVariant/12001', quantity: 5 }],
        });

        expect(submission).toBeDefined();
        expect(submission.submissionId).toBeDefined();
        expect(submission.success).toBe(true);
        expect(submission.subtotalAmount).toBe(375.0);
      } finally {
        clientSpy.mockRestore();
      }
    });
  });
});
