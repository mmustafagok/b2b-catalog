import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { CatalogSourceType, PriceMode, PlanTier } from '../src/types/index.js';

describe('Milestone 6: Submissions History & Merchant Operations', () => {
  let shopA: { id: string; shopDomain: string };
  let shopB: { id: string; shopDomain: string };
  let catalogA1: any;
  let catalogA2: any;
  let catalogB: any;

  beforeEach(async () => {
    await prisma.syncRun.deleteMany();
    await prisma.orderSubmission.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shopA = await installOrUpdateShop({
      shopDomain: 'merchant-a.myshopify.com',
      accessToken: 'token_a',
      plan: PlanTier.GROWTH,
    });

    shopB = await installOrUpdateShop({
      shopDomain: 'merchant-b.myshopify.com',
      accessToken: 'token_b',
    });

    catalogA1 = await createCatalog(shopA.id, {
      name: 'Catalog A1',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/1' }],
    });
    await publishCatalog(shopA.id, catalogA1.id);

    catalogA2 = await createCatalog(shopA.id, {
      name: 'Catalog A2',
      priceMode: PriceMode.PERCENT_DISCOUNT,
      discountPercent: 20,
      sources: [{ type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/2' }],
    });
    await publishCatalog(shopA.id, catalogA2.id);

    catalogB = await createCatalog(shopB.id, {
      name: 'Catalog B',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/3' }],
    });
    await publishCatalog(shopB.id, catalogB.id);

    // Seed submissions for Shop A
    await prisma.orderSubmission.createMany({
      data: [
        {
          shopId: shopA.id,
          catalogId: catalogA1.id,
          status: 'COMPLETED',
          draftOrderId: 'gid://shopify/DraftOrder/10001',
          draftOrderName: '#D1001',
          idempotencyKeyHash: 'hash-a1-1',
          itemCount: 5,
          lineCount: 2,
          subtotalAmount: 250.0,
          currency: 'USD',
        },
        {
          shopId: shopA.id,
          catalogId: catalogA2.id,
          status: 'COMPLETED',
          draftOrderId: 'gid://shopify/DraftOrder/10002',
          draftOrderName: '#D1002',
          idempotencyKeyHash: 'hash-a2-1',
          itemCount: 12,
          lineCount: 4,
          subtotalAmount: 1200.0,
          currency: 'USD',
        },
      ],
    });

    // Seed submission for Shop B
    await prisma.orderSubmission.create({
      data: {
        shopId: shopB.id,
        catalogId: catalogB.id,
        status: 'COMPLETED',
        draftOrderId: 'gid://shopify/DraftOrder/20001',
        draftOrderName: '#D2001',
        idempotencyKeyHash: 'hash-b-1',
        itemCount: 3,
        lineCount: 1,
        subtotalAmount: 150.0,
        currency: 'EUR',
      },
    });
  });

  it('should fetch paginated submissions for the authenticated shop with deep links', async () => {
    const res = await request(app)
      .get('/api/admin/submissions')
      .set('X-Shop-Domain', shopA.shopDomain);

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(2);
    expect(res.body.submissions).toHaveLength(2);

    const sub1 = res.body.submissions.find((s: any) => s.draftOrderName === '#D1001');
    expect(sub1).toBeDefined();
    expect(sub1.catalogName).toBe('Catalog A1');
    expect(sub1.subtotalAmount).toBe(250);
    expect(sub1.draftOrderUrl).toBe('https://merchant-a.myshopify.com/admin/draft_orders/10001');

    const sub2 = res.body.submissions.find((s: any) => s.draftOrderName === '#D1002');
    expect(sub2).toBeDefined();
    expect(sub2.catalogName).toBe('Catalog A2');
    expect(sub2.draftOrderUrl).toBe('https://merchant-a.myshopify.com/admin/draft_orders/10002');
  });

  it('should guarantee strict multi-tenant isolation: Shop B cannot see Shop A submissions', async () => {
    const resB = await request(app)
      .get('/api/admin/submissions')
      .set('X-Shop-Domain', shopB.shopDomain);

    expect(resB.status).toBe(200);
    expect(resB.body.totalCount).toBe(1);
    expect(resB.body.submissions).toHaveLength(1);
    expect(resB.body.submissions[0].draftOrderName).toBe('#D2001');
    expect(resB.body.submissions[0].draftOrderUrl).toBe('https://merchant-b.myshopify.com/admin/draft_orders/20001');

    // Ensure no Shop A submissions are present
    const shopANames = resB.body.submissions.map((s: any) => s.draftOrderName);
    expect(shopANames).not.toContain('#D1001');
    expect(shopANames).not.toContain('#D1002');
  });

  it('should filter submissions by catalogId', async () => {
    const res = await request(app)
      .get(`/api/admin/submissions?catalogId=${catalogA1.id}`)
      .set('X-Shop-Domain', shopA.shopDomain);

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(1);
    expect(res.body.submissions).toHaveLength(1);
    expect(res.body.submissions[0].catalogId).toBe(catalogA1.id);
    expect(res.body.submissions[0].draftOrderName).toBe('#D1001');
  });

  it('should return comprehensive sync health metrics via GET /api/admin/sync/health', async () => {
    // Record a completed sync run
    await prisma.syncRun.create({
      data: {
        shopId: shopA.id,
        type: 'INITIAL',
        status: 'COMPLETED',
        statsJson: JSON.stringify({ productsSynced: 45, variantsSynced: 120 }),
        finishedAt: new Date(),
      },
    });

    const res = await request(app)
      .get('/api/admin/sync/health')
      .set('X-Shop-Domain', shopA.shopDomain);

    expect(res.status).toBe(200);
    expect(res.body.shop.shopDomain).toBe(shopA.shopDomain);
    expect(res.body.catalogs.total).toBe(2);
    expect(res.body.catalogs.published).toBe(2);
    expect(res.body.submissions.total).toBe(2);
    expect(res.body.sync.status).toBe('COMPLETED');
    expect(res.body.sync.lastSyncStats).toEqual({ productsSynced: 45, variantsSynced: 120 });
    expect(res.body.jobs).toBeDefined();
    expect(res.body.jobs.pending).toBe(0);
    expect(res.body.jobs.failed).toBe(0);
  });

  it('should trigger manual sync via POST /api/admin/sync/trigger', async () => {
    const res = await request(app)
      .post('/api/admin/sync/trigger')
      .set('X-Shop-Domain', shopA.shopDomain);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Sync initiated');
  });
});
