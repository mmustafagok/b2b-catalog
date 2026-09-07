import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
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
  OrderSubmissionError,
  CatalogDataChangedError,
} from './services/order.server.js';
import {
  createCatalog,
  updateCatalog,
  publishCatalog,
  unpublishCatalog,
  deleteCatalog,
  getCatalogsByShop,
  getCatalogById,
  CatalogError,
} from './services/catalog.server.js';
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
  createRateLimiter,
  isValidPublicToken,
  sanitizeErrorMessage,
  sanitizeForLogging,
} from './services/security.server.js';
import dotenv from 'dotenv';

dotenv.config();

export const app = express();

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

// Healthcheck
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', time: new Date().toISOString() });
});

// Rate limiters for public endpoints
const publicRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute per IP
  message: 'Too many catalog requests. Please wait a moment.',
});

const submitRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30, // 30 order submit attempts per minute per IP
  message: 'Too many order submissions. Please wait a moment.',
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

// 1. Get Public Catalog
app.get('/api/public/catalog/:publicToken', publicRateLimiter, async (req: Request, res: Response) => {
  try {
    const { publicToken } = req.params;

    if (!isValidPublicToken(publicToken)) {
      return res.status(400).json({ error: 'Invalid catalog token format' });
    }

    const payload = await getPublicCatalogPayload(publicToken);

    if (!payload) {
      return res.status(404).json({ error: 'Catalog not found, unpublished, or unavailable' });
    }

    return res.status(200).json(payload);
  } catch (error: any) {
    return res.status(500).json({ error: sanitizeErrorMessage(error) });
  }
});

// 2. Pre-submit Validation
app.post('/api/public/catalog/:publicToken/validate', publicRateLimiter, async (req: Request, res: Response) => {
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

// 3. Buyer Order Submission (M5)
app.post('/api/public/catalog/:publicToken/submit', submitRateLimiter, async (req: Request, res: Response) => {
  try {
    const { publicToken } = req.params;
    const idempotencyKey = (req.get('Idempotency-Key') || req.get('idempotency-key') || '').trim();

    if (!isValidPublicToken(publicToken)) {
      return res.status(400).json({ error: 'Invalid catalog token format' });
    }

    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Missing required Idempotency-Key header' });
    }

    const result = await submitBuyerOrder(publicToken, idempotencyKey, req.body);
    return res.status(201).json(result);
  } catch (error: any) {
    if (error instanceof CatalogDataChangedError) {
      return res.status(409).json({
        error: error.message,
        code: error.code,
        changedLines: error.changedLines,
      });
    }

    if (error instanceof OrderSubmissionError) {
      switch (error.code) {
        case 'CONCURRENT_PROCESSING':
          return res.status(409).json({ error: error.message, code: error.code });
        case 'CATALOG_NOT_FOUND':
        case 'CATALOG_NOT_PUBLISHED':
          return res.status(404).json({ error: error.message, code: error.code });
        case 'QUOTA_EXCEEDED':
          return res.status(403).json({ error: error.message, code: error.code });
        case 'INVALID_LINES':
          return res.status(422).json({ error: error.message, code: error.code, details: error.details });
        case 'EMPTY_ORDER':
        case 'INVALID_INPUT':
        case 'VALIDATION_FAILED':
          return res.status(422).json({ error: error.message, code: error.code, details: error.details });
        case 'SHOP_UNAVAILABLE':
          return res.status(503).json({ error: error.message, code: error.code });
        case 'SHOPIFY_API_ERROR':
          return res.status(502).json({ error: error.message, code: error.code, details: error.details });
        default:
          return res.status(400).json({ error: error.message, code: error.code });
      }
    }

    return res.status(500).json({ error: sanitizeErrorMessage(error) });
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
      if (topic === 'products/delete') {
        await deleteProductSnapshot(shop.id, req.body.id);
      } else {
        await syncProductSnapshot(shop.id, req.body);
        if (topic === 'products/update') {
          // Bounded reconciliation for catalog-sourced collections so smart collection memberships stay fresh
          await reconcileSourcedCollectionsForShop(shop.id).catch(() => {});
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
      if (topic === 'collections/delete') {
        await deleteCollectionSnapshot(shop.id, req.body.id);
      } else {
        // collections/create or collections/update
        await syncSingleCollectionFromShopify(shop.id, req.body.id);
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
      ensureInitialShopSync(shop.id).catch(() => {});
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

// Submissions history (M6)
app.get('/api/admin/submissions', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 20;
    const catalogId = req.query.catalogId ? String(req.query.catalogId) : undefined;

    const result = await getSubmissionsByShop(req.shop.id, { page, pageSize, catalogId });
    return res.status(200).json(result);
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
// STATIC FRONTEND SERVING
// ==========================================

const clientDist = path.resolve(process.cwd(), 'dist/client');

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

// Serve Buyer portal SPA for /c/:publicToken
app.get('/c/:publicToken', (req: Request, res: Response) => {
  const { publicToken } = req.params;
  if (!isValidPublicToken(publicToken)) {
    return res.status(400).send('Invalid catalog URL format');
  }

  const htmlPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(200).send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>B2B Wholesale Catalog</title>
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
});

// Serve Embedded Merchant Admin SPA for root / and /app
app.get(['/', '/app', '/app/*'], (_req: Request, res: Response) => {
  const htmlPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    const rootHtml = path.resolve(process.cwd(), 'index.html');
    if (fs.existsSync(rootHtml)) {
      res.sendFile(rootHtml);
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

const PORT = process.env.PORT || 8080;

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[CatalogFlow Server] Running on port ${PORT}`);
  });
}
