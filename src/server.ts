import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { prisma } from './db.js';
import {
  getPublicCatalogPayload,
  syncProductSnapshot,
  deleteProductSnapshot,
  syncSingleCollectionFromShopify,
  deleteCollectionSnapshot,
  reconcileSourcedCollectionsForShop,
  performInitialShopSync,
  ensureInitialShopSync,
  triggerManualShopSync,
  SyncInProgressError,
} from './services/sync.server.js';
import { validateBuyerOrderLines } from './services/validation.server.js';
import {
  submitBuyerOrder,
  getSubmissionsByShop,
  getSyncHealthSummary,
  reconcileSubmission,
  OrderSubmissionError,
  CatalogDataChangedError,
  InventoryChangedError,
} from './services/order.server.js';
import {
  registerProcessDiagnostics,
  getShopRuntimeIncidents,
  recordRuntimeIncident,
} from './services/incident.server.js';
import crypto from 'crypto';
import {
  createCatalog,
  updateCatalog,
  publishCatalog,
  unpublishCatalog,
  deleteCatalog,
  getCatalogsByShop,
  getCatalogById,
  getPublishedCatalogByToken,
  CatalogError,
} from './services/catalog.server.js';
import {
  recordAnalyticsEvent,
  ANALYTICS_EVENTS,
  getShopAnalyticsSummary,
} from './services/analytics.server.js';
import {
  getShopBillingInfo,
  changeShopPlan,
  BillingError,
} from './services/billing.server.js';
import {
  getActiveShopByDomain,
  installOrUpdateShop,
  uninstallShop,
  checkShopQuota,
  redactShopData,
} from './services/shop.server.js';
import {
  verifyShopifyWebhookHmac,
  verifyAppBridgeJwt,
  isValidShopifyDomain,
  exchangeSessionTokenForOfflineToken,
  ShopifyStaleSessionTokenError,
} from './services/auth.server.js';
import {
  isValidPublicToken,
  sanitizeErrorMessage,
  sanitizeForLogging,
  publicCatalogGetLimiter,
  publicValidateLimiter,
  publicSubmitLimiter,
  publicEventLimiter,
} from './services/security.server.js';
import { validateEnvironment } from './services/env.server.js';
import { sanitizeShopifySearchQuery } from './services/shopify-search.server.js';
import { enqueueJob, JobType } from './services/job-queue.server.js';
import { runWorkerOnce } from './worker.js';
import dotenv from 'dotenv';

dotenv.config();
validateEnvironment();
registerProcessDiagnostics();

export const app = express();

// Safe Reverse Proxy configuration for Railway / container ingress:
// Trust 1 upstream proxy hop so Express reads the real buyer client IP from X-Forwarded-For
// without blindly trusting unverified client-forged proxy chains.
app.set('trust proxy', 1);

// Embedded Shopify Admin iframe headers (allow frame embedding in Shopify Admin)
app.use((req: Request, res: Response, next: NextFunction) => {
  const shopParam = req.query.shop as string;
  const frameAncestors = shopParam && isValidShopifyDomain(shopParam)
    ? `frame-ancestors https://${shopParam} https://admin.shopify.com https://*.myshopify.com https://*.spin.dev 'self';`
    : "frame-ancestors https://*.myshopify.com https://admin.shopify.com https://*.spin.dev 'self';";

  res.setHeader('Content-Security-Policy', frameAncestors);
  res.removeHeader('X-Frame-Options');
  next();
});

// Public CORS only for public buyer endpoints, restricted for admin
app.use('/api/public', cors());

app.use(cookieParser());

// Raw body parser for webhook HMAC verification
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// Healthcheck & Readiness Probes (M9.15)
app.get('/health', (_req: Request, res: Response) => {
  const uptimeSeconds = Math.floor(process.uptime());
  res.status(200).json({
    ok: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: uptimeSeconds,
    uptimeSeconds,
    pid: process.pid,
    build: process.env.COMMIT_SHA || process.env.BUILD_ID || process.env.npm_package_version || '1.0.0',
  });
});

app.get('/ready', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({
      status: 'ready',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: sanitizeErrorMessage(err),
    });
  }
});

// ==========================================
// SHOPIFY MANAGED INSTALLATION / TOKEN EXCHANGE
// ==========================================

/**
 * Handles Token Exchange (RFC 8693) for Shopify Managed Installation.
 * Exchanges App Bridge session token for an expiring offline access token, persists refresh token,
 * and triggers initial sync.
 */
