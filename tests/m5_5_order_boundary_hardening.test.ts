import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { syncProductSnapshot } from '../src/services/sync.server.js';
import { CatalogSourceType, PriceMode } from '../src/types/index.js';
import { ShopifyAdminClient } from '../src/services/shopify-client.server.js';

describe('Milestone 5.5: Order Boundary Hardening & Concurrency Guarantees', () => {
  let shop: { id: string; shopDomain: string };
  let catalogA: any;
  let clientRequestSpy: any;

  beforeEach(async () => {
    await prisma.syncRun.deleteMany();
    await prisma.orderSubmission.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'hardening-test.myshopify.com',
      accessToken: 'token_hardening_test',
    });

    // Product 1: In Catalog A
    await syncProductSnapshot(shop.id, {
      id: 1001,
      title: 'Authorized Desk',
      vendor: 'WorkPro',
      handle: 'authorized-desk',
      status: 'active',
      variants: [
        {
          id: 2001,
          product_id: 1001,
          title: 'Oak / 60-inch',
          price: '300.00',
          sku: 'DESK-OAK',
          inventory_quantity: 50,
          available: true,
        },
      ],
    });

    // Product 2: In the same shop, but NOT in Catalog A
    await syncProductSnapshot(shop.id, {
      id: 1002,
      title: 'Unauthorized Private Product',
      vendor: 'WorkPro',
      handle: 'unauthorized-private-product',
      status: 'active',
      variants: [
        {
          id: 2002,
          product_id: 1002,
          title: 'Special Item',
          price: '900.00',
          sku: 'UNAUTH-900',
          inventory_quantity: 10,
          available: true,
        },
      ],
    });

    // Create Catalog A with Product 1 only
    catalogA = await createCatalog(shop.id, {
      name: 'Authorized Desks Catalog',
      priceMode: PriceMode.PERCENT_DISCOUNT,
      discountPercent: 10,
      sources: [
        {
          type: CatalogSourceType.PRODUCT,
          shopifyGid: 'gid://shopify/Product/1001',
        },
      ],
    });

    catalogA = await publishCatalog(shop.id, catalogA.id);
  });

  afterEach(() => {
    if (clientRequestSpy) {
      clientRequestSpy.mockRestore();
    }
  });

  // ==========================================
  // 1. IDEMPOTENCY & CONCURRENCY
  // ==========================================

  it('two concurrent same-key submissions → exactly one Shopify Draft Order mutation', async () => {
    let shopifyMutationCount = 0;

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/2001',
              title: 'Oak / 60-inch',
              price: '300.00',
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/1001', title: 'Authorized Desk', status: 'ACTIVE' },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        shopifyMutationCount++;
        // Simulate real-world network latency to test race condition
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/555111',
              name: '#D555',
              totalPrice: '270.00',
              currencyCode: 'USD',
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const payload = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'Concurrent Corp', email: 'concurrent@corp.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    const key = 'concurrent-idem-key-001';

    // Dispatch two requests concurrently
    const [resA, resB] = await Promise.all([
      request(app).post(`/api/public/catalog/${catalogA.publicToken}/submit`).set('Idempotency-Key', key).send(payload),
      request(app).post(`/api/public/catalog/${catalogA.publicToken}/submit`).set('Idempotency-Key', key).send(payload),
    ]);

    // Exactly one Shopify mutation must have been invoked
    expect(shopifyMutationCount).toBe(1);

    // One request must succeed with 201; the concurrent one either receives 409 CONCURRENT_PROCESSING or 201 duplicate
    const statuses = [resA.status, resB.status];
    expect(statuses).toContain(201);
    const non201 = statuses.find((s) => s !== 201);
    if (non201) {
      expect(non201).toBe(409);
    }
  });

  it('Shopify succeeds + local DB update fails → retry reconciles with zero duplicate Draft Orders', async () => {
    let createCallCount = 0;
    let reconcileSearchCallCount = 0;

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string, vars?: any) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/2001',
              title: 'Oak / 60-inch',
              price: '300.00',
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/1001', title: 'Authorized Desk', status: 'ACTIVE' },
            },
          ],
        };
      }
      if (query.includes('findDraftOrderByTag')) {
        reconcileSearchCallCount++;
        return {
          draftOrders: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/DraftOrder/777999',
                  name: '#D777',
                  totalPrice: '270.00',
                  currencyCode: 'USD',
                },
              },
            ],
          },
        };
      }
      if (query.includes('createDraftOrder')) {
        createCallCount++;
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/777999',
              name: '#D777',
              totalPrice: '270.00',
              currencyCode: 'USD',
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const key = 'reconcile-test-key-xyz';
    const payload = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'Reconcile Inc', email: 'reconcile@test.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    // Simulate ambiguous crash: OrderSubmission row exists in 'REQUIRES_RECONCILIATION'
    const keyHash = '380486c99c75bf6e885c3f96e476008b479361ad2cd285cd9336d3ca01f40d49';
    await prisma.orderSubmission.create({
      data: {
        id: 'mock-sub-id-1234',
        shopId: shop.id,
        catalogId: catalogA.id,
        idempotencyKeyHash: keyHash,
        status: 'REQUIRES_RECONCILIATION',
        currency: 'USD',
      },
    });

    // Mock hash to match
    const authModule = await import('../src/services/auth.server.js');
    const hashSpy = vi.spyOn(authModule, 'hashIdempotencyKey').mockReturnValue(keyHash);

    // Call submit with the same key
    const res = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send(payload);

    hashSpy.mockRestore();

    expect(res.status).toBe(201);
    expect(res.body.draftOrderId).toBe('gid://shopify/DraftOrder/777999');
    expect(res.body.draftOrderName).toBe('#D777');
    expect(res.body.isDuplicate).toBe(true);

    // Draft Order creation was NOT called again; Shopify reconciliation was used
    expect(createCallCount).toBe(0);
    expect(reconcileSearchCallCount).toBe(1);
  });

  it('different idempotency keys intentionally create separate Draft Orders', async () => {
    let orderCounter = 100;
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/2001',
              title: 'Oak / 60-inch',
              price: '300.00',
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/1001', title: 'Authorized Desk', status: 'ACTIVE' },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        orderCounter++;
        return {
          draftOrderCreate: {
            draftOrder: {
              id: `gid://shopify/DraftOrder/${orderCounter}`,
              name: `#D${orderCounter}`,
              totalPrice: '270.00',
              currencyCode: 'USD',
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const payload = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'Separate Corp', email: 'orders@separate.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    const res1 = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', 'unique-key-AAA')
      .send(payload);

    const res2 = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', 'unique-key-BBB')
      .send(payload);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.draftOrderId).toBe('gid://shopify/DraftOrder/101');
    expect(res2.body.draftOrderId).toBe('gid://shopify/DraftOrder/102');
  });

  // ==========================================
  // 2. CATALOG AUTHORIZATION
  // ==========================================

  it('should reject same-shop but out-of-catalog variant with 422 INVALID_LINES and zero Shopify mutations', async () => {
    let shopifyCalled = false;
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async () => {
      shopifyCalled = true;
      return {};
    });

    const payload = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'Attacker Corp', email: 'hacker@attacker.com' },
      lines: [
        {
          variantId: 'gid://shopify/ProductVariant/2002', // Out-of-catalog variant!
          quantity: 1,
        },
      ],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', 'unauth-item-test-1')
      .send(payload);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_LINES');
    expect(res.body.details?.invalidVariants).toContain('gid://shopify/ProductVariant/2002');
    expect(shopifyCalled).toBe(false);
  });

  it('should reject mixed valid + invalid cart entirely with zero partial Draft Orders', async () => {
    let shopifyCalled = false;
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async () => {
      shopifyCalled = true;
      return {};
    });

    const payload = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'Attacker Corp', email: 'mixed@attacker.com' },
      lines: [
        {
          variantId: 'gid://shopify/ProductVariant/2001', // Valid
          quantity: 2,
        },
        {
          variantId: 'gid://shopify/ProductVariant/2002', // Invalid
          quantity: 1,
        },
      ],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', 'mixed-cart-test-1')
      .send(payload);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_LINES');
    expect(shopifyCalled).toBe(false);

    // Ensure no OrderSubmission was created
    const count = await prisma.orderSubmission.count({ where: { shopId: shop.id } });
    expect(count).toBe(0);
  });

  // ==========================================
  // 3. CATALOG VERSION (dataVersion)
  // ==========================================

  it('should return 409 CATALOG_CHANGED if submitted dataVersion is stale', async () => {
    let shopifyCalled = false;
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async () => {
      shopifyCalled = true;
      return {};
    });

    const staleVersion = catalogA.dataVersion - 1; // Stale version

    const payload = {
      dataVersion: staleVersion,
      buyer: { businessName: 'Stale Buyer', email: 'stale@buyer.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', 'stale-ver-test-1')
      .send(payload);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATALOG_CHANGED');
    expect(shopifyCalled).toBe(false);
  });

  // ==========================================
  // 4. QUOTA & BILLING CYCLE ROLLOVER
  // ==========================================

  it('should deterministically roll over billing cycle and reset usage after 30 days', async () => {
    // Simulate shop at 50/50 quota limit, with billingCycleAnchor 35 days ago
    const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        billingCycleAnchor: thirtyFiveDaysAgo,
        monthlySubmissionsCount: 50, // Cap reached in previous period
      },
    });

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/2001',
              title: 'Oak / 60-inch',
              price: '300.00',
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/1001', title: 'Authorized Desk', status: 'ACTIVE' },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/888001',
              name: '#D888',
              totalPrice: '270.00',
              currencyCode: 'USD',
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const payload = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'New Cycle Buyer', email: 'cycle@buyer.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    // Submit order -> should trigger billing rollover and succeed
    const res = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', 'cycle-rollover-test-1')
      .send(payload);

    expect(res.status).toBe(201);

    // Verify shop count was reset and now equals 1
    const updatedShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(updatedShop?.monthlySubmissionsCount).toBe(1);
    expect(updatedShop?.billingCycleAnchor.getTime()).toBeGreaterThan(thirtyFiveDaysAgo.getTime());
  });

  it('49/50 quota + two concurrent distinct submissions → exactly one succeeds, one gets 403', async () => {
    // Set usage to 49 on Starter plan (limit 50)
    await prisma.shop.update({
      where: { id: shop.id },
      data: { monthlySubmissionsCount: 49 },
    });

    let shopifyOrderCount = 0;
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/2001',
              title: 'Oak / 60-inch',
              price: '300.00',
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/1001', title: 'Authorized Desk', status: 'ACTIVE' },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        shopifyOrderCount++;
        await new Promise((r) => setTimeout(r, 40));
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/999111',
              name: '#D999',
              totalPrice: '270.00',
              currencyCode: 'USD',
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const payloadA = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'Buyer A', email: 'a@buyer.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    const payloadB = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'Buyer B', email: 'b@buyer.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    // Dispatch 2 distinct submissions simultaneously
    const [resA, resB] = await Promise.all([
      request(app).post(`/api/public/catalog/${catalogA.publicToken}/submit`).set('Idempotency-Key', 'quota-race-A').send(payloadA),
      request(app).post(`/api/public/catalog/${catalogA.publicToken}/submit`).set('Idempotency-Key', 'quota-race-B').send(payloadB),
    ]);

    const statuses = [resA.status, resB.status];
    expect(statuses).toContain(201);
    expect(statuses).toContain(403);
    expect(shopifyOrderCount).toBe(1);

    const finalShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(finalShop?.monthlySubmissionsCount).toBe(50);
  });

  it('failed-before-side-effect attempt releases reserved quota slot', async () => {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { monthlySubmissionsCount: 10 },
    });

    // Mock live Shopify query to report price change (triggers 409 before draftOrderCreate)
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/2001',
              title: 'Oak / 60-inch',
              price: '400.00', // Changed from 300 to 400!
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/1001', title: 'Authorized Desk', status: 'ACTIVE' },
            },
          ],
        };
      }
      return {};
    });

    const payload = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'Price Check Buyer', email: 'pc@buyer.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', 'fail-slot-release-test')
      .send(payload);

    expect(res.status).toBe(409);

    // Verify monthly count was NOT permanently incremented
    const finalShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(finalShop?.monthlySubmissionsCount).toBe(10);
  });

  // ==========================================
  // 5. MANUAL SYNC DEDUPLICATION
  // ==========================================

  it('concurrent manual sync trigger does not create duplicate SyncRuns', async () => {
    // Trigger first manual sync
    const res1 = await request(app)
      .post('/api/admin/sync/trigger')
      .set('X-Shop-Domain', shop.shopDomain);

    expect(res1.status).toBe(200);
    expect(res1.body.success).toBe(true);

    // Second click while sync is active should be rejected with 409 SYNC_IN_PROGRESS
    const res2 = await request(app)
      .post('/api/admin/sync/trigger')
      .set('X-Shop-Domain', shop.shopDomain);

    expect(res2.status).toBe(409);
    expect(res2.body.code).toBe('SYNC_IN_PROGRESS');
  });

  // ==========================================
  // 6. PRIVACY & METADATA
  // ==========================================

  it('Draft Order input strictly excludes publicToken and raw idempotency key', async () => {
    let capturedInput: any = null;

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string, vars?: any) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/2001',
              title: 'Oak / 60-inch',
              price: '300.00',
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/1001', title: 'Authorized Desk', status: 'ACTIVE' },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        capturedInput = vars?.input;
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/123999',
              name: '#D123',
              totalPrice: '270.00',
              currencyCode: 'USD',
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const rawKey = 'super-secret-client-idempotency-key-777';
    const payload = {
      dataVersion: catalogA.dataVersion,
      buyer: {
        businessName: 'Privacy Advocates Inc',
        email: 'privacy@advocates.org',
        poNumber: 'PO-PRIV-1',
        note: 'Handle with care',
      },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', rawKey)
      .send(payload);

    expect(res.status).toBe(201);
    expect(capturedInput).toBeDefined();

    const attrString = JSON.stringify(capturedInput.customAttributes);
    const tagsString = JSON.stringify(capturedInput.tags);

    // Verify publicToken is NOT in customAttributes or tags
    expect(attrString).not.toContain(catalogA.publicToken);
    expect(tagsString).not.toContain(catalogA.publicToken);

    // Verify raw key is NOT in customAttributes or tags
    expect(attrString).not.toContain(rawKey);
    expect(tagsString).not.toContain(rawKey);

    // Verify OrderSubmission does not store raw email or note
    const submissionInDb = await prisma.orderSubmission.findFirst({
      where: { draftOrderId: 'gid://shopify/DraftOrder/123999' },
    });
    const dbString = JSON.stringify(submissionInDb);
    expect(dbString).not.toContain('privacy@advocates.org');
    expect(dbString).not.toContain('Handle with care');
  });
});
