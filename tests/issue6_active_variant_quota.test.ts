import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/db.js';
import { PlanTier } from '../src/types/index.js';
import { countActiveVariantsForCatalog, publishCatalog, CatalogError } from '../src/services/catalog.server.js';

describe('Issue 6: Canonical Active Variant Counting & Quota Enforcement Test Suite', () => {
  let shop: any;

  beforeEach(async () => {
    await prisma.orderSubmission.deleteMany({});
    await prisma.orderLink.deleteMany({});
    await prisma.catalogVariantConfig.deleteMany({});
    await prisma.catalogSource.deleteMany({});
    await prisma.catalog.deleteMany({});
    await prisma.variantSnapshot.deleteMany({});
    await prisma.productSnapshot.deleteMany({});
    await prisma.collectionSnapshot.deleteMany({});
    await prisma.shop.deleteMany({});

    shop = await prisma.shop.create({
      data: {
        shopDomain: `variants-quota-${Date.now()}-${Math.random().toString(36).substring(7)}.myshopify.com`,
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
    await prisma.collectionProductMembership.deleteMany({}).catch(() => {});
    await prisma.productSnapshot.deleteMany({});
    await prisma.collectionSnapshot.deleteMany({});
    await prisma.shop.deleteMany({});
  });

  // Helper to create product snapshot with N variants
  async function createProductWithVariants(productId: string, variantCount: number, title = 'Test Product') {
    await prisma.productSnapshot.create({
      data: {
        shopId: shop.id,
        shopifyProductId: productId,
        handle: `test-product-${productId.replace(/[^a-zA-Z0-9]/g, '-')}`,
        title,
        status: 'ACTIVE',
      },
    });

    const variantsData = Array.from({ length: variantCount }).map((_, idx) => ({
      shopId: shop.id,
      shopifyProductId: productId,
      shopifyVariantId: `${productId}-v${idx + 1}`,
      title: `Variant ${idx + 1}`,
      shopifyPrice: 10.0,
      inventoryQuantity: 50,
      availableForSale: true,
    }));

    await prisma.variantSnapshot.createMany({
      data: variantsData,
    });
  }

  it('FREE plan: 50 selected + enabled → allowed', async () => {
    await createProductWithVariants('gid://shopify/Product/1', 50);

    const catalog = await prisma.catalog.create({
      data: {
        shopId: shop.id,
        name: 'Free 50 Catalog',
        publicToken: `token-${Date.now()}-50`,
        status: 'DRAFT',
        sources: {
          create: [{ type: 'PRODUCT', shopifyGid: 'gid://shopify/Product/1' }],
        },
      },
      include: { sources: true },
    });

    const activeCount = await countActiveVariantsForCatalog(shop.id, catalog.id, catalog.sources);
    expect(activeCount).toBe(50);

    const published = await publishCatalog(shop.id, catalog.id);
    expect(published.status).toBe('PUBLISHED');
  });

  it('FREE plan: 51 enabled → rejected', async () => {
    await createProductWithVariants('gid://shopify/Product/1', 51);

    const catalog = await prisma.catalog.create({
      data: {
        shopId: shop.id,
        name: 'Free 51 Catalog',
        publicToken: `token-${Date.now()}-51`,
        status: 'DRAFT',
        sources: {
          create: [{ type: 'PRODUCT', shopifyGid: 'gid://shopify/Product/1' }],
        },
      },
      include: { sources: true },
    });

    const activeCount = await countActiveVariantsForCatalog(shop.id, catalog.id, catalog.sources);
    expect(activeCount).toBe(51);

    await expect(publishCatalog(shop.id, catalog.id)).rejects.toThrow(CatalogError);
    await expect(publishCatalog(shop.id, catalog.id)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      statusCode: 403,
    });
  });

  it('FREE plan: 80 source variants, 40 explicitly disabled → active count 40 → allowed', async () => {
    await createProductWithVariants('gid://shopify/Product/80', 80);

    const catalog = await prisma.catalog.create({
      data: {
        shopId: shop.id,
        name: '80 source 40 disabled',
        publicToken: `token-${Date.now()}-80-40`,
        status: 'DRAFT',
        sources: {
          create: [{ type: 'PRODUCT', shopifyGid: 'gid://shopify/Product/80' }],
        },
      },
      include: { sources: true },
    });

    // Disable 40 variants
    await prisma.catalogVariantConfig.createMany({
      data: Array.from({ length: 40 }).map((_, idx) => ({
        catalogId: catalog.id,
        shopifyVariantId: `gid://shopify/Product/80-v${idx + 1}`,
        enabled: false,
      })),
    });

    const activeCount = await countActiveVariantsForCatalog(shop.id, catalog.id, catalog.sources);
    expect(activeCount).toBe(40);

    const published = await publishCatalog(shop.id, catalog.id);
    expect(published.status).toBe('PUBLISHED');
  });

  it('FREE plan: 100 source variants, 50 disabled → active count 50 → allowed', async () => {
    await createProductWithVariants('gid://shopify/Product/100', 100);

    const catalog = await prisma.catalog.create({
      data: {
        shopId: shop.id,
        name: '100 source 50 disabled',
        publicToken: `token-${Date.now()}-100-50`,
        status: 'DRAFT',
        sources: {
          create: [{ type: 'PRODUCT', shopifyGid: 'gid://shopify/Product/100' }],
        },
      },
      include: { sources: true },
    });

    // Disable 50 variants
    await prisma.catalogVariantConfig.createMany({
      data: Array.from({ length: 50 }).map((_, idx) => ({
        catalogId: catalog.id,
        shopifyVariantId: `gid://shopify/Product/100-v${idx + 1}`,
        enabled: false,
      })),
    });

    const activeCount = await countActiveVariantsForCatalog(shop.id, catalog.id, catalog.sources);
    expect(activeCount).toBe(50);

    const published = await publishCatalog(shop.id, catalog.id);
    expect(published.status).toBe('PUBLISHED');
  });

  it('FREE plan: 100 source variants, 49 disabled → active count 51 → rejected', async () => {
    await createProductWithVariants('gid://shopify/Product/100', 100);

    const catalog = await prisma.catalog.create({
      data: {
        shopId: shop.id,
        name: '100 source 49 disabled',
        publicToken: `token-${Date.now()}-100-49`,
        status: 'DRAFT',
        sources: {
          create: [{ type: 'PRODUCT', shopifyGid: 'gid://shopify/Product/100' }],
        },
      },
      include: { sources: true },
    });

    // Disable 49 variants -> 51 active variants left
    await prisma.catalogVariantConfig.createMany({
      data: Array.from({ length: 49 }).map((_, idx) => ({
        catalogId: catalog.id,
        shopifyVariantId: `gid://shopify/Product/100-v${idx + 1}`,
        enabled: false,
      })),
    });

    const activeCount = await countActiveVariantsForCatalog(shop.id, catalog.id, catalog.sources);
    expect(activeCount).toBe(51);

    await expect(publishCatalog(shop.id, catalog.id)).rejects.toThrow(CatalogError);
  });

  it('Deduplication: same variant appearing through both product source + collection source is counted ONCE', async () => {
    await createProductWithVariants('gid://shopify/Product/shared', 10);

    // Create collection snapshot containing product shared
    const coll = await prisma.collectionSnapshot.create({
      data: {
        shopId: shop.id,
        shopifyCollectionId: 'gid://shopify/Collection/1',
        handle: 'featured-collection',
        title: 'Featured Collection',
      },
    });

    await prisma.collectionProductMembership.create({
      data: {
        collectionId: coll.id,
        shopifyProductId: 'gid://shopify/Product/shared',
      },
    });

    const catalog = await prisma.catalog.create({
      data: {
        shopId: shop.id,
        name: 'Overlapping sources catalog',
        publicToken: `token-${Date.now()}-overlap`,
        status: 'DRAFT',
        sources: {
          create: [
            { type: 'PRODUCT', shopifyGid: 'gid://shopify/Product/shared' },
            { type: 'COLLECTION', shopifyGid: 'gid://shopify/Collection/1' },
          ],
        },
      },
      include: { sources: true },
    });

    // Product has 10 variants. Even though sourced twice (product + collection), active count is 10, not 20!
    const activeCount = await countActiveVariantsForCatalog(shop.id, catalog.id, catalog.sources);
    expect(activeCount).toBe(10);
  });

  it('STARTER plan: 500 active allowed, 501 rejected', async () => {
    await prisma.shop.update({ where: { id: shop.id }, data: { plan: PlanTier.STARTER } });

    await createProductWithVariants('gid://shopify/Product/starter500', 500);

    const catalog500 = await prisma.catalog.create({
      data: {
        shopId: shop.id,
        name: 'Starter 500',
        publicToken: `token-${Date.now()}-starter500`,
        status: 'DRAFT',
        sources: {
          create: [{ type: 'PRODUCT', shopifyGid: 'gid://shopify/Product/starter500' }],
        },
      },
      include: { sources: true },
    });

    const count500 = await countActiveVariantsForCatalog(shop.id, catalog500.id, catalog500.sources);
    expect(count500).toBe(500);
    const pub500 = await publishCatalog(shop.id, catalog500.id);
    expect(pub500.status).toBe('PUBLISHED');

    // Now test 501
    await createProductWithVariants('gid://shopify/Product/starter501', 501);
    const catalog501 = await prisma.catalog.create({
      data: {
        shopId: shop.id,
        name: 'Starter 501',
        publicToken: `token-${Date.now()}-starter501`,
        status: 'DRAFT',
        sources: {
          create: [{ type: 'PRODUCT', shopifyGid: 'gid://shopify/Product/starter501' }],
        },
      },
      include: { sources: true },
    });

    const count501 = await countActiveVariantsForCatalog(shop.id, catalog501.id, catalog501.sources);
    expect(count501).toBe(501);
    await expect(publishCatalog(shop.id, catalog501.id)).rejects.toThrow(CatalogError);
  });
});