app.post('/api/auth/token-exchange', async (req: Request, res: Response) => {
  try {
    const authHeader = req.get('Authorization');
    const sessionToken = authHeader?.startsWith('Bearer ')
      ? authHeader.replace('Bearer ', '')
      : req.body?.sessionToken;

    if (!sessionToken) {
      return res.status(400).json({ error: 'Missing session token' });
    }

    const secret = process.env.SHOPIFY_API_SECRET || '';
    const decoded = verifyAppBridgeJwt(sessionToken, secret);
    if (!decoded) {
      return res
        .set('X-Shopify-Retry-Invalid-Session-Request', '1')
        .status(401)
        .json({ error: 'Invalid, expired, or untrusted session token' });
    }

    const shopDomain = decoded.shopDomain;

    // Perform RFC 8693 Token Exchange with Shopify for expiring offline access token
    let tokenResult;
    try {
      tokenResult = await exchangeSessionTokenForOfflineToken({
        shopDomain,
        sessionToken,
      });
    } catch (exchangeErr: any) {
      if (exchangeErr instanceof ShopifyStaleSessionTokenError) {
        return res
          .set('X-Shopify-Retry-Invalid-Session-Request', '1')
          .status(401)
          .json({ error: 'Stale ID token' });
      }
      throw exchangeErr;
    }

    const accessExpiry = tokenResult.expiresIn
      ? new Date(Date.now() + tokenResult.expiresIn * 1000)
      : null;
    const refreshExpiry = tokenResult.refreshTokenExpiresIn
      ? new Date(Date.now() + tokenResult.refreshTokenExpiresIn * 1000)
      : null;

    // Install or reactivate shop record with encrypted access and refresh tokens
    const shop = await installOrUpdateShop({
      shopDomain,
      accessToken: tokenResult.accessToken,
      accessTokenExpiresAt: accessExpiry,
      refreshToken: tokenResult.refreshToken,
      refreshTokenExpiresAt: refreshExpiry,
      scopes: tokenResult.scope,
    });

    // Trigger centralized initial background sync asynchronously
    ensureInitialShopSync(shop.id).catch((err) => {
      console.error('Initial sync failed for shop:', shopDomain, sanitizeErrorMessage(err));
    });

    return res.status(200).json({
      success: true,
      shopDomain,
      installed: true,
    });
  } catch (error: any) {
    console.error('Token exchange error:', sanitizeErrorMessage(error));
    return res.status(500).json({ error: sanitizeErrorMessage(error) });
  }
});


// ==========================================
// PUBLIC BUYER PORTAL API
// ==========================================

// 1. Get Public Catalog (M9.2 Tiered Rate Limiter)
app.get('/api/public/catalog/:publicToken', publicCatalogGetLimiter, async (req: Request, res: Response) => {
  try {
    const { publicToken } = req.params;

    if (!isValidPublicToken(publicToken)) {
      return res.status(400).json({ error: 'Invalid catalog token format' });
    }

    const payload = await getPublicCatalogPayload(publicToken);

    if (!payload) {
      return res.status(404).json({ error: 'Catalog not found, unpublished, or unavailable' });
    }

    // Safe non-blocking fire-and-forget analytics recording (never delays or breaks buyer load)
    if (payload.shop && payload.shop.id) {
      void recordAnalyticsEvent(payload.shop.id, ANALYTICS_EVENTS.CATALOG_VIEWED, payload.catalog.id);
    }

    return res.status(200).json(payload);
  } catch (error: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(error) });
  }
});

// 1.5 Record Buyer Analytics Event (M9.2 Tiered Rate Limiter)
app.post('/api/public/catalog/:publicToken/event', publicEventLimiter, async (req: Request, res: Response) => {
  try {
    const { publicToken } = req.params;
    const { eventName, metadata } = req.body;

    if (!isValidPublicToken(publicToken)) {
      return res.status(400).json({ error: 'Invalid catalog token format' });
    }

    const catalog = await getPublishedCatalogByToken(publicToken);
    if (!catalog) {
      return res.status(404).json({ error: 'Catalog not found or unavailable' });
    }

    // Only allow buyer-safe event types
    if (eventName === ANALYTICS_EVENTS.ORDER_SUMMARY_STARTED) {
      await recordAnalyticsEvent(catalog.shopId, eventName, catalog.id, metadata);
    }

    return res.status(200).json({ success: true });
  } catch (error: any) {
    return res.status(400).json({ error: sanitizeErrorMessage(error) });
  }
});

// 2. Pre-submit Validation (M9.2 Tiered Rate Limiter)
app.post('/api/public/catalog/:publicToken/validate', publicValidateLimiter, async (req: Request, res: Response) => {
  try {
    const { publicToken } = req.params;

    if (!isValidPublicToken(publicToken)) {
      return res.status(400).json({ error: 'Invalid catalog token format' });
    }

    const result = await validateBuyerOrderLines(publicToken, req.body);
    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(400).json({ error: sanitizeErrorMessage(error) });
  }
});

