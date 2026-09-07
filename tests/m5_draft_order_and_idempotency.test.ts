import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { syncProductSnapshot } from '../src/services/sync.server.js';
import { CatalogSourceType, PriceMode } from '../src/types/index.js';
import { ShopifyAdminClient } from '../src/services/shopify-client.server.js';

describe('Milestone 5: Submit-Time Live Revalidation, Draft Order Creation & Idempotency', () => {
  let shop: { id: string; shopDomain: string };
  let publishedCatalog: any;
  let clientRequestSpy: any;

  beforeEach(async () => {
    await prisma.orderSubmission.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'draft-order-test.myshopify.com',
      accessToken: 'token_draft_order_test',
    });

    // Ingest sample product with 2 variants
    await syncProductSnapshot(shop.id, {
      id: 5001,
      title: 'Ergonomic Standing Desk',
      vendor: 'WorkPro',
      handle: 'ergonomic-standing-desk',
      status: 'active',
      variants: [
        {
          id: 6001,
          product_id: 5001,
          title: 'Walnut / 60-inch',
          price: '500.00',
          sku: 'DESK-WAL-60',
          inventory_quantity: 25,
          available: true,
        },
        {
          id: 6002,
          product_id: 5001,
          title: 'Oak / 48-inch',
          price: '400.00',
          sku: 'DESK-OAK-48',
          inventory_quantity: 10,
          available: true,
        },
      ],
    });

    // Create & publish catalog with 15% wholesale discount
    publishedCatalog = await createCatalog(shop.id, {
      name: 'Wholesale Desks 2026',
      priceMode: PriceMode.PERCENT_DISCOUNT,
      discountPercent: 15,
      showSku: true,
      showInventory: true,
      sources: [
        {
          type: CatalogSourceType.PRODUCT,
          shopifyGid: 'gid://shopify/Product/5001',
        },
      ],
    });

    publishedCatalog = await publishCatalog(shop.id, publishedCatalog.id);
  });

  afterEach(() => {
    if (clientRequestSpy) {
      clientRequestSpy.mockRestore();
    }
  });

  it('should reject requests missing the Idempotency-Key header with 400 Bad Request', async () => {
    const payload = {
      dataVersion: publishedCatalog.dataVersion,
      buyer: {
        businessName: 'Acme Corp',
        email: 'buyer@acme.com',
        poNumber: 'PO-991',
      },
      lines: [
        {
          variantId: 'gid://shopify/ProductVariant/6001',
          quantity: 2,
        },
      ],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Idempotency-Key');
  });

  it('should successfully revalidate, create a Shopify Draft Order, and persist submission atomically', async () => {
    let capturedDraftOrderInput: any = null;

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string, vars?: any) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/6001',
              title: 'Walnut / 60-inch',
              price: '500.00',
              availableForSale: true,
              inventoryQuantity: 25,
              product: {
                id: 'gid://shopify/Product/5001',
                title: 'Ergonomic Standing Desk',
                status: 'ACTIVE',
              },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        capturedDraftOrderInput = vars?.input;
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/888001',
              name: '#D1001',
              totalPrice: '850.00',
              currencyCode: 'USD',
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const payload = {
      dataVersion: publishedCatalog.dataVersion,
      buyer: {
        businessName: 'Acme Workspace LLC',
        email: 'procurement@acmeworkspace.com',
        poNumber: 'PO-2026-001',
        note: 'Deliver to loading dock B',
      },
      lines: [
        {
          variantId: 'gid://shopify/ProductVariant/6001',
          quantity: 2,
        },
      ],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'test-key-uuid-001')
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.draftOrderId).toBe('gid://shopify/DraftOrder/888001');
    expect(res.body.draftOrderName).toBe('#D1001');
    expect(res.body.subtotalAmount).toBe(850.0); // 2 * $500 * (1 - 0.15) = $850.00
    expect(res.body.currency).toBe('USD');

    // Verify Draft Order GraphQL input
    expect(capturedDraftOrderInput).toBeDefined();
    expect(capturedDraftOrderInput.email).toBe('procurement@acmeworkspace.com');
    expect(capturedDraftOrderInput.poNumber).toBe('PO-2026-001');
    expect(capturedDraftOrderInput.lineItems).toHaveLength(1);
    expect(capturedDraftOrderInput.lineItems[0].appliedDiscount).toEqual({
      value: 15,
      valueType: 'PERCENTAGE',
      title: '15% B2B Catalog Discount',
    });
    expect(capturedDraftOrderInput.customAttributes).toEqual(
      expect.arrayContaining([
        { name: 'Business Name', value: 'Acme Workspace LLC' },
        { name: 'Catalog', value: 'Wholesale Desks 2026' },
        { name: 'Catalog ID', value: publishedCatalog.id },
        { name: 'Submission Reference', value: expect.stringContaining('CatalogFlow-Submission:') },
        { name: 'PO Number', value: 'PO-2026-001' },
      ])
    );
    const attrNames = capturedDraftOrderInput.customAttributes.map((a: any) => a.name);
    expect(attrNames).not.toContain('CatalogFlow Public Token');

    // Verify atomic persistence in DB
    const submissionInDb = await prisma.orderSubmission.findFirst({
      where: { draftOrderId: 'gid://shopify/DraftOrder/888001' },
    });
    expect(submissionInDb).toBeDefined();
    expect(submissionInDb?.catalogId).toBe(publishedCatalog.id);
    expect(submissionInDb?.shopId).toBe(shop.id);
    expect(submissionInDb?.itemCount).toBe(2);
    expect(submissionInDb?.lineCount).toBe(1);
    expect(Number(submissionInDb?.subtotalAmount)).toBe(850.0);

    // Verify monthly submissions counter incremented
    const updatedShop = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(updatedShop?.monthlySubmissionsCount).toBe(1);
  });

  it('should be strictly idempotent: return existing record without calling Shopify on duplicate key', async () => {
    let shopifyCallCount = 0;

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/6001',
              title: 'Walnut / 60-inch',
              price: '500.00',
              availableForSale: true,
              inventoryQuantity: 25,
              product: {
                id: 'gid://shopify/Product/5001',
                title: 'Ergonomic Standing Desk',
                status: 'ACTIVE',
              },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        shopifyCallCount++;
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/999002',
              name: '#D1002',
              totalPrice: '425.00',
              currencyCode: 'USD',
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const payload = {
      dataVersion: publishedCatalog.dataVersion,
      buyer: {
        businessName: 'Beta Design Studio',
        email: 'orders@betastudio.com',
      },
      lines: [
        {
          variantId: 'gid://shopify/ProductVariant/6001',
          quantity: 1,
        },
      ],
    };

    const key = 'idem-unique-key-xyz-777';

    // First call: creates order
    const res1 = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res1.status).toBe(201);
    expect(res1.body.draftOrderId).toBe('gid://shopify/DraftOrder/999002');
    expect(res1.body.isDuplicate).toBeFalsy();
    expect(shopifyCallCount).toBe(1);

    // Second call: same idempotency key
    const res2 = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.body.draftOrderId).toBe('gid://shopify/DraftOrder/999002');
    expect(res2.body.isDuplicate).toBe(true);
    // Shopify mutation was NOT called a second time
    expect(shopifyCallCount).toBe(1);
  });

  it('should return 409 Conflict with CATALOG_CHANGED when Shopify price changed since catalog snapshot', async () => {
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/6001',
              title: 'Walnut / 60-inch',
              price: '550.00', // Changed on Shopify from 500.00 to 550.00!
              availableForSale: true,
              inventoryQuantity: 25,
              product: {
                id: 'gid://shopify/Product/5001',
                title: 'Ergonomic Standing Desk',
                status: 'ACTIVE',
              },
            },
          ],
        };
      }
      return {};
    });

    const payload = {
      dataVersion: publishedCatalog.dataVersion,
      buyer: {
        businessName: 'Delta Systems',
        email: 'purchasing@deltasystems.com',
      },
      lines: [
        {
          variantId: 'gid://shopify/ProductVariant/6001',
          quantity: 1,
        },
      ],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'price-check-key-1')
      .send(payload);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATALOG_CHANGED');
    expect(res.body.changedLines).toHaveLength(1);
    expect(res.body.changedLines[0].reason).toBe('PRICE_CHANGED');
    expect(res.body.changedLines[0].oldPrice).toBe(425); // 500 - 15% = 425
    expect(res.body.changedLines[0].newPrice).toBe(467.5); // 550 - 15% = 467.5
  });

  it('should return 409 Conflict with OUT_OF_STOCK when a variant became unavailable', async () => {
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/6001',
              title: 'Walnut / 60-inch',
              price: '500.00',
              availableForSale: false, // Out of stock on Shopify!
              inventoryQuantity: 0,
              product: {
                id: 'gid://shopify/Product/5001',
                title: 'Ergonomic Standing Desk',
                status: 'ACTIVE',
              },
            },
          ],
        };
      }
      return {};
    });

    const payload = {
      dataVersion: publishedCatalog.dataVersion,
      buyer: {
        businessName: 'Delta Systems',
        email: 'purchasing@deltasystems.com',
      },
      lines: [
        {
          variantId: 'gid://shopify/ProductVariant/6001',
          quantity: 1,
        },
      ],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'stock-check-key-1')
      .send(payload);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATALOG_CHANGED');
    expect(res.body.changedLines[0].reason).toBe('OUT_OF_STOCK');
  });

  it('should return 409 Conflict with DELETED when a variant was removed from Shopify', async () => {
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [], // Variant deleted in Shopify!
        };
      }
      return {};
    });

    const payload = {
      dataVersion: publishedCatalog.dataVersion,
      buyer: {
        businessName: 'Delta Systems',
        email: 'purchasing@deltasystems.com',
      },
      lines: [
        {
          variantId: 'gid://shopify/ProductVariant/6001',
          quantity: 1,
        },
      ],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'deleted-check-key-1')
      .send(payload);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATALOG_CHANGED');
    expect(res.body.changedLines[0].reason).toBe('DELETED');
  });

  it('should return 403 Forbidden when merchant monthly order submission quota is reached', async () => {
    // Set shop usage to Starter plan limit (50)
    await prisma.shop.update({
      where: { id: shop.id },
      data: { monthlySubmissionsCount: 50 },
    });

    const payload = {
      dataVersion: publishedCatalog.dataVersion,
      buyer: {
        businessName: 'Over Quota Inc',
        email: 'buyer@overquota.com',
      },
      lines: [
        {
          variantId: 'gid://shopify/ProductVariant/6001',
          quantity: 1,
        },
      ],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'quota-test-key-1')
      .send(payload);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
  });

  it('should guarantee zero raw buyer PII storage in OrderSubmission model', async () => {
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/6001',
              title: 'Walnut / 60-inch',
              price: '500.00',
              availableForSale: true,
              inventoryQuantity: 25,
              product: {
                id: 'gid://shopify/Product/5001',
                title: 'Ergonomic Standing Desk',
                status: 'ACTIVE',
              },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/777123',
              name: '#D1003',
              totalPrice: '425.00',
              currencyCode: 'USD',
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const buyerEmail = 'highly-sensitive-pii@privatebuyer.com';
    const buyerName = 'Confidential Buyer Organization';

    const payload = {
      dataVersion: publishedCatalog.dataVersion,
      buyer: {
        businessName: buyerName,
        email: buyerEmail,
        poNumber: 'PO-SECRET-1',
        note: 'Strict confidential delivery note',
      },
      lines: [
        {
          variantId: 'gid://shopify/ProductVariant/6001',
          quantity: 1,
        },
      ],
    };

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'pii-safety-key-1')
      .send(payload);

    expect(res.status).toBe(201);

    const submission = await prisma.orderSubmission.findFirst({
      where: { draftOrderId: 'gid://shopify/DraftOrder/777123' },
    });

    expect(submission).toBeDefined();
    // Verify local DB object contains no raw buyer PII
    const submissionString = JSON.stringify(submission);
    expect(submissionString).not.toContain(buyerEmail);
    expect(submissionString).not.toContain(buyerName);
    expect(submissionString).not.toContain('Strict confidential delivery note');
  });
});
