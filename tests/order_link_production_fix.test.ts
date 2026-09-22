import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog, upsertCatalogVariantConfigs } from '../src/services/catalog.server.js';
import { createOrderLink } from '../src/services/orderlink.server.js';
import { syncProductSnapshot, getPublicCatalogPayloadByLinkToken } from '../src/services/sync.server.js';
import { CatalogSourceType, PriceMode, resolveEffectiveQuantityRules } from '../src/types/index.js';

describe('Production Fix: Order Link HTTP 500 & Quantity Rule Override Migration', () => {
  let shop: { id: string; shopDomain: string };

  beforeEach(async () => {
    await prisma.analyticsEvent.deleteMany();
    await prisma.orderLink.deleteMany();
    await prisma.orderSubmission.deleteMany();
    await prisma.catalogVariantConfig.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'order-link-fix-test.myshopify.com',
      accessToken: 'token_order_link_fix',
    });

    await syncProductSnapshot(shop.id, {
      id: 8801,
      title: 'Wholesale Leather Journal',
      handle: 'wholesale-leather-journal',
      status: 'active',
      variants: [
        { id: 9901, product_id: 8801, title: 'A5 / Tan', price: '20.00', inventory_quantity: 150, inventory_policy: 'deny', inventory_management: 'shopify' },
        { id: 9902, product_id: 8801, title: 'A4 / Black', price: '30.00', inventory_quantity: 80, inventory_policy: 'deny', inventory_management: 'shopify' },
      ],
    });
  });

  it('1. migration file 20260922000009_add_variant_quantity_rule_override exists and contains column add & backfill', () => {
    const migrationPath = path.join(process.cwd(), 'prisma', 'migrations', '20260922000009_add_variant_quantity_rule_override', 'migration.sql');
    expect(fs.existsSync(migrationPath)).toBe(true);

    const sqlContent = fs.readFileSync(migrationPath, 'utf-8');
    expect(sqlContent).toContain('overrideQuantityRules');
    expect(sqlContent).toContain('CatalogVariantConfig');
    expect(sqlContent).toContain('UPDATE');
  });

  it('2. resolves catalog default rules when no CatalogVariantConfig row exists', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Default Rules Catalog',
      minQty: 5,
      maxQty: 100,
      qtyIncrement: 5,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/8801' }],
    });
    await publishCatalog(shop.id, catalog.id);

    const rules = resolveEffectiveQuantityRules(catalog as any, null);
    expect(rules.min).toBe(5);
    expect(rules.max).toBe(100);
    expect(rules.step).toBe(5);
  });

  it('3. resolves catalog default rules when CatalogVariantConfig has overrideQuantityRules = false', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Unoverridden Catalog',
      minQty: 10,
      maxQty: 50,
      qtyIncrement: 10,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/8801' }],
    });
    await publishCatalog(shop.id, catalog.id);

    await upsertCatalogVariantConfigs(catalog.id, shop.id, [
      { shopifyVariantId: 'gid://shopify/ProductVariant/9901', enabled: true, overrideQuantityRules: false, minQty: 2, maxQty: 12, qtyIncrement: 1 },
    ]);

    const configs = await prisma.catalogVariantConfig.findMany({ where: { catalogId: catalog.id } });
    expect(configs[0]?.overrideQuantityRules).toBe(false);

    const rules = resolveEffectiveQuantityRules(catalog as any, configs[0]);
    expect(rules.min).toBe(10);
    expect(rules.max).toBe(50);
    expect(rules.step).toBe(10);
  });

  it('4. legacy backfill behavior: CatalogVariantConfig with populated minQty/maxQty/qtyIncrement resolves as override when overrideQuantityRules = true', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Legacy Rules Catalog',
      minQty: 5,
      maxQty: 20,
      qtyIncrement: 5,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/8801' }],
    });
    await publishCatalog(shop.id, catalog.id);

    // Simulate backfilled record (overrideQuantityRules = true)
    await prisma.catalogVariantConfig.create({
      data: {
        catalogId: catalog.id,
        shopifyVariantId: 'gid://shopify/ProductVariant/9901',
        enabled: true,
        overrideQuantityRules: true,
        minQty: 12,
        maxQty: 60,
        qtyIncrement: 6,
      },
    });

    const config = await prisma.catalogVariantConfig.findFirst({ where: { catalogId: catalog.id, shopifyVariantId: 'gid://shopify/ProductVariant/9901' } });
    const rules = resolveEffectiveQuantityRules(catalog as any, config);
    expect(rules.min).toBe(12);
    expect(rules.max).toBe(60);
    expect(rules.step).toBe(6);
  });

  it('5. GET /api/public/link/:linkToken loads successfully with HTTP 200 OK without crashing or throwing HTTP 500', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Public Order Link Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      minQty: 6,
      qtyIncrement: 6,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/8801' }],
    });
    await publishCatalog(shop.id, catalog.id);

    const link = await createOrderLink(catalog.id, shop.id, { label: 'Trade Show Link' });

    const res = await request(app).get(`/api/public/link/${link.token}`);
    expect(res.status).toBe(200);
    expect(res.body.catalog).toBeDefined();
    expect(res.body.catalog.name).toBe('Public Order Link Catalog');
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].variants).toHaveLength(2);
    expect(res.body.products[0].variants[0].minQty).toBe(6);
    expect(res.body.products[0].variants[0].qtyIncrement).toBe(6);
  });

  it('6. GET /api/public/link/:linkToken handles passcode protected links before and after unlock cleanly with 200 OK', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Passcode Protected Catalog',
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/8801' }],
    });
    await publishCatalog(shop.id, catalog.id);

    const link = await createOrderLink(catalog.id, shop.id, { label: 'VIP Link', passcode: 'secret123' });

    // 1. Fetch without token -> returns requiresPasscode: true with 200 OK
    const preRes = await request(app).get(`/api/public/link/${link.token}`);
    expect(preRes.status).toBe(200);
    expect(preRes.body.requiresPasscode).toBe(true);

    // 2. Unlock -> returns linkAccessToken with 200 OK
    const unlockRes = await request(app)
      .post(`/api/public/link/${link.token}/unlock`)
      .send({ passcode: 'secret123' });
    expect(unlockRes.status).toBe(200);
    expect(unlockRes.body.linkAccessToken).toBeDefined();

    // 3. Fetch with header -> returns full catalog payload with 200 OK
    const postRes = await request(app)
      .get(`/api/public/link/${link.token}`)
      .set('X-Link-Access-Token', unlockRes.body.linkAccessToken);
    expect(postRes.status).toBe(200);
    expect(postRes.body.catalog.name).toBe('Passcode Protected Catalog');
    expect(postRes.body.products).toHaveLength(1);
  });

  it('7. GET /api/public/catalog/:publicToken loads successfully with HTTP 200 OK', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Direct Token Catalog',
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/8801' }],
    });
    await publishCatalog(shop.id, catalog.id);

    const res = await request(app).get(`/api/public/catalog/${catalog.publicToken}`);
    expect(res.status).toBe(200);
    expect(res.body.catalog.id).toBe(catalog.id);
  });
});
