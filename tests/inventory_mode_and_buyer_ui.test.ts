import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import {
  createCatalog,
  updateCatalog,
  publishCatalog,
  getCatalogVariantConfigs,
  upsertCatalogVariantConfigs,
} from '../src/services/catalog.server.js';
import { getPublicCatalogPayload, syncProductSnapshot } from '../src/services/sync.server.js';
import { validateBuyerOrderLines } from '../src/services/validation.server.js';
import { renderStockBadge } from '../src/client/buyer/VariantMatrix.js';
import { CatalogSourceType, PriceMode, resolveEffectiveQuantityRules, isValidQuantityStep, resolveVariantInventory } from '../src/types/index.js';

describe('Inventory Display Mode & Quantity Rule Inheritance Suite', () => {
  let shop: { id: string; shopDomain: string };
  const prodGid1 = 'gid://shopify/Product/9001';
  const varGidInStock = 'gid://shopify/ProductVariant/90011';
  const varGidHighStock = 'gid://shopify/ProductVariant/90012';
  const varGidOutOfStock = 'gid://shopify/ProductVariant/90013';

  beforeEach(async () => {
    await prisma.orderSubmission.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalogVariantConfig.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'inventory-test.myshopify.com',
      accessToken: 'token_inv_test',
    });

    // Create product snapshot with variants of different stock levels
    await prisma.productSnapshot.create({
      data: {
        shopId: shop.id,
        shopifyProductId: prodGid1,
        title: 'Inventory Test Widget',
        handle: 'inventory-test-widget',
        status: 'ACTIVE',
        variants: {
          create: [
            {
              shopifyVariantId: varGidInStock,
              title: 'Low Stock Variant',
              sku: 'LOW-STOCK',
              shopifyPrice: 25.0,
              inventoryQuantity: 4,
              availableForSale: true,
              inventoryTracked: true,
              inventoryPolicy: 'DENY',
              selectedOptionsJson: '[]',
            },
            {
              shopifyVariantId: varGidHighStock,
              title: 'High Stock Variant',
              sku: 'HIGH-STOCK',
              shopifyPrice: 25.0,
              inventoryQuantity: 75,
              availableForSale: true,
              inventoryTracked: true,
              inventoryPolicy: 'DENY',
              selectedOptionsJson: '[]',
            },
            {
              shopifyVariantId: varGidOutOfStock,
              title: 'Out Of Stock Variant',
              sku: 'OOS-STOCK',
              shopifyPrice: 25.0,
              inventoryQuantity: 0,
              availableForSale: false,
              inventoryTracked: true,
              inventoryPolicy: 'DENY',
              selectedOptionsJson: '[]',
            },
          ],
        },
      },
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BUG 1 TESTS: INVENTORY DISPLAY & AVAILABILITY
  // ───────────────────────────────────────────────────────────────────────────

  it('1. Positive tracked inventory is detected correctly', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Tracked Inv Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      inventoryMode: 'EXACT' as any,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });
    await publishCatalog(shop.id, catalog.id);

    const payload = await getPublicCatalogPayload(catalog.publicToken);
    const lowStockVar = payload?.products[0]?.variants.find((v) => v.shopifyVariantId === varGidInStock);
    expect(lowStockVar?.inventoryQuantity).toBe(4);
    expect(lowStockVar?.effectiveAvailable).toBe(4);
    expect(lowStockVar?.availableForSale).toBe(true);
  });

  it('2. Zero tracked inventory becomes Out of stock', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Zero Stock Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      inventoryMode: 'EXACT' as any,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });
    await publishCatalog(shop.id, catalog.id);

    const payload = await getPublicCatalogPayload(catalog.publicToken);
    const oosVar = payload?.products[0]?.variants.find((v) => v.shopifyVariantId === varGidOutOfStock);
    expect(oosVar?.effectiveAvailable).toBe(0);
    expect(oosVar?.availableForSale).toBe(false);

    const badge = renderStockBadge(oosVar!, 'EXACT');
    expect(badge?.props.children).toBe('Out of stock');
  });

  it('3. Missing / untracked inventory is not blindly treated as positive stock', async () => {
    const untrackedGid = 'gid://shopify/ProductVariant/90099';
    await prisma.variantSnapshot.create({
      data: {
        shopId: shop.id,
        shopifyProductId: prodGid1,
        shopifyVariantId: untrackedGid,
        title: 'Untracked Variant',
        shopifyPrice: 10.0,
        inventoryQuantity: 0,
        availableForSale: true,
        inventoryTracked: false,
        inventoryPolicy: 'CONTINUE',
        selectedOptionsJson: '[]',
      },
    });

    const catalog = await createCatalog(shop.id, {
      name: 'Untracked Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      inventoryMode: 'EXACT' as any,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });
    await publishCatalog(shop.id, catalog.id);

    const payload = await getPublicCatalogPayload(catalog.publicToken);
    const untrackedVar = payload?.products[0]?.variants.find((v) => v.shopifyVariantId === untrackedGid);
    expect(untrackedVar?.effectiveAvailable).toBeNull();
    expect(untrackedVar?.availableForSale).toBe(true);

    const badge = renderStockBadge(untrackedVar!, 'EXACT');
    expect(badge?.props.children).toBe('In stock');
  });

  it('4. STATUS_ONLY mode rendering', async () => {
    const inStockBadge = renderStockBadge({ availableForSale: true, effectiveAvailable: 4 }, 'STATUS_ONLY');
    const oosBadge = renderStockBadge({ availableForSale: false, effectiveAvailable: 0 }, 'STATUS_ONLY');

    expect(inStockBadge?.props.children).toBe('In stock');
    expect(oosBadge?.props.children).toBe('Out of stock');
  });

  it('5. EXACT mode rendering', async () => {
    const lowBadge = renderStockBadge({ availableForSale: true, effectiveAvailable: 4 }, 'EXACT');
    const oosBadge = renderStockBadge({ availableForSale: false, effectiveAvailable: 0 }, 'EXACT');

    expect(lowBadge?.props.children).toBe('4 available');
    expect(oosBadge?.props.children).toBe('Out of stock');
  });

  it('6. CAPPED below cap', async () => {
    const cap = 50;
    const lowBadge = renderStockBadge({ availableForSale: true, effectiveAvailable: 23, isCappedOverThreshold: false }, 'CAPPED', cap);
    expect(lowBadge?.props.children).toBe('23 available');
  });

  it('7. CAPPED above cap', async () => {
    const cap = 50;
    const highBadge = renderStockBadge({ availableForSale: true, effectiveAvailable: 50, isCappedOverThreshold: true }, 'CAPPED', cap);
    expect(highBadge?.props.children).toBe('50+ available');
  });

  it('8. HIDDEN mode rendering returns null', async () => {
    const badge = renderStockBadge({ availableForSale: true, effectiveAvailable: 4 }, 'HIDDEN');
    expect(badge).toBeNull();
  });

  it('9. Browse and Quick Order use same result', async () => {
    const oosVar = { availableForSale: false, effectiveAvailable: 0 };
    ['STATUS_ONLY', 'EXACT', 'CAPPED'].forEach((mode) => {
      const badge = renderStockBadge(oosVar, mode, 50);
      expect(badge?.props.children).toBe('Out of stock');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BUG 2 TESTS: QUANTITY RULE INHERITANCE
  // ───────────────────────────────────────────────────────────────────────────

  it('10. Variant with override OFF inherits catalog Step', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Step Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      minQty: 1,
      maxQty: 20,
      qtyIncrement: 5,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });

    const configs = await getCatalogVariantConfigs(catalog.id, shop.id);
    const variantConfig = configs.find((c) => c.shopifyVariantId === varGidInStock);

    expect(variantConfig?.overrideQuantityRules).toBe(false);
    expect(variantConfig?.minQty).toBe(1);
    expect(variantConfig?.maxQty).toBe(20);
    expect(variantConfig?.qtyIncrement).toBe(5);

    const effective = resolveEffectiveQuantityRules(catalog, variantConfig);
    expect(effective.min).toBe(1);
    expect(effective.max).toBe(20);
    expect(effective.step).toBe(5);
  });

  it('11. Changing catalog Step updates inherited variant', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Inherit Update Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      minQty: 1,
      maxQty: 20,
      qtyIncrement: 5,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });

    const updatedCatalog = await updateCatalog(shop.id, catalog.id, {
      qtyIncrement: 3,
    });

    const configs = await getCatalogVariantConfigs(catalog.id, shop.id);
    const variantConfig = configs.find((c) => c.shopifyVariantId === varGidInStock);

    const effective = resolveEffectiveQuantityRules(updatedCatalog, variantConfig);
    expect(effective.step).toBe(3);
  });

  it('12. Variant with override ON uses variant Step', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Override Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      minQty: 1,
      maxQty: 20,
      qtyIncrement: 5,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });

    await upsertCatalogVariantConfigs(catalog.id, shop.id, [
      {
        shopifyVariantId: varGidInStock,
        enabled: true,
        overrideQuantityRules: true,
        minQty: 2,
        maxQty: 20,
        qtyIncrement: 2,
      },
    ]);

    const configs = await getCatalogVariantConfigs(catalog.id, shop.id);
    const variantConfig = configs.find((c) => c.shopifyVariantId === varGidInStock);

    expect(variantConfig?.overrideQuantityRules).toBe(true);
    expect(variantConfig?.qtyIncrement).toBe(2);

    const effective = resolveEffectiveQuantityRules(catalog, variantConfig);
    expect(effective.min).toBe(2);
    expect(effective.step).toBe(2);
  });

  it('13. Turning override OFF restores catalog Step', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Toggle Override Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      minQty: 1,
      maxQty: 20,
      qtyIncrement: 5,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });

    // Turn ON override
    await upsertCatalogVariantConfigs(catalog.id, shop.id, [
      {
        shopifyVariantId: varGidInStock,
        enabled: true,
        overrideQuantityRules: true,
        minQty: 2,
        qtyIncrement: 2,
      },
    ]);

    // Turn OFF override
    await upsertCatalogVariantConfigs(catalog.id, shop.id, [
      {
        shopifyVariantId: varGidInStock,
        enabled: true,
        overrideQuantityRules: false,
        minQty: null,
        qtyIncrement: null,
      },
    ]);

    const configs = await getCatalogVariantConfigs(catalog.id, shop.id);
    const variantConfig = configs.find((c) => c.shopifyVariantId === varGidInStock);

    expect(variantConfig?.overrideQuantityRules).toBe(false);
    expect(variantConfig?.qtyIncrement).toBe(5);

    const effective = resolveEffectiveQuantityRules(catalog, variantConfig);
    expect(effective.step).toBe(5);
  });

  it('14. Saving Variant Config with override OFF does not persist silent override values', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'No Silent Override Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      minQty: 1,
      qtyIncrement: 5,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });

    await upsertCatalogVariantConfigs(catalog.id, shop.id, [
      {
        shopifyVariantId: varGidInStock,
        enabled: true,
        overrideQuantityRules: false,
        minQty: 10 as any, // Stale input passed when override=false
        qtyIncrement: 10 as any,
      },
    ]);

    const rawDbConfig = await prisma.catalogVariantConfig.findUnique({
      where: {
        catalogId_shopifyVariantId: {
          catalogId: catalog.id,
          shopifyVariantId: varGidInStock,
        },
      },
    });

    expect(rawDbConfig?.overrideQuantityRules).toBe(false);
    expect(rawDbConfig?.minQty).toBeNull();
    expect(rawDbConfig?.qtyIncrement).toBeNull();
  });

  it('15. Stale quantity override fields are ignored when overrideQuantityRules=false', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Stale Field Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      qtyIncrement: 5,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });

    const fakeStaleConfig = {
      overrideQuantityRules: false,
      minQty: 99,
      qtyIncrement: 99,
    };

    const effective = resolveEffectiveQuantityRules(catalog, fakeStaleConfig);
    expect(effective.step).toBe(5);
    expect(effective.min).toBe(1);
  });

  it('16. Client and server calculate same effective rules and step validation', async () => {
    // Test relative step calculation: (quantity - min) % step === 0
    // Min = 1, Step = 5, Max = 20
    const min1 = 1;
    const step5 = 5;
    const max20 = 20;

    expect(isValidQuantityStep(1, min1, step5, max20)).toBe(true);
    expect(isValidQuantityStep(6, min1, step5, max20)).toBe(true);
    expect(isValidQuantityStep(11, min1, step5, max20)).toBe(true);
    expect(isValidQuantityStep(16, min1, step5, max20)).toBe(true);

    expect(isValidQuantityStep(5, min1, step5, max20)).toBe(false);
    expect(isValidQuantityStep(10, min1, step5, max20)).toBe(false);
    expect(isValidQuantityStep(15, min1, step5, max20)).toBe(false);

    // Min = 6, Step = 6
    const min6 = 6;
    const step6 = 6;
    expect(isValidQuantityStep(6, min6, step6)).toBe(true);
    expect(isValidQuantityStep(12, min6, step6)).toBe(true);
    expect(isValidQuantityStep(18, min6, step6)).toBe(true);
    expect(isValidQuantityStep(24, min6, step6)).toBe(true);
    expect(isValidQuantityStep(7, min6, step6)).toBe(false);
  });

  it('17. Browse and Quick Order use same effective rules', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Parity Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      minQty: 5,
      maxQty: 50,
      qtyIncrement: 5,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });
    await publishCatalog(shop.id, catalog.id);

    const payload = await getPublicCatalogPayload(catalog.publicToken);
    const variant = payload?.products[0]?.variants.find((v) => v.shopifyVariantId === varGidInStock);

    expect(variant?.minQty).toBe(5);
    expect(variant?.maxQty).toBe(50);
    expect(variant?.qtyIncrement).toBe(5);
  });

  it('18. Server submit validation uses same effective rules', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Validation Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      minQty: 5,
      maxQty: 50,
      qtyIncrement: 5,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });
    await publishCatalog(shop.id, catalog.id);

    // Submit line below minQty
    const resMin = await validateBuyerOrderLines(catalog.publicToken, {
      dataVersion: catalog.dataVersion,
      lines: [{ variantId: varGidInStock, quantity: 2 }],
    });
    expect(resMin.changedLines.some((l) => l.reason === 'QTY_RULE')).toBe(true);
  });

  it('19. Min 5 Step 3 validates 5, 8, 11', async () => {
    const min5 = 5;
    const step3 = 3;

    expect(isValidQuantityStep(5, min5, step3)).toBe(true);
    expect(isValidQuantityStep(8, min5, step3)).toBe(true);
    expect(isValidQuantityStep(11, min5, step3)).toBe(true);

    expect(isValidQuantityStep(6, min5, step3)).toBe(false);
    expect(isValidQuantityStep(7, min5, step3)).toBe(false);
    expect(isValidQuantityStep(9, min5, step3)).toBe(false);
    expect(isValidQuantityStep(10, min5, step3)).toBe(false);
  });

  it('20. Invalid step quantities rejected', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Step Reject Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      minQty: 6,
      maxQty: 48,
      qtyIncrement: 6,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });
    await publishCatalog(shop.id, catalog.id);

    // Invalid step (e.g. 7 for Min 6 Step 6)
    expect(isValidQuantityStep(7, 6, 6, 48)).toBe(false);
    expect(isValidQuantityStep(12, 6, 6, 48)).toBe(true);
  });
});
