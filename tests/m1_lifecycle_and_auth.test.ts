import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import {
  installOrUpdateShop,
  uninstallShop,
  getActiveShopByDomain,
  getActiveShopById,
  checkShopQuota,
} from '../src/services/shop.server.js';
import {
  verifyShopifyWebhookHmac,
  generateOpaqueToken,
  hashIdempotencyKey,
  verifyAppBridgeJwt,
} from '../src/services/auth.server.js';
import crypto from 'crypto';

describe('Milestone 1: Shop Lifecycle and Auth Foundations', () => {
  const testDomain = 'test-merchant-lifecycle.myshopify.com';

  beforeEach(async () => {
    // Clean up test domain before each run
    await prisma.orderSubmission.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany({ where: { shopDomain: testDomain } });
  });

  it('should install a new shop with starter plan and active status', async () => {
    const shop = await installOrUpdateShop({
      shopDomain: testDomain,
      accessToken: 'shpua_initial_test_token_123',
    });

    expect(shop).toBeDefined();
    expect(shop.shopDomain).toBe(testDomain);
    expect(shop.accessToken).toBe('shpua_initial_test_token_123');
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

    // Verify it is inactive
    expect(await getActiveShopByDomain(testDomain)).toBeNull();

    // 3. Reinstall
    const reinstalled = await installOrUpdateShop({
      shopDomain: testDomain,
      accessToken: 'token_reinstalled_2',
    });

    expect(reinstalled.uninstalledAt).toBeNull();
    expect(reinstalled.accessToken).toBe('token_reinstalled_2');

    // Verify it is active again
    const active = await getActiveShopByDomain(testDomain);
    expect(active).toBeDefined();
    expect(active?.accessToken).toBe('token_reinstalled_2');
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

    it('should generate 256-bit cryptographically secure URL-safe opaque tokens', () => {
      const token1 = generateOpaqueToken();
      const token2 = generateOpaqueToken();

      expect(token1).toHaveLength(64); // 32 bytes = 64 hex characters
      expect(token2).toHaveLength(64);
      expect(token1).not.toBe(token2);
    });

    it('should deterministically hash idempotency keys per public token', () => {
      const publicToken = '0123456789abcdef0123456789abcdef';
      const clientKey = 'order-req-998811';

      const hash1 = hashIdempotencyKey(publicToken, clientKey);
      const hash2 = hashIdempotencyKey(publicToken, clientKey);
      const differentKeyHash = hashIdempotencyKey(publicToken, 'order-req-998812');

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // sha256 hex
      expect(hash1).not.toBe(differentKeyHash);
    });

    it('should verify and decode valid App Bridge JWT session tokens', () => {
      const secret = 'my_shopify_app_secret_123';
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const payloadObj = {
        dest: 'https://test-merchant.myshopify.com',
        iss: 'https://test-merchant.myshopify.com/admin',
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

      const decoded = verifyAppBridgeJwt(token, secret);
      expect(decoded).not.toBeNull();
      expect(decoded?.dest).toBe('https://test-merchant.myshopify.com');
      expect(decoded?.sub).toBe('user_123');

      // Test expired token
      const expiredPayloadObj = { ...payloadObj, exp: now - 100 };
      const expiredPayload = Buffer.from(JSON.stringify(expiredPayloadObj)).toString('base64url');
      const expiredSignature = crypto
        .createHmac('sha256', secret)
        .update(`${header}.${expiredPayload}`)
        .digest('base64url');
      const expiredToken = `${header}.${expiredPayload}.${expiredSignature}`;

      expect(verifyAppBridgeJwt(expiredToken, secret)).toBeNull();
    });
  });
});
