import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop, getActiveShopByDomain, uninstallShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import {
  syncProductSnapshot,
  syncCollectionSnapshot,
  deleteProductSnapshot,
  deleteCollectionSnapshot,
  getPublicCatalogPayload,
  performInitialShopSync,
  ensureInitialShopSync,
  syncSingleCollectionFromShopify,
  reconcileSourcedCollectionsForShop,
} from '../src/services/sync.server.js';
import * as syncModule from '../src/services/sync.server.js';
import { calculateDisplayPrice, formatMoney, toDecimal } from '../src/services/pricing.server.js';
import { ShopifyAdminClient } from '../src/services/shopify-client.server.js';
import { getValidOfflineAccessToken } from '../src/services/shopify-token.server.js';
import { exchangeSessionTokenForOfflineToken } from '../src/services/auth.server.js';
import { decryptToken } from '../src/services/crypto.server.js';
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
      expect(updatedShop?.initialSyncAt).not.toBeNull();
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

      const updatedShop = await prisma.shop.findUnique({ where: { id: shop.id } });
      expect(updatedShop?.initialSyncAt).toBeNull();
    });

    it('should populate initialSyncAt on successful sync and not set it on failure', async () => {
      // 1. Success sets initialSyncAt
      const successShop = await installOrUpdateShop({
        shopDomain: 'sync-success-shop.myshopify.com',
        accessToken: 'shpat_token_success',
      });
      const mockClient = {
        request: async (query: string) => {
          if (query.includes('currencyCode')) return { shop: { currencyCode: 'USD' } };
          if (query.includes('getCollections')) return { collections: { pageInfo: { hasNextPage: false }, edges: [] } };
          if (query.includes('getProducts')) return { products: { pageInfo: { hasNextPage: false }, edges: [] } };
          return {};
        },
      } as unknown as ShopifyAdminClient;

      await performInitialShopSync(successShop.id, mockClient);
      const afterSuccess = await prisma.shop.findUnique({ where: { id: successShop.id } });
      expect(afterSuccess?.initialSyncAt).toBeInstanceOf(Date);

      // 2. Failure does not populate initialSyncAt
      const failShop = await installOrUpdateShop({
        shopDomain: 'sync-fail-shop.myshopify.com',
        accessToken: 'shpat_token_fail',
      });
      const failingClient = {
        request: async () => { throw new Error('Simulated network failure'); },
      } as unknown as ShopifyAdminClient;

      await expect(performInitialShopSync(failShop.id, failingClient)).rejects.toThrow();
      const afterFail = await prisma.shop.findUnique({ where: { id: failShop.id } });
      expect(afterFail?.initialSyncAt).toBeNull();
    });

    it('should run initial sync once for a new shop via ensureInitialShopSync', async () => {
      const newShop = await installOrUpdateShop({
        shopDomain: 'brand-new-shop.myshopify.com',
        accessToken: 'shpat_brand_new_token',
      });
      expect(newShop.initialSyncAt).toBeNull();

      let syncCallCount = 0;
      const mockClient = {
        request: async (query: string) => {
          if (query.includes('currencyCode')) {
            syncCallCount++;
            return { shop: { currencyCode: 'USD' } };
          }
          if (query.includes('getCollections')) return { collections: { pageInfo: { hasNextPage: false }, edges: [] } };
          if (query.includes('getProducts')) return { products: { pageInfo: { hasNextPage: false }, edges: [] } };
          return {};
        },
      } as unknown as ShopifyAdminClient;

      const result = await ensureInitialShopSync(newShop.id, mockClient);
      expect(result).not.toBeNull();
      expect(syncCallCount).toBe(1);

      const updated = await prisma.shop.findUnique({ where: { id: newShop.id } });
      expect(updated?.initialSyncAt).toBeInstanceOf(Date);

      const syncRuns = await prisma.syncRun.findMany({ where: { shopId: newShop.id } });
      expect(syncRuns).toHaveLength(1);
      expect(syncRuns[0].status).toBe('COMPLETED');
    });

    it('should not start duplicate sync if repeated bootstrap occurs while IN_PROGRESS', async () => {
      const shopInProgress = await installOrUpdateShop({
        shopDomain: 'in-progress-shop.myshopify.com',
        accessToken: 'shpat_in_progress_token',
      });

      // Insert an IN_PROGRESS run in database
      await prisma.syncRun.create({
        data: {
          shopId: shopInProgress.id,
          type: 'INITIAL',
          status: 'IN_PROGRESS',
          startedAt: new Date(),
        },
      });

      let clientCalled = false;
      const mockClient = {
        request: async () => {
          clientCalled = true;
          return {};
        },
      } as unknown as ShopifyAdminClient;

      const result = await ensureInitialShopSync(shopInProgress.id, mockClient);
      expect(result).toBeNull();
      expect(clientCalled).toBe(false);

      // Total sync runs remain 1
      const totalRuns = await prisma.syncRun.findMany({ where: { shopId: shopInProgress.id } });
      expect(totalRuns).toHaveLength(1);
    });

    it('should not start a new sync for an already completed shop', async () => {
      const completedShop = await installOrUpdateShop({
        shopDomain: 'already-completed.myshopify.com',
        accessToken: 'shpat_completed_token',
        initialSyncAt: new Date(),
      });

      let clientCalled = false;
      const mockClient = {
        request: async () => {
          clientCalled = true;
          return {};
        },
      } as unknown as ShopifyAdminClient;

      const result = await ensureInitialShopSync(completedShop.id, mockClient);
      expect(result).toBeNull();
      expect(clientCalled).toBe(false);

      const totalRuns = await prisma.syncRun.findMany({ where: { shopId: completedShop.id } });
      expect(totalRuns).toHaveLength(0);
    });

    it('should allow retry if previous initial sync FAILED', async () => {
      const failedShop = await installOrUpdateShop({
        shopDomain: 'failed-prior-shop.myshopify.com',
        accessToken: 'shpat_failed_token',
      });

      // Create a FAILED run
      await prisma.syncRun.create({
        data: {
          shopId: failedShop.id,
          type: 'INITIAL',
          status: 'FAILED',
          startedAt: new Date(Date.now() - 60000),
          finishedAt: new Date(),
        },
      });

      const mockClient = {
        request: async (query: string) => {
          if (query.includes('currencyCode')) return { shop: { currencyCode: 'CAD' } };
          if (query.includes('getCollections')) return { collections: { pageInfo: { hasNextPage: false }, edges: [] } };
          if (query.includes('getProducts')) return { products: { pageInfo: { hasNextPage: false }, edges: [] } };
          return {};
        },
      } as unknown as ShopifyAdminClient;

      // Retry should be allowed and succeed
      const result = await ensureInitialShopSync(failedShop.id, mockClient);
      expect(result).not.toBeNull();

      const runs = await prisma.syncRun.findMany({ where: { shopId: failedShop.id } });
      expect(runs).toHaveLength(2);
      expect(runs.some((r) => r.status === 'COMPLETED')).toBe(true);

      const updated = await prisma.shop.findUnique({ where: { id: failedShop.id } });
      expect(updated?.initialSyncAt).toBeInstanceOf(Date);
    });

    it('should reset initialSyncAt to null upon reinstall and run one fresh sync', async () => {
      const reinstallShopDomain = 'reinstall-lifecycle-shop.myshopify.com';

      // 1. Install & complete initial sync
      const shop1 = await installOrUpdateShop({
        shopDomain: reinstallShopDomain,
        accessToken: 'shpat_first_install',
        initialSyncAt: new Date(),
      });
      expect(shop1.initialSyncAt).not.toBeNull();

      // 2. Uninstall shop
      await uninstallShop(reinstallShopDomain);
      let inDb = await prisma.shop.findUnique({ where: { shopDomain: reinstallShopDomain } });
      expect(inDb?.uninstalledAt).not.toBeNull();
      expect(inDb?.initialSyncAt).toBeNull();

      // 3. Reinstall shop (reactivates shop)
      const reinstalled = await installOrUpdateShop({
        shopDomain: reinstallShopDomain,
        accessToken: 'shpat_reinstalled_fresh_token',
      });
      expect(reinstalled.uninstalledAt).toBeNull();
      expect(reinstalled.initialSyncAt).toBeNull(); // Must be reset to null

      // 4. ensureInitialShopSync runs one fresh sync
      const mockClient = {
        request: async (query: string) => {
          if (query.includes('currencyCode')) return { shop: { currencyCode: 'EUR' } };
          if (query.includes('getCollections')) return { collections: { pageInfo: { hasNextPage: false }, edges: [] } };
          if (query.includes('getProducts')) return { products: { pageInfo: { hasNextPage: false }, edges: [] } };
          return {};
        },
      } as unknown as ShopifyAdminClient;

      await ensureInitialShopSync(reinstalled.id, mockClient);

      inDb = await prisma.shop.findUnique({ where: { id: reinstalled.id } });
      expect(inDb?.initialSyncAt).toBeInstanceOf(Date);
    });

    it('should fail safely and not overwrite stored credentials if expires_in is missing or invalid', async () => {
      const credShop = await installOrUpdateShop({
        shopDomain: 'expiry-safety-test.myshopify.com',
        accessToken: 'shpat_original_safe_access_token',
        accessTokenExpiresAt: new Date(Date.now() + 60 * 1000), // near expiry
        refreshToken: 'shprt_original_safe_refresh_token',
      });

      // 1. Missing expires_in on token refresh
      const missingExpiresFetch: any = async () => ({
        ok: true,
        json: async () => ({
          access_token: 'shpat_bad_token_no_expiry',
          refresh_token: 'shprt_bad_refresh',
          // expires_in omitted
        }),
      });

      await expect(
        getValidOfflineAccessToken(credShop.id, { fetchFn: missingExpiresFetch })
      ).rejects.toThrow('Refresh response missing valid expires_in');

      // Verify original credentials were NOT overwritten
      let verifiedShop = await prisma.shop.findUnique({ where: { id: credShop.id } });
      expect(decryptToken(verifiedShop!.accessToken)).toBe('shpat_original_safe_access_token');
      expect(decryptToken(verifiedShop!.refreshToken!)).toBe('shprt_original_safe_refresh_token');

      // 2. Invalid expires_in on token exchange
      const invalidExpiresExchangeFetch: any = async () => ({
        ok: true,
        json: async () => ({
          access_token: 'shpat_exchange_invalid',
          expires_in: 'not-a-number',
        }),
      });

      await expect(
        exchangeSessionTokenForOfflineToken({
          shopDomain: credShop.shopDomain,
          sessionToken: 'mock.session.token',
          clientId: 'test_client',
          clientSecret: 'test_secret',
          fetchFn: invalidExpiresExchangeFetch,
        })
      ).rejects.toThrow('Token exchange response missing valid expires_in');

      // Verify credentials STILL intact
      verifiedShop = await prisma.shop.findUnique({ where: { id: credShop.id } });
      expect(decryptToken(verifiedShop!.accessToken)).toBe('shpat_original_safe_access_token');
    });

    it('should paginate collection products (>100 products) across multiple pages without truncating memberships', async () => {
      // 120 products in collection: page 1 has 100, page 2 has 20
      const page1Edges = Array.from({ length: 100 }, (_, i) => ({
        node: { id: `gid://shopify/Product/multi_${i + 1}` },
      }));
      const page2Edges = Array.from({ length: 20 }, (_, i) => ({
        node: { id: `gid://shopify/Product/multi_${i + 101}` },
      }));

      const mockClient = {
        request: async (query: string, variables?: any) => {
          if (query.includes('currencyCode')) {
            return { shop: { currencyCode: 'USD' } };
          }
          if (query.includes('getCollections')) {
            return {
              collections: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/Collection/huge_coll',
                      title: 'Huge Collection',
                      handle: 'huge-collection',
                      updatedAt: new Date().toISOString(),
                      products: {
                        pageInfo: { hasNextPage: true, endCursor: 'cursor_page_1' },
                        edges: page1Edges,
                      },
                    },
                  },
                ],
              },
            };
          }
          if (query.includes('getCollectionProductsPage')) {
            expect(variables?.cursor).toBe('cursor_page_1');
            return {
              collection: {
                products: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  edges: page2Edges,
                },
              },
            };
          }
          if (query.includes('getProducts')) {
            return {
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [],
              },
            };
          }
          return {};
        },
      } as unknown as ShopifyAdminClient;

      await performInitialShopSync(shop.id, mockClient);

      const memberships = await prisma.collectionProductMembership.findMany({
        where: {
          collection: {
            shopifyCollectionId: 'gid://shopify/Collection/huge_coll',
          },
        },
      });

      expect(memberships).toHaveLength(120);
      const membershipGids = memberships.map((m) => m.shopifyProductId);
      expect(membershipGids).toContain('gid://shopify/Product/multi_1');
      expect(membershipGids).toContain('gid://shopify/Product/multi_100');
      expect(membershipGids).toContain('gid://shopify/Product/multi_101');
      expect(membershipGids).toContain('gid://shopify/Product/multi_120');
    });

    it('should paginate product variants (>50 variants) across multiple pages without dropping variants', async () => {
      // 70 variants for one product: page 1 has 50, page 2 has 20
      const page1Variants = Array.from({ length: 50 }, (_, i) => ({
        node: {
          id: `gid://shopify/ProductVariant/v_${i + 1}`,
          title: `Variant ${i + 1}`,
          sku: `SKU-${i + 1}`,
          price: '49.99',
          availableForSale: true,
          inventoryQuantity: 10,
          selectedOptions: [{ name: 'Option', value: `V${i + 1}` }],
        },
      }));

      const page2Variants = Array.from({ length: 20 }, (_, i) => ({
        node: {
          id: `gid://shopify/ProductVariant/v_${i + 51}`,
          title: `Variant ${i + 51}`,
          sku: `SKU-${i + 51}`,
          price: '59.99',
          availableForSale: true,
          inventoryQuantity: 5,
          selectedOptions: [{ name: 'Option', value: `V${i + 51}` }],
        },
      }));

      const mockClient = {
        request: async (query: string, variables?: any) => {
          if (query.includes('currencyCode')) {
            return { shop: { currencyCode: 'USD' } };
          }
          if (query.includes('getCollections')) {
            return {
              collections: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [],
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
                      id: 'gid://shopify/Product/high_variant_prod',
                      title: 'High Variant Product',
                      handle: 'high-variant-prod',
                      status: 'ACTIVE',
                      updatedAt: new Date().toISOString(),
                      variants: {
                        pageInfo: { hasNextPage: true, endCursor: 'v_cursor_50' },
                        edges: page1Variants,
                      },
                    },
                  },
                ],
              },
            };
          }
          if (query.includes('getProductVariantsPage')) {
            expect(variables?.cursor).toBe('v_cursor_50');
            return {
              product: {
                variants: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  edges: page2Variants,
                },
              },
            };
          }
          return {};
        },
      } as unknown as ShopifyAdminClient;

      await performInitialShopSync(shop.id, mockClient);

      const variants = await prisma.variantSnapshot.findMany({
        where: { shopifyProductId: 'gid://shopify/Product/high_variant_prod' },
      });

      expect(variants).toHaveLength(70);
      const variantGids = variants.map((v) => v.shopifyVariantId);
      expect(variantGids).toContain('gid://shopify/ProductVariant/v_1');
      expect(variantGids).toContain('gid://shopify/ProductVariant/v_50');
      expect(variantGids).toContain('gid://shopify/ProductVariant/v_51');
      expect(variantGids).toContain('gid://shopify/ProductVariant/v_70');
    });

    it('should strictly preserve selectedOptions (Size=M / Color=Black) and expose them in public buyer payload', async () => {
      const mockClient = {
        request: async (query: string) => {
          if (query.includes('currencyCode')) {
            return { shop: { currencyCode: 'USD' } };
          }
          if (query.includes('getCollections')) {
            return { collections: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } };
          }
          if (query.includes('getProducts')) {
            return {
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/Product/hoodie_01',
                      title: 'Premium Heavyweight Hoodie',
                      handle: 'premium-hoodie',
                      status: 'ACTIVE',
                      updatedAt: new Date().toISOString(),
                      variants: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        edges: [
                          {
                            node: {
                              id: 'gid://shopify/ProductVariant/hoodie_m_black',
                              title: 'M / Black',
                              sku: 'HD-BLK-M',
                              price: '95.00',
                              availableForSale: true,
                              inventoryQuantity: 15,
                              selectedOptions: [
                                { name: 'Size', value: 'M' },
                                { name: 'Color', value: 'Black' },
                              ],
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

      await performInitialShopSync(shop.id, mockClient);

      // Verify VariantSnapshot in DB
      const variant = await prisma.variantSnapshot.findUnique({
        where: {
          shopId_shopifyVariantId: {
            shopId: shop.id,
            shopifyVariantId: 'gid://shopify/ProductVariant/hoodie_m_black',
          },
        },
      });

      expect(variant).not.toBeNull();
      const storedOptions = JSON.parse(variant!.selectedOptionsJson);
      expect(storedOptions).toEqual([
        { name: 'Size', value: 'M' },
        { name: 'Color', value: 'Black' },
      ]);

      // Create and publish catalog
      const catalog = await createCatalog(shop.id, {
        name: 'Apparel Wholesale Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [
          {
            type: CatalogSourceType.PRODUCT,
            shopifyGid: 'gid://shopify/Product/hoodie_01',
          },
        ],
      });
      await publishCatalog(shop.id, catalog.id);

      // Verify public buyer payload returns the preserved selectedOptions
      const res = await request(app).get(`/api/public/catalog/${catalog.publicToken}`);
      expect(res.status).toBe(200);

      const buyerProduct = res.body.products.find(
        (p: any) => p.shopifyProductId === 'gid://shopify/Product/hoodie_01'
      );
      expect(buyerProduct).toBeDefined();
      expect(buyerProduct.variants).toHaveLength(1);

      const buyerVariant = buyerProduct.variants[0];
      expect(buyerVariant.selectedOptions).toEqual([
        { name: 'Size', value: 'M' },
        { name: 'Color', value: 'Black' },
      ]);
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

    it('should implement robust idempotency failure semantics: FAILED allows retry, COMPLETED deduplicates', async () => {
      const webhookId = 'webhook-state-fail-retry-999';
      const rawPayload = JSON.stringify({
        id: 7007,
        title: 'Transient Failure Product',
        handle: 'transient-failure',
        status: 'active',
        variants: [{ id: 70007, product_id: 7007, title: 'Default', price: '30.00' }],
      });
      const hmac = crypto.createHmac('sha256', secret).update(rawPayload).digest('base64');

      // Attempt 1: simulate transient error in sync
      const syncSpy = vi.spyOn(syncModule, 'syncProductSnapshot').mockRejectedValueOnce(new Error('Transient DB timeout or connection reset'));

      const res1 = await request(app)
        .post('/api/webhooks/products')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .set('X-Shopify-Topic', 'products/create')
        .set('X-Shopify-Webhook-Id', webhookId)
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res1.status).toBe(500);

      // Verify receipt is recorded as FAILED (NOT COMPLETED!)
      const failedReceipt = await prisma.webhookReceipt.findUnique({
        where: { webhookId },
      });
      expect(failedReceipt).not.toBeNull();
      expect(failedReceipt?.status).toBe('FAILED');
      expect(failedReceipt?.attempts).toBe(1);
      expect(failedReceipt?.lastError).toContain('Transient DB timeout');
      expect(failedReceipt?.completedAt).toBeNull();

      // Attempt 2 (Shopify retry with exact same webhookId): execution succeeds
      const res2 = await request(app)
        .post('/api/webhooks/products')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .set('X-Shopify-Topic', 'products/create')
        .set('X-Shopify-Webhook-Id', webhookId)
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res2.status).toBe(200);

      // Verify receipt transitions to COMPLETED with incremented attempts
      const completedReceipt = await prisma.webhookReceipt.findUnique({
        where: { webhookId },
      });
      expect(completedReceipt?.status).toBe('COMPLETED');
      expect(completedReceipt?.attempts).toBe(2);
      expect(completedReceipt?.lastError).toBeNull();
      expect(completedReceipt?.completedAt).not.toBeNull();

      // Attempt 3 (duplicate delivery of completed webhook): acknowledged safely without re-execution
      const res3 = await request(app)
        .post('/api/webhooks/products')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .set('X-Shopify-Topic', 'products/create')
        .set('X-Shopify-Webhook-Id', webhookId)
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res3.status).toBe(200);
      expect(res3.text).toContain('already processed');

      syncSpy.mockRestore();
    });

    it('should reject concurrent duplicate deliveries while in PROCESSING state with 429', async () => {
      const webhookId = 'webhook-concurrent-lock-001';

      // Pre-create a receipt in PROCESSING state from 2 seconds ago
      await prisma.webhookReceipt.create({
        data: {
          webhookId,
          topic: 'products/update',
          shopDomain: shop.shopDomain,
          status: 'PROCESSING',
          attempts: 1,
          processedAt: new Date(),
        },
      });

      const rawPayload = JSON.stringify({ id: 1234, title: 'Concurrent' });
      const hmac = crypto.createHmac('sha256', secret).update(rawPayload).digest('base64');

      const res = await request(app)
        .post('/api/webhooks/products')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .set('X-Shopify-Topic', 'products/update')
        .set('X-Shopify-Webhook-Id', webhookId)
        .set('Content-Type', 'application/json')
        .send(rawPayload);

      expect(res.status).toBe(429);
      expect(res.text).toContain('currently being processed');
    });
  });

  describe('Collection Webhook Synchronization & Membership Reconciliation', () => {
    const secret = 'collection_webhook_secret_789';

    beforeEach(() => {
      process.env.SHOPIFY_API_SECRET = secret;
    });

    it('should add manual product to collection via webhook and update public catalog payload', async () => {
      // 1. Setup product in DB
      await syncProductSnapshot(shop.id, {
        id: 301,
        title: 'New Member Product',
        handle: 'new-member-prod',
        status: 'active',
        variants: [{ id: 3001, product_id: 301, title: 'Default', price: '45.00' }],
      });

      // 2. Setup initial collection in DB without product 301
      await syncCollectionSnapshot(shop.id, {
        id: 601,
        title: 'Spring Collection',
        handle: 'spring-collection',
        productIds: [],
      });

      // 3. Catalog sourcing Collection 601
      const catalog = await createCatalog(shop.id, {
        name: 'Spring Wholesale',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [
          {
            type: CatalogSourceType.COLLECTION,
            shopifyGid: 'gid://shopify/Collection/601',
          },
        ],
      });
      await publishCatalog(shop.id, catalog.id);

      const initialPayload = await getPublicCatalogPayload(catalog.publicToken);
      expect(initialPayload?.products).toHaveLength(0);
      const initialVersion = initialPayload?.dataVersion;

      // 4. Deliver collections/update webhook with mocked GraphQL response returning product 301
      const originalFetch = global.fetch;
      global.fetch = async (url: any, options: any) => {
        if (typeof url === 'string' && url.includes('/graphql.json')) {
          return {
            ok: true,
            json: async () => ({
              data: {
                collection: {
                  id: 'gid://shopify/Collection/601',
                  title: 'Spring Collection',
                  handle: 'spring-collection',
                  updatedAt: new Date().toISOString(),
                  products: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    edges: [{ node: { id: 'gid://shopify/Product/301' } }],
                  },
                },
              },
            }),
            text: async () => '',
          } as any;
        }
        return originalFetch(url, options);
      };

      try {
        const payload = JSON.stringify({ id: 601, title: 'Spring Collection' });
        const hmac = crypto.createHmac('sha256', secret).update(payload).digest('base64');

        const res = await request(app)
          .post('/api/webhooks/collections')
          .set('X-Shopify-Hmac-Sha256', hmac)
          .set('X-Shopify-Shop-Domain', shop.shopDomain)
          .set('X-Shopify-Topic', 'collections/update')
          .set('X-Shopify-Webhook-Id', 'coll-webhook-add-001')
          .set('Content-Type', 'application/json')
          .send(payload);

        expect(res.status).toBe(200);

        // Verify product now appears in public catalog payload and dataVersion incremented
        const updatedPayload = await getPublicCatalogPayload(catalog.publicToken);
        expect(updatedPayload?.products).toHaveLength(1);
        expect(updatedPayload?.products[0].shopifyProductId).toBe('gid://shopify/Product/301');
        expect(updatedPayload?.dataVersion).toBeGreaterThan(initialVersion!);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should remove manual product from collection via webhook and update public catalog payload', async () => {
      // 1. Setup product in DB
      await syncProductSnapshot(shop.id, {
        id: 302,
        title: 'Product to be removed',
        handle: 'prod-to-remove',
        status: 'active',
        variants: [{ id: 3002, product_id: 302, title: 'Default', price: '55.00' }],
      });

      // 2. Setup collection in DB currently containing product 302
      await syncCollectionSnapshot(shop.id, {
        id: 602,
        title: 'Summer Collection',
        handle: 'summer-collection',
        productIds: [302],
      });

      // 3. Catalog sourcing Collection 602
      const catalog = await createCatalog(shop.id, {
        name: 'Summer Wholesale',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [
          {
            type: CatalogSourceType.COLLECTION,
            shopifyGid: 'gid://shopify/Collection/602',
          },
        ],
      });
      await publishCatalog(shop.id, catalog.id);

      const beforePayload = await getPublicCatalogPayload(catalog.publicToken);
      expect(beforePayload?.products).toHaveLength(1);

      // 4. Deliver collections/update webhook with empty product list
      const originalFetch = global.fetch;
      global.fetch = async (url: any, options: any) => {
        if (typeof url === 'string' && url.includes('/graphql.json')) {
          return {
            ok: true,
            json: async () => ({
              data: {
                collection: {
                  id: 'gid://shopify/Collection/602',
                  title: 'Summer Collection',
                  handle: 'summer-collection',
                  updatedAt: new Date().toISOString(),
                  products: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    edges: [],
                  },
                },
              },
            }),
            text: async () => '',
          } as any;
        }
        return originalFetch(url, options);
      };

      try {
        const payload = JSON.stringify({ id: 602, title: 'Summer Collection' });
        const hmac = crypto.createHmac('sha256', secret).update(payload).digest('base64');

        const res = await request(app)
          .post('/api/webhooks/collections')
          .set('X-Shopify-Hmac-Sha256', hmac)
          .set('X-Shopify-Shop-Domain', shop.shopDomain)
          .set('X-Shopify-Topic', 'collections/update')
          .set('X-Shopify-Webhook-Id', 'coll-webhook-remove-002')
          .set('Content-Type', 'application/json')
          .send(payload);

        expect(res.status).toBe(200);

        const afterPayload = await getPublicCatalogPayload(catalog.publicToken);
        expect(afterPayload?.products).toHaveLength(0);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should delete collection snapshot and increment catalog dataVersion on collections/delete webhook', async () => {
      // 1. Setup collection and catalog
      await syncCollectionSnapshot(shop.id, {
        id: 603,
        title: 'Collection To Delete',
        handle: 'collection-to-delete',
        productIds: [],
      });

      const catalog = await createCatalog(shop.id, {
        name: 'Catalog with Deleted Collection',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [
          {
            type: CatalogSourceType.COLLECTION,
            shopifyGid: 'gid://shopify/Collection/603',
          },
        ],
      });
      await publishCatalog(shop.id, catalog.id);

      const payload = JSON.stringify({ id: 603 });
      const hmac = crypto.createHmac('sha256', secret).update(payload).digest('base64');

      const res = await request(app)
        .post('/api/webhooks/collections')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .set('X-Shopify-Topic', 'collections/delete')
        .set('X-Shopify-Webhook-Id', 'coll-webhook-delete-003')
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);

      // Verify collection snapshot deleted
      const coll = await prisma.collectionSnapshot.findFirst({
        where: { shopId: shop.id, shopifyCollectionId: 'gid://shopify/Collection/603' },
      });
      expect(coll).toBeNull();

      // Verify catalog dataVersion incremented
      const updatedCat = await prisma.catalog.findUnique({ where: { id: catalog.id } });
      expect(updatedCat?.dataVersion).toBeGreaterThan(catalog.dataVersion);
    });

    it('should reconcile catalog-sourced collections when a product update webhook arrives', async () => {
      // Sourced collection in published catalog
      await syncCollectionSnapshot(shop.id, {
        id: 604,
        title: 'Smart Wholesale Collection',
        handle: 'smart-wholesale',
        productIds: [],
      });

      const catalog = await createCatalog(shop.id, {
        name: 'Smart Collection Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [
          {
            type: CatalogSourceType.COLLECTION,
            shopifyGid: 'gid://shopify/Collection/604',
          },
        ],
      });
      await publishCatalog(shop.id, catalog.id);

      // Deliver products/update webhook; mock collection refresh returning product 305
      const originalFetch = global.fetch;
      global.fetch = async (url: any, options: any) => {
        if (typeof url === 'string' && url.includes('/graphql.json')) {
          return {
            ok: true,
            json: async () => ({
              data: {
                collection: {
                  id: 'gid://shopify/Collection/604',
                  title: 'Smart Wholesale Collection',
                  handle: 'smart-wholesale',
                  updatedAt: new Date().toISOString(),
                  products: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    edges: [{ node: { id: 'gid://shopify/Product/305' } }],
                  },
                },
              },
            }),
            text: async () => '',
          } as any;
        }
        return originalFetch(url, options);
      };

      try {
        const prodPayload = JSON.stringify({
          id: 305,
          title: 'Product triggering smart membership',
          handle: 'smart-trigger',
          status: 'active',
          variants: [{ id: 3005, product_id: 305, title: 'Default', price: '75.00' }],
        });
        const hmac = crypto.createHmac('sha256', secret).update(prodPayload).digest('base64');

        const res = await request(app)
          .post('/api/webhooks/products')
          .set('X-Shopify-Hmac-Sha256', hmac)
          .set('X-Shopify-Shop-Domain', shop.shopDomain)
          .set('X-Shopify-Topic', 'products/update')
          .set('X-Shopify-Webhook-Id', 'prod-update-reconcile-001')
          .set('Content-Type', 'application/json')
          .send(prodPayload);

        expect(res.status).toBe(200);

        // Membership should now contain product 305
        const membership = await prisma.collectionProductMembership.findFirst({
          where: {
            shopifyProductId: 'gid://shopify/Product/305',
          },
        });
        expect(membership).not.toBeNull();
      } finally {
        global.fetch = originalFetch;
      }
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