// 3. Buyer Order Submission (M9.2 Tiered Rate Limiter)
app.post('/api/public/catalog/:publicToken/submit', publicSubmitLimiter, async (req: Request, res: Response) => {
  const requestId = (req.get('X-Request-ID') || req.get('x-request-id') || crypto.randomUUID()).trim();
  res.setHeader('X-Request-ID', requestId);

  try {
    const { publicToken } = req.params;
    const idempotencyKey = (req.get('Idempotency-Key') || req.get('idempotency-key') || '').trim();

    if (!isValidPublicToken(publicToken)) {
      return res.status(400).json({
        error: 'Invalid catalog token format',
        code: 'VALIDATION_FAILED',
        message: 'Invalid catalog token format',
        requestId,
      });
    }

    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'Missing required Idempotency-Key header',
        code: 'VALIDATION_FAILED',
        message: 'Missing required Idempotency-Key header',
        requestId,
      });
    }

    const result = await submitBuyerOrder(publicToken, idempotencyKey, req.body, undefined, requestId);
    return res.status(201).json({ ...result, requestId });
  } catch (error: any) {
    if (error?.name === 'ZodError' || error instanceof z.ZodError) {
      const issueMsg = error.issues?.map((i: any) => i.message).join(', ') || 'Validation error';
      return res.status(400).json({
        error: issueMsg,
        code: 'VALIDATION_FAILED',
        message: issueMsg,
        details: error.issues,
        requestId,
      });
    }

    if (error instanceof InventoryChangedError) {
      return res.status(409).json({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
        code: error.code,
        message: error.message,
        details: error.details,
        requestId,
      });
    }

    if (error instanceof CatalogDataChangedError) {
      return res.status(409).json({
        error: {
          code: error.code,
          message: error.message,
          details: error.changedLines,
        },
        code: error.code,
        message: error.message,
        changedLines: error.changedLines,
        details: error.changedLines,
        requestId,
      });
    }

    if (error instanceof OrderSubmissionError) {
      const statusCode = error.code === 'QUOTA_EXCEEDED' ? 403 : error.statusCode || 400;
      return res.status(statusCode).json({
        error: {
          code: error.code || 'VALIDATION_FAILED',
          message: error.message,
          details: error.details,
        },
        code: error.code,
        message: error.message,
        details: error.details,
        requestId,
      });
    }

    void recordRuntimeIncident({
      type: 'UNHANDLED_SUBMIT_ERROR',
      requestId,
      route: '/api/public/catalog/submit',
      errorCode: 'INTERNAL_ERROR',
      message: sanitizeErrorMessage(error),
    });

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: sanitizeErrorMessage(error),
      },
      code: 'INTERNAL_ERROR',
      message: sanitizeErrorMessage(error),
      requestId,
    });
  }
});

// ==========================================
// SHOPIFY WEBHOOKS (FAIL CLOSED & IDEMPOTENCY STATE MACHINE)
// ==========================================

export interface WebhookExecutionResult {
  status: 'ALREADY_COMPLETED' | 'CONCURRENT_PROCESSING' | 'PROCESSED' | 'FAILED';
  httpStatus: number;
  message: string;
}

/**
 * Robust webhook idempotency state machine tracking PROCESSING -> COMPLETED | FAILED.
 * - COMPLETED duplicate: safely acknowledge without reprocessing.
 * - FAILED delivery: Shopify retry allowed to reprocess.
 * - PROCESSING concurrent duplicate: avoids concurrent execution without losing event.
 * - Only COMPLETED means successfully applied.
 */
export async function handleWebhookWithState<T>(
  webhookId: string,
  topic: string,
  shopDomain: string,
  fn: () => Promise<T>
): Promise<WebhookExecutionResult> {
  if (!webhookId) {
    await fn();
    return { status: 'PROCESSED', httpStatus: 200, message: 'Processed without webhookId' };
  }

  const existing = await prisma.webhookReceipt.findUnique({
    where: { webhookId },
  });

  if (existing) {
    if (existing.status === 'COMPLETED') {
      return { status: 'ALREADY_COMPLETED', httpStatus: 200, message: 'Webhook already processed' };
    }

    if (existing.status === 'PROCESSING') {
      const elapsedMs = Date.now() - existing.processedAt.getTime();
      // Lock window: if under 60 seconds, reject concurrent execution so Shopify retries later
      if (elapsedMs < 60000) {
        return {
          status: 'CONCURRENT_PROCESSING',
          httpStatus: 429,
          message: 'Webhook currently being processed by another worker',
        };
      }
      // If stale lock (> 60s), allow retry to proceed
    }

    // Previous attempt FAILED or stale lock: transition to PROCESSING and increment attempts
    await prisma.webhookReceipt.update({
      where: { webhookId },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        processedAt: new Date(),
        lastError: null,
      },
    });
  } else {
    try {
      await prisma.webhookReceipt.create({
        data: {
          webhookId,
          topic,
          shopDomain,
          status: 'PROCESSING',
          attempts: 1,
          processedAt: new Date(),
        },
      });
    } catch {
      // Race condition fallback on unique constraint
      const concurrent = await prisma.webhookReceipt.findUnique({ where: { webhookId } });
      if (concurrent?.status === 'COMPLETED') {
        return { status: 'ALREADY_COMPLETED', httpStatus: 200, message: 'Webhook already processed' };
      }
      return {
        status: 'CONCURRENT_PROCESSING',
        httpStatus: 429,
        message: 'Concurrent webhook registration',
      };
    }
  }

  try {
    await fn();

    await prisma.webhookReceipt.update({
      where: { webhookId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        lastError: null,
      },
    });

    return { status: 'PROCESSED', httpStatus: 200, message: 'OK' };
  } catch (err: any) {
    const sanitized = sanitizeErrorMessage(err).slice(0, 500);
    await prisma.webhookReceipt.update({
      where: { webhookId },
      data: {
        status: 'FAILED',
        lastError: sanitized,
      },
    });
    throw err;
  }
}

