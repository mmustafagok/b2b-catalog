import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { syncProductSnapshot, syncInventoryLevelUpdate, getPublicCatalogPayload } from '../src/services/sync.server.js';
import { enqueueJob, JobType } from '../src/services/job-queue.server.js';
import { submitBuyerOrder, reconcileSubmission } from '../src/services/order.server.js';
import { hashIdempotencyKey } from '../src/services/auth.server.js';
import {
  getOrCreateBuyerIdempotencyKey,
  clearBuyerIdempotencyKey,
  computeOrderFingerprint,
} from '../src/client/buyer/idempotencySession.js';
import { PriceMode, CatalogSourceType } from '../src/types/index.js';
import { Prisma } from '@prisma/client';

function computeHmac(body: Buffer | string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

describe('FINAL CORRECTNESS PASS: V1 Scope Verification', () => {
  const shopDomain = 'correctness-test.myshopify.com';
  const secret = process.env.SHOPIFY_API_SECRET || 'test_secret';
  let shop: any;

  beforeEach(async () => {
    process.env.SHOPIFY_API_SECRET = secret;
    process.env.SHOPIFY_API_KEY = 'test_api_key';

    // Clear test tables
    await prisma.runtimeIncident.deleteMany({}).catch(() => {});
    await prisma.analyticsEvent.deleteMany({}).catch(() => {});
    await prisma.backgroundJob.deleteMany({}).catch(() => {});
    await prisma.webhookReceipt.deleteMany({}).catch(() => {});
    await prisma.orderSubmission.deleteMany({}).catch(() => {});
    await prisma.catalogItemOverride.deleteMany({}).catch(() => {});
    await prisma.catalogSource.deleteMany({}).catch(() => {});
    await prisma.catalog.deleteMany({}).catch(() => {});
    await prisma.collectionProductMembership.deleteMany({}).catch(() => {});
    await prisma.collectionSnapshot.deleteMany({}).catch(() => {});
    await prisma.variantSnapshot.deleteMany({}).catch(() => {});
    await prisma.productSnapshot.deleteMany({}).catch(() => {});
    await prisma.syncRun.deleteMany({}).catch(() => {});
    await prisma.shop.deleteMany({ where: { shopDomain } }).catch(() => {});

    shop = await installOrUpdateShop({
      shopDomain,
      accessToken: 'shpat_test_token',
      scopes: 'read_products,read_inventory,write_draft_orders,read_draft_orders',
    });
  });

  // =========================================================================
  // 1. COMPLETE INVENTORY UPDATE PIPELINE
  // =========================================================================
  describe('1. Inventory Update Pipeline (Webhook -> Queue -> Worker -> DB)', () => {
    it('processes inventory_levels/update webhook, enqueues job, and worker updates availability', async () => {
      const prodGid = 'gid://shopify/Product/99100';
      const variantGid = 'gid://shopify/ProductVariant/99101';
      const inventoryItemGid = 'gid://shopify/InventoryItem/88101';

      // 1. Seed initial product with 10 available
      await syncProductSnapshot(shop.id, {
        id: prodGid,
        title: 'Industrial Drill',
        handle: 'industrial-drill',
        status: 'ACTIVE',
        variants: [
          {
            id: variantGid,
            product_id: prodGid,
            title: 'Standard Chuck',
            price: '150.00',
            inventory_quantity: 10,
            available: true,
            inventoryPolicy: 'DENY',
            inventoryTracked: true,
          },
        ],
      });

      const cat = await createCatalog(shop.id, {
        name: 'Tools Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        showInventory: true,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid }],
      });
      const published = await publishCatalog(shop.id, cat.id);
      const initialVersion = published.dataVersion;

      // 2. Send inventory_levels/update webhook
      const webhookPayload = {
        inventory_item_id: 88101,
        location_id: 55555,
        available: 3,
        updated_at: new Date().toISOString(),
      };
      const bodyStr = JSON.stringify(webhookPayload);
      const hmac = computeHmac(bodyStr, secret);

      const res = await request(app)
        .post('/api/webhooks/inventory')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shopDomain)
        .set('X-Shopify-Topic', 'inventory_levels/update')
        .set('X-Shopify-Webhook-Id', 'wh-inv-001')
        .set('Content-Type', 'application/json')
        .send(bodyStr);

      expect(res.status).toBe(200);

      // 3. Verify job was enqueued
      const job = await prisma.backgroundJob.findFirst({
        where: { shopId: shop.id, type: JobType.PRODUCT_SYNC },
      });
      expect(job).not.toBeNull();
      const jobPayload = JSON.parse(job!.payloadJson!);
      expect(jobPayload.action).toBe('inventory_update');
      expect(jobPayload.inventoryItemId).toBe('88101');

      // 4. Worker processes the job with authoritative Shopify GraphQL response
      const mockClient = {
        request: async (query: string, vars: any) => {
          expect(vars.id).toBe(inventoryItemGid);
          return {
            inventoryItem: {
              id: inventoryItemGid,
              tracked: true,
              variant: {
                id: variantGid,
                title: 'Standard Chuck',
                availableForSale: true,
                inventoryQuantity: 3,
                inventoryPolicy: 'DENY',
                product: { id: prodGid, status: 'ACTIVE' },
              },
            },
          };
        },
      } as any;

      const syncResult = await syncInventoryLevelUpdate(
        shop.id,
        { inventoryItemId: '88101', available: 3 },
        mockClient
      );
      expect(syncResult).not.toBeNull();
      expect(syncResult!.inventoryQuantity).toBe(3);
      expect(syncResult!.availableForSale).toBe(true);

      // 5. Verify catalog dataVersion was incremented
      const updatedCat = await prisma.catalog.findUnique({ where: { id: published.id } });
      expect(updatedCat!.dataVersion).toBeGreaterThan(initialVersion);

      // 6. Verify buyer catalog reflects updated inventory
      const publicPayload = await getPublicCatalogPayload(published.publicToken);
      expect(publicPayload).not.toBeNull();
      const v = publicPayload!.products[0]!.variants[0]!;
      expect(v.effectiveAvailable).toBe(3);
      expect(v.inventoryQuantity).toBe(3);
    });

    it('safely handles malformed inventory payloads without failing', async () => {
      const bodyStr = JSON.stringify({ location_id: 123 }); // Missing inventory_item_id and available
      const hmac = computeHmac(bodyStr, secret);

      const res = await request(app)
        .post('/api/webhooks/inventory')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shopDomain)
        .set('X-Shopify-Topic', 'inventory_levels/update')
        .set('X-Shopify-Webhook-Id', 'wh-inv-malformed')
        .set('Content-Type', 'application/json')
        .send(bodyStr);

      expect(res.status).toBe(200);

      // No job should be enqueued for malformed payload
      const job = await prisma.backgroundJob.findFirst({
        where: { shopId: shop.id, type: JobType.PRODUCT_SYNC },
      });
      expect(job).toBeNull();
    });

    it('safely handles missing/deleted variants on Shopify during worker inventory sync', async () => {
      const mockClient = {
        request: async () => ({ inventoryItem: null }),
      } as any;

      const result = await syncInventoryLevelUpdate(
        shop.id,
        { inventoryItemId: '99999999', available: 0 },
        mockClient
      );
      expect(result).toBeNull();
    });

    it('enforces strict shop isolation: inventory sync does not update variants of other shops', async () => {
      const otherShopDomain = 'other-shop.myshopify.com';
      const otherShop = await installOrUpdateShop({
        shopDomain: otherShopDomain,
        accessToken: 'shpat_other_token',
      });

      const prodGid = 'gid://shopify/Product/12345';
      const variantGid = 'gid://shopify/ProductVariant/67890';

      await syncProductSnapshot(otherShop.id, {
        id: prodGid,
        title: 'Other Product',
        handle: 'other-product',
        status: 'ACTIVE',
        variants: [{
          id: variantGid,
          product_id: prodGid,
          title: 'Variant 1',
          price: '50.00',
          inventory_quantity: 10,
        }],
      });

      const mockClient = {
        request: async () => ({
          inventoryItem: {
            id: 'gid://shopify/InventoryItem/111',
            tracked: true,
            variant: {
              id: variantGid,
              inventoryQuantity: 0,
              availableForSale: false,
              product: { id: prodGid },
            },
          },
        }),
      } as any;

      // Run sync for shop (not otherShop)
      const res = await syncInventoryLevelUpdate(
        shop.id,
        { inventoryItemId: '111', available: 0 },
        mockClient
      );
      expect(res).toBeNull();

      // otherShop variant remains untouched
      const otherVariant = await prisma.variantSnapshot.findUnique({
        where: { shopId_shopifyVariantId: { shopId: otherShop.id, shopifyVariantId: variantGid } },
      });
      expect(otherVariant!.inventoryQuantity).toBe(10);
    });
  });

  // =========================================================================
  // 2. PUBLIC BUYER ROUTE vs APP BRIDGE ISOLATION
  // =========================================================================
  describe('2. Public Buyer Route vs App Bridge Isolation', () => {
    it('public buyer route /c/:publicToken does NOT contain App Bridge script or API key meta tag', async () => {
      const prodGid = 'gid://shopify/Product/11100';
      const cat = await createCatalog(shop.id, {
        name: 'Public Test Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid }],
      });
      const published = await publishCatalog(shop.id, cat.id);

      const res = await request(app).get(`/c/${published.publicToken}`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('https://cdn.shopify.com/shopifycloud/app-bridge.js');
      expect(res.text).not.toContain('name="shopify-api-key"');
      expect(res.text).not.toContain('%VITE_SHOPIFY_API_KEY%');
    });

    it('merchant admin route /app includes App Bridge script and client ID meta tag', async () => {
      const res = await request(app).get('/app');
      expect(res.status).toBe(200);
      expect(res.text).toContain('https://cdn.shopify.com/shopifycloud/app-bridge.js');
      expect(res.text).toContain('name="shopify-api-key"');
    });
  });

  // =========================================================================
  // 3. MONEY / CURRENCY SEMANTICS
  // =========================================================================
  describe('3. Draft Order Money / Currency Semantics', () => {
    it('persists subtotalAmount from subtotalPriceSet (not total) in submitBuyerOrder', async () => {
      const prodGid = 'gid://shopify/Product/55001';
      const variantGid = 'gid://shopify/ProductVariant/55002';

      await syncProductSnapshot(shop.id, {
        id: prodGid,
        title: 'Wholesale Jacket',
        handle: 'wholesale-jacket',
        status: 'ACTIVE',
        variants: [
          {
            id: variantGid,
            product_id: prodGid,
            title: 'Large',
            price: '100.00',
            inventory_quantity: 50,
            available: true,
          },
        ],
      });

      const cat = await createCatalog(shop.id, {
        name: 'Jacket Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid }],
      });
      const published = await publishCatalog(shop.id, cat.id);

      const idempotencyKey = 'cfb2b-money-test-' + Date.now();

      // Mock Shopify client returning different subtotal and total (e.g. taxes or shipping included in total)
      const mockClient = {
        request: async (query: string) => {
          if (query.includes('getVariantsByIds')) {
            return {
              nodes: [
                {
                  id: variantGid,
                  title: 'Large',
                  price: '100.00',
                  availableForSale: true,
                  inventoryQuantity: 50,
                  inventoryPolicy: 'DENY',
                  inventoryItem: { tracked: true },
                  product: { id: prodGid, title: 'Wholesale Jacket', status: 'ACTIVE' },
                },
              ],
            };
          }
          if (query.includes('draftOrderCreate')) {
            return {
              draftOrderCreate: {
                draftOrder: {
                  id: 'gid://shopify/DraftOrder/777001',
                  name: '#D7701',
                  status: 'OPEN',
                  subtotalPriceSet: {
                    shopMoney: {
                      amount: '200.00',
                      currencyCode: 'USD',
                    },
                  },
                  totalPriceSet: {
                    shopMoney: {
                      amount: '240.00', // Total with tax/shipping
                      currencyCode: 'USD',
                    },
                  },
                },
                userErrors: [],
              },
            };
          }
          return {};
        },
      } as any;

      const result = await submitBuyerOrder(
        published.publicToken,
        idempotencyKey,
        {
          dataVersion: published.dataVersion,
          buyer: {
            businessName: 'Apex Retailers',
            email: 'buyer@apexretail.com',
          },
          lines: [{ variantId: variantGid, quantity: 2 }],
        },
        mockClient
      );

      expect(result.subtotalAmount).toBe(200.00); // Must be actual subtotal (200.00), not total (240.00)

      const submission = await prisma.orderSubmission.findUnique({
        where: { id: result.submissionId },
      });
      expect(submission!.subtotalAmount.toString()).toBe('200');
    });

    it('reconcileSubmission parses subtotal from subtotalPriceSet', async () => {
      const prodGid = 'gid://shopify/Product/66100';
      const cat = await createCatalog(shop.id, {
        name: 'Reconcile Money Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid }],
      });
      const published = await publishCatalog(shop.id, cat.id);

      const sub = await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: published.id,
          status: 'REQUIRES_RECONCILIATION',
          idempotencyKeyHash: 'abc123hash',
          correlationRef: 'cfb2b-reconcile-money-ref',
          quotaReserved: true,
        },
      });

      const mockClient = {
        request: async () => ({
          draftOrders: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/DraftOrder/888001',
                  name: '#D8801',
                  subtotalPriceSet: {
                    shopMoney: {
                      amount: '350.00',
                      currencyCode: 'CAD',
                    },
                  },
                  totalPriceSet: {
                    shopMoney: {
                      amount: '395.50',
                      currencyCode: 'CAD',
                    },
                  },
                },
              },
            ],
          },
        }),
      } as any;

      const res = await reconcileSubmission(shop.id, sub.id, mockClient);
      expect(res.status).toBe('COMPLETED');

      const updated = await prisma.orderSubmission.findUnique({ where: { id: sub.id } });
      expect(updated!.subtotalAmount.toString()).toBe('350');
      expect(updated!.currency).toBe('CAD');
    });
  });

  // =========================================================================
  // 4. PUBLIC INVENTORY PRIVACY (showInventory=false)
  // =========================================================================
  describe('4. Inventory Privacy Audit', () => {
    it('hides inventoryQuantity and effectiveAvailable when showInventory is false', async () => {
      const prodGid = 'gid://shopify/Product/33001';
      const variantGid = 'gid://shopify/ProductVariant/33002';

      await syncProductSnapshot(shop.id, {
        id: prodGid,
        title: 'Secret Stock Item',
        handle: 'secret-stock',
        status: 'ACTIVE',
        variants: [
          {
            id: variantGid,
            product_id: prodGid,
            title: 'Only 3 Left',
            price: '50.00',
            inventory_quantity: 3,
            available: true,
            inventoryPolicy: 'DENY',
            inventoryTracked: true,
          },
        ],
      });

      const cat = await createCatalog(shop.id, {
        name: 'Hidden Inventory Cat',
        priceMode: PriceMode.SHOPIFY_PRICE,
        showInventory: false,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid }],
      });
      const published = await publishCatalog(shop.id, cat.id);

      const payload = await getPublicCatalogPayload(published.publicToken);
      expect(payload).not.toBeNull();
      const v = payload!.products[0]!.variants[0]!;

      // Privacy guarantees
      expect(v.inventoryQuantity).toBeUndefined();
      expect(v.effectiveAvailable).toBeUndefined();
      expect(v.availableForSale).toBe(true); // Availability boolean is safe
    });
  });

  // =========================================================================
  // 5. RECONCILIATION MONEY SEMANTICS (submitBuyerOrder retry path)
  // =========================================================================
  describe('5. Reconciliation Money Semantics (submitBuyerOrder retry)', () => {
    it('persists subtotalAmount from subtotalPriceSet when subtotal != total during reconciliation recovery', async () => {
      const prodGid = 'gid://shopify/Product/44001';
      const variantGid = 'gid://shopify/ProductVariant/44002';

      await syncProductSnapshot(shop.id, {
        id: prodGid,
        title: 'Wholesale Jacket',
        handle: 'wholesale-jacket',
        status: 'ACTIVE',
        variants: [
          {
            id: variantGid,
            product_id: prodGid,
            title: 'L',
            price: '100.00',
            inventory_quantity: 50,
            available: true,
            inventoryPolicy: 'DENY',
            inventoryTracked: true,
          },
        ],
      });

      const cat = await createCatalog(shop.id, {
        name: 'Jackets Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid }],
      });
      const published = await publishCatalog(shop.id, cat.id);

      const idempotencyKey = 'order-recon-money-diff-test';
      const keyHash = hashIdempotencyKey(published.id, idempotencyKey);

      // Seed an existing submission in REQUIRES_RECONCILIATION state
      await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: published.id,
          status: 'REQUIRES_RECONCILIATION',
          idempotencyKeyHash: keyHash,
          correlationRef: 'cfb2b-diff-money-recon',
          quotaReserved: true,
        },
      });

      // Mock Shopify client returning subtotal = 100.00 (shopMoney), total = 125.00 (with taxes/shipping)
      const mockClient = {
        request: async (queryStr: string, vars: any) => {
          if (queryStr.includes('getVariantsByIds')) {
            return {
              nodes: [
                {
                  id: variantGid,
                  title: 'L',
                  price: '100.00',
                  availableForSale: true,
                  inventoryQuantity: 50,
                  inventoryPolicy: 'DENY',
                  inventoryItem: { tracked: true },
                  product: { id: prodGid, title: 'Wholesale Jacket', status: 'ACTIVE' },
                },
              ],
            };
          }
          if (queryStr.includes('findDraftOrderByTag')) {
            return {
              draftOrders: {
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/DraftOrder/990011',
                      name: '#D990011',
                      subtotalPriceSet: {
                        shopMoney: {
                          amount: '100.00',
                          currencyCode: 'EUR',
                        },
                      },
                      totalPriceSet: {
                        shopMoney: {
                          amount: '125.00',
                          currencyCode: 'EUR',
                        },
                      },
                    },
                  },
                ],
              },
            };
          }
          return {};
        },
      } as any;

      const result = await submitBuyerOrder(
        published.publicToken,
        idempotencyKey,
        {
          dataVersion: published.dataVersion,
          buyer: {
            businessName: 'Euro Retailers',
            email: 'buyer@euroretail.eu',
          },
          lines: [{ variantId: variantGid, quantity: 1 }],
        },
        mockClient
      );

      expect(result.success).toBe(true);
      expect(result.isDuplicate).toBe(true);
      expect(result.subtotalAmount).toBe(100.00); // Authoritative subtotal, not total (125.00)
      expect(result.currency).toBe('EUR');

      const saved = await prisma.orderSubmission.findUnique({
        where: { id: result.submissionId },
      });
      expect(saved!.subtotalAmount.toString()).toBe('100');
      expect(saved!.currency).toBe('EUR');
    });
  });

  // =========================================================================
  // 6. BUYER IDEMPOTENCY SESSION PERSISTENCE
  // =========================================================================
  describe('6. Buyer Idempotency Session Persistence', () => {
    class MockStorage implements Storage {
      private store: Record<string, string> = {};
      get length() {
        return Object.keys(this.store).length;
      }
      clear() {
        this.store = {};
      }
      getItem(key: string): string | null {
        return this.store[key] ?? null;
      }
      key(index: number): string | null {
        return Object.keys(this.store)[index] ?? null;
      }
      removeItem(key: string): void {
        delete this.store[key];
      }
      setItem(key: string, value: string): void {
        this.store[key] = value;
      }
    }

    it('reuses the same idempotency key across page refreshes / remounts for the same logical order', () => {
      const storage = new MockStorage();
      const publicToken = 'tok_catalog_session_test';
      const lines = [
        { variantId: 'gid://shopify/ProductVariant/101', quantity: 3 },
        { variantId: 'gid://shopify/ProductVariant/102', quantity: 5 },
      ];

      // 1. Initial attempt
      const key1 = getOrCreateBuyerIdempotencyKey(publicToken, lines, storage);
      expect(key1).toMatch(/^order-/);

      // 2. Simulated page refresh / component remount with exact same order lines
      const key2 = getOrCreateBuyerIdempotencyKey(publicToken, lines, storage);
      expect(key2).toBe(key1);

      // Verify no PII in storage
      const rawStored = storage.getItem(`cf_buyer_idemp_${publicToken}`);
      expect(rawStored).not.toBeNull();
      expect(rawStored).not.toContain('@');
      expect(rawStored).not.toContain('email');
    });

    it('generates a new idempotency key if order intent (lines/quantities) changes', () => {
      const storage = new MockStorage();
      const publicToken = 'tok_catalog_session_test_2';
      const originalLines = [
        { variantId: 'gid://shopify/ProductVariant/201', quantity: 2 },
      ];
      const alteredLines = [
        { variantId: 'gid://shopify/ProductVariant/201', quantity: 4 }, // changed quantity
      ];

      const key1 = getOrCreateBuyerIdempotencyKey(publicToken, originalLines, storage);
      const key2 = getOrCreateBuyerIdempotencyKey(publicToken, alteredLines, storage);

      expect(key2).not.toBe(key1);
    });

    it('clears stored idempotency key on explicit reset or order success', () => {
      const storage = new MockStorage();
      const publicToken = 'tok_catalog_session_test_3';
      const lines = [{ variantId: 'gid://shopify/ProductVariant/301', quantity: 1 }];

      const key1 = getOrCreateBuyerIdempotencyKey(publicToken, lines, storage);
      expect(storage.getItem(`cf_buyer_idemp_${publicToken}`)).not.toBeNull();

      // Clear after confirmed success or "Place Another Order"
      clearBuyerIdempotencyKey(publicToken, storage);
      expect(storage.getItem(`cf_buyer_idemp_${publicToken}`)).toBeNull();

      // Next order gets a new key
      const key2 = getOrCreateBuyerIdempotencyKey(publicToken, lines, storage);
      expect(key2).not.toBe(key1);
    });
  });

  // =========================================================================
  // 7. INVENTORYITEM.VARIANTS (2026-07) SYNC
  // =========================================================================
  describe('7. GraphQL 2026-07 InventoryItem.variants Sync', () => {
    it('syncs inventory level correctly using variants(first: 10).nodes structure', async () => {
      const prodGid = 'gid://shopify/Product/55001';
      const variantGid = 'gid://shopify/ProductVariant/55002';
      const inventoryItemGid = 'gid://shopify/InventoryItem/77001';

      // Seed local variant snapshot
      await syncProductSnapshot(shop.id, {
        id: prodGid,
        title: 'Tracked Hardware',
        handle: 'tracked-hardware',
        status: 'ACTIVE',
        variants: [
          {
            id: variantGid,
            product_id: prodGid,
            title: 'Titanium Bolt',
            price: '25.00',
            inventory_quantity: 5,
            available: true,
            inventoryPolicy: 'DENY',
            inventoryTracked: true,
          },
        ],
      });

      // Mock client responding with GraphQL 2026-07 variants connection
      const mockClient = {
        request: async (queryStr: string, vars: any) => {
          expect(queryStr).toContain('variants(first: 10)');
          return {
            inventoryItem: {
              id: inventoryItemGid,
              tracked: true,
              variants: {
                nodes: [
                  {
                    id: variantGid,
                    title: 'Titanium Bolt',
                    availableForSale: true,
                    inventoryQuantity: 77,
                    inventoryPolicy: 'CONTINUE',
                    product: {
                      id: prodGid,
                      status: 'ACTIVE',
                    },
                  },
                ],
              },
            },
          };
        },
      } as any;

      const result = await syncInventoryLevelUpdate(
        shop.id,
        { inventoryItemId: '77001', available: 77 },
        mockClient
      );

      expect(result).not.toBeNull();
      expect(result!.inventoryQuantity).toBe(77);
      expect(result!.inventoryPolicy).toBe('CONTINUE');
      expect(result!.inventoryTracked).toBe(true);

      const dbVariant = await prisma.variantSnapshot.findUnique({
        where: {
          shopId_shopifyVariantId: {
            shopId: shop.id,
            shopifyVariantId: variantGid,
          },
        },
      });
      expect(dbVariant!.inventoryQuantity).toBe(77);
      expect(dbVariant!.inventoryPolicy).toBe('CONTINUE');
    });

    it('safely no-ops when variant is deleted or unlinked on Shopify', async () => {
      const mockClient = {
        request: async () => ({
          inventoryItem: {
            id: 'gid://shopify/InventoryItem/88888',
            tracked: true,
            variants: {
              nodes: [], // Empty nodes
            },
          },
        }),
      } as any;

      const result = await syncInventoryLevelUpdate(
        shop.id,
        { inventoryItemId: '88888', available: 0 },
        mockClient
      );

      expect(result).toBeNull();
    });
  });
});

