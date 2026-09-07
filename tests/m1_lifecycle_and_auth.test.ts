import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import {
  installOrUpdateShop,
  uninstallShop,
  getActiveShopByDomain,
  getActiveShopById,
  checkShopQuota,
  getDecryptedAccessToken,
} from '../src/services/shop.server.js';
import {
  verifyShopifyWebhookHmac,
  generateOpaqueToken,
  hashIdempotencyKey,
  verifyAppBridgeJwt,
  isValidShopifyDomain,
  exchangeSessionTokenForOfflineToken,
  ShopifyStaleSessionTokenError,
} from '../src/services/auth.server.js';
import {
  getValidOfflineAccessToken,
  ShopifyAuthRequiredError,
} from '../src/services/shopify-token.server.js';
import { ShopifyAdminClient } from '../src/services/shopify-client.server.js';
import { encryptToken, decryptToken, CryptoError } from '../src/services/crypto.server.js';
import crypto from 'crypto';

describe('Milestone 1: Shop Lifecycle, Encryption & Auth Hardening', () => {
  const testDomain = 'test-merchant-lifecycle.myshopify.com';

  beforeEach(async () => {
    await prisma.orderSubmission.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany({ where: { shopDomain: testDomain } });
  });

  it('should install a new shop with encrypted access token and starter plan', async () => {
    const shop = await installOrUpdateShop({
      shopDomain: testDomain,
      accessToken: 'shpua_initial_test_token_123',
    });

    expect(shop).toBeDefined();
    expect(shop.shopDomain).toBe(testDomain);
    // Token must be encrypted at rest with version envelope
    expect(shop.accessToken).toMatch(/^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+/);
    expect(shop.accessToken).not.toContain('shpua_initial_test_token_123');

    // Decrypted token must match original
    const plainToken = await getDecryptedAccessToken(shop.id);
    expect(plainToken).toBe('shpua_initial_test_token_123');

    expect(shop.plan).toBe('STARTER');
    expect(shop.uninstalledAt).toBeNull();

    const active = await getActiveShopByDomain(testDomain);
    expect(active?.id).toBe(shop.id);
  });

  it('should handle uninstallation by setting uninstalledAt and revoking access token', async () => {
    const shop = await installOrUpdateShop({
      shopDomain: testDomain,
      accessToken: 'shpua_token_before_uninstall',
    });

    const uninstalled = await uninstallShop(testDomain);
    expect(uninstalled).toBeDefined();
    expect(uninstalled?.uninstalledAt).not.toBeNull();
    expect(uninstalled?.accessToken).toBe('');

    // Querying active shop should return null
    const active = await getActiveShopByDomain(testDomain);
    expect(active).toBeNull();

    const activeById = await getActiveShopById(shop.id);
    expect(activeById).toBeNull();
  });

  it('should cleanly reactivate a previously uninstalled shop upon reinstall', async () => {
    // 1. Install
    await installOrUpdateShop({
      shopDomain: testDomain,
      accessToken: 'token_1',
    });

    // 2. Uninstall
    await uninstallShop(testDomain);
    expect(await getActiveShopByDomain(testDomain)).toBeNull();

    // 3. Reinstall
    const reinstalled = await installOrUpdateShop({
      shopDomain: testDomain,
      accessToken: 'token_reinstalled_2',
    });

    expect(reinstalled.uninstalledAt).toBeNull();
    const plainToken = await getDecryptedAccessToken(reinstalled.id);
    expect(plainToken).toBe('token_reinstalled_2');

    // Verify it is active again
    const active = await getActiveShopByDomain(testDomain);
    expect(active).toBeDefined();
  });

  it('should correctly check shop quota boundaries', async () => {
    const shop = await installOrUpdateShop({
      shopDomain: testDomain,
      accessToken: 'token_quota_test',
    });

    const quota = await checkShopQuota(shop.id);
    expect(quota.planTier).toBe('STARTER');
    expect(quota.limits.maxLiveCatalogs).toBe(1);
    expect(quota.limits.monthlySubmissionsLimit).toBe(50);
    expect(quota.allowed.canPublishCatalog).toBe(true);
    expect(quota.allowed.canAcceptSubmission).toBe(true);
  });

  describe('Token Encryption at Rest (AES-256-GCM)', () => {
    const secret = 'my_super_secret_encryption_key_32bytes!';

    it('should encrypt with fresh IV every time and decrypt cleanly', () => {
      const token = 'shpat_secret_token_abcdef123456';
      const enc1 = encryptToken(token, secret);
      const enc2 = encryptToken(token, secret);

      expect(enc1).toMatch(/^enc:v1:/);
      expect(enc2).toMatch(/^enc:v1:/);
      // Fresh IV ensures different ciphertexts for the same plaintext
      expect(enc1).not.toBe(enc2);

      expect(decryptToken(enc1, secret)).toBe(token);
      expect(decryptToken(enc2, secret)).toBe(token);
    });

    it('should fail safely when attempting to decrypt with incorrect key', () => {
      const token = 'shpat_secret_token_abcdef123456';
      const enc = encryptToken(token, secret);

      const wrongSecret = 'wrong_secret_encryption_key_32bytes!';
      expect(() => decryptToken(enc, wrongSecret)).toThrow(CryptoError);
    });

    it('should reject malformed or tampered encryption envelopes', () => {
      expect(() => decryptToken('malformed_envelope', secret)).not.toThrow(); // non-envelope returns as-is
      expect(() => decryptToken('enc:v1:corrupted:tag:data', secret)).toThrow(CryptoError);
    });
  });

  describe('Auth Security and Hashing', () => {
    const secret = 'shpss_super_secret_webhook_key_xyz';

    it('should verify valid Shopify webhook HMAC', () => {
      const rawBody = JSON.stringify({ id: 12345, title: 'Product A' });
      const validHmac = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('base64');

      const isValid = verifyShopifyWebhookHmac(rawBody, validHmac, secret);
      expect(isValid).toBe(true);
    });

    it('should reject tampered webhook body or invalid HMAC', () => {
      const rawBody = JSON.stringify({ id: 12345, title: 'Product A' });
      const invalidHmac = 'invalid_base64_hmac==';

      expect(verifyShopifyWebhookHmac(rawBody, invalidHmac, secret)).toBe(false);
      expect(verifyShopifyWebhookHmac('tampered content', 'some_hmac', secret)).toBe(false);
      expect(verifyShopifyWebhookHmac(rawBody, '', secret)).toBe(false);
    });

    it('should validate myshopify.com domain format strictly', () => {
      expect(isValidShopifyDomain('my-store.myshopify.com')).toBe(true);
      expect(isValidShopifyDomain('https://my-store.myshopify.com')).toBe(true);
      expect(isValidShopifyDomain('evil-domain.com')).toBe(false);
      expect(isValidShopifyDomain('not-shopify.com/admin')).toBe(false);
      expect(isValidShopifyDomain('my-store.myshopify.com.attacker.com')).toBe(false);
    });

    it('should verify and decode valid App Bridge JWT session tokens with audience check', () => {
      const secret = 'my_shopify_app_secret_123';
      const clientId = 'my_app_client_id_456';
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const payloadObj = {
        dest: 'https://test-merchant.myshopify.com',
        iss: 'https://test-merchant.myshopify.com/admin',
        aud: clientId,
        sub: 'user_123',
        exp: now + 3600,
        nbf: now - 10,
        iat: now,
        jti: 'jwt_id_123',
        sid: 'session_123',
      };
      const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
      const signature = crypto
        .createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url');

      const token = `${header}.${payload}.${signature}`;

      const decoded = verifyAppBridgeJwt(token, secret, clientId);
      expect(decoded).not.toBeNull();
      expect(decoded?.shopDomain).toBe('test-merchant.myshopify.com');
      expect(decoded?.sub).toBe('user_123');

      // 1. Wrong audience
      expect(verifyAppBridgeJwt(token, secret, 'different_client_id')).toBeNull();

      // 2. Mismatched dest and iss host
      const tamperedIssObj = { ...payloadObj, iss: 'https://evil-merchant.myshopify.com/admin' };
      const tamperedPayload = Buffer.from(JSON.stringify(tamperedIssObj)).toString('base64url');
      const tamperedSig = crypto
        .createHmac('sha256', secret)
        .update(`${header}.${tamperedPayload}`)
        .digest('base64url');
      expect(verifyAppBridgeJwt(`${header}.${tamperedPayload}.${tamperedSig}`, secret, clientId)).toBeNull();

      // 3. Expired token
      const expiredPayloadObj = { ...payloadObj, exp: now - 100 };
      const expiredPayload = Buffer.from(JSON.stringify(expiredPayloadObj)).toString('base64url');
      const expiredSignature = crypto
        .createHmac('sha256', secret)
        .update(`${header}.${expiredPayload}`)
        .digest('base64url');
      expect(verifyAppBridgeJwt(`${header}.${expiredPayload}.${expiredSignature}`, secret, clientId)).toBeNull();
    });
  });

  const defaultSecret = 'managed_install_test_secret_123';
  const defaultClientId = 'managed_install_client_id_456';

  function createValidSessionToken(shopDomain: string = 'managed-store.myshopify.com', secret: string = defaultSecret, clientId: string = defaultClientId): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payloadObj = {
      dest: `https://${shopDomain}`,
      iss: `https://${shopDomain}/admin`,
      aud: clientId,
      sub: 'user_456',
      exp: now + 3600,
      nbf: now - 10,
      iat: now,
      jti: 'jwt_id_456',
      sid: 'session_456',
    };
    const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  describe('Shopify Managed Installation & Token Exchange Boundary', () => {
    const secret = defaultSecret;
    const clientId = defaultClientId;
    const managedDomain = 'managed-store.myshopify.com';

    beforeEach(async () => {
      process.env.SHOPIFY_API_SECRET = secret;
      process.env.SHOPIFY_API_KEY = clientId;
      await prisma.shop.deleteMany({ where: { shopDomain: managedDomain } });
    });

    it('should exchange session token for expiring offline access token via RFC 8693 token exchange with application/x-www-form-urlencoded', async () => {
      const sessionToken = createValidSessionToken();

      // Mock fetch response from Shopify token exchange
      const mockFetch: any = async (url: string, options: any) => {
        expect(url).toBe(`https://${managedDomain}/admin/oauth/access_token`);
        expect(options.method).toBe('POST');
        expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

        const params = new URLSearchParams(options.body);
        expect(params.get('client_id')).toBe(clientId);
        expect(params.get('client_secret')).toBe(secret);
        expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
        expect(params.get('subject_token')).toBe(sessionToken);
        expect(params.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id_token');
        expect(params.get('requested_token_type')).toBe('urn:shopify:params:oauth:token-type:offline-access-token');
        expect(params.get('expiring')).toBe('1');

        return {
          ok: true,
          json: async () => ({
            access_token: 'shpat_offline_expiring_token_789',
            scope: 'read_products,read_inventory,write_draft_orders,read_draft_orders',
            expires_in: 86400,
            refresh_token: 'shprt_refresh_token_789',
            refresh_token_expires_in: 2592000,
          }),
        };
      };

      const result = await exchangeSessionTokenForOfflineToken({
        shopDomain: managedDomain,
        sessionToken,
        clientId,
        clientSecret: secret,
        fetchFn: mockFetch,
      });

      expect(result.accessToken).toBe('shpat_offline_expiring_token_789');
      expect(result.scope).toContain('read_products');
      expect(result.expiresIn).toBe(86400);
      expect(result.refreshToken).toBe('shprt_refresh_token_789');
      expect(result.refreshTokenExpiresIn).toBe(2592000);
    });

    it('should store encrypted access token, encrypted refresh token, and expiry timestamps in Shop model', async () => {
      const accessExpires = new Date(Date.now() + 86400 * 1000);
      const refreshExpires = new Date(Date.now() + 2592000 * 1000);

      const shop = await installOrUpdateShop({
        shopDomain: managedDomain,
        accessToken: 'shpat_secret_access_value',
        accessTokenExpiresAt: accessExpires,
        refreshToken: 'shprt_secret_refresh_value',
        refreshTokenExpiresAt: refreshExpires,
        scopes: 'read_products,write_draft_orders',
      });

      expect(shop.accessToken).toMatch(/^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+/);
      expect(shop.refreshToken).toMatch(/^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+/);
      expect(shop.accessToken).not.toContain('shpat_secret_access_value');
      expect(shop.refreshToken).not.toContain('shprt_secret_refresh_value');
      expect(shop.accessTokenExpiresAt).toEqual(accessExpires);
      expect(shop.refreshTokenExpiresAt).toEqual(refreshExpires);
      expect(shop.scopes).toBe('read_products,write_draft_orders');

      // Safe decryption with correct key
      expect(decryptToken(shop.accessToken)).toBe('shpat_secret_access_value');
      expect(decryptToken(shop.refreshToken!)).toBe('shprt_secret_refresh_value');

      // Wrong key fails safely
      const wrongKey = crypto.randomBytes(32).toString('hex');
      expect(() => decryptToken(shop.accessToken, wrongKey)).toThrow(CryptoError);
    });

    it('should complete managed install and store expiring tokens via /api/auth/token-exchange endpoint', async () => {
      const sessionToken = createValidSessionToken();

      // Intercept global fetch for token exchange
      const originalFetch = global.fetch;
      global.fetch = async (url: any, options: any) => {
        if (typeof url === 'string' && url.includes('/admin/oauth/access_token')) {
          const params = new URLSearchParams(options.body);
          expect(params.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id_token');
          expect(params.get('expiring')).toBe('1');
          return {
            ok: true,
            json: async () => ({
              access_token: 'shpat_offline_endpoint_token',
              scope: 'read_products',
              expires_in: 3600,
              refresh_token: 'shprt_endpoint_refresh',
              refresh_token_expires_in: 86400,
            }),
            text: async () => '',
          } as any;
        }
        return originalFetch(url, options);
      };

      try {
        const res = await request(app)
          .post('/api/auth/token-exchange')
          .set('Authorization', `Bearer ${sessionToken}`)
          .send();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.shopDomain).toBe(managedDomain);
        expect(res.body.installed).toBe(true);

        const shop = await prisma.shop.findUnique({ where: { shopDomain: managedDomain } });
        expect(shop).not.toBeNull();
        expect(shop?.uninstalledAt).toBeNull();
        expect(decryptToken(shop!.accessToken)).toBe('shpat_offline_endpoint_token');
        expect(decryptToken(shop!.refreshToken!)).toBe('shprt_endpoint_refresh');
        expect(shop!.accessTokenExpiresAt).not.toBeNull();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should reactivate credentials on reinstall via token exchange', async () => {
      await installOrUpdateShop({
        shopDomain: managedDomain,
        accessToken: 'shpat_old_revoked_token',
      });

      await uninstallShop(managedDomain);
      let shop = await prisma.shop.findUnique({ where: { shopDomain: managedDomain } });
      expect(shop?.uninstalledAt).not.toBeNull();

      const sessionToken = createValidSessionToken();
      const originalFetch = global.fetch;
      global.fetch = async (url: any, options: any) => {
        if (typeof url === 'string' && url.includes('/admin/oauth/access_token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'shpat_freshly_reinstalled_token',
              scope: 'read_products',
              expires_in: 7200,
              refresh_token: 'shprt_reinstalled_refresh',
            }),
            text: async () => '',
          } as any;
        }
        return originalFetch(url, options);
      };

      try {
        const res = await request(app)
          .post('/api/auth/token-exchange')
          .set('Authorization', `Bearer ${sessionToken}`)
          .send();

        expect(res.status).toBe(200);
        shop = await prisma.shop.findUnique({ where: { shopDomain: managedDomain } });
        expect(shop?.uninstalledAt).toBeNull();

        const activeToken = await getDecryptedAccessToken(shop!.id);
        expect(activeToken).toBe('shpat_freshly_reinstalled_token');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should reject legacy OAuth routes with 404 (authorization-code flow removed)', async () => {
      const resShopify = await request(app).get('/auth/shopify?shop=test.myshopify.com');
      expect(resShopify.status).toBe(404);

      const resCallback = await request(app).get('/auth/callback?shop=test.myshopify.com&code=123');
      expect(resCallback.status).toBe(404);
    });
  });

  describe('Server-Side Token Refresh & Rotation', () => {
    const refreshShopDomain = 'test-token-refresh.myshopify.com';

    beforeEach(async () => {
      await prisma.shop.deleteMany({ where: { shopDomain: refreshShopDomain } });
    });

    it('should NOT refresh a valid access token far from expiry', async () => {
      const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const shop = await installOrUpdateShop({
        shopDomain: refreshShopDomain,
        accessToken: 'shpat_valid_not_expiring',
        accessTokenExpiresAt: farFuture,
        refreshToken: 'shprt_refresh_initial',
      });

      let fetchCalled = false;
      const mockFetch: any = async () => {
        fetchCalled = true;
        throw new Error('Should not call fetch');
      };

      const token = await getValidOfflineAccessToken(shop.id, { fetchFn: mockFetch });
      expect(fetchCalled).toBe(false);
      expect(token).toBe('shpat_valid_not_expiring');
    });

    it('should refresh near-expiry access token and atomically persist new token pair', async () => {
      // Near expiry: expires in 2 minutes (within 5-minute safety buffer)
      const nearExpiry = new Date(Date.now() + 2 * 60 * 1000);
      const shop = await installOrUpdateShop({
        shopDomain: refreshShopDomain,
        accessToken: 'shpat_about_to_expire',
        accessTokenExpiresAt: nearExpiry,
        refreshToken: 'shprt_rotation_1',
      });

      let refreshPayloadCaptured: any = null;
      const mockFetch: any = async (url: string, options: any) => {
        expect(url).toBe(`https://${refreshShopDomain}/admin/oauth/access_token`);
        expect(options.method).toBe('POST');
        expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

        const params = new URLSearchParams(options.body);
        refreshPayloadCaptured = {
          grant_type: params.get('grant_type'),
          refresh_token: params.get('refresh_token'),
          client_id: params.get('client_id'),
          client_secret: params.get('client_secret'),
        };

        return {
          ok: true,
          json: async () => ({
            access_token: 'shpat_rotated_access_2',
            expires_in: 7200,
            refresh_token: 'shprt_rotated_refresh_2',
            refresh_token_expires_in: 86400,
          }),
        };
      };

      const newToken = await getValidOfflineAccessToken(shop.id, { fetchFn: mockFetch });
      expect(newToken).toBe('shpat_rotated_access_2');
      expect(refreshPayloadCaptured.grant_type).toBe('refresh_token');
      expect(refreshPayloadCaptured.refresh_token).toBe('shprt_rotation_1');

      // Verify atomic DB persistence of rotated credentials
      const updatedShop = await prisma.shop.findUnique({ where: { id: shop.id } });
      expect(decryptToken(updatedShop!.accessToken)).toBe('shpat_rotated_access_2');
      expect(decryptToken(updatedShop!.refreshToken!)).toBe('shprt_rotated_refresh_2');
      expect(updatedShop!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 7000 * 1000);

      // Subsequent retrieval should return the newly persisted token immediately without calling fetch
      let secondFetchCalled = false;
      const noFetch: any = async () => { secondFetchCalled = true; };
      const cachedToken = await getValidOfflineAccessToken(shop.id, { fetchFn: noFetch });
      expect(cachedToken).toBe('shpat_rotated_access_2');
      expect(secondFetchCalled).toBe(false);
    });

    it('should not overwrite valid stored credentials if token refresh fails with network/server error', async () => {
      const nearExpiry = new Date(Date.now() + 60 * 1000);
      const shop = await installOrUpdateShop({
        shopDomain: refreshShopDomain,
        accessToken: 'shpat_safe_fallback_token',
        accessTokenExpiresAt: nearExpiry,
        refreshToken: 'shprt_safe_refresh',
      });

      const failingFetch: any = async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Shopify Gateway Error',
      });

      await expect(
        getValidOfflineAccessToken(shop.id, { fetchFn: failingFetch })
      ).rejects.toThrow('Failed to refresh Shopify access token');

      // Database should NOT have wiped or broken the stored credentials
      const unchangedShop = await prisma.shop.findUnique({ where: { id: shop.id } });
      expect(decryptToken(unchangedShop!.accessToken)).toBe('shpat_safe_fallback_token');
      expect(decryptToken(unchangedShop!.refreshToken!)).toBe('shprt_safe_refresh');
    });

    it('should produce ShopifyAuthRequiredError when refresh token is rejected (400/401)', async () => {
      const expiredDate = new Date(Date.now() - 1000);
      const shop = await installOrUpdateShop({
        shopDomain: refreshShopDomain,
        accessToken: 'shpat_expired',
        accessTokenExpiresAt: expiredDate,
        refreshToken: 'shprt_revoked_by_merchant',
      });

      const rejectedFetch: any = async () => ({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant: refresh token revoked',
      });

      await expect(
        getValidOfflineAccessToken(shop.id, { fetchFn: rejectedFetch })
      ).rejects.toThrow(ShopifyAuthRequiredError);
    });

    it('should make GraphQL client token-aware and retry once on 401 with refreshed token', async () => {
      const shop = await installOrUpdateShop({
        shopDomain: refreshShopDomain,
        accessToken: 'shpat_current_token',
        accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
        refreshToken: 'shprt_refresh_for_graphql',
      });

      let requestCount = 0;
      let tokenReceivedInHeader: string | null = null;

      const originalFetch = global.fetch;
      global.fetch = async (url: any, options: any) => {
        if (typeof url === 'string' && url.includes('/admin/oauth/access_token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'shpat_freshly_refreshed_graphql_token',
              expires_in: 3600,
              refresh_token: 'shprt_next_refresh',
            }),
            text: async () => '',
          } as any;
        }

        if (typeof url === 'string' && url.includes('/graphql.json')) {
          requestCount++;
          tokenReceivedInHeader = options.headers['X-Shopify-Access-Token'];
          if (requestCount === 1) {
            // First call fails with 401 Unauthorized
            return {
              ok: false,
              status: 401,
              text: async () => 'Unauthorized',
              headers: new Headers(),
            } as any;
          }
          // Second call after refresh succeeds
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { shop: { name: 'Refreshed Shop' } } }),
            headers: new Headers(),
          } as any;
        }
        return originalFetch(url, options);
      };

      try {
        const client = new ShopifyAdminClient({
          shopDomain: refreshShopDomain,
          shopId: shop.id,
        });

        const data = await client.request<{ shop: { name: string } }>('{ shop { name } }');
        expect(requestCount).toBe(2);
        expect(tokenReceivedInHeader).toBe('shpat_freshly_refreshed_graphql_token');
        expect(data.shop.name).toBe('Refreshed Shop');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('App Bridge Stale Token Retry Semantics (401 & Header)', () => {
    it('should return 401 with X-Shopify-Retry-Invalid-Session-Request: 1 on invalid ID token', async () => {
      const res = await request(app)
        .get('/api/admin/catalogs')
        .set('Authorization', 'Bearer invalid.or.tampered.token');

      expect(res.status).toBe(401);
      expect(res.headers['x-shopify-retry-invalid-session-request']).toBe('1');
      expect(res.body.error).toContain('Invalid, expired, or untrusted session token');
    });

    it('should return 401 with X-Shopify-Retry-Invalid-Session-Request: 1 when token exchange returns HTTP 400', async () => {
      const sessionToken = createValidSessionToken('stale-token-shop.myshopify.com');

      const originalFetch = global.fetch;
      global.fetch = async (url: any) => {
        if (typeof url === 'string' && url.includes('/admin/oauth/access_token')) {
          return {
            ok: false,
            status: 400,
            text: async () => 'stale subject token expired',
          } as any;
        }
        return originalFetch(url);
      };

      try {
        const res = await request(app)
          .post('/api/auth/token-exchange')
          .set('Authorization', `Bearer ${sessionToken}`)
          .send();

        expect(res.status).toBe(401);
        expect(res.headers['x-shopify-retry-invalid-session-request']).toBe('1');
        expect(res.body.error).toBe('Stale ID token');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('Embedded Admin Bootstrap & Public Buyer Routing', () => {
    const bootstrapShopDomain = 'test-embedded-bootstrap.myshopify.com';

    beforeEach(async () => {
      await prisma.shop.deleteMany({ where: { shopDomain: bootstrapShopDomain } });
    });

    it('should bootstrap an authenticated shop and trigger initial sync for new installs', async () => {
      const sessionToken = createValidSessionToken(bootstrapShopDomain);

      const originalFetch = global.fetch;
      global.fetch = async (url: any) => {
        if (typeof url === 'string' && url.includes('/admin/oauth/access_token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'shpat_bootstrap_offline_token',
              scope: 'read_products',
              expires_in: 86400,
              refresh_token: 'shprt_bootstrap_refresh',
            }),
            text: async () => '',
          } as any;
        }
        return originalFetch(url);
      };

      try {
        const res = await request(app)
          .post('/api/admin/bootstrap')
          .set('Authorization', `Bearer ${sessionToken}`)
          .send();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.shop.shopDomain).toBe(bootstrapShopDomain);
        expect(res.body.shop.installed).toBe(true);

        // Verify shop was created in DB
        const shop = await prisma.shop.findUnique({ where: { shopDomain: bootstrapShopDomain } });
        expect(shop).not.toBeNull();
        expect(decryptToken(shop!.accessToken)).toBe('shpat_bootstrap_offline_token');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should reactivate an uninstalled shop on embedded admin bootstrap', async () => {
      // Create and uninstall shop
      await installOrUpdateShop({
        shopDomain: bootstrapShopDomain,
        accessToken: 'shpat_prior_to_uninstall',
      });
      await uninstallShop(bootstrapShopDomain);

      const sessionToken = createValidSessionToken(bootstrapShopDomain);
      const originalFetch = global.fetch;
      global.fetch = async (url: any) => {
        if (typeof url === 'string' && url.includes('/admin/oauth/access_token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'shpat_reactivated_bootstrap_token',
              scope: 'read_products',
              expires_in: 86400,
              refresh_token: 'shprt_reactivated_refresh',
            }),
            text: async () => '',
          } as any;
        }
        return originalFetch(url);
      };

      try {
        const res = await request(app)
          .post('/api/admin/bootstrap')
          .set('Authorization', `Bearer ${sessionToken}`)
          .send();

        expect(res.status).toBe(200);
        const shop = await prisma.shop.findUnique({ where: { shopDomain: bootstrapShopDomain } });
        expect(shop?.uninstalledAt).toBeNull();
        expect(decryptToken(shop!.accessToken)).toBe('shpat_reactivated_bootstrap_token');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should keep public buyer portal /c/:publicToken isolated from admin authentication', async () => {
      // 1. Public catalog API endpoint does not require App Bridge session token or Admin auth
      const validFormatNonExistent = '0'.repeat(64);
      const apiRes = await request(app).get(`/api/public/catalog/${validFormatNonExistent}`);
      expect(apiRes.status).toBe(404);
      expect(apiRes.headers['x-shopify-retry-invalid-session-request']).toBeUndefined();

      // 2. Public buyer HTML entrypoint does not require session token or redirect
      const pageRes = await request(app).get(`/c/${validFormatNonExistent}`);
      expect(pageRes.status).toBe(200);
      expect(pageRes.headers['x-shopify-retry-invalid-session-request']).toBeUndefined();
    });
  });
});

