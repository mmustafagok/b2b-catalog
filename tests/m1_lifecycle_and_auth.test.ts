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
} from '../src/services/auth.server.js';
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

  describe('Shopify Managed Installation & Token Exchange Boundary', () => {
    const secret = 'managed_install_test_secret_123';
    const clientId = 'managed_install_client_id_456';
    const managedDomain = 'managed-store.myshopify.com';

    beforeEach(async () => {
      process.env.SHOPIFY_API_SECRET = secret;
      process.env.SHOPIFY_API_KEY = clientId;
      await prisma.shop.deleteMany({ where: { shopDomain: managedDomain } });
    });

    function createValidSessionToken(shopDomain: string = managedDomain): string {
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

    it('should exchange session token for offline access token via RFC 8693 token exchange', async () => {
      const sessionToken = createValidSessionToken();

      // Mock fetch response from Shopify token exchange
      const mockFetch: any = async (url: string, options: any) => {
        expect(url).toBe(`https://${managedDomain}/admin/oauth/access_token`);
        const body = JSON.parse(options.body);
        expect(body.client_id).toBe(clientId);
        expect(body.client_secret).toBe(secret);
        expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
        expect(body.subject_token).toBe(sessionToken);
        expect(body.requested_token_type).toBe('urn:shopify:params:oauth:token-type:offline-access-token');

        return {
          ok: true,
          json: async () => ({
            access_token: 'shpat_offline_exchanged_token_789',
            scope: 'read_products,read_inventory,write_draft_orders,read_draft_orders',
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

      expect(result.accessToken).toBe('shpat_offline_exchanged_token_789');
      expect(result.scope).toContain('read_products');
    });

    it('should complete managed install via /api/auth/token-exchange endpoint', async () => {
      const sessionToken = createValidSessionToken();

      // Intercept global fetch for token exchange
      const originalFetch = global.fetch;
      global.fetch = async (url: any, options: any) => {
        if (typeof url === 'string' && url.includes('/admin/oauth/access_token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'shpat_offline_exchanged_token_endpoint',
              scope: 'read_products',
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

        // Verify shop was installed in DB
        const shop = await prisma.shop.findUnique({ where: { shopDomain: managedDomain } });
        expect(shop).not.toBeNull();
        expect(shop?.uninstalledAt).toBeNull();

        // Verify access token is encrypted
        const decrypted = await getDecryptedAccessToken(shop!.id);
        expect(decrypted).toBe('shpat_offline_exchanged_token_endpoint');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should reactivate credentials on reinstall via token exchange', async () => {
      // 1. Initial install
      await installOrUpdateShop({
        shopDomain: managedDomain,
        accessToken: 'shpat_old_revoked_token',
      });

      // 2. Merchant uninstalls
      await uninstallShop(managedDomain);
      let shop = await prisma.shop.findUnique({ where: { shopDomain: managedDomain } });
      expect(shop?.uninstalledAt).not.toBeNull();

      // 3. Merchant reinstalls through Shopify admin (triggers token exchange)
      const sessionToken = createValidSessionToken();
      const originalFetch = global.fetch;
      global.fetch = async (url: any, options: any) => {
        if (typeof url === 'string' && url.includes('/admin/oauth/access_token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'shpat_freshly_reinstalled_token',
              scope: 'read_products',
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
});

