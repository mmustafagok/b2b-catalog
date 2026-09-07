import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { submitBuyerOrder, reconcileSubmission } from '../src/services/order.server.js';
import { enqueueJob } from '../src/services/job-queue.server.js';
import { runWorkerOnce } from '../src/worker.js';
import { ShopifyAdminClient } from '../src/services/shopify-client.server.js';
import { ANALYTICS_EVENTS } from '../src/services/analytics.server.js';
import crypto from 'node:crypto';
import { CatalogSourceType, PriceMode, SubmissionStatus } from '../src/types/index.js';

function createTestAppBridgeToken(shopDomain: string): string {
  const secret = process.env.SHOPIFY_API_SECRET || 'test_secret';
  const apiKey = process.env.SHOPIFY_API_KEY || 'test_key';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: `https://${shopDomain}/admin`,
      dest: `https://${shopDomain}`,
      aud: apiKey,
      sub: 'test-user-m9',
      exp: now + 3600,
      nbf: now - 10,
      iat: now,
      jti: 'jti-m9',
      sid: 'sid-m9',
    })
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('Milestone 9: Production Hardening, Reliability, Edge Cases, Performance & Visual Polish', () => {
  let shopA: { id: string; shopDomain: string };
  let shopB: { id: string; shopDomain: string };

  beforeEach(async () => {
    await prisma.backgroundJob.deleteMany();
    await prisma.webhookReceipt.deleteMany();
    await prisma.analyticsEvent.deleteMany();
    await prisma.orderSubmission.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.syncRun.deleteMany();
    await prisma.shop.deleteMany();

    shopA = await installOrUpdateShop({
      shopDomain: 'store-a.myshopify.com',
      accessToken: 'token-a',
      scopes: 'read_products,write_draft_orders',
    });

    shopB = await installOrUpdateShop({
      shopDomain: 'store-b.myshopify.com',
      accessToken: 'token-b',
      scopes: 'read_products,write_draft_orders',
    });
  });

  describe('M9.1 Security & Multi-Tenant Isolation', () => {
    it('strictly isolates admin catalog operations by tenant', async () => {
      const catA = await createCatalog(shopA.id, {
        name: 'Catalog Shop A',
        sources: [{ type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/111' }],
      });

      const tokenB = createTestAppBridgeToken(shopB.shopDomain);

      // Shop B tries to get Shop A catalog
      const getRes = await request(app)
        .get(`/api/admin/catalogs/${catA.id}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(getRes.status).toBe(404);

      // Shop B tries to update Shop A catalog
      const putRes = await request(app)
        .put(`/api/admin/catalogs/${catA.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Hacked Name' });
      expect(putRes.status).toBe(404);

      // Verify unmutated
      const checkCat = await prisma.catalog.findUnique({ where: { id: catA.id } });
      expect(checkCat?.name).toBe('Catalog Shop A');
    });

    it('strictly isolates admin submission details and reconciliation by tenant', async () => {
      const catA = await createCatalog(shopA.id, {
        name: 'Cat A',
        sources: [{ type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/111' }],
      });
      await publishCatalog(shopA.id, catA.id);

      const subA = await prisma.orderSubmission.create({
        data: {
          shopId: shopA.id,
          catalogId: catA.id,
          idempotencyKeyHash: 'hash-sub-sec-1',
          status: SubmissionStatus.REQUIRES_RECONCILIATION,
          lineCount: 1,
          itemCount: 10,
          subtotalAmount: 100,
          currency: 'USD',
        },
      });

      const tokenB = createTestAppBridgeToken(shopB.shopDomain);

      // Shop B tries to get Shop A submission
      const subRes = await request(app)
        .get(`/api/admin/submissions/${subA.id}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(subRes.status).toBe(404);

      // Shop B tries to reconcile Shop A submission
      const reconRes = await request(app)
        .post(`/api/admin/submissions/${subA.id}/reconcile`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(reconRes.status).toBe(404);
    });
  });

  describe('M9.2 Tiered Rate Limiting & DoS Protection', () => {
    it('returns standard rate limit headers on public endpoints', async () => {
      const cat = await createCatalog(shopA.id, {
        name: 'Public Cat',
        sources: [{ type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/111' }],
      });
      await publishCatalog(shopA.id, cat.id);

      const res = await request(app).get(`/api/public/catalog/${cat.publicToken}`);
      expect(res.status).toBe(200);
      expect(res.headers).toHaveProperty('x-ratelimit-limit');
      expect(res.headers).toHaveProperty('x-ratelimit-remaining');
    });

    it('rejects submissions with over 500 line items with 400 Bad Request', async () => {
      const cat = await createCatalog(shopA.id, {
        name: 'Public Cat',
        sources: [{ type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/111' }],
      });
      await publishCatalog(shopA.id, cat.id);

      const hugeLines = Array.from({ length: 501 }, (_, i) => ({
        variantId: `gid://shopify/ProductVariant/${1000 + i}`,
        quantity: 1,
      }));

      const res = await request(app)
        .post(`/api/public/catalog/${cat.publicToken}/submit`)
        .set('Idempotency-Key', 'huge-lines-test')
        .send({
          dataVersion: cat.dataVersion,
          buyer: { businessName: 'Big Order Corp', email: 'orders@bigcorp.com' },
          lines: hugeLines,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/maximum allowable line items/i);
    });

    it('rejects line items with quantity exceeding 100,000 with 400 Bad Request', async () => {
      const cat = await createCatalog(shopA.id, {
        name: 'Public Cat',
        sources: [{ type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/111' }],
      });
      await publishCatalog(shopA.id, cat.id);

      const res = await request(app)
        .post(`/api/public/catalog/${cat.publicToken}/submit`)
        .set('Idempotency-Key', 'huge-qty-test')
        .send({
          dataVersion: cat.dataVersion,
          buyer: { businessName: 'Big Order Corp', email: 'orders@bigcorp.com' },
          lines: [{ variantId: 'gid://shopify/ProductVariant/12345', quantity: 150000 }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/allowable line limit/i);
    });
  });

  describe('M9.4 & M9.5 Webhook Fast-Ack & Background Job Queue', () => {
    it('fast-acks Shopify webhook and enqueues BackgroundJob', async () => {
      const secret = process.env.SHOPIFY_API_SECRET || 'test_secret';
      const body = JSON.stringify({ id: 998877, title: 'Updated Product', handle: 'updated-product' });
      const hmac = crypto.createHmac('sha256', secret).update(body).digest('base64');

      const startTime = Date.now();
      const res = await request(app)
        .post('/api/webhooks/products')
        .set('x-shopify-shop-domain', shopA.shopDomain)
        .set('x-shopify-topic', 'products/update')
        .set('x-shopify-hmac-sha256', hmac)
        .set('x-shopify-webhook-id', 'wh-uuid-m9-01')
        .set('Content-Type', 'application/json')
        .send(body);
      const elapsed = Date.now() - startTime;

      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(500); // Fast ack

      const job = await prisma.backgroundJob.findFirst({
        where: { shopId: shopA.id, type: 'PRODUCT_SYNC' },
      });
      expect(job).not.toBeNull();
      // Job was created and either PENDING or picked up by setImmediate worker
      expect(['PENDING', 'PROCESSING', 'COMPLETED']).toContain(job?.status);
    });

    it('executes background jobs via runWorkerOnce() and handles retries', async () => {
      const job = await enqueueJob({
        shopId: shopA.id,
        type: 'PRODUCT_SYNC',
        payload: {
          action: 'sync',
          product: {
            id: 'gid://shopify/Product/12345678',
            title: 'Worker Test Product',
            handle: 'worker-test',
            variants: [],
          },
        },
        maxAttempts: 3,
      });

      expect(job.status).toBe('PENDING');

      const processed = await runWorkerOnce();
      expect(processed).toBe(true);

      const completedJob = await prisma.backgroundJob.findUnique({ where: { id: job.id } });
      expect(completedJob?.status).toBe('COMPLETED');
      expect(completedJob?.completedAt).not.toBeNull();
    });

    it('marks poisoned background jobs as FAILED after maxAttempts', async () => {
      const job = await enqueueJob({
        shopId: shopA.id,
        type: 'INVALID_JOB_TYPE',
        payload: {},
        maxAttempts: 1, // Only 1 attempt allowed
      });

      // Execute worker which will fail on unknown job type
      const processed = await runWorkerOnce();
      expect(processed).toBe(true);

      const failedJob = await prisma.backgroundJob.findUnique({ where: { id: job.id } });
      expect(failedJob?.status).toBe('FAILED');
      expect(failedJob?.lastError).toContain('Unknown or unsupported background job type');
    });

    it('drops background jobs for uninstalled/inactive shops', async () => {
      // Mark shop as uninstalled
      await prisma.shop.update({
        where: { id: shopA.id },
        data: { uninstalledAt: new Date() },
      });

      const job = await enqueueJob({
        shopId: shopA.id,
        type: 'PRODUCT_SYNC',
        payload: { action: 'delete', productId: '123' },
      });

      const processed = await runWorkerOnce();
      expect(processed).toBe(true);

      const droppedJob = await prisma.backgroundJob.findUnique({ where: { id: job.id } });
      expect(droppedJob?.status).toBe('COMPLETED');
    });
  });

  describe('M9.7 Merchant Submission Reconciliation Service', () => {
    it('reconciles submission to COMPLETED when Draft Order is found in Shopify', async () => {
      const catA = await createCatalog(shopA.id, {
        name: 'Cat Recon',
        sources: [{ type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/111' }],
      });
      await publishCatalog(shopA.id, catA.id);

      const sub = await prisma.orderSubmission.create({
        data: {
          shopId: shopA.id,
          catalogId: catA.id,
          idempotencyKeyHash: 'hash-recon-found',
          status: SubmissionStatus.REQUIRES_RECONCILIATION,
          lineCount: 1,
          itemCount: 5,
          subtotalAmount: 150,
          currency: 'USD',
        },
      });

      // Mock Shopify client returning matching draft order
      vi.spyOn(ShopifyAdminClient.prototype, 'request').mockResolvedValueOnce({
        draftOrders: {
          edges: [
            {
              node: {
                id: 'gid://shopify/DraftOrder/888999',
                name: '#D-888999',
                totalPrice: '150.00',
                currencyCode: 'USD',
              },
            },
          ],
        },
      });

      const result = await reconcileSubmission(shopA.id, sub.id);
      expect(result.status).toBe(SubmissionStatus.COMPLETED);
      expect(result.draftOrderId).toBe('gid://shopify/DraftOrder/888999');

      const updated = await prisma.orderSubmission.findUnique({ where: { id: sub.id } });
      expect(updated?.status).toBe(SubmissionStatus.COMPLETED);
      expect(updated?.draftOrderId).toBe('gid://shopify/DraftOrder/888999');

      // Verify north star analytics event recorded
      const event = await prisma.analyticsEvent.findFirst({
        where: { shopId: shopA.id, eventName: ANALYTICS_EVENTS.DRAFT_ORDER_CREATED },
      });
      expect(event).not.toBeNull();
    });

    it('leaves submission as REQUIRES_RECONCILIATION when not yet found in Shopify (NEVER calls draftOrderCreate)', async () => {
      const catA = await createCatalog(shopA.id, {
        name: 'Cat Recon Unconfirmed',
        sources: [{ type: CatalogSourceType.COLLECTION, shopifyGid: 'gid://shopify/Collection/111' }],
      });
      await publishCatalog(shopA.id, catA.id);

      const sub = await prisma.orderSubmission.create({
        data: {
          shopId: shopA.id,
          catalogId: catA.id,
          idempotencyKeyHash: 'hash-recon-missing',
          status: SubmissionStatus.REQUIRES_RECONCILIATION,
          lineCount: 1,
          itemCount: 2,
          subtotalAmount: 50,
          currency: 'USD',
        },
      });

      // Mock Shopify client returning empty edges (not found yet)
      const requestSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockResolvedValueOnce({
        draftOrders: {
          edges: [],
        },
      });

      const result = await reconcileSubmission(shopA.id, sub.id);
      expect(result.status).toBe(SubmissionStatus.REQUIRES_RECONCILIATION);
      expect(result.draftOrderId).toBeUndefined();

      // Ensure NO draftOrderCreate mutation was called!
      for (const call of requestSpy.mock.calls) {
        expect(call[0]).not.toContain('draftOrderCreate');
      }

      const checkSub = await prisma.orderSubmission.findUnique({ where: { id: sub.id } });
      expect(checkSub?.status).toBe(SubmissionStatus.REQUIRES_RECONCILIATION);
    });
  });

  describe('M9.15 Observability & Health Probes', () => {
    it('returns 200 OK with uptime for /health liveness probe', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('uptime');
    });

    it('returns 200 OK for /ready readiness probe when database is healthy', async () => {
      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'ready');
      expect(res.body).toHaveProperty('database', 'connected');
    });
  });
});
