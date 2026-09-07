import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { getPublicCatalogPayload, syncProductSnapshot, deleteProductSnapshot } from './services/sync.server.js';
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
} from './services/shop.server.js';
import {
  verifyShopifyWebhookHmac,
  verifyAppBridgeJwt,
  extractShopDomainFromDest,
} from './services/auth.server.js';
import dotenv from 'dotenv';

dotenv.config();

export const app = express();

app.use(cors());
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

// ==========================================
// PUBLIC BUYER PORTAL API
// ==========================================

// 1. Get Public Catalog
app.get('/api/public/catalog/:publicToken', async (req: Request, res: Response) => {
  try {
    const { publicToken } = req.params;
    const payload = await getPublicCatalogPayload(publicToken);

    if (!payload) {
      return res.status(404).json({ error: 'Catalog not found, unpublished, or unavailable' });
    }

    return res.status(200).json(payload);
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to load catalog', details: error.message });
  }
});

// 2. Pre-submit Validation
app.post('/api/public/catalog/:publicToken/validate', async (req: Request, res: Response) => {
  try {
    const { publicToken } = req.params;
    const result = await validateBuyerOrderLines(publicToken, req.body);
    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// ==========================================
// SHOPIFY WEBHOOKS
// ==========================================

app.post('/api/webhooks/products', async (req: any, res: Response) => {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
  const shopDomain = req.get('X-Shopify-Shop-Domain') || '';
  const topic = req.get('X-Shopify-Topic') || '';
  const secret = process.env.SHOPIFY_API_SECRET || '';

  if (secret && !verifyShopifyWebhookHmac(req.rawBody, hmacHeader, secret)) {
    return res.status(401).send('HMAC verification failed');
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
    console.error('Webhook product sync error:', err.message);
    return res.status(500).send('Sync failed');
  }
});

app.post('/api/webhooks/app/uninstalled', async (req: any, res: Response) => {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
  const shopDomain = req.get('X-Shopify-Shop-Domain') || '';
  const secret = process.env.SHOPIFY_API_SECRET || '';

  if (secret && !verifyShopifyWebhookHmac(req.rawBody, hmacHeader, secret)) {
    return res.status(401).send('HMAC verification failed');
  }

  try {
    await uninstallShop(shopDomain);
    return res.status(200).send('Uninstalled recorded');
  } catch (err: any) {
    return res.status(500).send('Uninstall error');
  }
});

// ==========================================
// MERCHANT ADMIN API (AUTHENTICATED)
// ==========================================

export async function adminAuthMiddleware(req: any, res: Response, next: NextFunction) {
  // Support Bearer JWT from Shopify App Bridge or test header in non-prod
  const authHeader = req.get('Authorization');
  const testShopDomain = req.get('X-Shop-Domain');

  if (process.env.NODE_ENV === 'test' && testShopDomain) {
    const shop = await getActiveShopByDomain(testShopDomain);
    if (!shop) {
      return res.status(401).json({ error: 'Shop inactive or not found' });
    }
    req.shop = shop;
    return next();
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing session token' });
  }

  const token = authHeader.replace('Bearer ', '');
  const secret = process.env.SHOPIFY_API_SECRET || '';

  const decoded = verifyAppBridgeJwt(token, secret);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }

  const shopDomain = extractShopDomainFromDest(decoded.dest);
  const shop = await getActiveShopByDomain(shopDomain);
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
    return res.status(500).json({ error: err.message });
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
    return res.status(400).json({ error: err.message });
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
    return res.status(500).json({ error: err.message });
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
    return res.status(400).json({ error: err.message });
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
    return res.status(400).json({ error: err.message });
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
    return res.status(400).json({ error: err.message });
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
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/quota', adminAuthMiddleware, async (req: any, res: Response) => {
  try {
    const quota = await checkShopQuota(req.shop.id);
    return res.status(200).json(quota);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
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
app.get('/c/:publicToken', (_req: Request, res: Response) => {
  const htmlPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    // Development fallback HTML
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
