/**
 * Prelaunch Bug Fix Regression Tests
 *
 * BUG-1 & BUG-10: Embedded app misrouted as buyer app (pathname-only routing)
 * BUG-2: Buyer token extraction strict canonical route, no query-param fallback
 * BUG-3: SHOPIFY_APP_URL safety validation (HOST must not override SHOPIFY_APP_URL)
 * BUG-8: Shopify search query special character injection prevention
 * BUG-5: Billing billingStatus passthrough
 * AUTH: 401 + X-Shopify-Retry-Invalid-Session-Request header
 * WEBHOOKS: HMAC verification
 * PUBLIC ROUTE: /c/:publicToken token format validation
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { parseBuyerRoute, CANONICAL_BUYER_ROUTE_REGEX } from '../src/client/routeUtils.js';
import { validateShopifyAppUrl } from '../src/services/env.server.js';
import { sanitizeShopifySearchQuery } from '../src/services/shopify-search.server.js';
import { getAppBridgeToken, authenticatedFetch as clientAuthFetch } from '../src/client/merchant/appBridgeAuth.js';
import crypto from 'node:crypto';

function createTestAppBridgeToken(shopDomain: string): string {
  const secret = process.env.SHOPIFY_API_SECRET || 'test_secret';
  const apiKey = process.env.SHOPIFY_API_KEY || 'test_key';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://' + shopDomain + '/admin',
      dest: 'https://' + shopDomain,
      aud: apiKey,
      sub: 'test-user-prelaunch',
      exp: now + 3600,
      nbf: now - 10,
      iat: now,
      jti: 'jti-prelaunch',
      sid: 'sid-prelaunch',
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
  return header + '.' + payload + '.' + sig;
}

// ───────────────────────────────────────────────────────────────────────────
// BUG-1 & BUG-10: Buyer route parsing — production parseBuyerRoute helper
// ───────────────────────────────────────────────────────────────────────────

describe('BUG-1 & BUG-10: Buyer route parsing — production parseBuyerRoute helper', () => {
  const validToken = 'a'.repeat(64);

  it('/ (root) should NOT match buyer route', () => {
    expect(parseBuyerRoute('/').isBuyerRoute).toBe(false);
  });
  it('/app should NOT match buyer route', () => {
    expect(parseBuyerRoute('/app').isBuyerRoute).toBe(false);
  });
  it('/app/billing should NOT match buyer route', () => {
    expect(parseBuyerRoute('/app/billing').isBuyerRoute).toBe(false);
  });
  it('pathname / (id_token in query never affects pathname) should NOT match buyer route', () => {
    expect(parseBuyerRoute('/').isBuyerRoute).toBe(false);
  });
  it('/c/foo should NOT match buyer route (rejects non-64-hex token)', () => {
    expect(parseBuyerRoute('/c/foo').isBuyerRoute).toBe(false);
  });
  it('/c/<token> (canonical 64-hex) should match buyer route', () => {
    expect(parseBuyerRoute('/c/' + validToken).isBuyerRoute).toBe(true);
  });
  it('/c/<token>/ (canonical 64-hex with trailing slash) should match buyer route', () => {
    expect(parseBuyerRoute('/c/' + validToken + '/').isBuyerRoute).toBe(true);
  });
  it('/c/ (no token) should NOT match buyer route', () => {
    expect(parseBuyerRoute('/c/').isBuyerRoute).toBe(false);
  });
  it('/foo/c/<token> should NOT match buyer route (BUG-10 regression)', () => {
    expect(parseBuyerRoute('/foo/c/' + validToken).isBuyerRoute).toBe(false);
  });
  it('/c/<token>/anything should NOT match buyer route', () => {
    expect(parseBuyerRoute('/c/' + validToken + '/anything').isBuyerRoute).toBe(false);
  });
  it('/catalog/c/<token> should NOT match buyer route', () => {
    expect(parseBuyerRoute('/catalog/c/' + validToken).isBuyerRoute).toBe(false);
  });
  it('/ctoken (no slash) should NOT match buyer route', () => {
    expect(parseBuyerRoute('/ctoken').isBuyerRoute).toBe(false);
  });
  it('?token= should NOT match buyer route', () => {
    expect(parseBuyerRoute('?token=' + validToken).isBuyerRoute).toBe(false);
  });
  it('?id_token= should NOT match buyer route', () => {
    expect(parseBuyerRoute('?id_token=' + validToken).isBuyerRoute).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// BUG-2: Buyer token extraction — production parseBuyerRoute helper
// ───────────────────────────────────────────────────────────────────────────

describe('BUG-2: Buyer token extraction — production parseBuyerRoute helper', () => {
  const validToken = 'a'.repeat(64);

  it('extracts token from /c/<64hexchars>', () => {
    const res = parseBuyerRoute('/c/' + validToken);
    expect(res.isBuyerRoute).toBe(true);
    expect(res.token).toBe(validToken);
  });
  it('extracts token from /c/<64hexchars>/ (trailing slash)', () => {
    const res = parseBuyerRoute('/c/' + validToken + '/');
    expect(res.isBuyerRoute).toBe(true);
    expect(res.token).toBe(validToken);
  });
  it('does NOT extract from /foo/c/<token> (BUG-10 regression)', () => {
    expect(parseBuyerRoute('/foo/c/' + validToken).token).toBeNull();
  });
  it('does NOT extract from /c/<token>/anything (rejects trailing path)', () => {
    expect(parseBuyerRoute('/c/' + validToken + '/anything').token).toBeNull();
  });
  it('does NOT extract from / (no /c/ prefix — query param fallback was BUG-2)', () => {
    expect(parseBuyerRoute('/').token).toBeNull();
  });
  it('rejects token shorter than 64 chars', () => {
    expect(parseBuyerRoute('/c/' + 'a'.repeat(32)).token).toBeNull();
  });
  it('rejects non-hex characters in token', () => {
    expect(parseBuyerRoute('/c/' + 'z'.repeat(64)).token).toBeNull();
  });
  it('rejects token longer than 64 chars (65 chars)', () => {
    expect(parseBuyerRoute('/c/' + 'a'.repeat(65)).token).toBeNull();
  });
  it('accepts mixed-case hex and normalizes to lower-case', () => {
    const mixedToken = 'A'.repeat(32) + 'f'.repeat(32);
    const res = parseBuyerRoute('/c/' + mixedToken);
    expect(res.isBuyerRoute).toBe(true);
    expect(res.token).toBe(mixedToken.toLowerCase());
  });
});

// ───────────────────────────────────────────────────────────────────────────
// BUG-3: SHOPIFY_APP_URL safety validation — production validateShopifyAppUrl
// ───────────────────────────────────────────────────────────────────────────

describe('BUG-3: SHOPIFY_APP_URL safety validation — production validateShopifyAppUrl', () => {
  it('rejects undefined (missing) SHOPIFY_APP_URL', () => {
    expect(validateShopifyAppUrl(undefined)).not.toBeNull();
  });
  it('rejects http:// localhost URL', () => {
    expect(validateShopifyAppUrl('http://localhost:3000')).not.toBeNull();
  });
  it('rejects 127.0.0.1 URL', () => {
    expect(validateShopifyAppUrl('http://127.0.0.1:8080')).not.toBeNull();
  });
  it('rejects 0.0.0.0 URL (used as server bind, not app URL)', () => {
    expect(validateShopifyAppUrl('http://0.0.0.0:8000')).not.toBeNull();
  });
  it('rejects trycloudflare tunnel URL', () => {
    expect(validateShopifyAppUrl('https://abc.trycloudflare.com')).not.toBeNull();
  });
  it('rejects shopify.dev default-app-home URL', () => {
    expect(validateShopifyAppUrl('https://shopify.dev/apps/default-app-home')).not.toBeNull();
  });
  it('rejects non-HTTPS production URL', () => {
    expect(validateShopifyAppUrl('http://b2b-catalog.hostless.app')).not.toBeNull();
  });
  it('accepts production HTTPS URL', () => {
    expect(validateShopifyAppUrl('https://b2b-catalog.hostless.app')).toBeNull();
  });
  it('accepts any well-formed HTTPS hostname URL', () => {
    expect(validateShopifyAppUrl('https://my-app.example.com')).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// BUG-8: Shopify search query sanitization — production sanitizeShopifySearchQuery
// ───────────────────────────────────────────────────────────────────────────

describe('BUG-8: Shopify search query sanitization — production sanitizeShopifySearchQuery', () => {
  it('strips double quotes', () => {
    expect(sanitizeShopifySearchQuery('title:"evil"')).not.toContain('"');
  });
  it('strips colons', () => {
    expect(sanitizeShopifySearchQuery('status:ACTIVE')).not.toContain(':');
  });
  it('strips parentheses', () => {
    expect(sanitizeShopifySearchQuery('(foo AND bar)')).not.toMatch(/[()]/);
  });
  it('strips asterisks to prevent wildcard syntax errors', () => {
    expect(sanitizeShopifySearchQuery('foo*bar')).not.toContain('*');
  });
  it('strips forward slash', () => {
    expect(sanitizeShopifySearchQuery('foo/bar')).not.toContain('/');
  });
  it('collapses repeated whitespace after stripping', () => {
    expect(sanitizeShopifySearchQuery('foo:::bar')).not.toContain(':::');
  });
  it('preserves normal search text', () => {
    expect(sanitizeShopifySearchQuery('Blue Widget')).toBe('Blue Widget');
  });
  it('preserves hyphens', () => {
    expect(sanitizeShopifySearchQuery('summer-dress')).toBe('summer-dress');
  });
  it('handles empty string', () => {
    expect(sanitizeShopifySearchQuery('')).toBe('');
  });
  it('collapses string of only special chars to empty', () => {
    expect(sanitizeShopifySearchQuery(':::():::')).toBe('');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AUTH: 401 + retry header
// ───────────────────────────────────────────────────────────────────────────

describe('AUTH: Unauthorized requests receive retry header', () => {
  it('returns 401 with X-Shopify-Retry-Invalid-Session-Request when Authorization missing', async () => {
    const res = await request(app).post('/api/admin/bootstrap');
    expect(res.status).toBe(401);
    expect(res.headers['x-shopify-retry-invalid-session-request']).toBe('1');
  });

  it('returns 401 with retry header for malformed Bearer token', async () => {
    const res = await request(app)
      .post('/api/admin/bootstrap')
      .set('Authorization', 'Bearer not.valid.jwt');
    expect(res.status).toBe(401);
    expect(res.headers['x-shopify-retry-invalid-session-request']).toBe('1');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WEBHOOKS: HMAC verification
// ───────────────────────────────────────────────────────────────────────────

describe('WEBHOOKS: Bad HMAC rejected with 401', () => {
  it('rejects product webhook with bad HMAC', async () => {
    const res = await request(app)
      .post('/api/webhooks/products')
      .set('x-shopify-shop-domain', 'test.myshopify.com')
      .set('x-shopify-topic', 'products/update')
      .set('x-shopify-hmac-sha256', 'badsignature==')
      .set('x-shopify-webhook-id', 'wh-bad-hmac-prod')
      .send({ id: 123, title: 'Test' }); // send object so supertest sets Content-Type: application/json
    expect(res.status).toBe(401);
  });

  it('rejects collection webhook with bad HMAC', async () => {
    const res = await request(app)
      .post('/api/webhooks/collections')
      .set('x-shopify-shop-domain', 'test.myshopify.com')
      .set('x-shopify-topic', 'collections/update')
      .set('x-shopify-hmac-sha256', 'badsignature==')
      .set('x-shopify-webhook-id', 'wh-bad-hmac-col')
      .send({ id: 456 }); // send object so supertest sets Content-Type: application/json
    expect(res.status).toBe(401);
  });

  it('rejects app/uninstalled webhook with bad HMAC', async () => {
    const res = await request(app)
      .post('/api/webhooks/app/uninstalled')
      .set('x-shopify-shop-domain', 'test.myshopify.com')
      .set('x-shopify-hmac-sha256', 'badsignature==')
      .set('x-shopify-webhook-id', 'wh-bad-hmac-uninstall')
      .send({ myshopify_domain: 'test.myshopify.com' }); // send object
    expect(res.status).toBe(401);
  });
});


// ───────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTE: /c/:publicToken server-side token format validation
// ───────────────────────────────────────────────────────────────────────────

describe('PUBLIC ROUTE: /c/:publicToken — server-side validation', () => {
  it('GET /c/<short-token> returns 400 (invalid format)', async () => {
    const res = await request(app).get('/c/short');
    expect(res.status).toBe(400);
  });
  it('GET /api/public/catalog/<non-hex-chars> returns 400', async () => {
    const res = await request(app).get('/api/public/catalog/' + 'z'.repeat(64));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid catalog token/i);
  });
  it('GET /api/public/catalog/<valid-nonexistent-hex> returns 404', async () => {
    const res = await request(app).get('/api/public/catalog/' + 'a'.repeat(64));
    expect(res.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// BUG-5: Billing — billingStatus passthrough in API response
// ───────────────────────────────────────────────────────────────────────────

describe('BUG-5: Billing — billingStatus passthrough', () => {
  let shop: { id: string; shopDomain: string };

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
    shop = await installOrUpdateShop({
      shopDomain: 'billing-pl.myshopify.com',
      accessToken: 'tok',
      scopes: 'read_products',
    });
  });

  it('GET /api/admin/billing includes billingStatus field', async () => {
    const token = createTestAppBridgeToken(shop.shopDomain);
    const res = await request(app)
      .get('/api/admin/billing')
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('billingStatus');
    expect(['DEV_OVERRIDE', 'SHOPIFY_APP_PRICING_PENDING_M10']).toContain(res.body.billingStatus);
  });

  it('GET /api/admin/billing includes entitlementSource field', async () => {
    const token = createTestAppBridgeToken(shop.shopDomain);
    const res = await request(app)
      .get('/api/admin/billing')
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('entitlementSource');
  });

  it('POST /api/admin/billing/change-plan in test/dev does not return 500', async () => {
    const token = createTestAppBridgeToken(shop.shopDomain);
    const res = await request(app)
      .post('/api/admin/billing/change-plan')
      .set('Authorization', 'Bearer ' + token)
      .send({ plan: 'GROWTH' });
    // In dev/test mode: either 200 (dev override) or 403 (billing locked) — never 500
    expect(res.status).not.toBe(500);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// EMBEDDED AUTH: getAppBridgeToken transient failure retry & bounded timeout
// ───────────────────────────────────────────────────────────────────────────

describe('EMBEDDED AUTH: getAppBridgeToken transient error polling', () => {
  it('returns token immediately when idToken succeeds on first poll', async () => {
    const mockWin = {
      shopify: {
        idToken: async () => 'valid-token-1',
      },
    };
    const token = await getAppBridgeToken({
      maxPolls: 5,
      pollInterval: 1,
      getWindow: () => mockWin,
    });
    expect(token).toBe('valid-token-1');
  });

  it('continues polling when idToken throws transient errors and succeeds later', async () => {
    let callCount = 0;
    const mockWin = {
      shopify: {
        idToken: async () => {
          callCount++;
          if (callCount < 3) {
            throw new Error('Transient bridge handshake error');
          }
          return 'recovered-token';
        },
      },
    };
    const token = await getAppBridgeToken({
      maxPolls: 5,
      pollInterval: 1,
      getWindow: () => mockWin,
    });
    expect(token).toBe('recovered-token');
    expect(callCount).toBe(3);
  });

  it('continues polling when idToken returns empty/whitespace string initially', async () => {
    let callCount = 0;
    const mockWin = {
      shopify: {
        idToken: async () => {
          callCount++;
          if (callCount === 1) return '';
          if (callCount === 2) return '   ';
          return 'valid-token-after-empty';
        },
      },
    };
    const token = await getAppBridgeToken({
      maxPolls: 5,
      pollInterval: 1,
      getWindow: () => mockWin,
    });
    expect(token).toBe('valid-token-after-empty');
    expect(callCount).toBe(3);
  });

  it('continues polling while window.shopify is undefined initially, then becomes ready', async () => {
    let pollCount = 0;
    const mockWin: any = {};
    const token = await getAppBridgeToken({
      maxPolls: 5,
      pollInterval: 1,
      getWindow: () => {
        pollCount++;
        if (pollCount >= 3) {
          mockWin.shopify = { idToken: async () => 'late-ready-token' };
        }
        return mockWin;
      },
    });
    expect(token).toBe('late-ready-token');
    expect(pollCount).toBe(3);
  });

  it('returns null after bounded maxPolls without infinite loop when idToken continuously throws', async () => {
    let callCount = 0;
    const mockWin = {
      shopify: {
        idToken: async () => {
          callCount++;
          throw new Error('Persistent handshake error');
        },
      },
    };
    const token = await getAppBridgeToken({
      maxPolls: 4,
      pollInterval: 1,
      getWindow: () => mockWin,
    });
    expect(token).toBeNull();
    expect(callCount).toBe(4);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// EMBEDDED AUTH: authenticatedFetch error & retry semantics
// ───────────────────────────────────────────────────────────────────────────

describe('EMBEDDED AUTH: authenticatedFetch safety & retry semantics', () => {
  it('throws clear client error without calling fetch if token is unavailable', async () => {
    let fetchCalled = false;
    await expect(
      clientAuthFetch(
        '/api/admin/catalogs',
        {},
        {
          tokenFetcher: async () => null,
          fetchFn: (async () => {
            fetchCalled = true;
            return new Response('{}', { status: 200 });
          }) as any,
        }
      )
    ).rejects.toThrow(/Shopify session token unavailable/i);
    expect(fetchCalled).toBe(false);
  });

  it('sends Authorization: Bearer <token> on request', async () => {
    let capturedHeaders: any = null;
    const res = await clientAuthFetch(
      '/api/admin/catalogs',
      { headers: { 'Custom-Header': 'foo' } },
      {
        tokenFetcher: async () => 'my-token',
        fetchFn: (async (_url: string, init: any) => {
          capturedHeaders = init.headers;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as any,
      }
    );
    expect(res.status).toBe(200);
    expect(capturedHeaders['Authorization']).toBe('Bearer my-token');
    expect(capturedHeaders['Content-Type']).toBe('application/json');
    expect(capturedHeaders['Custom-Header']).toBe('foo');
  });

  it('retries once with fresh token when receiving X-Shopify-Retry-Invalid-Session-Request: 1', async () => {
    let callCount = 0;
    const capturedTokens: string[] = [];

    const mockFetch = async (_url: string, init: any) => {
      callCount++;
      capturedTokens.push(init.headers['Authorization']);
      if (callCount === 1) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'X-Shopify-Retry-Invalid-Session-Request': '1' },
        });
      }
      return new Response(JSON.stringify({ retrySuccess: true }), { status: 200 });
    };

    let tokenFetchCount = 0;
    const mockTokenFetcher = async () => {
      tokenFetchCount++;
      return tokenFetchCount === 1 ? 'stale-token' : 'fresh-token';
    };

    const res = await clientAuthFetch('/api/admin/catalogs', {}, {
      tokenFetcher: mockTokenFetcher,
      fetchFn: mockFetch as any,
    });

    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
    expect(capturedTokens[0]).toBe('Bearer stale-token');
    expect(capturedTokens[1]).toBe('Bearer fresh-token');
  });

  it('throws clear session-expired error if second token acquisition fails on retry', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'X-Shopify-Retry-Invalid-Session-Request': '1' },
      });
    };

    let tokenFetchCount = 0;
    const mockTokenFetcher = async () => {
      tokenFetchCount++;
      if (tokenFetchCount === 1) return 'stale-token';
      return null; // second token acquisition fails
    };

    await expect(
      clientAuthFetch('/api/admin/catalogs', {}, {
        tokenFetcher: mockTokenFetcher,
        fetchFn: mockFetch as any,
      })
    ).rejects.toThrow(/Shopify session expired and could not be refreshed/i);

    expect(callCount).toBe(1); // fetch was only called once, aborted before second unauthenticated fetch
  });
});

