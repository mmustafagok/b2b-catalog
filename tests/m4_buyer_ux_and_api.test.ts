import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { syncProductSnapshot } from '../src/services/sync.server.js';
import { CatalogSourceType, PriceMode } from '../src/types/index.js';

describe('Milestone 4: Public Buyer Ordering API & UX Integration', () => {
  let shop: { id: string; shopDomain: string };
  let publishedCatalog: any;

  beforeEach(async () => {
    await prisma.orderSubmission.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'buyer-api-test.myshopify.com',
      accessToken: 'token_buyer_api',
    });

    // Ingest sample product
    await syncProductSnapshot(shop.id, {
      id: 8801,
      title: 'Ergonomic Office Chair',
      vendor: 'Furniture Corp',
      handle: 'ergonomic-office-chair',
      status: 'active',
      variants: [
        {
          id: 9901,
          product_id: 8801,
          title: 'Grey / Standard',
          price: '200.00',
          sku: 'CHAIR-GRY',
          inventory_quantity: 15,
          available: true,
        },
        {
          id: 9902,
          product_id: 8801,
          title: 'Black / Out of stock variant',
          price: '200.00',
          sku: 'CHAIR-BLK',
          inventory_quantity: 0,
          available: false,
        },
      ],
    });

    // Create & publish catalog with 10% wholesale discount
    publishedCatalog = await createCatalog(shop.id, {
      name: 'Corporate Office Catalog',
      priceMode: PriceMode.PERCENT_DISCOUNT,
      discountPercent: 10,
      showSku: true,
      showInventory: true,
      sources: [
        {
          type: CatalogSourceType.PRODUCT,
          shopifyGid: 'gid://shopify/Product/8801',
        },
      ],
    });

    await publishCatalog(shop.id, publishedCatalog.id);
  });

  it('should return health check 200 OK', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('should fetch public catalog payload via GET /api/public/catalog/:publicToken', async () => {
    const res = await request(app).get(`/api/public/catalog/${publishedCatalog.publicToken}`);
    expect(res.status).toBe(200);
    expect(res.body.catalog.name).toBe('Corporate Office Catalog');
    expect(res.body.catalog.discountPercent).toBe(10);
    expect(res.body.products).toHaveLength(1);

    const product = res.body.products[0];
    expect(product.title).toBe('Ergonomic Office Chair');
    expect(product.variants).toHaveLength(2);

    const v1 = product.variants[0];
    expect(v1.sku).toBe('CHAIR-GRY');
    expect(v1.basePrice).toBe(200);
    expect(v1.displayPrice).toBe(180); // 10% discount on $200
    expect(v1.availableForSale).toBe(true);
  });

  it('should return 404 for unknown or unpublished catalog tokens', async () => {
    const res = await request(app).get('/api/public/catalog/non_existent_token_12345');
    expect(res.status).toBe(404);
  });

  it('should validate valid buyer lines via POST /api/public/catalog/:publicToken/validate', async () => {
    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/validate`)
      .send({
        dataVersion: 2,
        lines: [
          {
            variantId: 'gid://shopify/ProductVariant/9901',
            quantity: 5,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VALID');
    expect(res.body.changedLines).toHaveLength(0);
    expect(res.body.summary.totalItems).toBe(5);
    expect(res.body.summary.totalLines).toBe(1);
    expect(res.body.summary.subtotal).toBe(900.0); // 5 * $180 = $900
  });

  it('should flag out-of-stock items during pre-submit validation', async () => {
    const res = await request(app)
      .post(`/api/public/catalog/${publishedCatalog.publicToken}/validate`)
      .send({
        dataVersion: 2,
        lines: [
          {
            variantId: 'gid://shopify/ProductVariant/9902', // out of stock
            quantity: 2,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('INVALID');
    expect(res.body.changedLines).toHaveLength(1);
    expect(res.body.changedLines[0].reason).toBe('OUT_OF_STOCK');
  });

  it('should protect Merchant Admin API and enforce tenant isolation', async () => {
    // 1. Unauthenticated request -> 401
    const unauthRes = await request(app).get('/api/admin/catalogs');
    expect(unauthRes.status).toBe(401);

    // 2. Authenticated request with shop header -> 200
    const authRes = await request(app)
      .get('/api/admin/catalogs')
      .set('X-Shop-Domain', shop.shopDomain);

    expect(authRes.status).toBe(200);
    expect(authRes.body.catalogs).toHaveLength(1);
    expect(authRes.body.catalogs[0].id).toBe(publishedCatalog.id);
  });
});
