import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop, getActiveShopByDomain } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import {
  syncProductSnapshot,
  syncCollectionSnapshot,
  deleteProductSnapshot,
  getPublicCatalogPayload,
  performInitialShopSync,
} from '../src/services/sync.server.js';
import { calculateDisplayPrice, formatMoney, toDecimal } from '../src/services/pricing.server.js';
import { ShopifyAdminClient } from '../src/services/shopify-client.server.js';
import { CatalogSourceType, PriceMode } from '../src/types/index.js';
import crypto from 'crypto';

describe('Milestone 4.5: Collections, Initial Sync, Hardened Webhooks & Compliance', () => {
  let shop: { id: string; shopDomain: string };

  beforeEach(async () => {
    await prisma.webhookReceipt.deleteMany();
    await prisma.syncRun.deleteMany();
    await prisma.orderSubmission.deleteMany();
    await prisma.collectionProductMembership.deleteMany();
    await prisma.collectionSnapshot.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'collections-test.myshopify.com',
      accessToken: 'shpat_test_token_123',
      currency: 'EUR',
    });
  });

  describe('Exact Collection Membership & Resolution (Critical Fix)', () => {
    beforeEach(async () => {
      // Ingest 3 products: Product A, B, C
      await syncProductSnapshot(shop.id, {
        id: 101,
        title: 'Product A (In Coll A)',
        handle: 'prod-a',
        status: 'active',
        variants: [{ id: 1001, product_id: 101, title: 'Default', price: '50.00', sku: 'SKU-A' }],
      });

      await syncProductSnapshot(shop.id, {
        id: 102,
        title: 'Product B (In Coll A)',
        handle: 'prod-b',
        status: 'active',
        variants: [{ id: 1002, product_id: 102, title: 'Default', price: '60.00', sku: 'SKU-B' }],
      });

      await syncProductSnapshot(shop.id, {
        id: 103,
        title: 'Product C (In Coll B)',
        handle: 'prod-c',
        status: 'active',
        variants: [{ id: 1003, product_id: 103, title: 'Default', price: '70.00', sku: 'SKU-C' }],
      });

      // Ingest Collection A with products 101 and 102
      await syncCollectionSnapshot(shop.id, {
        id: 501,
        title: 'Collection A',
        handle: 'collection-a',
        productIds: [101, 102],
      });

      // Ingest Collection B with product 103
      await syncCollectionSnapshot(shop.id, {
        id: 502,
        title: 'Collection B',
        handle: 'collection-b',
        productIds: [103],
      });
    });

    it('should resolve ONLY products belonging to the selected collection (NEVER unrelated products)', async () => {
      // Catalog sourcing ONLY Collection A
      const catalogA = await createCatalog(shop.id, {
        name: 'Catalog Collection A Only',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [
          {
            type: CatalogSourceType.COLLECTION,
            shopifyGid: 'gid://shopify/Collection/501',
          },
        ],
      });
      await publishCatalog(shop.id, catalogA.id);

      const payload = await getPublicCatalogPayload(catalogA.publicToken);
      expect(payload).toBeDefined();
      expect(payload?.products).toHaveLength(2);

      const productTitles = payload?.products.map((p) => p.title);
      expect(productTitles).toContain('Product A (In Coll A)');
      expect(productTitles).toContain('Product B (In Coll A)');
      // Critical check: Product C must NEVER appear!
      expect(productTitles).not.toContain('Product C (In Coll B)');
    });

    it('should resolve mixed sources without duplicate products', async () => {
      // Catalog sourcing Collection A + explicit Product C
      const mixedCatalog = await createCatalog(shop.id, {
        name: 'Mixed Sources Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [
          {
            type: CatalogSourceType.COLLECTION,
            shopifyGid: 'gid://shopify/Collection/501',
          },
          {
            type: CatalogSourceType.PRODUCT,
            shopifyGid: 'gid://shopify/Product/103', // Explicit Product C
          },
          {
            type: CatalogSourceType.PRODUCT,
            shopifyGid: 'gid://shopify/Product/101', // Explicit Product A (already in Collection A)
          },
        ],
      });
      await publishCatalog(shop.id, mixedCatalog.id);

      const payload = await getPublicCatalogPayload(mixedCatalog.publicToken);
      expect(payload).toBeDefined();
      // Should have exactly 3 products without duplicates
      expect(payload?.products).toHaveLength(3);

      const productIds = payload?.products.map((p) => p.shopifyProductId);
      expect(productIds).toContain('gid://shopify/Product/101');
      expect(productIds).toContain('gid://shopify/Product/102');
      expect(productIds).toContain('gid://shopify/Product/103');
    });

    it('should remove product from resolved catalog when removed from collection', async () => {
      const catalogA = await createCatalog(shop.id, {
        name: 'Dynamic Collection Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [
          {
            type: CatalogSourceType.COLLECTION,
            shopifyGid: 'gid://shopify/Collection/501',
          },
        ],
      });
      await publishCatalog(shop.id, catalogA.id);

      let payload = await getPublicCatalogPayload(catalogA.publicToken);
      expect(payload?.products).toHaveLength(2);

      // Now update Collection A: remove Product 101, keep only Product 102
      await syncCollectionSnapshot(shop.id, {
        id: 501,
        title: 'Collection A',
        handle: 'collection-a',
        productIds: [102], // 101 removed
      });

      payload = await getPublicCatalogPayload(catalogA.publicToken);
      expect(payload?.products).toHaveLength(1);
      expect(payload?.products[0].title).toBe('Product B (In Coll A)');
    });
  });

  describe('Initial Product and Collection Sync Engine', () => {
    it('should execute paginated initial sync and persist products, variants, and currency', async () => {
      // Mock ShopifyAdminClient with paginated GraphQL response
      const mockClient = {
        request: async (query: string, variables?: any) => {
          if (query.includes('currencyCode')) {
            return { shop: { currencyCode: 'GBP' } };
          }
          if (query.includes('getCollections')) {
            return {
              collections: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/Collection/801',
                      title: 'Autumn Wholesale',
                      handle: 'autumn-wholesale',
                      updatedAt: new Date().toISOString(),
                      products: {
                        edges: [{ node: { id: 'gid://shopify/Product/901' } }],
                      },
                    },
                  },
                ],
              },
            };
          }
          if (query.includes('getProducts')) {
            return {
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/Product/901',
                      title: 'Cashmere Knit Sweater',
                      vendor: 'Luxury Apparel',
                      handle: 'cashmere-knit-sweater',
                      status: 'ACTIVE',
                      updatedAt: new Date().toISOString(),
                      images: { edges: [{ node: { url: 'https://example.com/sweater.jpg' } }] },
                      options: [{ name: 'Size', position: 1 }],
                      variants: {
                        edges: [
                          {
                            node: {
                              id: 'gid://shopify/ProductVariant/9001',
                              title: 'M',
                              sku: 'CASH-M',
                              barcode: '889977',
                              price: '180.00',
                              availableForSale: true,
                              inventoryQuantity: 20,
                              selectedOptions: [{ name: 'Size', value: 'M' }],
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            };
          }
          return {};
        },
      } as unknown as ShopifyAdminClient;

      const result = await performInitialShopSync(shop.id, mockClient);
      expect(result.collectionsSynced).toBe(1);
      expect(result.productsSynced).toBe(1);
      expect(result.variantsSynced).toBe(1);

      // Verify currency updated
      const updatedShop = await prisma.shop.findUnique({ where: { id: shop.id } });
      expect(updatedShop?.currency).toBe('GBP');

      // Verify product and membership in DB
      const memberships = await prisma.collectionProductMembership.findMany();
      expect(memberships).toHaveLength(1);
      expect(memberships[0].shopifyProductId).toBe('gid://shopify/Product/901');

      // Verify SyncRun record
      const syncRun = await prisma.syncRun.findFirst({
        where: { shopId: shop.id },
      });
      expect(syncRun?.status).toBe('COMPLETED');
    });

    it('should mark SyncRun as FAILED if Shopify API encounters errors', async () => {
      const failingClient = {
        request: async () => {
          throw new Error('Shopify rate limit exceeded or connection reset');
        },
      } as unknown as ShopifyAdminClient;

      await expect(performInitialShopSync(shop.id, failingClient)).rejects.toThrow(
        'Shopify rate limit exceeded or connection reset'
      );

      const syncRun = await prisma.syncRun.findFirst({
        where: { shopId: shop.id },
      });
      expect(syncRun?.status).toBe('FAILED');
    });
  });

  describe('Webhook Hardening & Idempotency', () => {
    const secret = 'webhook_secret_for_hardening_tests_123';

    beforeEach(() => {
      process.env.SHOPIFY_API_SECRET = secret;
    });

    it('should fail closed with 401 when HMAC signature is invalid or secret missing', async () => {
      const res = await request(app)
        .post('/api/webhooks/products')
        .set('X-Shopify-Hmac-Sha256', 'tampered_hmac==')
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .send({ id: 123 });

      expect(res.status).toBe(401);
    });

    it('should process product webhook successfully with valid HMAC and record receipt', async () => {
      const rawPayload = JSON.stringify({
        id: 999,
        title: 'Webhook Synced Product',
        handle: 'webhook-synced',
        status: 'active',
        variants: [{ id: 8888, product_id: 999, title: 'Default', price: '25.00', sku: 'WH-1' }],
      });

      const hmac = crypto.createHmac('sha256', secret).update(rawPayload).digest('base64');
      const webhookId = 'shopify-webhook-uuid-001';

      const res = await request(app)
        .post('/api/webhooks/products')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .set('X-Shopify-Topic', 'products/create')
        .set('X-Shopify-Webhook-Id', webhookId)
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res.status).toBe(200);

      // Verify receipt created
      const receipt = await prisma.webhookReceipt.findUnique({
        where: { webhookId },
      });
      expect(receipt).toBeDefined();
      expect(receipt?.topic).toBe('products/create');

      // Duplicate delivery of same webhook ID must be acknowledged without duplicate execution
      const dupRes = await request(app)
        .post('/api/webhooks/products')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .set('X-Shopify-Topic', 'products/create')
        .set('X-Shopify-Webhook-Id', webhookId)
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(dupRes.status).toBe(200);
      expect(dupRes.text).toContain('already processed');
    });
  });

  describe('Compliance Webhooks (Mandatory Shopify Topics)', () => {
    const secret = 'compliance_secret_123';

    beforeEach(() => {
      process.env.SHOPIFY_API_SECRET = secret;
    });

    it('should handle customers/data_request compliant with PII minimization', async () => {
      const body = JSON.stringify({ customer: { id: 123 }, orders_requested: [] });
      const hmac = crypto.createHmac('sha256', secret).update(body).digest('base64');

      const res = await request(app)
        .post('/api/webhooks/compliance/customers-data-request')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('No customer PII stored');
    });

    it('should handle customers/redact compliant with PII minimization', async () => {
      const body = JSON.stringify({ customer: { id: 123 } });
      const hmac = crypto.createHmac('sha256', secret).update(body).digest('base64');

      const res = await request(app)
        .post('/api/webhooks/compliance/customers-redact')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('No customer PII to redact');
    });

    it('should handle shop/redact by completely erasing retained shop data', async () => {
      const shopDomainToRedact = 'shop-to-redact.myshopify.com';
      await installOrUpdateShop({
        shopDomain: shopDomainToRedact,
        accessToken: 'token_to_redact',
      });

      const body = JSON.stringify({ shop_domain: shopDomainToRedact });
      const hmac = crypto.createHmac('sha256', secret).update(body).digest('base64');

      const res = await request(app)
        .post('/api/webhooks/compliance/shop-redact')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shopDomainToRedact)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(200);

      // Verify shop is completely erased
      const check = await prisma.shop.findUnique({
        where: { shopDomain: shopDomainToRedact },
      });
      expect(check).toBeNull();
    });
  });

  describe('Deterministic Decimal Pricing & Currency Formatting', () => {
    it('should format money in multiple currencies accurately', () => {
      expect(formatMoney(100.5, 'USD')).toBe('$100.50');
      expect(formatMoney(100.5, 'EUR')).toMatch(/€100.50|100,50\s*€/);
      expect(formatMoney(100.5, 'GBP')).toBe('£100.50');
      expect(formatMoney(100.5, 'CAD')).toMatch(/CA\$100.50|\$100.50/);
    });

    it('should perform exact decimal half-up rounding without binary float errors', () => {
      // 0.1 + 0.2 in binary float is 0.30000000000000004
      const p1 = toDecimal('0.1');
      const p2 = toDecimal('0.2');
      expect(p1.plus(p2).toString()).toBe('0.3');

      // 33.3% discount on 45.50
      const discounted = calculateDisplayPrice(toDecimal('45.50'), PriceMode.PERCENT_DISCOUNT, toDecimal('33.3'));
      expect(discounted.toString()).toBe('30.35');
    });
  });
});
