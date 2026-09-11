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
  let shop: { id: string; shopDomain: string; billingCycleAnchor: Date };
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

  // ==========================================
  // 7. M5.6 CORRECTNESS & REGRESSION TESTS
  // ==========================================

  it('e2e submit flow: timeout after draftOrderCreate side effect sets REQUIRES_RECONCILIATION, keeps quota, and retry reconciles exactly once', async () => {
    // Initial usage 48 / 50
    await prisma.shop.update({
      where: { id: shop.id },
      data: { monthlySubmissionsCount: 48 },
    });

    let draftOrderCreatedInShopify: any = null;
    let createDraftOrderCalls = 0;
    let reconcileSearchCalls = 0;

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
        createDraftOrderCalls++;
        // Simulate side effect in Shopify: draft order is created with correlation tag from vars
        const tags = vars?.input?.tags || [];
        const correlationTag = tags.find((t: string) => t.startsWith('cf-sub:'));
        draftOrderCreatedInShopify = {
          id: 'gid://shopify/DraftOrder/timeout-888',
          name: '#D-TIMEOUT',
          totalPrice: '270.00',
          currencyCode: 'USD',
          tags,
          correlationTag,
        };
        // Transport failure / timeout happens right after Shopify creates the record
        throw new Error('ETIMEDOUT: Connection timed out while awaiting Shopify response');
      }
      if (query.includes('findDraftOrderByTag')) {
        reconcileSearchCalls++;
        const searchTag = vars?.query?.replace(/^tag:/, '');
        if (draftOrderCreatedInShopify && draftOrderCreatedInShopify.correlationTag === searchTag) {
          return {
            draftOrders: {
              edges: [{ node: draftOrderCreatedInShopify }],
            },
          };
        }
        return { draftOrders: { edges: [] } };
      }
      return {};
    });

    const key = 'timeout-regression-key-1';
    const payload = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'Timeout Buyer', email: 'timeout@buyer.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    // Attempt 1: Should fail with 502 SHOPIFY_API_ERROR due to timeout
    const res1 = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res1.status).toBe(502);
    expect(res1.body.code).toBe('SHOPIFY_API_ERROR');
    expect(createDraftOrderCalls).toBe(1);

    // State inspection: OrderSubmission must be in REQUIRES_RECONCILIATION
    const keyHash = (await import('../src/services/auth.server.js')).hashIdempotencyKey(catalogA.id, key);
    const subAttempt1 = await prisma.orderSubmission.findUnique({
      where: {
        catalogId_idempotencyKeyHash: {
          catalogId: catalogA.id,
          idempotencyKeyHash: keyHash,
        },
      },
    });
    expect(subAttempt1?.status).toBe('REQUIRES_RECONCILIATION');
    expect(subAttempt1?.correlationRef).toBe(draftOrderCreatedInShopify.correlationTag);

    // Quota remains reserved: count must still be 49 (not released!)
    const shopAfterAttempt1 = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopAfterAttempt1?.monthlySubmissionsCount).toBe(49);

    // Attempt 2 (Retry with same idempotency key):
    const res2 = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.body.draftOrderId).toBe('gid://shopify/DraftOrder/timeout-888');
    expect(res2.body.draftOrderName).toBe('#D-TIMEOUT');
    expect(res2.body.isDuplicate).toBe(true);

    // createDraftOrder call count MUST remain exactly 1!
    expect(createDraftOrderCalls).toBe(1);
    expect(reconcileSearchCalls).toBe(1);

    // Final DB state: COMPLETED
    const subAttempt2 = await prisma.orderSubmission.findUnique({
      where: {
        catalogId_idempotencyKeyHash: {
          catalogId: catalogA.id,
          idempotencyKeyHash: keyHash,
        },
      },
    });
    expect(subAttempt2?.status).toBe('COMPLETED');
    expect(subAttempt2?.draftOrderId).toBe('gid://shopify/DraftOrder/timeout-888');

    // Final quota remains 49 (exactly 1 slot consumed)
    const finalShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(finalShop?.monthlySubmissionsCount).toBe(49);
  });

  it('FAILED retry lifecycle A: 49/50 -> reserves 50 -> conclusive Shopify rejection releases to 49 -> same key retry reserves 50 and completes -> final usage 50', async () => {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { monthlySubmissionsCount: 49 },
    });

    let attemptCount = 0;
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
        attemptCount++;
        if (attemptCount === 1) {
          // Conclusive rejection
          return {
            draftOrderCreate: {
              draftOrder: null,
              userErrors: [{ field: ['lineItems'], message: 'Inventory unavailable for variant' }],
            },
          };
        }
        // Attempt 2 succeeds
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/retry-success-1',
              name: '#D-RETRY',
              totalPrice: '270.00',
              currencyCode: 'USD',
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const key = 'failed-retry-quota-key-A';
    const payload = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'Retry Buyer A', email: 'retryA@test.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    // Attempt 1: Conclusive rejection -> status 422
    const res1 = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res1.status).toBe(422);

    // Slot was released -> usage returned to 49
    let shopRecord = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopRecord?.monthlySubmissionsCount).toBe(49);

    // Attempt 2: Retry with SAME key
    const res2 = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.body.draftOrderId).toBe('gid://shopify/DraftOrder/retry-success-1');

    // Final usage = 50!
    shopRecord = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopRecord?.monthlySubmissionsCount).toBe(50);
  });

  it('FAILED retry lifecycle B: usage becomes 50 due to another order -> same FAILED key retries -> cannot reserve -> 403 QUOTA_EXCEEDED -> no Shopify mutation', async () => {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { monthlySubmissionsCount: 49 },
    });

    let draftCreateCalled = false;
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
        draftCreateCalled = true;
        // First attempt fails conclusively
        return {
          draftOrderCreate: {
            draftOrder: null,
            userErrors: [{ field: ['lineItems'], message: 'Initial error' }],
          },
        };
      }
      return {};
    });

    const key = 'failed-retry-quota-key-B';
    const payload = {
      dataVersion: catalogA.dataVersion,
      buyer: { businessName: 'Retry Buyer B', email: 'retryB@test.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
    };

    // Attempt 1 fails conclusively -> slot released -> usage is 49
    const res1 = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res1.status).toBe(422);

    // Another successful order occupies the last slot -> usage becomes 50
    await prisma.shop.update({
      where: { id: shop.id },
      data: { monthlySubmissionsCount: 50 },
    });

    // Reset spy flag to observe retry
    draftCreateCalled = false;

    // Attempt 2: Same FAILED key retries
    const res2 = await request(app)
      .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res2.status).toBe(403);
    expect(res2.body.code).toBe('QUOTA_EXCEEDED');

    // Shopify mutation MUST NOT be called!
    expect(draftCreateCalled).toBe(false);

    // Usage remains 50
    const shopRecord = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopRecord?.monthlySubmissionsCount).toBe(50);
  });

  it('billing cycle rollover CAS: multiple concurrent reservations on expired boundary -> exactly one reset and accurate final count', async () => {
    // Set shop billingCycleAnchor to 35 days ago (expired) and monthlySubmissionsCount to 50 (at limit)
    const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        billingCycleAnchor: thirtyFiveDaysAgo,
        monthlySubmissionsCount: 50,
      },
    });

    const { reserveSubmissionQuotaSlot } = await import('../src/services/shop.server.js');

    // Run 5 concurrent reservation attempts simultaneously
    const results = await Promise.all([
      reserveSubmissionQuotaSlot(shop.id, 50),
      reserveSubmissionQuotaSlot(shop.id, 50),
      reserveSubmissionQuotaSlot(shop.id, 50),
      reserveSubmissionQuotaSlot(shop.id, 50),
      reserveSubmissionQuotaSlot(shop.id, 50),
    ]);

    // All 5 should have succeeded because cycle was rolled over to 0, then 5 slots were reserved
    expect(results).toEqual([true, true, true, true, true]);

    // Final count must be exactly 5
    const updatedShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(updatedShop?.monthlySubmissionsCount).toBe(5);
    expect(updatedShop?.billingCycleAnchor.getTime()).toBeGreaterThan(thirtyFiveDaysAgo.getTime());
  });

  it('manual sync trigger produces exactly one SyncRun of type MANUAL, zero nested INITIAL runs, and leaves initialSyncAt intact', async () => {
    const { triggerManualShopSync } = await import('../src/services/sync.server.js');

    // Mock client for sync
    const mockClient = {
      request: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes('shop { currencyCode }')) {
          return { shop: { currencyCode: 'USD' } };
        }
        if (query.includes('getCollections')) {
          return { collections: { edges: [], pageInfo: { hasNextPage: false } } };
        }
        if (query.includes('getProducts')) {
          return { products: { edges: [], pageInfo: { hasNextPage: false } } };
        }
        return {};
      }),
    } as any;

    const initialShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(initialShop?.initialSyncAt).toBeNull();

    // Trigger manual sync
    const { syncRunId, promise } = await triggerManualShopSync(shop.id, mockClient);
    expect(syncRunId).toBeDefined();

    // Wait for the sync to complete
    await promise;

    // Check all SyncRuns in DB for this shop
    const allRuns = await prisma.syncRun.findMany({ where: { shopId: shop.id } });
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0].id).toBe(syncRunId);
    expect(allRuns[0].type).toBe('MANUAL');
    expect(allRuns[0].status).toBe('COMPLETED');

    // Zero nested INITIAL runs exist
    const initialRuns = allRuns.filter((r) => r.type === 'INITIAL');
    expect(initialRuns).toHaveLength(0);

    // initialSyncAt must remain null (not altered by manual sync)
    const updatedShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(updatedShop?.initialSyncAt).toBeNull();
  });

  // ==========================================
  // 6. M5.7 RECONCILIATION, PROCESSING LEASE & QUOTA PERIOD REGRESSIONS
  // ==========================================

  describe('M5.7 Reconciliation, Processing Lease & Quota Period Correctness', () => {
    it('1. reconciliation search empty -> RECONCILIATION_PENDING (no second mutation call)', async () => {
      const { hashIdempotencyKey } = await import('../src/services/auth.server.js');
      let draftOrderCreateCalls = 0;
      let findDraftCalls = 0;

      const key = 'test-rec-no-fallthrough-key';
      const keyHash = hashIdempotencyKey(catalogA.id, key);

      // Create a submission in REQUIRES_RECONCILIATION state
      const existingSubmission = await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: catalogA.id,
          idempotencyKeyHash: keyHash,
          status: 'REQUIRES_RECONCILIATION',
          correlationRef: 'cf-sub:rec-test-1',
          quotaReserved: true,
          quotaCycleAnchor: shop.billingCycleAnchor,
        },
      });

      clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
        if (query.includes('findDraftOrderByTag')) {
          findDraftCalls++;
          // Empty search response (draft order not yet indexed)
          return { draftOrders: { edges: [] } };
        }
        if (query.includes('createDraftOrder')) {
          draftOrderCreateCalls++;
          return {
            draftOrderCreate: {
              draftOrder: { id: 'gid://shopify/DraftOrder/9999', name: '#D9999', totalPrice: '300.00', currencyCode: 'USD' },
              userErrors: [],
            },
          };
        }
        return {};
      });

      const payload = {
        dataVersion: catalogA.dataVersion,
        buyer: { businessName: 'Recon Buyer', email: 'recon@buyer.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
      };

      // Attempt retry with same idempotency key
      const res = await request(app)
        .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
        .set('Idempotency-Key', key)
        .send(payload);

      // Must return 409 RECONCILIATION_PENDING
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RECONCILIATION_PENDING');
      expect(res.body.error?.message || res.body.error).toContain('still confirming the previous order attempt');

      // Crucial: draftOrderCreate MUST NOT have been called!
      expect(findDraftCalls).toBe(1);
      expect(draftOrderCreateCalls).toBe(0);

      // Submission status must REMAIN REQUIRES_RECONCILIATION
      const subCheck = await prisma.orderSubmission.findUnique({ where: { id: existingSubmission.id } });
      expect(subCheck?.status).toBe('REQUIRES_RECONCILIATION');
      expect(subCheck?.quotaReserved).toBe(true);
    });

    it('2. reconciliation eventually finds original draft -> completes without draftOrderCreate call', async () => {
      const { hashIdempotencyKey } = await import('../src/services/auth.server.js');
      let draftOrderCreateCalls = 0;
      let findDraftCalls = 0;

      const key = 'test-rec-finds-original-key';
      const keyHash = hashIdempotencyKey(catalogA.id, key);

      const existingSubmission = await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: catalogA.id,
          idempotencyKeyHash: keyHash,
          status: 'REQUIRES_RECONCILIATION',
          correlationRef: 'cf-sub:rec-test-2',
          quotaReserved: true,
          quotaCycleAnchor: shop.billingCycleAnchor,
        },
      });

      clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
        if (query.includes('findDraftOrderByTag')) {
          findDraftCalls++;
          return {
            draftOrders: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/DraftOrder/7777',
                    name: '#D7777',
                    totalPrice: '300.00',
                    currencyCode: 'USD',
                  },
                },
              ],
            },
          };
        }
        if (query.includes('createDraftOrder')) {
          draftOrderCreateCalls++;
          return {};
        }
        return {};
      });

      const payload = {
        dataVersion: catalogA.dataVersion,
        buyer: { businessName: 'Recon Buyer', email: 'recon@buyer.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
      };

      const res = await request(app)
        .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
        .set('Idempotency-Key', key)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.draftOrderId).toBe('gid://shopify/DraftOrder/7777');
      expect(res.body.isDuplicate).toBe(true);

      // draftOrderCreate call count remains 0!
      expect(findDraftCalls).toBe(1);
      expect(draftOrderCreateCalls).toBe(0);

      // Submission status transitions to COMPLETED
      const subCheck = await prisma.orderSubmission.findUnique({ where: { id: existingSubmission.id } });
      expect(subCheck?.status).toBe('COMPLETED');
      expect(subCheck?.draftOrderId).toBe('gid://shopify/DraftOrder/7777');
      expect(subCheck?.quotaReserved).toBe(true);
      expect(subCheck?.processingStartedAt).toBeNull();
    });

    it('3. FAILED createdAt > 60s + fresh processingStartedAt -> concurrent retry blocked with 409 CONCURRENT_PROCESSING', async () => {
      const { hashIdempotencyKey } = await import('../src/services/auth.server.js');
      const key = 'test-lease-failed-concur-key';
      const keyHash = hashIdempotencyKey(catalogA.id, key);

      // Create a submission that failed 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const sub = await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: catalogA.id,
          idempotencyKeyHash: keyHash,
          status: 'FAILED',
          createdAt: twoHoursAgo,
          quotaReserved: false,
        },
      });

      // Retry A transitions FAILED -> CREATING with fresh processingStartedAt = now
      const now = new Date();
      await prisma.orderSubmission.update({
        where: { id: sub.id },
        data: {
          status: 'CREATING',
          processingStartedAt: now,
          quotaReserved: true,
          quotaCycleAnchor: shop.billingCycleAnchor,
        },
      });

      // Before A completes, Retry B arrives with same idempotency key
      const payload = {
        dataVersion: catalogA.dataVersion,
        buyer: { businessName: 'Concurrent Buyer', email: 'concur@buyer.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
      };

      let shopifyCalls = 0;
      clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async () => {
        shopifyCalls++;
        return {};
      });

      const res = await request(app)
        .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
        .set('Idempotency-Key', key)
        .send(payload);

      // Retry B MUST receive 409 CONCURRENT_PROCESSING (not assume stale based on createdAt > 60s!)
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONCURRENT_PROCESSING');
      // Retry B must NOT reconcile and must NOT call Shopify
      expect(shopifyCalls).toBe(0);
    });

    it('4. processing lease uses processingStartedAt, not createdAt: stale lease triggers reconciliation', async () => {
      const { hashIdempotencyKey } = await import('../src/services/auth.server.js');
      const key = 'test-lease-stale-key';
      const keyHash = hashIdempotencyKey(catalogA.id, key);

      // Created recently (e.g. 5 seconds ago), but processingStartedAt is 90 seconds ago (stale)
      const ninetySecondsAgo = new Date(Date.now() - 90 * 1000);
      const sub = await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: catalogA.id,
          idempotencyKeyHash: keyHash,
          status: 'CREATING',
          processingStartedAt: ninetySecondsAgo,
          quotaReserved: true,
          quotaCycleAnchor: shop.billingCycleAnchor,
        },
      });

      let reconciliationQueryCalled = false;
      clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
        if (query.includes('findDraftOrderByTag')) {
          reconciliationQueryCalled = true;
          return { draftOrders: { edges: [] } };
        }
        return {};
      });

      const payload = {
        dataVersion: catalogA.dataVersion,
        buyer: { businessName: 'Buyer', email: 'b@b.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
      };

      const res = await request(app)
        .post(`/api/public/catalog/${catalogA.publicToken}/submit`)
        .set('Idempotency-Key', key)
        .send(payload);

      // Because processingStartedAt > 60s, it transitioned to reconciliation and returned RECONCILIATION_PENDING
      expect(reconciliationQueryCalled).toBe(true);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RECONCILIATION_PENDING');
    });

    it('5. old billing cycle reservation release cannot decrement new cycle usage', async () => {
      const { releaseSubmissionQuotaReservation } = await import('../src/services/shop.server.js');

      // Cycle A: 35 days ago
      const cycleAAnchor = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);

      // Create submission X reserved in Cycle A
      const subX = await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: catalogA.id,
          idempotencyKeyHash: 'sub-x-hash',
          status: 'FAILED',
          quotaCycleAnchor: cycleAAnchor,
          quotaReserved: true,
        },
      });

      // Advance shop into Cycle B: anchor is now, usage is 1 (from Submission Y in Cycle B)
      const cycleBAnchor = new Date();
      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          billingCycleAnchor: cycleBAnchor,
          monthlySubmissionsCount: 1,
        },
      });

      // Release submission X's reservation (reserved in Cycle A)
      const released = await releaseSubmissionQuotaReservation(subX.id);

      // Cycle B usage MUST remain exactly 1!
      const shopAfter = await prisma.shop.findUnique({ where: { id: shop.id } });
      expect(shopAfter?.monthlySubmissionsCount).toBe(1);

      // subX quotaReserved marker must be cleared to false
      const subXAfter = await prisma.orderSubmission.findUnique({ where: { id: subX.id } });
      expect(subXAfter?.quotaReserved).toBe(false);
    });

    it('6. duplicate release cannot decrement quota twice', async () => {
      const { releaseSubmissionQuotaReservation } = await import('../src/services/shop.server.js');

      // Current cycle anchor
      const currentAnchor = new Date();
      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          billingCycleAnchor: currentAnchor,
          monthlySubmissionsCount: 5,
        },
      });

      const sub = await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: catalogA.id,
          idempotencyKeyHash: 'sub-dup-release-hash',
          status: 'FAILED',
          quotaCycleAnchor: currentAnchor,
          quotaReserved: true,
        },
      });

      // First release should decrement from 5 to 4
      const firstRelease = await releaseSubmissionQuotaReservation(sub.id);
      expect(firstRelease).toBe(true);

      const shopAfter1 = await prisma.shop.findUnique({ where: { id: shop.id } });
      expect(shopAfter1?.monthlySubmissionsCount).toBe(4);

      // Second release with same submission must NOT decrement again!
      const secondRelease = await releaseSubmissionQuotaReservation(sub.id);
      expect(secondRelease).toBe(false);

      const shopAfter2 = await prisma.shop.findUnique({ where: { id: shop.id } });
      expect(shopAfter2?.monthlySubmissionsCount).toBe(4);
    });
  });
});