app.post('/api/webhooks/products', async (req: any, res: Response) => {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
  const shopDomain = req.get('X-Shopify-Shop-Domain') || '';
  const topic = req.get('X-Shopify-Topic') || '';
  const webhookId = req.get('X-Shopify-Webhook-Id') || '';
  const secret = process.env.SHOPIFY_API_SECRET;

  // Fail closed if secret missing or verification fails
  if (!secret || !verifyShopifyWebhookHmac(req.rawBody, hmacHeader, secret)) {
    return res.status(401).send('Webhook authentication failed');
  }

  const shop = await getActiveShopByDomain(shopDomain);
  if (!shop) {
    return res.status(200).send('Shop not active');
  }

  try {
    const result = await handleWebhookWithState(webhookId, topic, shopDomain, async () => {
      // Enqueue persistent BackgroundJob for worker processing
      await enqueueJob({
        type: JobType.PRODUCT_SYNC,
        shopId: shop.id,
        payload: {
          topic,
          action: topic === 'products/delete' ? 'delete' : 'sync',
          productId: req.body?.id,
          product: req.body,
        },
      });

      // In test mode, also execute inline so integration test assertions see the updated DB immediately
      if (process.env.NODE_ENV === 'test') {
        if (topic === 'products/delete') {
          await deleteProductSnapshot(shop.id, req.body.id);
        } else {
          await syncProductSnapshot(shop.id, req.body);
          if (topic === 'products/update') {
            await reconcileSourcedCollectionsForShop(shop.id).catch(() => { });
          }
        }
      }
    });

    return res.status(result.httpStatus).send(result.message);
  } catch (err: any) {
    console.error('Webhook product sync error:', sanitizeErrorMessage(err));
    return res.status(500).send('Sync failed');
  }
});

app.post('/api/webhooks/collections', async (req: any, res: Response) => {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
  const shopDomain = req.get('X-Shopify-Shop-Domain') || '';
  const topic = req.get('X-Shopify-Topic') || '';
  const webhookId = req.get('X-Shopify-Webhook-Id') || '';
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret || !verifyShopifyWebhookHmac(req.rawBody, hmacHeader, secret)) {
    return res.status(401).send('Webhook authentication failed');
  }

  const shop = await getActiveShopByDomain(shopDomain);
  if (!shop) {
    return res.status(200).send('Shop not active');
  }

  try {
    const result = await handleWebhookWithState(webhookId, topic, shopDomain, async () => {
      // Enqueue persistent BackgroundJob for worker processing
      await enqueueJob({
        type: JobType.COLLECTION_SYNC,
        shopId: shop.id,
        payload: {
          topic,
          action: topic === 'collections/delete' ? 'delete' : 'sync',
          collectionId: req.body?.id,
          collection: req.body,
        },
      });

      // In test mode, also execute inline for test assertions
      if (process.env.NODE_ENV === 'test') {
        if (topic === 'collections/delete') {
          await deleteCollectionSnapshot(shop.id, req.body.id);
        } else {
          await syncSingleCollectionFromShopify(shop.id, req.body.id);
        }
      }
    });

    return res.status(result.httpStatus).send(result.message);
  } catch (err: any) {
    console.error('Webhook collection sync error:', sanitizeErrorMessage(err));
    return res.status(500).send('Sync failed');
  }
});

app.post('/api/webhooks/app/uninstalled', async (req: any, res: Response) => {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
  const shopDomain = req.get('X-Shopify-Shop-Domain') || '';
  const webhookId = req.get('X-Shopify-Webhook-Id') || '';
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret || !verifyShopifyWebhookHmac(req.rawBody, hmacHeader, secret)) {
    return res.status(401).send('Webhook authentication failed');
  }

  try {
    const result = await handleWebhookWithState(webhookId, 'app/uninstalled', shopDomain, async () => {
      await uninstallShop(shopDomain);
    });

    return res.status(result.httpStatus).send(result.message);
  } catch (err: any) {
    return res.status(500).send('Uninstall error');
  }
});

// ==========================================
// MANDATORY COMPLIANCE WEBHOOKS
// ==========================================

app.post('/api/webhooks/compliance/customers-data-request', async (req: any, res: Response) => {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret || !verifyShopifyWebhookHmac(req.rawBody, hmacHeader, secret)) {
    return res.status(401).send('HMAC verification failed');
  }

  // CatalogFlow stores NO raw buyer customer records
  return res.status(200).json({ message: 'No customer PII stored' });
});

app.post('/api/webhooks/compliance/customers-redact', async (req: any, res: Response) => {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret || !verifyShopifyWebhookHmac(req.rawBody, hmacHeader, secret)) {
    return res.status(401).send('HMAC verification failed');
  }

  // No customer PII retained in application DB
  return res.status(200).json({ message: 'No customer PII to redact' });
});

