import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, updateCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { getPublicCatalogPayload } from '../src/services/sync.server.js';
import { renderStockBadge } from '../src/client/buyer/VariantMatrix.js';
import { CatalogSourceType, PriceMode } from '../src/types/index.js';

describe('Inventory Display Mode & Buyer Portal Hardening', () => {
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

  it('1. Admin persistence: inventoryMode and inventoryCap are correctly created and updated in DB', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Persistence Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      inventoryMode: 'CAPPED' as any,
      inventoryCap: 20,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });

    expect(catalog.inventoryMode).toBe('CAPPED');
    expect(catalog.inventoryCap).toBe(20);

    const updated = await updateCatalog(shop.id, catalog.id, {
      inventoryMode: 'EXACT' as any,
    });
    expect(updated.inventoryMode).toBe('EXACT');
    expect(updated.inventoryCap).toBeNull();
  });

  it('2. Public catalog DTO payload contains correct inventoryMode, cap, and variant effective availability', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'DTO Test Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      inventoryMode: 'CAPPED' as any,
      inventoryCap: 10,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });
    await publishCatalog(shop.id, catalog.id);

    const payload = await getPublicCatalogPayload(catalog.publicToken);
    expect(payload).not.toBeNull();
    expect(payload?.catalog.inventoryMode).toBe('CAPPED');
    expect(payload?.catalog.inventoryCap).toBe(10);

    const product = payload?.products[0];
    expect(product).toBeDefined();

    const lowStockVar = product?.variants.find((v) => v.shopifyVariantId === varGidInStock);
    expect(lowStockVar?.effectiveAvailable).toBe(4);
    expect(lowStockVar?.isCappedOverThreshold).toBe(false);

    const highStockVar = product?.variants.find((v) => v.shopifyVariantId === varGidHighStock);
    expect(highStockVar?.effectiveAvailable).toBe(10); // Capped at 10
    expect(highStockVar?.isCappedOverThreshold).toBe(true);

    const oosVar = product?.variants.find((v) => v.shopifyVariantId === varGidOutOfStock);
    expect(oosVar?.availableForSale).toBe(false);
    expect(oosVar?.effectiveAvailable).toBe(0);
  });

  it('3. HIDDEN mode: public payload returns mode HIDDEN and badge renderer returns null', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Hidden Mode Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      inventoryMode: 'HIDDEN' as any,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });
    await publishCatalog(shop.id, catalog.id);

    const payload = await getPublicCatalogPayload(catalog.publicToken);
    expect(payload?.catalog.inventoryMode).toBe('HIDDEN');

    const lowVar = { availableForSale: true, effectiveAvailable: 4 };
    const oosVar = { availableForSale: false, effectiveAvailable: 0 };

    expect(renderStockBadge(lowVar, 'HIDDEN')).toBeNull();
    expect(renderStockBadge(oosVar, 'HIDDEN')).toBeNull();
  });

  it('4. STATUS_ONLY mode: buyer badge renders "In stock" or "Out of stock" without leaking numbers', async () => {
    const lowVar = { availableForSale: true, effectiveAvailable: 4 };
    const oosVar = { availableForSale: false, effectiveAvailable: 0 };

    const inStockBadge = renderStockBadge(lowVar, 'STATUS_ONLY');
    const oosBadge = renderStockBadge(oosVar, 'STATUS_ONLY');

    expect(inStockBadge?.props.children).toBe('In stock');
    expect(oosBadge?.props.children).toBe('Out of stock');
  });

  it('5. CAPPED mode: buyer badge renders exact count under cap and "{cap}+ available" over cap', async () => {
    const cap = 10;

    const lowVar = { availableForSale: true, effectiveAvailable: 4, isCappedOverThreshold: false };
    const highVar = { availableForSale: true, effectiveAvailable: 10, isCappedOverThreshold: true };
    const oosVar = { availableForSale: false, effectiveAvailable: 0 };

    const lowBadge = renderStockBadge(lowVar, 'CAPPED', cap);
    const highBadge = renderStockBadge(highVar, 'CAPPED', cap);
    const oosBadge = renderStockBadge(oosVar, 'CAPPED', cap);

    expect(lowBadge?.props.children).toBe('4 available');
    expect(highBadge?.props.children).toBe('10+ available');
    expect(oosBadge?.props.children).toBe('Out of stock');
  });

  it('6. EXACT mode: buyer badge renders exact numeric available count', async () => {
    const lowVar = { availableForSale: true, effectiveAvailable: 4 };
    const highVar = { availableForSale: true, effectiveAvailable: 75 };
    const oosVar = { availableForSale: false, effectiveAvailable: 0 };

    const lowBadge = renderStockBadge(lowVar, 'EXACT');
    const highBadge = renderStockBadge(highVar, 'EXACT');
    const oosBadge = renderStockBadge(oosVar, 'EXACT');

    expect(lowBadge?.props.children).toBe('4 available');
    expect(highBadge?.props.children).toBe('75 available');
    expect(oosBadge?.props.children).toBe('Out of stock');
  });

  it('7. Out-of-stock variants are never misleadingly shown as "In stock" under any mode', async () => {
    const oosVar = { availableForSale: false, effectiveAvailable: 0 };

    ['STATUS_ONLY', 'CAPPED', 'EXACT'].forEach((mode) => {
      const badge = renderStockBadge(oosVar, mode, 50);
      expect(badge?.props.children).toBe('Out of stock');
    });
  });
});
