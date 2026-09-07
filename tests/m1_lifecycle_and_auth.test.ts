import { describe, it, expect, beforeEach } from 'vitest';
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
});
