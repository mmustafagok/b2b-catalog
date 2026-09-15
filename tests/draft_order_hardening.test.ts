import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { syncProductSnapshot } from '../src/services/sync.server.js';
import { CatalogSourceType, PriceMode } from '../src/types/index.js';
import { ShopifyAdminClient, ShopifyGraphQLError } from '../src/services/shopify-client.server.js';
import { isShopifyProductVariantGid, isShopifyDraftOrderGid } from '../src/services/order.server.js';

describe('Draft Order Hardening & Shopify 2026-07 Compliance', () => {
  let shop: { id: string; shopDomain: string };
  let publishedCatalog: any;
  let clientRequestSpy: any;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await prisma.orderSubmission.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'hardening-suite.myshopify.com',
      accessToken: 'token_hardening_suite',
    });

    await syncProductSnapshot(shop.id, {
      id: 7001,
      title: 'Industrial Standing Desk',
      vendor: 'SteelCase',
      handle: 'industrial-standing-desk',
      status: 'active',
      variants: [
        {
          id: 8001,
          product_id: 7001,
          title: '60x30 / Walnut',
          price: '600.00',
          sku: 'DESK-6030-W',
          inventory_quantity: 20,
          inventory_tracked: true,
          inventory_policy: 'deny',
          available: true,
        },
      ],
    });

    const catalog = await createCatalog(shop.id, {
      name: 'SteelCase Wholesale 2026',
      priceMode: PriceMode.PERCENT_DISCOUNT,
      discountPercent: 10,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/7001' }],
    });
    publishedCatalog = await publishCatalog(shop.id, catalog.id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Correct Shopify ProductVariant GID reaches draftOrderCreate
  it('1. passes verified ProductVariant GraphQL GID to draftOrderCreate', async () => {
    let capturedInput: any = null;
    let capturedMutation: string = '';

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string, vars?: any) => {
      if (query.includes('getVariantsByIds') || query.includes('nodes')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              title: '60x30 / Walnut',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              inventoryPolicy: 'DENY',
              inventoryItem: { tracked: true },
              product: { id: 'gid://shopify/Product/7001', title: 'Industrial Standing Desk', status: 'ACTIVE' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        capturedMutation = query;
        capturedInput = vars?.input;
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/99001',
              name: '#D99001',
              totalPriceSet: {
                shopMoney: {
                  amount: '540.00',
                  currencyCode: 'USD',
                },
              },
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-gid-check-1')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: {
          businessName: 'Nordic Workspace Corp',
          email: 'purchasing@nordic.com',
          poNumber: 'PO-NORDIC-2026',
          note: 'Please rush shipment',
        },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(capturedInput).toBeDefined();
    expect(capturedInput.lineItems[0].variantId).toBe('gid://shopify/ProductVariant/8001');
    expect(isShopifyProductVariantGid(capturedInput.lineItems[0].variantId)).toBe(true);
  });

  // 2. Malformed variant ID rejected before mutation
  it('2. rejects malformed variant ID before invoking Shopify mutation', async () => {
    const mutationSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request');

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-malformed-gid')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: {
          businessName: 'Nordic Workspace Corp',
          email: 'purchasing@nordic.com',
        },
        lines: [{ variantId: '8001', quantity: 1 }], // Plain numeric ID without GID prefix
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_LINES');
    expect(mutationSpy).not.toHaveBeenCalled();
  });

  // 3. draftOrderCreate valid input succeeds with totalPriceSet
  it('3. creates draft order successfully querying totalPriceSet and returns 201', async () => {
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              title: '60x30 / Walnut',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', title: 'Industrial Standing Desk', status: 'ACTIVE' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        expect(query).toContain('totalPriceSet');
        expect(query).not.toContain('totalPrice\n');
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/10001',
              name: '#D10001',
              totalPriceSet: {
                shopMoney: {
                  amount: '540.00',
                  currencyCode: 'USD',
                },
              },
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-valid-input-success')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'Valid Buyer Inc', email: 'valid@buyer.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.draftOrderId).toBe('gid://shopify/DraftOrder/10001');
    expect(res.body.subtotalAmount).toBe(540);
  });

  // 4. GraphQL top-level errors mapped correctly and releases quota
  it('4. maps top-level GraphQL error to conclusive failure and releases quota', async () => {
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              title: '60x30 / Walnut',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        throw new ShopifyGraphQLError(
          "Shopify GraphQL Error: Field 'undefinedField' doesn't exist on type 'DraftOrder'",
          [{ message: "Field 'undefinedField' doesn't exist on type 'DraftOrder'" }],
          undefined,
          400
        );
      }
      return {};
    });

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-top-level-err')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'Top Level Err Corp', email: 'err@corp.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DRAFT_ORDER_CREATE_FAILED');
    expect(res.body.message).toBe("We couldn't create the Shopify Draft Order. Your order was not confirmed.");

    // Quota reservation rolled back
    const shopRecord = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopRecord?.monthlySubmissionsCount).toBe(0);

    const subRecord = await prisma.orderSubmission.findFirst({ where: { shopId: shop.id } });
    expect(subRecord?.status).toBe('FAILED');
    expect(subRecord?.quotaReserved).toBe(false);
  });

  // 5. draftOrderCreate userErrors mapped correctly and releases quota
  it('5. maps draftOrderCreate userErrors to DRAFT_ORDER_VALIDATION_FAILED and releases quota', async () => {
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              title: '60x30 / Walnut',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        return {
          draftOrderCreate: {
            draftOrder: null,
            userErrors: [{ field: ['email'], message: 'Customer email address is invalid' }],
          },
        };
      }
      return {};
    });

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-user-errors')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'User Error Corp', email: 'valid-syntax@buyer.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DRAFT_ORDER_VALIDATION_FAILED');
    expect(res.body.message).toBe("We couldn't create the Shopify Draft Order. Your order was not confirmed.");

    // Quota reservation rolled back
    const shopRecord = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopRecord?.monthlySubmissionsCount).toBe(0);

    const subRecord = await prisma.orderSubmission.findFirst({ where: { shopId: shop.id } });
    expect(subRecord?.status).toBe('FAILED');
    expect(subRecord?.quotaReserved).toBe(false);
  });

  // 6. null draftOrder with no apparent success is rejected safely
  it('6. rejects null draftOrder without userErrors as ambiguous failure and enters reconciliation', async () => {
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              title: '60x30 / Walnut',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        return {
          draftOrderCreate: {
            draftOrder: null,
            userErrors: [],
          },
        };
      }
      return {};
    });

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-null-draft')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'Null Draft Corp', email: 'null@draft.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SHOPIFY_API_ERROR');

    // Quota retained for reconciliation
    const subRecord = await prisma.orderSubmission.findFirst({ where: { shopId: shop.id } });
    expect(subRecord?.status).toBe('REQUIRES_RECONCILIATION');
    expect(subRecord?.quotaReserved).toBe(true);
  });

  // 7. Buyer company name is not treated as Shopify Company ID
  it('7. preserves buyer company name in note and customAttributes without fabricating Shopify Company ID', async () => {
    let capturedInput: any = null;

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string, vars?: any) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              title: '60x30 / Walnut',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        capturedInput = vars?.input;
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/10002',
              name: '#D10002',
              totalPriceSet: { shopMoney: { amount: '540.00', currencyCode: 'USD' } },
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-b2b-company-test')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'Acme Architecture & Design Corp', email: 'design@acme.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(capturedInput.purchasingEntity).toBeUndefined();
    expect(capturedInput.companyId).toBeUndefined();
    expect(capturedInput.note).toContain('Business: Acme Architecture & Design Corp');
    expect(capturedInput.customAttributes).toEqual(
      expect.arrayContaining([{ key: 'Business Name', value: 'Acme Architecture & Design Corp' }])
    );
  });

  // 8. Buyer email mapping
  it('8. maps buyer email cleanly to draftOrderInput.email', async () => {
    let capturedInput: any = null;

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string, vars?: any) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        capturedInput = vars?.input;
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/10003',
              name: '#D10003',
              totalPriceSet: { shopMoney: { amount: '540.00', currencyCode: 'USD' } },
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-email-map')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'Alpha Corp', email: 'order-desk@alpha.org' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(capturedInput.email).toBe('order-desk@alpha.org');
  });

  // 9. PO / Note metadata mapping
  it('9. maps PO number and notes cleanly into note and customAttributes using key/value', async () => {
    let capturedInput: any = null;

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string, vars?: any) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        capturedInput = vars?.input;
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/10004',
              name: '#D10004',
              totalPriceSet: { shopMoney: { amount: '540.00', currencyCode: 'USD' } },
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-po-metadata-map')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: {
          businessName: 'Beta Ltd',
          email: 'beta@ltd.com',
          poNumber: 'PO-BETA-999',
          note: 'Deliver to loading dock 3',
        },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(capturedInput.poNumber).toBe('PO-BETA-999');
    expect(capturedInput.note).toContain('PO Number: PO-BETA-999');
    expect(capturedInput.note).toContain('Buyer Notes: Deliver to loading dock 3');
    expect(capturedInput.customAttributes).toEqual(
      expect.arrayContaining([
        { key: 'Business Name', value: 'Beta Ltd' },
        { key: 'PO Number', value: 'PO-BETA-999' },
      ])
    );
  });

  // 10. Quota released after definitive Draft Order failure
  it('10. releases quota slot exactly once when Draft Order creation fails conclusively', async () => {
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        throw new ShopifyGraphQLError('Store not permitted to create draft orders', undefined, undefined, 403);
      }
      return {};
    });

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-quota-rollback-definitive')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'Definitive Corp', email: 'def@corp.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DRAFT_ORDER_PERMISSION_DENIED');

    const shopRecord = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopRecord?.monthlySubmissionsCount).toBe(0);

    const sub = await prisma.orderSubmission.findFirst({ where: { shopId: shop.id } });
    expect(sub?.status).toBe('FAILED');
    expect(sub?.quotaReserved).toBe(false);
  });

  // 11. Quota retained after success
  it('11. retains consumed quota slot after successful draft order creation', async () => {
    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/10005',
              name: '#D10005',
              totalPriceSet: { shopMoney: { amount: '540.00', currencyCode: 'USD' } },
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-quota-retained-success')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'Success Corp', email: 'success@corp.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(res.status).toBe(201);
    const shopRecord = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopRecord?.monthlySubmissionsCount).toBe(1);

    const sub = await prisma.orderSubmission.findFirst({ where: { shopId: shop.id } });
    expect(sub?.status).toBe('COMPLETED');
    expect(sub?.quotaReserved).toBe(true);
  });

  // 12. Duplicate submission does not duplicate Draft Order
  it('12. deduplicates identical submission without creating duplicate Draft Order', async () => {
    let createCallCount = 0;

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        createCallCount++;
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/10006',
              name: '#D10006',
              totalPriceSet: { shopMoney: { amount: '540.00', currencyCode: 'USD' } },
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const payload = {
      dataVersion: publishedCatalog.dataVersion,
      buyer: { businessName: 'Dedup Corp', email: 'dedup@corp.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
    };

    const res1 = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-dedup-check')
      .send(payload);

    expect(res1.status).toBe(201);
    expect(res1.body.isDuplicate).toBeFalsy();

    const res2 = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-dedup-check')
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.body.isDuplicate).toBe(true);
    expect(createCallCount).toBe(1); // Exact single mutation
  });

  // 13. Inventory revalidation still happens before mutation
  it('13. performs live inventory revalidation before executing Draft Order mutation', async () => {
    const callOrder: string[] = [];

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        callOrder.push('REVALIDATE');
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        callOrder.push('MUTATION');
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/10007',
              name: '#D10007',
              totalPriceSet: { shopMoney: { amount: '540.00', currencyCode: 'USD' } },
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-revalidation-order')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'Order Check Corp', email: 'order@check.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(callOrder).toEqual(['REVALIDATE', 'MUTATION']);
  });

  // 14. INVENTORY_CHANGED prevents Draft Order mutation
  it('14. stops execution with INVENTORY_CHANGED without triggering draftOrderCreate', async () => {
    let mutationTriggered = false;

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              title: '60x30 / Walnut',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 2, // Only 2 left, buyer requests 5
              inventoryPolicy: 'DENY',
              inventoryItem: { tracked: true },
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        mutationTriggered = true;
        return {};
      }
      return {};
    });

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-inventory-changed')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'Inventory Depleted Corp', email: 'depleted@corp.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 5 }],
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVENTORY_CHANGED');
    expect(mutationTriggered).toBe(false);

    // Quota slot was rolled back
    const shopRecord = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopRecord?.monthlySubmissionsCount).toBe(0);
  });

  // 15. Shopify timeout keeps reconciliation-safe behavior
  it('15. treats network timeout as ambiguous, keeps quota, and allows tag-based reconciliation', async () => {
    let attempt = 0;

    clientRequestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              price: '600.00',
              availableForSale: true,
              inventoryQuantity: 20,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Desk' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        attempt++;
        throw new ShopifyGraphQLError('Shopify Admin API network request timed out after 15000ms', undefined, undefined, 504);
      }
      if (query.includes('findDraftOrderByTag')) {
        // Simulates reconciliation locating the draft order created during the timeout
        return {
          draftOrders: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/DraftOrder/reconciled-15',
                  name: '#D-RECONCILED',
                  totalPriceSet: {
                    shopMoney: {
                      amount: '540.00',
                      currencyCode: 'USD',
                    },
                  },
                },
              },
            ],
          },
        };
      }
      return {};
    });

    const payload = {
      dataVersion: publishedCatalog.dataVersion,
      buyer: { businessName: 'Timeout Corp', email: 'timeout@corp.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
    };

    // Attempt 1: Timeout -> returns 502 SHOPIFY_TIMEOUT
    const res1 = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-timeout-reconcile')
      .send(payload);

    expect(res1.status).toBe(502);
    expect(res1.body.code).toBe('SHOPIFY_TIMEOUT');

    // Quota slot is kept (not rolled back) because the mutation might have succeeded on Shopify
    let shopRecord = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopRecord?.monthlySubmissionsCount).toBe(1);

    const sub1 = await prisma.orderSubmission.findFirst({ where: { shopId: shop.id } });
    expect(sub1?.status).toBe('REQUIRES_RECONCILIATION');
    expect(sub1?.quotaReserved).toBe(true);

    // Attempt 2: Same key retries -> executes findDraftOrderByTag -> reconciles without re-mutating!
    const res2 = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'key-timeout-reconcile')
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.body.draftOrderId).toBe('gid://shopify/DraftOrder/reconciled-15');
    expect(res2.body.isDuplicate).toBe(true);

    // Mutation was NOT called again
    expect(attempt).toBe(1);

    // Final quota is still 1
    shopRecord = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopRecord?.monthlySubmissionsCount).toBe(1);
  });
});