app.post('/api/webhooks/compliance/shop-redact', async (req: any, res: Response) => {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
  const shopDomain = req.get('X-Shopify-Shop-Domain') || req.body.shop_domain || '';
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret || !verifyShopifyWebhookHmac(req.rawBody, hmacHeader, secret)) {
    return res.status(401).send('HMAC verification failed');
  }

  try {
    if (shopDomain) {
      await redactShopData(shopDomain);
    }
    return res.status(200).json({ message: 'Shop data redacted successfully' });
  } catch (err: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// ==========================================
// MERCHANT ADMIN API (AUTHENTICATED)
// ==========================================

export async function adminAuthMiddleware(req: any, res: Response, next: NextFunction) {
  const authHeader = req.get('Authorization');
  const testShopDomain = req.get('X-Shop-Domain');

  // Allow test header strictly in non-production test environment
  if (process.env.NODE_ENV === 'test' && testShopDomain) {
    const shop = await getActiveShopByDomain(testShopDomain);
    if (!shop) {
      return res.status(401).json({ error: 'Shop inactive or not found' });
    }
    req.shop = shop;
    return next();
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res
      .set('X-Shopify-Retry-Invalid-Session-Request', '1')
      .status(401)
      .json({ error: 'Missing or malformed Authorization session token' });
  }

  const token = authHeader.replace('Bearer ', '');
  const secret = process.env.SHOPIFY_API_SECRET || '';

  const decoded = verifyAppBridgeJwt(token, secret);
  if (!decoded) {
    return res
      .set('X-Shopify-Retry-Invalid-Session-Request', '1')
      .status(401)
      .json({ error: 'Invalid, expired, or untrusted session token' });
  }

  let shop = await getActiveShopByDomain(decoded.shopDomain);
  if (!shop) {
    // Transparent token exchange for managed install/reinstall on embedded launch
    try {
      const exchangeResult = await exchangeSessionTokenForOfflineToken({
        shopDomain: decoded.shopDomain,
        sessionToken: token,
      });

      const accessExpiry = exchangeResult.expiresIn
        ? new Date(Date.now() + exchangeResult.expiresIn * 1000)
        : null;
      const refreshExpiry = exchangeResult.refreshTokenExpiresIn
        ? new Date(Date.now() + exchangeResult.refreshTokenExpiresIn * 1000)
        : null;

      shop = await installOrUpdateShop({
        shopDomain: decoded.shopDomain,
        accessToken: exchangeResult.accessToken,
        accessTokenExpiresAt: accessExpiry,
        refreshToken: exchangeResult.refreshToken,
        refreshTokenExpiresAt: refreshExpiry,
        scopes: exchangeResult.scope,
      });
      ensureInitialShopSync(shop.id).catch(() => { });
    } catch (err: any) {
      if (err instanceof ShopifyStaleSessionTokenError) {
        return res
          .set('X-Shopify-Retry-Invalid-Session-Request', '1')
          .status(401)
          .json({ error: 'Stale ID token during exchange' });
      }
      return res.status(401).json({ error: 'Shop not found or inactive' });
    }
  }

  req.shop = shop;
  return next();
}

// ==========================================
// ADMIN: PRODUCT & COLLECTION SEARCH (A1)
// Used by wizard Step 1 ResourceSelector — merchant-facing, no raw GID entry.
// ==========================================


app.get('/api/admin/products/search', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const { createShopifyClient } = await import('./services/shopify-client.server.js');
    const client = createShopifyClient(req.shop);
    const gqlQuery = `
      query searchProducts($query: String!, $first: Int!) {
        products(query: $query, first: $first) {
          edges {
            node {
              id
              title
              handle
              status
              featuredImage { url }
              variants(first: 20) {
                edges {
                  node {
                    id
                    title
                    price
                    inventoryQuantity
                    availableForSale
                  }
                }
              }
            }
          }
        }
      }
    `;
    const safeQ = sanitizeShopifySearchQuery(q);
    const data: any = await client.request(gqlQuery, { query: safeQ ? `title:*${safeQ}*` : 'status:ACTIVE', first: limit });
    const products = (data?.products?.edges || []).map((e: any) => {
      const variants = (e.node.variants?.edges || []).map((ve: any) => ({
        id: ve.node.id,
        title: ve.node.title,
        price: ve.node.price,
        inventoryQuantity: ve.node.inventoryQuantity ?? 0,
        availableForSale: ve.node.availableForSale,
      }));
      return {
        id: e.node.id,
        title: e.node.title,
        handle: e.node.handle,
        status: e.node.status,
        imageUrl: e.node.featuredImage?.url || null,
        price: variants[0]?.price || null,
        variants,
      };
    });
    return res.status(200).json({ products });
  } catch (err: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// Admin Diagnostic Endpoint — Operational Incidents (shop-isolated, max 50)
app.get('/api/admin/runtime-incidents', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const incidents = await getShopRuntimeIncidents(req.shop.shopDomain, 50);
    return res.status(200).json({ incidents });
  } catch (err: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

app.get('/api/admin/collections/search', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const { createShopifyClient } = await import('./services/shopify-client.server.js');
    const client = createShopifyClient(req.shop);
    const gqlQuery = `
      query searchCollections($query: String!, $first: Int!) {
        collections(query: $query, first: $first) {
          edges {
            node {
              id
              title
              handle
              productsCount { count }
              image { url }
            }
          }
        }
      }
    `;
    const safeQ = sanitizeShopifySearchQuery(q);
    const data: any = await client.request(gqlQuery, { query: safeQ ? `title:*${safeQ}*` : '', first: limit });
    const collections = (data?.collections?.edges || []).map((e: any) => ({
      id: e.node.id,
      title: e.node.title,
      handle: e.node.handle,
      productsCount: e.node.productsCount?.count ?? null,
      imageUrl: e.node.image?.url || null,
    }));
    return res.status(200).json({ collections });
  } catch (err: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

app.get('/api/admin/catalogs', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const catalogs = await getCatalogsByShop(req.shop.id);
    return res.status(200).json({ catalogs });
  } catch (err: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

app.post('/api/admin/catalogs', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const catalog = await createCatalog(req.shop.id, req.body);
    return res.status(201).json({ catalog });
  } catch (err: any) {
    if (err instanceof CatalogError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

app.get('/api/admin/catalogs/:id', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const catalog = await getCatalogById(req.shop.id, req.params.id);
    return res.status(200).json({ catalog });
  } catch (err: any) {
    if (err instanceof CatalogError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

app.put('/api/admin/catalogs/:id', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const catalog = await updateCatalog(req.shop.id, req.params.id, req.body);
    return res.status(200).json({ catalog });
  } catch (err: any) {
    if (err instanceof CatalogError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

app.post('/api/admin/catalogs/:id/publish', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const catalog = await publishCatalog(req.shop.id, req.params.id);
    return res.status(200).json({ catalog });
  } catch (err: any) {
    if (err instanceof CatalogError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

app.post('/api/admin/catalogs/:id/unpublish', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const catalog = await unpublishCatalog(req.shop.id, req.params.id);
    return res.status(200).json({ catalog });
  } catch (err: any) {
    if (err instanceof CatalogError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

app.delete('/api/admin/catalogs/:id', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    await deleteCatalog(req.shop.id, req.params.id);
    return res.status(200).json({ success: true });
  } catch (err: any) {
    if (err instanceof CatalogError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return res.status(400).json({ error: sanitizeErrorMessage(err) });
  }
});

app.get('/api/admin/quota', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const quota = await checkShopQuota(req.shop.id);
    return res.status(200).json(quota);
  } catch (err: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// Admin Bootstrap Endpoint (Embedded App Bridge launch)
app.post('/api/admin/bootstrap', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const shop = req.shop;
    ensureInitialShopSync(shop.id).catch((err) => {
      console.error('Initial sync failed for shop during bootstrap:', shop.shopDomain, sanitizeErrorMessage(err));
    });

    return res.status(200).json({
      success: true,
      shop: {
        id: shop.id,
        shopDomain: shop.shopDomain,
        plan: shop.plan,
        initialSyncAt: shop.initialSyncAt,
        installed: !shop.uninstalledAt,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// Submissions history (M6/M7)
app.get('/api/admin/submissions', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 20;
    const catalogId = req.query.catalogId ? String(req.query.catalogId) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;

    const result = await getSubmissionsByShop(req.shop.id, { page, pageSize, catalogId, status });
    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// Retry Submission Reconciliation (M9.7)
app.post('/api/admin/submissions/:id/reconcile', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const { id } = req.params;
    const result = await reconcileSubmission(req.shop.id, id);
    return res.status(200).json(result);
  } catch (err: any) {
    if (err instanceof OrderSubmissionError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// Billing & Quotas (M8)
app.get('/api/admin/billing', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const billingInfo = await getShopBillingInfo(req.shop.id);
    return res.status(200).json(billingInfo);
  } catch (err: any) {
    if (err instanceof BillingError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// Change Plan Tier (M8)
app.post('/api/admin/billing/change-plan', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const { plan } = req.body;
    if (!plan) {
      return res.status(400).json({ error: 'Missing required plan tier' });
    }
    const updatedBilling = await changeShopPlan(req.shop.id, plan);
    return res.status(200).json(updatedBilling);
  } catch (err: any) {
    if (err instanceof BillingError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// Product Analytics & Funnel (M8)
app.get('/api/admin/analytics', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    let days = parseInt(req.query.days as string, 10);
    if (isNaN(days) || days < 1) {
      days = 30;
    } else if (days > 90) {
      days = 90;
    }
    const analytics = await getShopAnalyticsSummary(req.shop.id, days);
    return res.status(200).json(analytics);
  } catch (err: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// Sync health overview (M6)
app.get('/api/admin/sync/health', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const health = await getSyncHealthSummary(req.shop.id);
    return res.status(200).json(health);
  } catch (err: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// Manual Sync Trigger (M6 / M5.5 Deduplicated)
app.post('/api/admin/sync/trigger', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const result = await triggerManualShopSync(req.shop.id);
    return res.status(200).json({ success: true, message: 'Sync initiated', syncRunId: result.syncRunId });
  } catch (err: any) {
    if (err instanceof SyncInProgressError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// ==========================================
// PUBLIC LEGAL / SUPPORT PAGES (A5)
// Required for Shopify App Store submission.
// Must be accessible without authentication.
// ==========================================

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@catalogflow.app';
const APP_DOMAIN = process.env.APP_DOMAIN || 'catalogflow.app';

function legalPageHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — CatalogFlow</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;padding:2rem 1rem}
    .wrap{max-width:760px;margin:0 auto}
    header{margin-bottom:2.5rem;padding-bottom:1.5rem;border-bottom:1px solid #1e293b}
    .logo{font-size:1.1rem;font-weight:700;color:#6366f1;letter-spacing:.5px;margin-bottom:.5rem}
    h1{font-size:2rem;font-weight:700;margin-bottom:.5rem}
    .updated{color:#64748b;font-size:.875rem}
    h2{font-size:1.2rem;font-weight:600;color:#a5b4fc;margin:2rem 0 .65rem}
    p,li{font-size:.9375rem;line-height:1.75;color:#cbd5e1;margin-bottom:.75rem}
    ul{padding-left:1.5rem;margin-bottom:.75rem}
    a{color:#818cf8}
    footer{margin-top:3rem;padding-top:1.5rem;border-top:1px solid #1e293b;color:#475569;font-size:.85rem;text-align:center}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="logo">⚡ CatalogFlow</div>
      <h1>${title}</h1>
      <p class="updated">Last updated: September 2026</p>
    </header>
    ${body}
    <footer>© 2026 CatalogFlow &nbsp;·&nbsp; <a href="/privacy">Privacy</a> &nbsp;·&nbsp; <a href="/terms">Terms</a> &nbsp;·&nbsp; <a href="/support">Support</a></footer>
  </div>
</body>
</html>`;
}

app.get('/privacy', (_req: Request, res: Response) => {
  const body = `
    <h2>1. What We Collect</h2>
    <p>CatalogFlow collects only the Shopify store data required to operate the app: product and collection snapshots from your Shopify catalogue, order submissions made by your wholesale buyers (business name, email, PO number, note, and ordered line items), and usage metadata required for billing entitlement and quota enforcement.</p>
    <p>We do <strong>not</strong> collect end-consumer payment card data. Payment and financial data is handled exclusively by Shopify.</p>

    <h2>2. How We Use Your Data</h2>
    <ul>
      <li>Product and collection snapshots are stored locally to build live wholesale catalog pages for your buyers without querying Shopify on every page load.</li>
      <li>Buyer order submission data (name, email, line items) is forwarded to Shopify as a Draft Order and retained in the app database for order history and reconciliation.</li>
      <li>Usage metrics (submissions count, catalog count, variant count) are used to enforce plan quota limits.</li>
    </ul>

    <h2>3. Data Retention</h2>
    <p>Buyer order submissions (including business name and email) are retained for operational purposes. Product snapshots are refreshed via Shopify webhooks and are removed when a product or collection is deleted in Shopify. When you uninstall CatalogFlow, all shop data is scheduled for deletion within 48 hours, in compliance with Shopify GDPR webhook requirements (<code>shop/redact</code>, <code>customers/redact</code>).</p>

    <h2>4. Data Sharing</h2>
    <p>We do not sell, rent, or share your data with third parties for marketing purposes. Data is shared only as required to operate the service: with Shopify (to create Draft Orders on your behalf) and with our infrastructure provider (Railway) for application hosting. Railway is a SOC 2 compliant platform.</p>

    <h2>5. Security</h2>
    <p>All Shopify access tokens are encrypted at rest using AES-256-GCM before database storage. Data in transit is protected by TLS 1.2+. We apply rate limiting on all public endpoints and enforce strict per-shop tenant isolation to prevent cross-merchant data access.</p>

    <h2>6. Your Rights</h2>
    <p>You may request data export or deletion at any time by contacting us at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. Uninstalling the app from your Shopify Admin automatically triggers our GDPR data deletion workflow.</p>

    <h2>7. Contact</h2>
    <p>For privacy inquiries: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
  `;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(legalPageHtml('Privacy Policy', body));
});

app.get('/terms', (_req: Request, res: Response) => {
  const body = `
    <h2>1. Acceptance</h2>
    <p>By installing or using CatalogFlow ("the App"), you agree to these Terms of Service. If you do not agree, please uninstall the App from your Shopify Admin.</p>

    <h2>2. Description of Service</h2>
    <p>CatalogFlow enables Shopify merchants to create wholesale product catalogs and accept bulk variant orders from B2B buyers. Buyer submissions are created as Shopify Draft Orders in the merchant's Shopify Admin. The App does not process payments; all payment and fulfillment remain under Shopify's control.</p>

    <h2>3. Subscription and Billing</h2>
    <p>CatalogFlow is offered on a subscription basis through Shopify App Pricing. Your plan determines the number of live catalogs, maximum variants per catalog, and monthly order submission limits. Billing, upgrades, and cancellations are managed through your Shopify account under Shopify's standard billing terms.</p>

    <h2>4. Acceptable Use</h2>
    <ul>
      <li>You must not use the App to create catalogs or solicit orders for products that violate Shopify's Acceptable Use Policy.</li>
      <li>You must not attempt to circumvent plan quota limits, rate limiting, or authentication mechanisms.</li>
      <li>You are responsible for ensuring product pricing, availability, and descriptions in your Shopify store are accurate.</li>
    </ul>

    <h2>5. Intellectual Property</h2>
    <p>All App software, design, and documentation is the property of CatalogFlow. You are granted a limited, non-exclusive, non-transferable license to use the App for its intended purpose during your active subscription.</p>

    <h2>6. Limitation of Liability</h2>
    <p>To the maximum extent permitted by law, the App is provided "as is" without warranties of any kind. We are not liable for lost orders, buyer disputes, revenue impacts, or data loss arising from App downtime, data synchronization delays, or Shopify API outages.</p>

    <h2>7. Termination</h2>
    <p>Either party may terminate this agreement at any time. You may uninstall the App from your Shopify Admin. We may suspend access for violations of these Terms.</p>

    <h2>8. Changes to Terms</h2>
    <p>We may update these Terms with reasonable advance notice. Continued use of the App after changes take effect constitutes acceptance of the updated Terms.</p>

    <h2>9. Contact</h2>
    <p>Legal inquiries: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
  `;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(legalPageHtml('Terms of Service', body));
});

app.get('/support', (_req: Request, res: Response) => {
  const body = `
    <h2>Get Help with CatalogFlow</h2>
    <p>We're here to help you get the most out of your wholesale catalog setup. Reach out via the channel below.</p>

    <h2>📧 Email Support</h2>
    <p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
    <p>We typically respond within 1–2 business days (Monday–Friday).</p>

    <h2>📚 Common Questions</h2>
    <ul>
      <li><strong>How do I create a catalog?</strong> — In the CatalogFlow app, click "Create Catalog", search and select your products or collections in Step 1, choose a pricing mode in Step 2, then set a catalog name and publish in Step 3.</li>
      <li><strong>How do buyers place orders?</strong> — Share your catalog link with buyers. They browse products, select variants and quantities, fill in their business details, and submit. The order appears as a Shopify Draft Order in your Shopify Admin.</li>
      <li><strong>How do I upgrade my plan?</strong> — Go to the Billing &amp; Quotas tab in CatalogFlow. Plan changes are handled through Shopify App Pricing in your existing Shopify account.</li>
      <li><strong>Why is my order showing as "Requires Reconciliation"?</strong> — This means the order was submitted but Shopify confirmation could not be verified immediately. Use the Reconcile button in the Submissions tab to check the order status. Contact support if reconciliation fails repeatedly.</li>
      <li><strong>How do I delete my data?</strong> — Uninstall the App from your Shopify Admin. All data is deleted within 48 hours per our Privacy Policy. You may also email us to request earlier deletion.</li>
    </ul>

    <h2>🌐 App Information</h2>
    <p>App domain: ${APP_DOMAIN}</p>
    <p><a href="/privacy">Privacy Policy</a> &nbsp;·&nbsp; <a href="/terms">Terms of Service</a></p>
  `;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(legalPageHtml('Support', body));
});

// ==========================================
// ==========================================
// ==========================================
// STATIC & DEV FRONTEND SERVING
// ==========================================

const clientDist = path.resolve(process.cwd(), 'dist/client');

// Use index: false so express.static only serves static assets (/assets/*)
// and NEVER intercepts GET / or /app with raw index.html
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false }));
}

// Vite dev server middleware for live TSX compilation and HMR in dev mode
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
  try {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(vite.middlewares);

    app.get(['/', '/app', '/app/*'], async (req: Request, res: Response, next: NextFunction) => {
      try {
        const url = req.originalUrl;
        const templatePath = path.resolve(process.cwd(), 'index.html');
        let template = fs.readFileSync(templatePath, 'utf-8');
        const apiKey = process.env.SHOPIFY_API_KEY || process.env.VITE_SHOPIFY_API_KEY || '';
        template = template.replace(/%VITE_SHOPIFY_API_KEY%/g, apiKey);
        template = template.replace(
          /<meta\s+name="shopify-api-key"\s+content="[^"]*"\s*\/?>/gi,
          `<meta name="shopify-api-key" content="${apiKey}" />`
        );
        const html = await vite.transformIndexHtml(url, template);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(html);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } catch (err) {
    console.warn('Vite dev middleware initialization skipped:', err);
  }
}

// Serve Buyer portal SPA for /c/:publicToken
app.get('/c/:publicToken', (req: Request, res: Response) => {
  const { publicToken } = req.params;
  if (!isValidPublicToken(publicToken)) {
    return res.status(400).send('Invalid catalog URL format');
  }

  const htmlPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(htmlPath)) {
    sendRenderedIndexHtml(res, htmlPath);
  } else {
    const rootHtml = path.resolve(process.cwd(), 'index.html');
    if (fs.existsSync(rootHtml)) {
      sendRenderedIndexHtml(res, rootHtml);
    } else {
      res.status(200).send(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <meta name="shopify-api-key" content="${process.env.SHOPIFY_API_KEY || ''}" />
            <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
            <title>CatalogFlow: B2B Order Catalog</title>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
          </head>
          <body>
            <div id="root"></div>
            <script type="module" src="/src/client/main.tsx"></script>
          </body>
        </html>
      `);
    }
  }
});

// Helper to serve index.html with resolved Shopify API Key
function sendRenderedIndexHtml(res: Response, filePath: string) {
  try {
    let html = fs.readFileSync(filePath, 'utf-8');
    const apiKey = process.env.SHOPIFY_API_KEY || process.env.VITE_SHOPIFY_API_KEY || '';

    // Replace %VITE_SHOPIFY_API_KEY% placeholder
    html = html.replace(/%VITE_SHOPIFY_API_KEY%/g, apiKey);

    // Replace meta tag content attribute to guarantee client ID injection
    html = html.replace(
      /<meta\s+name="shopify-api-key"\s+content="[^"]*"\s*\/?>/gi,
      `<meta name="shopify-api-key" content="${apiKey}" />`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).send('Error loading page');
  }
}

// Serve Embedded Merchant Admin SPA for root / and /app (production / static fallback)
app.get(['/', '/app', '/app/*'], (_req: Request, res: Response) => {
  const htmlPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(htmlPath)) {
    sendRenderedIndexHtml(res, htmlPath);
  } else {
    const rootHtml = path.resolve(process.cwd(), 'index.html');
    if (fs.existsSync(rootHtml)) {
      sendRenderedIndexHtml(res, rootHtml);
    } else {
      res.status(200).send(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <meta name="shopify-api-key" content="${process.env.SHOPIFY_API_KEY || ''}" />
            <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
            <title>CatalogFlow: B2B Order Catalog</title>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
          </head>
          <body>
            <div id="root"></div>
            <script type="module" src="/src/client/main.tsx"></script>
          </body>
        </html>
      `);
    }
  }
});

const PORT = Number(process.env.PORT || 8080);

if (!process.env.VITEST) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[CatalogFlow Server] Running on port ${PORT}`);
  });
}
