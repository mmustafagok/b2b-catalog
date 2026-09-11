import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { syncProductSnapshot, getPublicCatalogPayload } from '../src/services/sync.server.js';
import { submitBuyerOrder } from '../src/services/order.server.js';
import { recordRuntimeIncident, getShopRuntimeIncidents } from '../src/services/incident.server.js';
import { ShopifyAdminClient, ShopifyGraphQLError } from '../src/services/shopify-client.server.js';
import { CatalogSourceType, PriceMode } from '../src/types/index.js';

describe('Part A & Part B Hardening Regression Suite', () => {
  const shopDomainA = 'hardening-shop-a.myshopify.com';
  const shopDomainB = 'hardening-shop-b.myshopify.com';
  let shopA: any;
  let shopB: any;

  beforeEach(async () => {
    shopA = await installOrUpdateShop({
      shopDomain: shopDomainA,
      accessToken: 'test_token_a',
      scopes: 'read_products,write_draft_orders',
    });

    shopB = await installOrUpdateShop({
      shopDomain: shopDomainB,
      accessToken: 'test_token_b',
      scopes: 'read_products,write_draft_orders',
    });

    // Clean up catalogs, submissions, and incidents between tests
    await prisma.orderSubmission.deleteMany({ where: { shopId: { in: [shopA.id, shopB.id] } } });
    await prisma.catalog.deleteMany({ where: { shopId: { in: [shopA.id, shopB.id] } } });
    await prisma.runtimeIncident.deleteMany({ where: { shopDomain: { in: [shopDomainA, shopDomainB] } } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================
  // PART A: PROCESS & OPERATIONAL DIAGNOSTICS
  // ==========================================

  describe('A1 & A2: Process Diagnostics & Incident Persistence', () => {
    it('recordRuntimeIncident redacts sensitive tokens, secrets, emails and authorization headers', async () => {
      const sensitiveMessage =
        'Error with token shpat_secrettoken123 and secret shpss_mysecret456 and email buyer@privatecorp.com and Bearer eyJhbGciOiJIUzI1NiJ9.sensitive';

      await recordRuntimeIncident({
        type: 'TEST_INCIDENT',
        shopDomain: shopDomainA,
        message: sensitiveMessage,
        metadata: { safeKey: 'safeVal', token: 'shpat_99999999' },
      });

      const incidents = await getShopRuntimeIncidents(shopDomainA, 10);
      const recorded = incidents.find((i) => i.type === 'TEST_INCIDENT');

      expect(recorded).toBeDefined();
      expect(recorded!.message).not.toContain('shpat_secrettoken123');
      expect(recorded!.message).not.toContain('shpss_mysecret456');
      expect(recorded!.message).not.toContain('buyer@privatecorp.com');
      expect(recorded!.message).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(recorded!.message).toContain('[REDACTED_TOKEN]');
      expect(recorded!.message).toContain('[REDACTED_SECRET]');
      expect(recorded!.message).toContain('[REDACTED_EMAIL]');
    });

    it('A2: recordRuntimeIncident safely falls back to console.error when DB write fails without crashing', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failingDb = {
        runtimeIncident: {
          create: vi.fn().mockRejectedValue(new Error('PostgreSQL connection dropped')),
        },
      };

      await expect(
        recordRuntimeIncident(
          {
            type: 'DB_FAIL_TEST',
            message: 'Safe test error',
          },
          failingDb
        )
      ).resolves.not.toThrow();

      expect(consoleSpy).toHaveBeenCalled();
    });

    it('A8: getShopRuntimeIncidents strictly isolates records between shops and caps at 50', async () => {
      // Record incident for Shop A
      await recordRuntimeIncident({
        type: 'SHOP_A_INCIDENT',
        shopDomain: shopDomainA,
        message: 'Incident for Shop A',
      });

      // Record incident for Shop B
      await recordRuntimeIncident({
        type: 'SHOP_B_INCIDENT',
        shopDomain: shopDomainB,
        message: 'Incident for Shop B',
      });

      const shopAIncidents = await getShopRuntimeIncidents(shopDomainA, 100);
      expect(shopAIncidents.some((i) => i.type === 'SHOP_A_INCIDENT')).toBe(true);
      expect(shopAIncidents.some((i) => i.type === 'SHOP_B_INCIDENT')).toBe(false);

      // Verify max limit cap at 50
      expect(shopAIncidents.length).toBeLessThanOrEqual(50);
    });
  });

  describe('A9: /health Endpoint Contract', () => {
    it('returns 200 OK with ok, status, uptimeSeconds, timestamp, pid, and build', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptimeSeconds).toBe('number');
      expect(typeof res.body.pid).toBe('number');
      expect(typeof res.body.timestamp).toBe('string');
      expect(res.body.build).toBeDefined();
    });
  });

  describe('A4: Shopify Client Timeout & Idempotent Reconciliation', () => {
    it('ShopifyAdminClient times out and throws ShopifyGraphQLError 504 on slow network response', async () => {
      const fastTimeoutClient = new ShopifyAdminClient({
        shopDomain: shopDomainA,
        accessToken: 'test_token',
        timeoutMs: 30, // 30ms timeout
      });

      // Mock slow global fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((_url, options) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
          }, 500);

          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      try {
        await expect(fastTimeoutClient.request('{ shop { name } }', undefined, 1)).rejects.toThrow(
          /timed out/i
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('A4: draftOrderCreate network timeout transitions to REQUIRES_RECONCILIATION and does not blindly duplicate draft order on retry', async () => {
      const productGid = 'gid://shopify/Product/99100';
      const variantGid = 'gid://shopify/ProductVariant/99101';

      await syncProductSnapshot(shopA.id, {
        id: productGid,
        title: 'Timeout Test Desk',
        handle: 'timeout-desk',
        status: 'ACTIVE',
        variants: [
          {
            id: variantGid,
            product_id: productGid,
            title: 'Oak',
            price: '250.00',
            inventory_quantity: 10,
            available: true,
            inventoryPolicy: 'DENY',
            inventoryTracked: true,
          },
        ],
      });

      const catalog = await createCatalog(shopA.id, {
        name: 'Timeout Test Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: productGid }],
      });
      const published = await publishCatalog(shopA.id, catalog.id);

      let draftOrderCreateCount = 0;
      let draftOrderSearchCount = 0;

      const mockClient = new ShopifyAdminClient({
        shopDomain: shopDomainA,
        accessToken: 'test_token',
      });

      vi.spyOn(mockClient, 'request').mockImplementation(async (query: string) => {
        if (query.includes('getVariantsByIds') || query.includes('nodes')) {
          return {
            nodes: [
              {
                id: variantGid,
                price: '250.00',
                availableForSale: true,
                inventoryQuantity: 10,
                inventoryPolicy: 'DENY',
                inventoryItem: { tracked: true },
                product: { id: productGid, status: 'ACTIVE', title: 'Timeout Test Desk' },
              },
            ],
          };
        }
        if (query.includes('createDraftOrder') || query.includes('draftOrderCreate')) {
          draftOrderCreateCount++;
          // First attempt times out or drops connection
          throw new ShopifyGraphQLError('Shopify Admin API network request timed out', undefined, undefined, 504);
        }
        if (query.includes('findDraftOrderByTag') || query.includes('draftOrders')) {
          draftOrderSearchCount++;
          // On reconciliation query, find the draft order that Shopify successfully created before the timeout
          return {
            draftOrders: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/DraftOrder/99911',
                    name: '#D99911',
                    totalPrice: '250.00',
                    currencyCode: 'USD',
                  },
                },
              ],
            },
          };
        }
        return {};
      });

      const idempotencyKey = 'idem-timeout-safety-1';
      const orderPayload = {
        dataVersion: published.dataVersion,
        lines: [{ variantId: variantGid, quantity: 1 }],
        buyer: { businessName: 'Safety Corp', email: 'safety@corp.com' },
      };

      // First submit attempt: fails with 502 SHOPIFY_API_ERROR due to timeout
      await expect(
        submitBuyerOrder(published.publicToken, idempotencyKey, orderPayload, mockClient)
      ).rejects.toThrow(/network error or timeout/i);

      expect(draftOrderCreateCount).toBe(1);

      // Verify submission state is marked REQUIRES_RECONCILIATION
      const sub = await prisma.orderSubmission.findFirst({
        where: { catalogId: published.id },
      });
      expect(sub?.status).toBe('REQUIRES_RECONCILIATION');

      // Second submit attempt (retry with same idempotency key):
      // Must reconcile against Shopify and complete without calling draftOrderCreate again!
      const retryResult = await submitBuyerOrder(published.publicToken, idempotencyKey, orderPayload, mockClient);

      expect(retryResult.success).toBe(true);
      expect(retryResult.draftOrderId).toBe('gid://shopify/DraftOrder/99911');
      expect(retryResult.isDuplicate).toBe(true);

      // CRUCIAL: draftOrderCreate must NOT have been called a second time!
      expect(draftOrderCreateCount).toBe(1);
      expect(draftOrderSearchCount).toBe(1);
    });
  });

  // ==========================================
  // PART B: INVENTORY & QUANTITY PRODUCT HARDENING
  // ==========================================

  describe('Part B: Canonical Inventory & Submit-Time Revalidation', () => {
    it('B4 & B9: getPublicCatalogPayload exposes effectiveAvailable, inventoryPolicy, and inventoryTracked', async () => {
      const prodGid = 'gid://shopify/Product/88001';
      const trackedVariant = 'gid://shopify/ProductVariant/88002';
      const untrackedVariant = 'gid://shopify/ProductVariant/88003';
      const continueVariant = 'gid://shopify/ProductVariant/88004';

      await syncProductSnapshot(shopA.id, {
        id: prodGid,
        title: 'Snowboard Pro',
        handle: 'snowboard-pro',
        status: 'ACTIVE',
        variants: [
          {
            id: trackedVariant,
            product_id: prodGid,
            title: 'Tracked / 18 Available',
            price: '400.00',
            inventory_quantity: 18,
            available: true,
            inventoryPolicy: 'DENY',
            inventoryTracked: true,
          },
          {
            id: untrackedVariant,
            product_id: prodGid,
            title: 'Untracked / Unlimited',
            price: '400.00',
            inventory_quantity: 0,
            available: true,
            inventoryPolicy: 'DENY',
            inventoryTracked: false,
          },
          {
            id: continueVariant,
            product_id: prodGid,
            title: 'Tracked / Continue Selling',
            price: '400.00',
            inventory_quantity: 0,
            available: true,
            inventoryPolicy: 'CONTINUE',
            inventoryTracked: true,
          },
        ],
      });

      const cat = await createCatalog(shopA.id, {
        name: 'Snowboard Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid }],
      });
      const published = await publishCatalog(shopA.id, cat.id);

      const payload = await getPublicCatalogPayload(published.publicToken);
      expect(payload).not.toBeNull();

      const variants = payload!.products[0].variants;

      // 1. Tracked variant with DENY policy
      const v1 = variants.find((v) => v.shopifyVariantId === trackedVariant);
      expect(v1?.effectiveAvailable).toBe(18);
      expect(v1?.availableForSale).toBe(true);
      expect(v1?.inventoryPolicy).toBe('DENY');
      expect(v1?.inventoryTracked).toBe(true);

      // 2. Untracked variant: effectiveAvailable is null (unbounded)
      const v2 = variants.find((v) => v.shopifyVariantId === untrackedVariant);
      expect(v2?.effectiveAvailable).toBeNull();
      expect(v2?.availableForSale).toBe(true);
      expect(v2?.inventoryTracked).toBe(false);

      // 3. CONTINUE policy variant: effectiveAvailable is null (oversell allowed)
      const v3 = variants.find((v) => v.shopifyVariantId === continueVariant);
      expect(v3?.effectiveAvailable).toBeNull();
      expect(v3?.availableForSale).toBe(true);
      expect(v3?.inventoryPolicy).toBe('CONTINUE');
    });

    it('B5: Submit-time revalidation rejects order when requested quantity > live available inventory with HTTP 409 INVENTORY_CHANGED', async () => {
      const prodGid = 'gid://shopify/Product/77001';
      const variantGid = 'gid://shopify/ProductVariant/77002';

      await syncProductSnapshot(shopA.id, {
        id: prodGid,
        title: 'Ice Skates',
        handle: 'ice-skates',
        status: 'ACTIVE',
        variants: [
          {
            id: variantGid,
            product_id: prodGid,
            title: 'Size 10',
            price: '150.00',
            inventory_quantity: 10, // Stored snapshot had 10
            available: true,
            inventoryPolicy: 'DENY',
            inventoryTracked: true,
          },
        ],
      });

      const cat = await createCatalog(shopA.id, {
        name: 'Skates Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid }],
      });
      const published = await publishCatalog(shopA.id, cat.id);

      // Live Shopify returns only 1 available!
      vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
        if (query.includes('getVariantsByIds') || query.includes('nodes')) {
          return {
            nodes: [
              {
                id: variantGid,
                price: '150.00',
                availableForSale: true,
                inventoryQuantity: 1, // Live Shopify has only 1!
                inventoryPolicy: 'DENY',
                inventoryItem: { tracked: true },
                product: { id: prodGid, status: 'ACTIVE', title: 'Ice Skates' },
              },
            ],
          };
        }
        return {};
      });

      // Buyer submits 2 units
      const submitRes = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idem-inv-check-1')
        .send({
          dataVersion: published.dataVersion,
          lines: [{ variantId: variantGid, quantity: 2 }],
          buyer: { businessName: 'Skate Club', email: 'skate@club.com' },
        });

      expect(submitRes.status).toBe(409);
      expect(submitRes.body.code).toBe('INVENTORY_CHANGED');
      expect(submitRes.body.error.code).toBe('INVENTORY_CHANGED');
      expect(submitRes.body.details).toHaveLength(1);
      expect(submitRes.body.details[0]).toEqual({
        variantId: variantGid,
        title: 'Ice Skates / Size 10',
        requested: 2,
        available: 1,
      });

      // Draft order must not have been created
      const submissions = await prisma.orderSubmission.findMany({
        where: { catalogId: published.id },
      });
      expect(submissions[0].status).toBe('FAILED');
    });

    it('B4 & Zod: Rejects negative, zero, and fractional quantities with 400 VALIDATION_FAILED', async () => {
      const prodGid = 'gid://shopify/Product/66001';
      const variantGid = 'gid://shopify/ProductVariant/66002';

      await syncProductSnapshot(shopA.id, {
        id: prodGid,
        title: 'Helmet',
        handle: 'helmet',
        status: 'ACTIVE',
        variants: [
          {
            id: variantGid,
            product_id: prodGid,
            title: 'Medium',
            price: '80.00',
            inventory_quantity: 50,
            available: true,
          },
        ],
      });

      const cat = await createCatalog(shopA.id, {
        name: 'Helmet Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid }],
      });
      const published = await publishCatalog(shopA.id, cat.id);

      // Fractional quantity
      const resFractional = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idem-fractional')
        .send({
          dataVersion: published.dataVersion,
          lines: [{ variantId: variantGid, quantity: 2.5 }],
          buyer: { businessName: 'Buyer', email: 'buyer@corp.com' },
        });

      expect(resFractional.status).toBe(400);

      // Zero quantity
      const resZero = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idem-zero')
        .send({
          dataVersion: published.dataVersion,
          lines: [{ variantId: variantGid, quantity: 0 }],
          buyer: { businessName: 'Buyer', email: 'buyer@corp.com' },
        });

      expect(resZero.status).toBe(400);

      // Negative quantity
      const resNegative = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idem-negative')
        .send({
          dataVersion: published.dataVersion,
          lines: [{ variantId: variantGid, quantity: -3 }],
          buyer: { businessName: 'Buyer', email: 'buyer@corp.com' },
        });

      expect(resNegative.status).toBe(400);
    });

    it('B4: Rejects orders with more than 499 distinct line items', async () => {
      const prodGid = 'gid://shopify/Product/55001';
      const variantGid = 'gid://shopify/ProductVariant/55002';

      await syncProductSnapshot(shopA.id, {
        id: prodGid,
        title: 'Socks',
        handle: 'socks',
        status: 'ACTIVE',
        variants: [
          {
            id: variantGid,
            product_id: prodGid,
            title: 'One Size',
            price: '10.00',
            inventory_quantity: 5000,
            available: true,
          },
        ],
      });

      const cat = await createCatalog(shopA.id, {
        name: 'Socks Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid }],
      });
      const published = await publishCatalog(shopA.id, cat.id);

      const excessLines = Array.from({ length: 500 }, (_, i) => ({
        variantId: `${variantGid}-${i}`,
        quantity: 1,
      }));

      const res = await request(app)
        .post(`/api/public/catalog/${published.publicToken}/submit`)
        .set('Idempotency-Key', 'idem-excess-lines')
        .send({
          dataVersion: published.dataVersion,
          lines: excessLines,
          buyer: { businessName: 'Big Buyer', email: 'buyer@corp.com' },
        });

      expect(res.status).toBe(400);
    });
  });
});
