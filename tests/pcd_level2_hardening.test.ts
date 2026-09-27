import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prisma, validateDatabaseEnvironmentForContext, DatabaseEnvironmentError } from '../src/db.js';
import { app } from '../src/server.js';
import { installOrUpdateShop, redactShopData } from '../src/services/shop.server.js';
import { syncProductSnapshot } from '../src/services/sync.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { submitBuyerOrder } from '../src/services/order.server.js';
import { ShopifyAdminClient } from '../src/services/shopify-client.server.js';
import { logger } from '../src/services/logger.server.js';
import {
  sanitizeForLogging,
  sanitizeErrorMessage,
  redactSensitiveString,
} from '../src/services/security.server.js';
import { recordRuntimeIncident } from '../src/services/incident.server.js';
import { recordAnalyticsEvent, sanitizeAnalyticsMetadata, ANALYTICS_EVENTS } from '../src/services/analytics.server.js';
import {
  enforceDataRetention,
  RETENTION_RUNTIME_INCIDENT_DAYS,
  RETENTION_WEBHOOK_RECEIPT_DAYS,
  RETENTION_BACKGROUND_JOB_DAYS,
  RETENTION_ANALYTICS_EVENT_DAYS,
  RETENTION_PCD_ACCESS_AUDIT_DAYS,
  RETENTION_BUYER_PCD_PERSISTENT_DAYS,
} from '../src/services/retention.server.js';
import { PCD_AUDIT_ACTIONS } from '../src/services/pcd-audit.server.js';
import { mapShopifyAppPricingHandleToPlan, PlanTier } from '../src/services/billing.server.js';
import { BuyerSubmitOrderSchema, CatalogSourceType } from '../src/types/index.js';

