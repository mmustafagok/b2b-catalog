import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { installOrUpdateShop, uninstallShop } from '../src/services/shop.server.js';
import {
  createCatalog,
  updateCatalog,
  publishCatalog,
  unpublishCatalog,
  deleteCatalog,
  getCatalogById,
  getCatalogsByShop,
  getPublishedCatalogByToken,
  CatalogError,
} from '../src/services/catalog.server.js';
import { CatalogSourceType, PriceMode } from '../src/types/index.js';

describe('Milestone 2: Merchant Catalog Domain & CRUD', () => {
  let shopA: { id: string; shopDomain: string };
  let shopB: { id: string; shopDomain: string };

  beforeEach(async () => {
    await prisma.orderSubmission.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shopA = await installOrUpdateShop({
      shopDomain: 'shop-a.myshopify.com',
      accessToken: 'token_shop_a',
    });

    shopB = await installOrUpdateShop({
      shopDomain: 'shop-b.myshopify.com',
      accessToken: 'token_shop_b',
    });
  });

  it('should create a catalog in DRAFT status with sources and valid token', async () => {
    const catalog = await createCatalog(shopA.id, {
      name: 'Summer Wholesale 2026',
      priceMode: PriceMode.PERCENT_DISCOUNT,
      discountPercent: 15,
      accentColor: '#2b6cb0',
      showSku: true,
      showInventory: true,
      sources: [
        { type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/1001' },
        { type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/2001' },
      ],
    });

    expect(catalog).toBeDefined();
    expect(catalog.name).toBe('Summer Wholesale 2026');
    expect(catalog.status).toBe('DRAFT');
    expect(catalog.publicToken).toHaveLength(64);
    expect(Number(catalog.discountPercent)).toBe(15);
    expect(catalog.sources).toHaveLength(2);
    expect(catalog.dataVersion).toBe(1);
  });

  it('should enforce strict multi-tenant isolation across shops', async () => {
    const catalogA = await createCatalog(shopA.id, {
      name: 'Shop A Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1' }],
    });

    // Shop B tries to read Shop A's catalog
    await expect(getCatalogById(shopB.id, catalogA.id)).rejects.toThrow(CatalogError);

    // Shop B tries to update Shop A's catalog
    await expect(
      updateCatalog(shopB.id, catalogA.id, { name: 'Hacked Catalog' })
    ).rejects.toThrow(CatalogError);

    // Shop B tries to publish Shop A's catalog
    await expect(publishCatalog(shopB.id, catalogA.id)).rejects.toThrow(CatalogError);

    // Shop B tries to delete Shop A's catalog
    await expect(deleteCatalog(shopB.id, catalogA.id)).rejects.toThrow(CatalogError);

    // Verify catalog A remains unchanged
    const pristine = await getCatalogById(shopA.id, catalogA.id);
    expect(pristine.name).toBe('Shop A Catalog');
  });

  it('should update catalog sources, details, and increment dataVersion', async () => {
    const catalog = await createCatalog(shopA.id, {
      name: 'Initial Name',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1' }],
    });

    const updated = await updateCatalog(shopA.id, catalog.id, {
      name: 'Updated Name',
      priceMode: PriceMode.PERCENT_DISCOUNT,
      discountPercent: 20,
      sources: [
        { type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/99' },
      ],
    });

    expect(updated.name).toBe('Updated Name');
    expect(updated.priceMode).toBe('PERCENT_DISCOUNT');
    expect(Number(updated.discountPercent)).toBe(20);
    expect(updated.sources).toHaveLength(1);
    expect(updated.sources[0].shopifyGid).toBe('gid://shopify/Collection/99');
    expect(updated.dataVersion).toBe(2);
  });

  it('should publish catalog and enforce plan quota limits', async () => {
    // Catalog 1 for Shop A
    const cat1 = await createCatalog(shopA.id, {
      name: 'Catalog 1',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1' }],
    });

    const published1 = await publishCatalog(shopA.id, cat1.id);
    expect(published1.status).toBe('PUBLISHED');
    expect(published1.publishedAt).not.toBeNull();

    // Catalog 2 for Shop A (Starter plan limit is 1 live catalog)
    const cat2 = await createCatalog(shopA.id, {
      name: 'Catalog 2',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/2' }],
    });

    await expect(publishCatalog(shopA.id, cat2.id)).rejects.toThrow(/Plan quota reached/);
  });

  it('should control public access based on publish state and shop active status', async () => {
    const catalog = await createCatalog(shopA.id, {
      name: 'Public Test Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1' }],
    });

    // 1. Unpublished (DRAFT) -> should return null
    let publicView = await getPublishedCatalogByToken(catalog.publicToken);
    expect(publicView).toBeNull();

    // 2. Published -> should return catalog
    await publishCatalog(shopA.id, catalog.id);
    publicView = await getPublishedCatalogByToken(catalog.publicToken);
    expect(publicView).not.toBeNull();
    expect(publicView?.name).toBe('Public Test Catalog');

    // 3. Unpublished again -> returns null
    await unpublishCatalog(shopA.id, catalog.id);
    publicView = await getPublishedCatalogByToken(catalog.publicToken);
    expect(publicView).toBeNull();

    // 4. Publish again, but shop gets uninstalled -> returns null immediately
    await publishCatalog(shopA.id, catalog.id);
    await uninstallShop(shopA.shopDomain);
    publicView = await getPublishedCatalogByToken(catalog.publicToken);
    expect(publicView).toBeNull();
  });

  it('should support adding and removing products from a catalog while preserving token and incrementing dataVersion', async () => {
    const catalog = await createCatalog(shopA.id, {
      name: 'Product Edit Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [
        { type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1' },
        { type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/2' },
      ],
    });

    const initialToken = catalog.publicToken;
    expect(catalog.sources).toHaveLength(2);

    // Update catalog: remove product 2 and add product 3
    const updated = await updateCatalog(shopA.id, catalog.id, {
      sources: [
        { type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1' },
        { type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/3' },
      ],
    });

    expect(updated.publicToken).toBe(initialToken);
    expect(updated.dataVersion).toBe(2);
    expect(updated.sources).toHaveLength(2);
    const gids = updated.sources.map((s) => s.shopifyGid);
    expect(gids).toContain('gid://shopify/Product/1');
    expect(gids).toContain('gid://shopify/Product/3');
    expect(gids).not.toContain('gid://shopify/Product/2');
  });

  it('should respect Inventory Display Modes (STATUS_ONLY, CAPPED, EXACT, HIDDEN) and maintain strict privacy', async () => {
    // 1. Create with STATUS_ONLY
    const statusCat = await createCatalog(shopA.id, {
      name: 'Status Only Catalog',
      inventoryMode: 'STATUS_ONLY' as any,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/100' }],
    });
    expect(statusCat.inventoryMode).toBe('STATUS_ONLY');
    expect(statusCat.showInventory).toBe(true);

    // 2. Create with CAPPED
    const cappedCat = await createCatalog(shopA.id, {
      name: 'Capped Inventory Catalog',
      inventoryMode: 'CAPPED' as any,
      inventoryCap: 15,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
    });
    expect(cappedCat.inventoryMode).toBe('CAPPED');
    expect(cappedCat.inventoryCap).toBe(15);
    expect(cappedCat.showInventory).toBe(true);

    // 3. Create with HIDDEN
    const hiddenCat = await createCatalog(shopA.id, {
      name: 'Hidden Inventory Catalog',
      inventoryMode: 'HIDDEN' as any,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/102' }],
    });
    expect(hiddenCat.inventoryMode).toBe('HIDDEN');
    expect(hiddenCat.showInventory).toBe(false);

    // 4. Update to EXACT
    const exactCat = await updateCatalog(shopA.id, statusCat.id, {
      inventoryMode: 'EXACT' as any,
    });
    expect(exactCat.inventoryMode).toBe('EXACT');
    expect(exactCat.showInventory).toBe(true);
  });
});

