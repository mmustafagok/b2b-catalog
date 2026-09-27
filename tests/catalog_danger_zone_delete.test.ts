import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import {
  createCatalog,
  publishCatalog,
  deleteCatalog,
  getCatalogById,
  CatalogError,
  upsertCatalogVariantConfigs,
  getPublishedCatalogByToken,
} from '../src/services/catalog.server.js';
import { createOrderLink, getOrderLinkByToken } from '../src/services/orderlink.server.js';
import { getPublicCatalogPayload, getPublicCatalogPayloadByLinkToken } from '../src/services/sync.server.js';
import { CatalogSourceType, PriceMode } from '../src/types/index.js';

describe('Danger Zone: Permanent Catalog Deletion & Link Invalidation', () => {
  let shopA: { id: string; shopDomain: string };
  let shopB: { id: string; shopDomain: string };

  beforeEach(async () => {
    await prisma.orderSubmission.deleteMany();
    await prisma.orderLink.deleteMany();
    await prisma.catalogVariantConfig.deleteMany();
    await prisma.catalogItemOverride.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.reorderIntent.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shopA = await installOrUpdateShop({
      shopDomain: 'danger-zone-a.myshopify.com',
      accessToken: 'token_shop_a',
    });

    shopB = await installOrUpdateShop({
      shopDomain: 'danger-zone-b.myshopify.com',
      accessToken: 'token_shop_b',
    });
  });

  it('permanently deletes catalog and all associated order links and metadata', async () => {
    const catalog = await createCatalog(shopA.id, {
      name: 'To Be Deleted Catalog',
      priceMode: PriceMode.PERCENT_DISCOUNT,
      discountPercent: 10,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
    });

    // Create 2 additional order links
    const link1 = await createOrderLink(catalog.id, shopA.id, { label: 'VIP Buyer Link' });
    const link2 = await createOrderLink(catalog.id, shopA.id, { label: 'Wholesale Fair Link' });

    // Verify links exist
    const linksBefore = await prisma.orderLink.findMany({ where: { catalogId: catalog.id } });
    expect(linksBefore.length).toBeGreaterThanOrEqual(2);

    // Delete catalog via Danger Zone action
    await deleteCatalog(shopA.id, catalog.id);

    // Verify catalog is deleted
    await expect(getCatalogById(shopA.id, catalog.id)).rejects.toThrow(CatalogError);

    // Verify all associated order links are completely deleted
    const linksAfter = await prisma.orderLink.findMany({ where: { catalogId: catalog.id } });
    expect(linksAfter).toHaveLength(0);

    // Verify buyer links stop working immediately
    const resolvedLink1 = await getOrderLinkByToken(link1.token);
    expect(resolvedLink1).toBeNull();
    const resolvedLink2 = await getOrderLinkByToken(link2.token);
    expect(resolvedLink2).toBeNull();

    const buyerPayload1 = await getPublicCatalogPayloadByLinkToken(link1.token);
    expect(buyerPayload1).toBeNull();
    const buyerPayload2 = await getPublicCatalogPayloadByLinkToken(link2.token);
    expect(buyerPayload2).toBeNull();

    // Verify public catalog token stops working immediately
    const publicView = await getPublishedCatalogByToken(catalog.publicToken);
    expect(publicView).toBeNull();
    const publicPayload = await getPublicCatalogPayload(catalog.publicToken);
    expect(publicPayload).toBeNull();
  });

  it('cleans up variant configs, sources, and overrides during permanent delete', async () => {
    const catalog = await createCatalog(shopA.id, {
      name: 'Configured Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/202' }],
    });

    // Add variant config override
    await upsertCatalogVariantConfigs(catalog.id, shopA.id, [
      {
        shopifyVariantId: 'gid://shopify/ProductVariant/505',
        enabled: true,
        overrideQuantityRules: true,
        minQty: 3,
        qtyIncrement: 3,
      },
    ]);

    const configsBefore = await prisma.catalogVariantConfig.findMany({ where: { catalogId: catalog.id } });
    expect(configsBefore).toHaveLength(1);

    // Delete catalog
    await deleteCatalog(shopA.id, catalog.id);

    // Verify configs & sources are cleaned up
    const configsAfter = await prisma.catalogVariantConfig.findMany({ where: { catalogId: catalog.id } });
    expect(configsAfter).toHaveLength(0);

    const sourcesAfter = await prisma.catalogSource.findMany({ where: { catalogId: catalog.id } });
    expect(sourcesAfter).toHaveLength(0);
  });

  it('enforces multi-tenant isolation: shop B cannot delete shop A catalog', async () => {
    const catalogA = await createCatalog(shopA.id, {
      name: 'Shop A Private Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/303' }],
    });

    // Shop B tries to delete Shop A's catalog
    await expect(deleteCatalog(shopB.id, catalogA.id)).rejects.toThrow(CatalogError);

    // Verify catalog A still exists and is untouched
    const catalogAfter = await getCatalogById(shopA.id, catalogA.id);
    expect(catalogAfter.name).toBe('Shop A Private Catalog');
  });

  it('protects historical submission records and Draft Orders: rejects delete if catalog has submissions', async () => {
    const catalog = await createCatalog(shopA.id, {
      name: 'Active Catalog with Submissions',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/404' }],
    });

    // Simulate an existing OrderSubmission
    await prisma.orderSubmission.create({
      data: {
        shopId: shopA.id,
        catalogId: catalog.id,
        status: 'COMPLETED',
        draftOrderId: 'gid://shopify/DraftOrder/9999',
        draftOrderName: '#D1001',
        idempotencyKeyHash: 'hash-test-danger-zone',
        itemCount: 5,
        lineCount: 1,
        subtotalAmount: 150.0,
      },
    });

    // Attempting to delete must be rejected with 409 CATALOG_HAS_HISTORY to protect historical submissions & Draft Orders
    await expect(deleteCatalog(shopA.id, catalog.id)).rejects.toThrow(
      /Cannot delete catalog with order submission history/
    );

    // Verify catalog still exists and submission is intact
    const cat = await getCatalogById(shopA.id, catalog.id);
    expect(cat).toBeDefined();

    const sub = await prisma.orderSubmission.findFirst({ where: { catalogId: catalog.id } });
    expect(sub).toBeDefined();
    expect(sub?.draftOrderId).toBe('gid://shopify/DraftOrder/9999');
  });

  it('returns 404 when attempting to delete non-existent catalog', async () => {
    await expect(deleteCatalog(shopA.id, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(CatalogError);
  });
});
