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
  performInitialShopSync,
} from './services/sync.server.js';
import { validateBuyerOrderLines } from './services/validation.server.js';
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
  verifyShopifyOauthHmac,
  isValidShopifyDomain,
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

// ==========================================
// REAL SHOPIFY OAUTH / INSTALLATION
// ==========================================

app.get('/auth/shopify', (req: Request, res: Response) => {
  const shop = req.query.shop as string;

  if (!isValidShopifyDomain(shop)) {
    return res.status(400).send('Invalid shop domain. Must be a valid myshopify.com domain.');
  }

  const clientId = process.env.SHOPIFY_API_KEY;
  const scopes = process.env.SCOPES || 'read_products,read_inventory,write_draft_orders,read_draft_orders';
  const host = process.env.HOST || 'http://localhost:8080';
  const redirectUri = `${host}/auth/callback`;

  // State parameter for CSRF prevention
  const state = Math.random().toString(36).substring(2);

  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=${encodeURIComponent(
    scopes
  )}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  return res.redirect(installUrl);
});

app.get('/auth/callback', async (req: Request, res: Response) => {
  const query = req.query as Record<string, string>;
  const shop = query.shop;
  const code = query.code;
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret) {
    return res.status(500).send('App secret not configured.');
  }

  if (!isValidShopifyDomain(shop)) {
    return res.status(400).send('Invalid shop domain.');
  }

  if (!verifyShopifyOauthHmac(query, secret)) {
    return res.status(401).send('OAuth signature verification failed.');
  }

  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  try {
    // Exchange code for offline access token
    const tokenUrl = `https://${shop}/admin/oauth/access_token`;
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: secret,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      return res.status(400).send(`Failed to exchange token: ${errText}`);
    }

    const tokenData: any = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Install or reactivate shop
    const installedShop = await installOrUpdateShop({
      shopDomain: shop,
      accessToken,
    });

    // Trigger initial product sync in background
    performInitialShopSync(installedShop.id).catch((err) => {
      console.error('Initial sync failed for shop:', shop, sanitizeErrorMessage(err));
    });

    // Redirect to Shopify Admin embedded app
    const apiKey = process.env.SHOPIFY_API_KEY;
    const embeddedUrl = `https://${shop}/admin/apps/${apiKey}`;
    return res.redirect(embeddedUrl);
  } catch (err: any) {
    return res.status(500).send(`Installation failed: ${sanitizeErrorMessage(err)}`);
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

// ==========================================
// SHOPIFY WEBHOOKS (FAIL CLOSED & IDEMPOTENT)
// ==========================================

async function handleWebhookIdempotency(webhookId: string, topic: string, shopDomain: string): Promise<boolean> {
  if (!webhookId) return false;

  const existing = await prisma.webhookReceipt.findUnique({
    where: { webhookId },
  });
  if (existing) {
    return false; // Already processed
  }

  try {
    await prisma.webhookReceipt.create({
      data: {
        webhookId,
        topic,
        shopDomain,
      },
    });
    return true; // First time seeing this webhook
  } catch {
    return false; // Already processed concurrently
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

  // Check webhook idempotency
  if (webhookId) {
    const isNew = await handleWebhookIdempotency(webhookId, topic, shopDomain);
    if (!isNew) {
      // Safely acknowledge duplicate delivery
      return res.status(200).send('Webhook already processed');
    }
  }

  const shop = await getActiveShopByDomain(shopDomain);
  if (!shop) {
    return res.status(200).send('Shop not active');
  }

  try {
    if (topic === 'products/delete') {
      await deleteProductSnapshot(shop.id, req.body.id);
    } else {
      await syncProductSnapshot(shop.id, req.body);
    }
    return res.status(200).send('OK');
  } catch (err: any) {
    console.error('Webhook product sync error:', sanitizeErrorMessage(err));
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

  if (webhookId) {
    const isNew = await handleWebhookIdempotency(webhookId, 'app/uninstalled', shopDomain);
    if (!isNew) {
      return res.status(200).send('Webhook already processed');
    }
  }

  try {
    await uninstallShop(shopDomain);
    return res.status(200).send('Uninstalled recorded');
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
    return res.status(401).json({ error: 'Missing or malformed Authorization session token' });
  }

  const token = authHeader.replace('Bearer ', '');
  const secret = process.env.SHOPIFY_API_SECRET || '';

  const decoded = verifyAppBridgeJwt(token, secret);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid, expired, or untrusted session token' });
  }

  const shop = await getActiveShopByDomain(decoded.shopDomain);
  if (!shop) {
    return res.status(401).json({ error: 'Shop not found or inactive' });
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

const PORT = process.env.PORT || 8080;

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[CatalogFlow Server] Running on port ${PORT}`);
  });
}
