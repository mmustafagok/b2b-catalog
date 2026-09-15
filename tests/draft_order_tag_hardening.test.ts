import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { syncProductSnapshot } from '../src/services/sync.server.js';
import { CatalogSourceType, PriceMode } from '../src/types/index.js';
import {
  buildDraftOrderIdempotencyTag,
  sanitizeShopifyTag,
  buildDraftOrderTags,
} from '../src/services/order.server.js';
import { ShopifyAdminClient } from '../src/services/shopify-client.server.js';
import crypto from 'crypto';

describe('Draft Order Tag Hardening & Shopify 40-Character Limit', () => {
  let shop: { id: string; shopDomain: string };
  let publishedCatalog: any;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await prisma.orderSubmission.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'tag-hardening.myshopify.com',
      accessToken: 'token_tag_hardening',
    });

    await syncProductSnapshot(shop.id, {
      id: 7001,
      title: 'Ergonomic Desk',
      vendor: 'DeskCo',
      handle: 'ergo-desk',
      status: 'active',
      variants: [
        {
          id: 8001,
          product_id: 7001,
          title: '60x30 Walnut',
          price: '350.00',
          sku: 'DESK-8001',
          inventory_quantity: 50,
          inventory_tracked: true,
          inventory_policy: 'deny',
          available: true,
        },
      ],
    });

    const catalog = await createCatalog(shop.id, {
      name: 'Standard Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/7001' }],
    });
    publishedCatalog = await publishCatalog(shop.id, catalog.id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Tag generator unit tests
  it('1. generates canonical tag <= 40 chars for UUID idempotency keys', () => {
    const uuidKey = crypto.randomUUID();
    const tag = buildDraftOrderIdempotencyTag(uuidKey);

    expect(tag).toMatch(/^cfb2b:[0-9a-f]{32}$/);
    expect(tag.length).toBe(38);
    expect(tag.length).toBeLessThanOrEqual(40);
  });

  it('2. generates deterministic tags: same key produces identical tag, different keys produce different tags', () => {
    const keyA = 'idemp-key-abc-123';
    const keyB = 'idemp-key-xyz-789';

    const tagA1 = buildDraftOrderIdempotencyTag(keyA);
    const tagA2 = buildDraftOrderIdempotencyTag(keyA);
    const tagB = buildDraftOrderIdempotencyTag(keyB);

    expect(tagA1).toBe(tagA2);
    expect(tagA1).not.toBe(tagB);
  });

  it('3. sanitizeShopifyTag bounds dynamic strings to <= 40 chars without throwing', () => {
    const shortTag = 'Wholesale';
    expect(sanitizeShopifyTag(shortTag)).toBe('Wholesale');

    const exact40 = 'a'.repeat(40);
    expect(sanitizeShopifyTag(exact40).length).toBe(40);

    const longTag = 'This is an excessively long catalog name that definitely exceeds the 40 character tag limit';
    const sanitized = sanitizeShopifyTag(longTag);
    expect(sanitized.length).toBe(40);
    expect(sanitized).toBe(longTag.slice(0, 40));
  });

  it('4. buildDraftOrderTags ensures EVERY tag in array is <= 40 chars, even with ultra-long catalog name', () => {
    const ultraLongCatalogName = 'Summer Mega Wholesale Clearance Catalog For VIP Retailers 2026';
    const uuidKey = crypto.randomUUID();

    const tags = buildDraftOrderTags(ultraLongCatalogName, uuidKey);

    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const tag of tags) {
      expect(tag.length).toBeLessThanOrEqual(40);
      expect(tag.length).toBeGreaterThan(0);
    }

    // Check fixed tags
    expect(tags).toContain('B2B-Catalog');
    expect(tags).toContain('CatalogFlow');
    // Check canonical idempotency tag
    const expectedIdempTag = buildDraftOrderIdempotencyTag(uuidKey);
    expect(tags).toContain(expectedIdempTag);
  });

  // 5. Integration: createDraftOrder uses canonical idempotency tag and satisfies <= 40 chars
  it('5. draftOrderCreate mutation receives tags that strictly satisfy length <= 40', async () => {
    let capturedInput: any = null;

    vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string, vars?: any) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              title: '60x30 Walnut',
              price: '350.00',
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Ergonomic Desk' },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        capturedInput = vars?.input;
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/tag-test-100',
              name: '#D-TAG-100',
              totalPriceSet: {
                shopMoney: { amount: '350.00', currencyCode: 'USD' },
              },
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const key = crypto.randomUUID();
    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'Tag Tested Buyer LLC', email: 'tagtest@buyer.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(capturedInput).not.toBeNull();
    expect(Array.isArray(capturedInput.tags)).toBe(true);

    const canonicalTag = buildDraftOrderIdempotencyTag(key);
    expect(capturedInput.tags).toContain(canonicalTag);

    for (const t of capturedInput.tags) {
      expect(t.length).toBeLessThanOrEqual(40);
    }
  });

  // 6. Integration: reconciliation uses the exact same canonical tag
  it('6. reconciliation query uses the EXACT same canonical idempotency tag as creation', async () => {
    let capturedSearchQuery: string = '';

    vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string, vars?: any) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              title: '60x30 Walnut',
              price: '350.00',
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Ergonomic Desk' },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        // Ambiguous failure after creating on Shopify
        throw new Error('ETIMEDOUT: network dropped');
      }
      if (query.includes('findDraftOrderByTag')) {
        capturedSearchQuery = vars?.query;
        return {
          draftOrders: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/DraftOrder/tag-recov-1',
                  name: '#D-RECOV',
                  totalPriceSet: { shopMoney: { amount: '350.00', currencyCode: 'USD' } },
                },
              },
            ],
          },
        };
      }
      return {};
    });

    const key = crypto.randomUUID();
    const payload = {
      dataVersion: publishedCatalog.dataVersion,
      buyer: { businessName: 'Recon Match Buyer', email: 'reconmatch@buyer.com' },
      lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
    };

    // Attempt 1: fails with timeout
    const res1 = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send(payload);
    expect(res1.status).toBe(502);

    // Attempt 2: retry triggers reconciliation
    const res2 = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send(payload);
    expect(res2.status).toBe(201);
    expect(res2.body.draftOrderId).toBe('gid://shopify/DraftOrder/tag-recov-1');

    const expectedCanonicalTag = buildDraftOrderIdempotencyTag(key);
    expect(capturedSearchQuery).toBe(`tag:${expectedCanonicalTag}`);
    expect(expectedCanonicalTag.length).toBeLessThanOrEqual(40);
  });

  // 7. Full DB idempotency hash remains unchanged
  it('7. keeps full idempotency key hash in DB orderSubmission record', async () => {
    vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              title: '60x30 Walnut',
              price: '350.00',
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Ergonomic Desk' },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/tag-test-101',
              name: '#D-TAG-101',
              totalPriceSet: { shopMoney: { amount: '350.00', currencyCode: 'USD' } },
            },
            userErrors: [],
          },
        };
      }
      return {};
    });

    const key = 'full-idempotency-key-uuid-12345';
    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', key)
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'DB Hash Check LLC', email: 'hash@buyer.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(res.status).toBe(201);

    const submission = await prisma.orderSubmission.findFirst({
      where: { shopId: shop.id },
    });

    expect(submission).not.toBeNull();
    // 64-character SHA-256 hash of (catalog.id, key)
    expect(submission?.idempotencyKeyHash.length).toBe(64);
    // correlationRef is canonical 38-char tag
    expect(submission?.correlationRef).toBe(buildDraftOrderIdempotencyTag(key));
    expect(submission?.correlationRef?.length).toBe(38);
  });

  // 8. Shopify userErrors on tag length still release quota properly
  it('8. releases quota and marks FAILED if Shopify returns tag length validation error', async () => {
    vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/8001',
              title: '60x30 Walnut',
              price: '350.00',
              availableForSale: true,
              inventoryQuantity: 50,
              product: { id: 'gid://shopify/Product/7001', status: 'ACTIVE', title: 'Ergonomic Desk' },
            },
          ],
        };
      }
      if (query.includes('createDraftOrder')) {
        return {
          draftOrderCreate: {
            draftOrder: null,
            userErrors: [
              {
                field: ['tags', '3'],
                message: 'Title Tag exceeds the maximum length of 40 characters',
              },
            ],
          },
        };
      }
      return {};
    });

    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/submit`)
      .set('Idempotency-Key', 'simulate-shopify-tag-error')
      .send({
        dataVersion: publishedCatalog.dataVersion,
        buyer: { businessName: 'Tag Error Buyer', email: 'tagerror@buyer.com' },
        lines: [{ variantId: 'gid://shopify/ProductVariant/8001', quantity: 1 }],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DRAFT_ORDER_VALIDATION_FAILED');

    // Quota slot released
    const shopRecord = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(shopRecord?.monthlySubmissionsCount).toBe(0);

    const submission = await prisma.orderSubmission.findFirst({
      where: { shopId: shop.id },
    });
    expect(submission?.status).toBe('FAILED');
    expect(submission?.quotaReserved).toBe(false);
  });
});