describe('Shopify Protected Customer Data (PCD) Level 2 Hardening Pass', () => {
  let shop: any;
  let catalog: any;
  let draftOrderSpy: any;

  beforeEach(async () => {
    // Clean all relevant application tables
    await prisma.pcdAccessAudit.deleteMany({});
    await prisma.runtimeIncident.deleteMany({});
    await prisma.analyticsEvent.deleteMany({});
    await prisma.webhookReceipt.deleteMany({});
    await prisma.backgroundJob.deleteMany({});
    await prisma.orderSubmission.deleteMany({});
    await prisma.orderLink.deleteMany({});
    await prisma.catalogVariantConfig.deleteMany({});
    await prisma.catalogSource.deleteMany({});
    await prisma.catalog.deleteMany({});
    await prisma.variantSnapshot.deleteMany({});
    await prisma.collectionProductMembership.deleteMany({}).catch(() => {});
    await prisma.productSnapshot.deleteMany({});
    await prisma.collectionSnapshot.deleteMany({});
    await prisma.shop.deleteMany({});

    shop = await installOrUpdateShop({
      shopDomain: `pcd-test-${Date.now()}-${Math.random().toString(36).substring(7)}.myshopify.com`,
      accessToken: 'shpat_test_token_12345',
    });

    await syncProductSnapshot(shop.id, {
      id: 9901,
      title: 'Ergonomic Executive Chair',
      vendor: 'OfficeCorp',
      handle: 'ergonomic-executive-chair',
      status: 'active',
      variants: [
        {
          id: 99001,
          product_id: 9901,
          title: 'Midnight Black',
          price: '300.00',
          sku: 'CHAIR-BLK-01',
          inventory_quantity: 50,
          available: true,
        },
      ],
    });

    catalog = await createCatalog(shop.id, {
      name: 'B2B Executive Catalog',
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/9901' }],
    });
    catalog = await publishCatalog(shop.id, catalog.id);

    draftOrderSpy = vi.spyOn(ShopifyAdminClient.prototype, 'request').mockImplementation(async (query: string) => {
      if (query.includes('getVariantsByIds')) {
        return {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/99001',
              title: 'Ergonomic Desk Chair',
              price: '300.00',
              availableForSale: true,
              inventoryQuantity: 50,
              inventoryPolicy: 'DENY',
              inventoryItem: { tracked: true },
              product: { id: 'gid://shopify/Product/9901', title: 'Executive Desk Chair', status: 'ACTIVE' },
            },
          ],
        };
      }
      if (query.includes('draftOrderCreate')) {
        return {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/888001',
              name: '#D888001',
              status: 'OPEN',
              subtotalPriceSet: { shopMoney: { amount: '600.00', currencyCode: 'USD' } },
              totalPriceSet: { shopMoney: { amount: '600.00', currencyCode: 'USD' } },
            },
            userErrors: [],
          },
        };
      }
      return {};
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.pcdAccessAudit.deleteMany({});
    await prisma.runtimeIncident.deleteMany({});
    await prisma.analyticsEvent.deleteMany({});
    await prisma.webhookReceipt.deleteMany({});
    await prisma.backgroundJob.deleteMany({});
    await prisma.orderSubmission.deleteMany({});
    await prisma.orderLink.deleteMany({});
    await prisma.catalogVariantConfig.deleteMany({});
    await prisma.catalogSource.deleteMany({});
    await prisma.catalog.deleteMany({});
    await prisma.variantSnapshot.deleteMany({});
    await prisma.collectionProductMembership.deleteMany({}).catch(() => {});
    await prisma.productSnapshot.deleteMany({});
    await prisma.collectionSnapshot.deleteMany({});
    await prisma.shop.deleteMany({});
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. DATA MINIMIZATION: EMAIL ONLY & NO NAME/PHONE/ADDRESS DEPENDENCY
  // ───────────────────────────────────────────────────────────────────────────
  describe('1. Data Minimization & Protected Fields', () => {
    it('Buyer submission schema accepts only email, businessName, poNumber, and note (no names/phones/addresses)', () => {
      const validPayload = {
        buyer: {
          email: 'buyer.wholesale@example.com',
          businessName: 'Apex Wholesale LLC',
          poNumber: 'PO-2026-001',
          note: 'Please deliver to loading dock B',
        },
        lines: [
          {
            variantId: 'gid://shopify/ProductVariant/99001',
            quantity: 5,
          },
        ],
        dataVersion: 2,
      };

      const parsed = BuyerSubmitOrderSchema.parse(validPayload);
      expect(parsed.buyer.email).toBe('buyer.wholesale@example.com');
      expect((parsed.buyer as any).firstName).toBeUndefined();
      expect((parsed.buyer as any).lastName).toBeUndefined();
      expect((parsed.buyer as any).phone).toBeUndefined();
      expect((parsed.buyer as any).address).toBeUndefined();
      expect((parsed.buyer as any).shippingAddress).toBeUndefined();
      expect((parsed.buyer as any).billingAddress).toBeUndefined();
    });

    it('retains 0 persistent days for buyer PCD in application database', () => {
      expect(RETENTION_BUYER_PCD_PERSISTENT_DAYS).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. ZERO-PII PERSISTENCE AFTER ORDER SUBMISSION
  // ───────────────────────────────────────────────────────────────────────────
  describe('2. Zero-Persistence Buyer PCD Architecture', () => {
    it('raw buyer email, business name, PO number, and note are NEVER persisted in any application database table', async () => {
      const targetEmail = 'confidential.buyer.999@enterprise-buyers.org';
      const targetBusiness = 'Confidential Global Partners Inc.';
      const targetPo = 'PO-TOP-SECRET-8877';
      const targetNote = 'Confidential delivery note with gate access instructions.';

      const submission = await submitBuyerOrder(catalog.publicToken, 'idemp-pcd-zero-pii-1', {
        buyer: {
          email: targetEmail,
          businessName: targetBusiness,
          poNumber: targetPo,
          note: targetNote,
        },
        lines: [
          {
            variantId: 'gid://shopify/ProductVariant/99001',
            quantity: 2,
          },
        ],
        dataVersion: 2,
      });

      expect(submission.success).toBe(true);
      expect(submission.draftOrderId).toBe('gid://shopify/DraftOrder/888001');

      // 1. Check OrderSubmission table
      const storedSubmission = await prisma.orderSubmission.findUnique({
        where: { id: submission.submissionId },
      });
      expect(storedSubmission).toBeTruthy();
      expect(storedSubmission?.status).toBe('COMPLETED');
      const submissionJson = JSON.stringify(storedSubmission);
      expect(submissionJson).not.toContain(targetEmail);
      expect(submissionJson).not.toContain(targetBusiness);
      expect(submissionJson).not.toContain(targetPo);
      expect(submissionJson).not.toContain(targetNote);

      // 2. Check AnalyticsEvent table
      const analyticsEvents = await prisma.analyticsEvent.findMany({
        where: { shopId: shop.id },
      });
      const analyticsJson = JSON.stringify(analyticsEvents);
      expect(analyticsJson).not.toContain(targetEmail);
      expect(analyticsJson).not.toContain(targetBusiness);
      expect(analyticsJson).not.toContain(targetPo);
      expect(analyticsJson).not.toContain(targetNote);

      // 3. Check RuntimeIncident table
      const incidents = await prisma.runtimeIncident.findMany();
      const incidentsJson = JSON.stringify(incidents);
      expect(incidentsJson).not.toContain(targetEmail);
      expect(incidentsJson).not.toContain(targetBusiness);
      expect(incidentsJson).not.toContain(targetPo);
      expect(incidentsJson).not.toContain(targetNote);

      // 4. Check BackgroundJob table
      const jobs = await prisma.backgroundJob.findMany();
      const jobsJson = JSON.stringify(jobs);
      expect(jobsJson).not.toContain(targetEmail);
      expect(jobsJson).not.toContain(targetBusiness);
      expect(jobsJson).not.toContain(targetPo);
      expect(jobsJson).not.toContain(targetNote);

      // 5. Check PcdAccessAudit table
      const audits = await prisma.pcdAccessAudit.findMany({
        where: { shopId: shop.id },
      });
      expect(audits.length).toBeGreaterThan(0);
      const auditJson = JSON.stringify(audits);
      expect(auditJson).not.toContain(targetEmail);
      expect(auditJson).not.toContain(targetBusiness);
      expect(auditJson).not.toContain(targetPo);
      expect(auditJson).not.toContain(targetNote);
      expect(audits[0].action).toBe(PCD_AUDIT_ACTIONS.BUYER_EMAIL_PROCESSED_FOR_DRAFT_ORDER);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. DATA LOSS PREVENTION (DLP) & LOGGING REDACTION
  // ───────────────────────────────────────────────────────────────────────────
  describe('3. DLP Hardening & Redaction', () => {
    it('redactSensitiveString redacts emails, tokens, credentials, PO numbers, and business fields', () => {
      const input = 'Error for buyer@example.com with token shpat_secret12345 and PO-SECRET-999 connected to postgresql://user:pass@dbhost.internal/db';
      const output = redactSensitiveString(input);

      expect(output).not.toContain('buyer@example.com');
      expect(output).toContain('[REDACTED_EMAIL]');
      expect(output).not.toContain('shpat_secret12345');
      expect(output).toContain('[REDACTED_SHOPIFY_TOKEN]');
      expect(output).not.toContain('PO-SECRET-999');
      expect(output).toContain('[REDACTED_PO]');
      expect(output).not.toContain('pass@dbhost');
      expect(output).toContain('[REDACTED_PASSWORD]');
    });

    it('logger.error prevents Error.message, Error.stack, and Error.cause from leaking raw PII or secrets', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const adversarialError = new Error('Database connection failed for customer buyer.adverse@target.com with auth Bearer secret_bearer_token');
      (adversarialError as any).cause = {
        internalEmail: 'cause.email@victim.com',
        apiKey: 'shppat_secret_partner_token',
      };

      logger.error('Unhandled failure', adversarialError, {
        shopDomain: 'test-shop.myshopify.com',
        buyerEmail: 'unhandled@buyer.com',
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
      const loggedOutput = consoleErrorSpy.mock.calls.map((c) => JSON.stringify(c)).join(' ');

      expect(loggedOutput).not.toContain('buyer.adverse@target.com');
      expect(loggedOutput).not.toContain('secret_bearer_token');
      expect(loggedOutput).not.toContain('cause.email@victim.com');
      expect(loggedOutput).not.toContain('shppat_secret_partner_token');
      expect(loggedOutput).not.toContain('unhandled@buyer.com');
    });

    it('sanitizeErrorMessage redacts sensitive error messages before sending to client or storing', () => {
      const rawError = new Error('Shopify rejected order for WholesaleBuyer@corp.com with poNumber: PO-PRIV-777');
      const safe = sanitizeErrorMessage(rawError);

      expect(safe).not.toContain('WholesaleBuyer@corp.com');
      expect(safe).not.toContain('PO-PRIV-777');
      expect(safe).toContain('[REDACTED_EMAIL]');
    });

    it('recordRuntimeIncident redacts message and metadata to guarantee zero raw PII in database', async () => {
      await recordRuntimeIncident({
        type: 'SUBMIT_FAILURE',
        shopDomain: shop.shopDomain,
        message: 'Order failed for buyer.incident@secret.org with secret key shpss_super_secret',
        metadata: {
          email: 'metadata.leak@secret.org',
          note: 'Sensitive order note text',
          subtotal: 100.5,
        },
      });

      const incident = await prisma.runtimeIncident.findFirst({
        where: { shopDomain: shop.shopDomain },
      });

      expect(incident).toBeTruthy();
      expect(incident?.message).not.toContain('buyer.incident@secret.org');
      expect(incident?.message).not.toContain('shpss_super_secret');
      expect(incident?.message).toContain('[REDACTED_EMAIL]');

      const metadataStr = JSON.stringify(incident?.metadata);
      expect(metadataStr).not.toContain('metadata.leak@secret.org');
      expect(metadataStr).not.toContain('Sensitive order note text');
      expect(metadataStr).toContain('[REDACTED]');
    });

    it('analytics metadata sanitizer strictly blocks buyer PII and unapproved keys', () => {
      const sanitized = sanitizeAnalyticsMetadata(ANALYTICS_EVENTS.ORDER_SUBMITTED, {
        submissionId: 'sub-12345',
        itemCount: 10,
        email: 'attacker@leak.com',
        buyerName: 'Jane Doe',
        poNumber: 'PO-999',
        note: 'Secret instructions',
      });

      expect(sanitized).toBeTruthy();
      const parsed = JSON.parse(sanitized!);
      expect(parsed.submissionId).toBe('sub-12345');
      expect(parsed.itemCount).toBe(10);
      expect(parsed.email).toBeUndefined();
      expect(parsed.buyerName).toBeUndefined();
      expect(parsed.poNumber).toBeUndefined();
      expect(parsed.note).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. RETENTION CLEANUP
  // ───────────────────────────────────────────────────────────────────────────
  describe('4. Bounded Operational Data Retention', () => {
    it('enforceDataRetention purges stale records and preserves active operational records', async () => {
      const now = new Date('2026-09-27T12:00:00Z');

      // 1. Create stale incident (35 days old) vs fresh incident (10 days old)
      const staleDate = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);
      const freshDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

      await prisma.runtimeIncident.create({
        data: {
          type: 'STALE_INCIDENT',
          message: 'Old incident',
          createdAt: staleDate,
        },
      });
      await prisma.runtimeIncident.create({
        data: {
          type: 'FRESH_INCIDENT',
          message: 'Recent incident',
          createdAt: freshDate,
        },
      });

      // 2. Create stale terminal job (18 days old) vs fresh job (5 days old)
      const staleJobDate = new Date(now.getTime() - 18 * 24 * 60 * 60 * 1000);
      await prisma.backgroundJob.create({
        data: {
          type: 'PRODUCT_SYNC',
          status: 'COMPLETED',
          createdAt: staleJobDate,
        },
      });
      await prisma.backgroundJob.create({
        data: {
          type: 'PRODUCT_SYNC',
          status: 'PENDING',
          createdAt: staleJobDate, // Pending job must NOT be deleted even if old
        },
      });

      // 3. Create stale webhook receipt (35 days old)
      await prisma.webhookReceipt.create({
        data: {
          webhookId: 'stale-webhook-1',
          topic: 'products/update',
          shopDomain: shop.shopDomain,
          status: 'COMPLETED',
          processedAt: staleDate,
        },
      });

      // 4. Create stale PCD access audit (95 days old) vs fresh audit (5 days old)
      const staleAuditDate = new Date(now.getTime() - 95 * 24 * 60 * 60 * 1000);
      await prisma.pcdAccessAudit.create({
        data: {
          shopId: shop.id,
          action: PCD_AUDIT_ACTIONS.BUYER_EMAIL_PROCESSED_FOR_DRAFT_ORDER,
          purpose: 'Stale audit',
          actorType: 'BUYER',
          createdAt: staleAuditDate,
        },
      });
      await prisma.pcdAccessAudit.create({
        data: {
          shopId: shop.id,
          action: PCD_AUDIT_ACTIONS.BUYER_EMAIL_PROCESSED_FOR_DRAFT_ORDER,
          purpose: 'Fresh audit',
          actorType: 'BUYER',
          createdAt: freshDate,
        },
      });

      const result = await enforceDataRetention({ now });

      expect(result.deletedIncidents).toBe(1);
      expect(result.deletedWebhooks).toBe(1);
      expect(result.deletedJobs).toBe(1); // Only the COMPLETED job, not the PENDING one
      expect(result.deletedAudits).toBe(1);

      // Verify fresh incident was retained
      const remainingIncidents = await prisma.runtimeIncident.findMany();
      expect(remainingIncidents.length).toBe(1);
      expect(remainingIncidents[0].type).toBe('FRESH_INCIDENT');

      // Verify fresh audit was retained
      const remainingAudits = await prisma.pcdAccessAudit.findMany();
      expect(remainingAudits.length).toBe(1);
      expect(remainingAudits[0].purpose).toBe('Fresh audit');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. COMPLIANCE WEBHOOKS & SHOP REDACTION
  // ───────────────────────────────────────────────────────────────────────────
  describe('5. Compliance Webhooks & Shop Purge', () => {
    const apiSecret = 'test_api_secret_compliance_123';

    beforeEach(() => {
      process.env.SHOPIFY_API_SECRET = apiSecret;
    });

    it('customers/data_request: valid HMAC returns 200 and records zero-PII audit', async () => {
      const payload = JSON.stringify({
        shop_id: 12345,
        shop_domain: shop.shopDomain,
        customer: { id: 9876, email: 'request@buyer.com' },
      });
      const hmac = crypto.createHmac('sha256', apiSecret).update(payload, 'utf8').digest('base64');

      const res = await request(app)
        .post('/api/webhooks/compliance/customers-data-request')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('No customer PII stored');

      const audits = await prisma.pcdAccessAudit.findMany({
        where: { action: PCD_AUDIT_ACTIONS.CUSTOMERS_DATA_REQUEST_RECEIVED },
      });
      expect(audits.length).toBe(1);
      expect(JSON.stringify(audits)).not.toContain('request@buyer.com');
    });

    it('customers/redact: valid HMAC returns 200 and records zero-PII audit', async () => {
      const payload = JSON.stringify({
        shop_id: 12345,
        shop_domain: shop.shopDomain,
        customer: { id: 9876, email: 'redact@buyer.com' },
      });
      const hmac = crypto.createHmac('sha256', apiSecret).update(payload, 'utf8').digest('base64');

      const res = await request(app)
        .post('/api/webhooks/compliance/customers-redact')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('No customer PII to redact');
    });

    it('compliance endpoints reject requests with invalid HMAC with 401', async () => {
      const payload = JSON.stringify({ shop_domain: shop.shopDomain });
      const badHmac = 'invalid_tampered_hmac';

      const res1 = await request(app)
        .post('/api/webhooks/compliance/customers-data-request')
        .set('X-Shopify-Hmac-Sha256', badHmac)
        .set('Content-Type', 'application/json')
        .send(payload);
      expect(res1.status).toBe(401);

      const res2 = await request(app)
        .post('/api/webhooks/compliance/customers-redact')
        .set('X-Shopify-Hmac-Sha256', badHmac)
        .set('Content-Type', 'application/json')
        .send(payload);
      expect(res2.status).toBe(401);

      const res3 = await request(app)
        .post('/api/webhooks/compliance/shop-redact')
        .set('X-Shopify-Hmac-Sha256', badHmac)
        .set('Content-Type', 'application/json')
        .send(payload);
      expect(res3.status).toBe(401);
    });

    it('shop/redact: valid HMAC permanently purges all shop records, catalogs, and non-FK operational records (zero lingering data)', async () => {
      // Seed shop-identifiable operational records without FK cascade
      await prisma.webhookReceipt.create({
        data: {
          webhookId: 'test-wh-receipt-' + Date.now(),
          topic: 'app/uninstalled',
          shopDomain: shop.shopDomain,
          status: 'COMPLETED',
        },
      });

      await prisma.runtimeIncident.create({
        data: {
          type: 'SUBMIT_FAILURE',
          shopDomain: shop.shopDomain,
          message: 'Transient incident before uninstall',
        },
      });

      await prisma.pcdAccessAudit.create({
        data: {
          shopId: shop.id,
          action: PCD_AUDIT_ACTIONS.BUYER_EMAIL_PROCESSED_FOR_DRAFT_ORDER,
          purpose: 'Historical order submission test',
          actorType: 'BUYER',
        },
      });

      const payload = JSON.stringify({
        shop_id: 12345,
        shop_domain: shop.shopDomain,
      });
      const hmac = crypto.createHmac('sha256', apiSecret).update(payload, 'utf8').digest('base64');

      const res = await request(app)
        .post('/api/webhooks/compliance/shop-redact')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Shop data redacted successfully');

      // 1. Verify shop itself is erased
      const dbShopById = await prisma.shop.findUnique({ where: { id: shop.id } });
      const dbShopByDomain = await prisma.shop.findUnique({ where: { shopDomain: shop.shopDomain } });
      expect(dbShopById).toBeNull();
      expect(dbShopByDomain).toBeNull();

      // 2. Verify FK-cascaded tables are completely erased
      const dbCatalogs = await prisma.catalog.findMany({ where: { shopId: shop.id } });
      expect(dbCatalogs.length).toBe(0);

      // 3. Verify non-FK tables are explicitly purged (ZERO lingering records)
      const remainingWebhooks = await prisma.webhookReceipt.findMany({ where: { shopDomain: shop.shopDomain } });
      expect(remainingWebhooks.length).toBe(0);

      const remainingIncidents = await prisma.runtimeIncident.findMany({ where: { shopDomain: shop.shopDomain } });
      expect(remainingIncidents.length).toBe(0);

      const remainingAudits = await prisma.pcdAccessAudit.findMany({
        where: { shopId: { in: [shop.id, shop.shopDomain] } },
      });
      expect(remainingAudits.length).toBe(0);
    });

    it('shop/redact: already-deleted or unknown shop returns safe 200 (idempotent)', async () => {
      const payload = JSON.stringify({
        shop_id: 99999,
        shop_domain: 'already-deleted-shop.myshopify.com',
      });
      const hmac = crypto.createHmac('sha256', apiSecret).update(payload, 'utf8').digest('base64');

      const res = await request(app)
        .post('/api/webhooks/compliance/shop-redact')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', 'already-deleted-shop.myshopify.com')
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);
    });

    it('shop/redact: database deletion failure returns non-2xx so Shopify can retry', async () => {
      const payload = JSON.stringify({
        shop_id: 12345,
        shop_domain: shop.shopDomain,
      });
      const hmac = crypto.createHmac('sha256', apiSecret).update(payload, 'utf8').digest('base64');

      const redactSpy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(
        new Error('Database lock acquisition timeout during redact')
      );

      const res = await request(app)
        .post('/api/webhooks/compliance/shop-redact')
        .set('X-Shopify-Hmac-Sha256', hmac)
        .set('X-Shopify-Shop-Domain', shop.shopDomain)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();

      redactSpy.mockRestore();
    });

    it('privacy and support pages no longer promise "deleted within 48 hours"', async () => {
      const supportRes = await request(app).get('/support');
      expect(supportRes.status).toBe(200);
      expect(supportRes.text).not.toContain('deleted within 48');
      expect(supportRes.text).not.toContain('All data is deleted within 48 hours');

      const privacyRes = await request(app).get('/privacy');
      expect(privacyRes.status).toBe(200);
      expect(privacyRes.text).not.toContain('deleted within 48');
      expect(privacyRes.text).toContain('approximately 48 hours');
    });

    it('strict plan handle mapping prevents arbitrary or fake strings from granting paid entitlement', () => {
      // Canonical handles
      expect(mapShopifyAppPricingHandleToPlan('free')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan('starter')).toBe(PlanTier.STARTER);
      expect(mapShopifyAppPricingHandleToPlan('growth')).toBe(PlanTier.GROWTH);

      // Whitelisted legacy aliases
      expect(mapShopifyAppPricingHandleToPlan('catalogflow_starter')).toBe(PlanTier.STARTER);
      expect(mapShopifyAppPricingHandleToPlan('catalogflow_growth')).toBe(PlanTier.GROWTH);

      // Attack / arbitrary strings must NEVER grant paid tiers
      expect(mapShopifyAppPricingHandleToPlan('fake_growth')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan('growth_fake')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan('starter-test')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan('notgrowth')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan('catalogflow_growth_fake')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan('enterprise')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan('pro')).toBe(PlanTier.FREE);
      expect(mapShopifyAppPricingHandleToPlan('growth_unlimited')).toBe(PlanTier.FREE);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. TEST / PRODUCTION ENVIRONMENT SEPARATION GUARD
  // ───────────────────────────────────────────────────────────────────────────
  describe('6. Test / Production Database Separation Guard', () => {
    it('refuses execution if test runner database matches designated production database', () => {
      const prodUrl = 'postgresql://catalogflow_user:secret@production-db.internal.cloud:5432/catalogflow_prod';

      expect(() => {
        validateDatabaseEnvironmentForContext({
          nodeEnv: 'test',
          databaseUrl: prodUrl,
          productionDatabaseUrl: prodUrl,
        });
      }).toThrow(DatabaseEnvironmentError);
    });

    it('refuses execution if database URL contains explicit production indicators in test mode', () => {
      const prodNamedUrl = 'postgresql://admin:pass@postgres.prod.company.com:5432/orders_prod';

      expect(() => {
        validateDatabaseEnvironmentForContext({
          nodeEnv: 'test',
          databaseUrl: prodNamedUrl,
        });
      }).toThrow(DatabaseEnvironmentError);
    });

    it('accepts isolated test database URLs in test mode', () => {
      const testDbUrl = 'postgresql://postgres:postgres@localhost:5432/catalogflow_test?schema=public';

      const res = validateDatabaseEnvironmentForContext({
        nodeEnv: 'test',
        databaseUrl: testDbUrl,
        productionDatabaseUrl: 'postgresql://prod:pass@production-host:5432/prod_db',
      });

      expect(res.ok).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. TOKENS ENCRYPTED AT REST
  // ───────────────────────────────────────────────────────────────────────────
  describe('7. Merchant Token Encryption at Rest', () => {
    it('offline access token is stored with AES-256-GCM envelope and cannot be read in plaintext', async () => {
      const dbShop = await prisma.shop.findUnique({
        where: { id: shop.id },
      });

      expect(dbShop).toBeTruthy();
      expect(dbShop?.accessToken).toMatch(/^enc:v1:[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);
      expect(dbShop?.accessToken).not.toContain('shpat_test_token_12345');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. ENCRYPTED BACKUP ARCHITECTURE (SafeMerge PostgreSQL Pattern)
  // ───────────────────────────────────────────────────────────────────────────
  describe('8. Encrypted Backup Architecture (SafeMerge PostgreSQL Pattern)', () => {
    it('backup architecture uses AES-256-GCM authenticated envelopes with guaranteed plaintext cleanup', async () => {
      const {
        generateBackupEncryptionKey,
        parseBackupEncryptionKey,
        decryptBackupFile,
      } = await import('../scripts/backup-crypto.js');
      const { runDatabaseBackup } = await import('../scripts/backup-database.js');

      const keyBase64 = generateBackupEncryptionKey();
      const tempDir = path.join(os.tmpdir(), `pcd-bkp-test-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        let plaintextTempCreated = '';
        const mockDump = async (args: string[]) => {
          const fileArg = args.find((a) => a.startsWith('--file='));
          plaintextTempCreated = fileArg!.replace('--file=', '');
          fs.writeFileSync(plaintextTempCreated, 'MOCK_PG_DUMP_DATA');
          return { stdout: '', stderr: '' };
        };

        const res = await runDatabaseBackup({
          databaseBackupUrl: 'postgresql://user:pass@hostless-bkp.internal/catalogflow',
          backupEncryptionKey: keyBase64,
          tempDir,
          outputDir: tempDir,
          dumpExecutor: mockDump,
        });

        expect(res.encryptedFilePath.endsWith('.dump.enc')).toBe(true);
        expect(fs.existsSync(res.encryptedFilePath)).toBe(true);
        // Guaranteed plaintext cleanup
        expect(fs.existsSync(plaintextTempCreated)).toBe(false);

        // Verify authenticated decryption
        const decryptedFile = path.join(tempDir, 'decrypted.dump');
        await decryptBackupFile(res.encryptedFilePath, decryptedFile, parseBackupEncryptionKey(keyBase64));
        expect(fs.readFileSync(decryptedFile, 'utf8')).toBe('MOCK_PG_DUMP_DATA');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

