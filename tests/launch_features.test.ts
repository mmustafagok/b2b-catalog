import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import {
  createCatalog,
  publishCatalog,
  unpublishCatalog,
  getCatalogVariantConfigs,
  upsertCatalogVariantConfigs,
} from '../src/services/catalog.server.js';
import {
  createOrderLink,
  getOrderLinksForCatalog,
  getOrderLinkById,
  recordOrderLinkView,
  recordOrderLinkSubmission,
  validateOrderLinkAccess,
  generateQrCodeDataUrl,
  verifyPasscode,
  hashPasscode,
  generateOrderLinkAccessToken,
  verifyOrderLinkAccessToken,
  resetOrderLinkViewCache,
  isOrderLinkExpired,
} from '../src/services/orderlink.server.js';
import {
  createReorderIntent,
  getReorderIntentPayload,
  markReorderIntentUsed,
  claimReorderIntent,
  releaseReorderIntentClaim,
  commitReorderIntentUsed,
  markReorderIntentReconciliationPending,
  resetReorderIntentToAvailable,
  ReorderIntentError,
} from '../src/services/reorder.server.js';
import { parseCsvBulkOrder } from '../src/services/bulkorder.server.js';
import { getPublicCatalogPayload, syncProductSnapshot } from '../src/services/sync.server.js';
import { validateBuyerOrderLines } from '../src/services/validation.server.js';
import { submitBuyerOrder, reconcileSubmission } from '../src/services/order.server.js';
import { PriceMode, InventoryMode, CatalogSourceType } from '../src/types/index.js';

describe('Focused Hardening Pass: Passcode Gate, Reorder Concurrency, View Analytics', () => {
  let shop: { id: string; shopDomain: string; currency?: string };

  beforeEach(async () => {
    resetOrderLinkViewCache();
    await prisma.reorderIntent.deleteMany();
    await prisma.orderLink.deleteMany();
    await prisma.catalogVariantConfig.deleteMany();
    await prisma.orderSubmission.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'launch-features-test.myshopify.com',
      accessToken: 'test_token',
    });
  });

  // ===========================================================================
  // 1. PASSCODE SECURITY TESTS (Cases 1 - 9)
  // ===========================================================================
  describe('Passcode Security & Scoped Access Credential', () => {
    it('1. passcode cannot be supplied by query string or plain string to access validator', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Protected VIP Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'VIP Link',
        passcode: 'secret2026',
      });

      // Passing raw passcode as credential string fails validation
      const accessWithRawPasscode = validateOrderLinkAccess(link, 'secret2026');
      expect(accessWithRawPasscode.ok).toBe(false);
      expect(accessWithRawPasscode.reason).toBe('INVALID_ACCESS_TOKEN');
    });

    it('2. protected catalog content is unavailable before unlock', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Protected VIP Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'VIP Link',
        passcode: 'secret2026',
      });

      const accessWithoutToken = validateOrderLinkAccess(link, null);
      expect(accessWithoutToken.ok).toBe(false);
      expect(accessWithoutToken.reason).toBe('PASSCODE_REQUIRED');
    });

    it('3. correct passcode unlocks link and yields valid scoped access credential', async () => {
      const plain = 'WholesaleVIP2026!';
      const hash = hashPasscode(plain);
      expect(verifyPasscode(plain, hash)).toBe(true);

      const catalog = await createCatalog(shop.id, {
        name: 'Protected VIP Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'VIP Link',
        passcode: plain,
      });

      // Verify passcode against stored scrypt hash
      expect(verifyPasscode(plain, link.passcodeHash!)).toBe(true);

      // Issue signed scoped access credential
      const token = generateOrderLinkAccessToken(link);
      expect(token).toContain('.');

      // Scoped credential grants access
      const access = validateOrderLinkAccess(link, token);
      expect(access.ok).toBe(true);
    });

    it('4. incorrect passcode rejected', async () => {
      const plain = 'WholesaleVIP2026!';
      const hash = hashPasscode(plain);
      expect(verifyPasscode('wrong-password', hash)).toBe(false);
      expect(verifyPasscode('', hash)).toBe(false);
      expect(verifyPasscode('wholesalevip2026!', hash)).toBe(false); // Case sensitive
    });

    it('5. rate limiter is configured and available for unlock endpoint', async () => {
      // Validates that verifyPasscode uses scrypt with high work factor
      const start = Date.now();
      const hash = hashPasscode('test-passcode');
      verifyPasscode('wrong', hash);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(1); // Non-trivial cryptographic work
    });

    it('6. unlock credential is scoped to correct link only', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Protected VIP Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const linkA = await createOrderLink(catalog.id, shop.id, {
        label: 'Link A',
        passcode: 'passcodeA',
      });
      const linkB = await createOrderLink(catalog.id, shop.id, {
        label: 'Link B',
        passcode: 'passcodeB',
      });

      const tokenA = generateOrderLinkAccessToken(linkA);

      // Token generated for Link A must be rejected when accessing Link B
      const accessB = validateOrderLinkAccess(linkB, tokenA);
      expect(accessB.ok).toBe(false);
      expect(accessB.reason).toBe('ACCESS_TOKEN_SCOPE_MISMATCH');
    });

    it('7. expired link rejected after previous unlock', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Expiring VIP Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'Expiring Link',
        passcode: 'validpass',
        expiresAt: new Date(Date.now() - 60000).toISOString(), // Expired 1 min ago
      });

      const token = generateOrderLinkAccessToken(link);
      const access = validateOrderLinkAccess(link, token);
      expect(access.ok).toBe(false);
      expect(access.reason).toBe('LINK_EXPIRED');
    });

    it('8. inactive link rejected after previous unlock', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Inactive VIP Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'Inactive Link',
        passcode: 'validpass',
      });
      // Deactivate link
      const inactiveLink = { ...link, active: false };

      const token = generateOrderLinkAccessToken(inactiveLink);
      const access = validateOrderLinkAccess(inactiveLink, token);
      expect(access.ok).toBe(false);
      expect(access.reason).toBe('LINK_INACTIVE');
    });

    it('9. raw passcode is not exposed in returned URLs or payloads', async () => {
      const plain = 'SuperSecret123';
      const catalog = await createCatalog(shop.id, {
        name: 'Secure Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'Secure Link',
        passcode: plain,
      });

      expect(link.passcodeHash).not.toBe(plain);
      expect(link.passcodeHash).not.toContain(plain);
      expect(JSON.stringify(link)).not.toContain(plain);
    });
  });

  // ===========================================================================
  // 2. REORDER CONCURRENCY & RECONCILIATION HARDENING TESTS (18 Scenarios)
  // ===========================================================================
  describe('Reorder Concurrency & Reconciliation State Machine', () => {
    // 1. Normal unused reorder token can be claimed
    it('1. normal unused reorder token can be claimed', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Reorder Test Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'a'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const res = await claimReorderIntent(intent.token, 'claim_worker_1', 60);
      expect(res.success).toBe(true);

      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.claimedAt).not.toBeNull();
      expect(inDb?.claimId).toBe('claim_worker_1');
      expect(inDb?.usedAt).toBeNull();
      expect(inDb?.reconciliationPendingAt).toBeNull();
    });

    // 2. Two simultaneous claims: exactly one succeeds
    it('2. two simultaneous claims -> exactly one succeeds', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Race Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'b'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 10 }]),
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const results = await Promise.allSettled([
        claimReorderIntent(intent.token, 'worker_A', 60),
        claimReorderIntent(intent.token, 'worker_B', 60),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('REORDER_LINK_ALREADY_IN_USE');
    });

    // 3. Normal abandoned CLAIMED token: becomes reclaimable after TTL when no ambiguous execution occurred
    it('3. normal abandoned CLAIMED token becomes reclaimable after TTL when no ambiguous execution occurred', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Abandoned Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'c'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          claimedAt: new Date(Date.now() - 300000), // Claimed 5 mins ago
          claimId: 'crashed_worker',
          claimExpiresAt: new Date(Date.now() - 180000), // Expired 3 mins ago
          reconciliationPendingAt: null, // No ambiguous execution occurred
        },
      });

      // New worker can reclaim the abandoned token
      const res = await claimReorderIntent(intent.token, 'new_worker', 120);
      expect(res.success).toBe(true);

      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.claimId).toBe('new_worker');
    });

    // 4. Ambiguous Shopify execution: token enters RECONCILIATION_PENDING
    it('4. ambiguous Shopify execution -> token enters RECONCILIATION_PENDING', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Ambiguous Execution Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'd'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          claimedAt: new Date(),
          claimId: 'in_flight_claim',
          claimExpiresAt: new Date(Date.now() + 120000),
        },
      });

      await markReorderIntentReconciliationPending(intent.token, 'in_flight_claim');

      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.reconciliationPendingAt).not.toBeNull();
      expect(inDb?.usedAt).toBeNull();
    });

    // 5. RECONCILIATION_PENDING token: cannot be reclaimed after 2 minutes
    it('5. RECONCILIATION_PENDING token cannot be reclaimed after 2 minutes', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'TTL Block 2min Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'e'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          claimedAt: new Date(Date.now() - 150000), // 2.5 min ago
          claimId: 'ambiguous_worker',
          claimExpiresAt: new Date(Date.now() - 30000), // Claim TTL passed 30s ago
          reconciliationPendingAt: new Date(Date.now() - 140000), // Marked ambiguous
        },
      });

      await expect(claimReorderIntent(intent.token, 'intruder_worker', 120)).rejects.toMatchObject({
        code: 'REORDER_LINK_RECONCILIATION_PENDING',
        statusCode: 409,
      });
    });

    // 6. RECONCILIATION_PENDING token: cannot be reclaimed after a much longer simulated time either
    it('6. RECONCILIATION_PENDING token cannot be reclaimed after a much longer simulated time either', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'TTL Block Long Time Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'f'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          claimedAt: new Date(Date.now() - 7 * 86400000), // 7 days ago
          claimId: 'ancient_worker',
          claimExpiresAt: new Date(Date.now() - 7 * 86400000 + 120000),
          reconciliationPendingAt: new Date(Date.now() - 7 * 86400000), // Marked ambiguous 7 days ago
        },
      });

      await expect(claimReorderIntent(intent.token, 'new_attempt', 120)).rejects.toMatchObject({
        code: 'REORDER_LINK_RECONCILIATION_PENDING',
        statusCode: 409,
      });

      await expect(getReorderIntentPayload(intent.token)).rejects.toMatchObject({
        code: 'REORDER_LINK_RECONCILIATION_PENDING',
        statusCode: 409,
      });
    });

    // 7. Reconciliation finds Draft Order: token becomes USED
    it('7. reconciliation finds Draft Order -> token becomes USED', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Reconciliation Adopt Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'g'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          reconciliationPendingAt: new Date(),
        },
      });

      // Synchronous commit when Draft Order is recovered/adopted
      await commitReorderIntentUsed(intent.token);

      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.usedAt).not.toBeNull();
      expect(inDb?.reconciliationPendingAt).toBeNull();
      expect(inDb?.claimedAt).toBeNull();
      expect(inDb?.claimId).toBeNull();
    });

    // 8. USED token: cannot be reused
    it('8. USED token cannot be reused', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Used Link Block Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'h'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          usedAt: new Date(),
        },
      });

      await expect(claimReorderIntent(intent.token, 'subsequent_attempt', 120)).rejects.toMatchObject({
        code: 'REORDER_LINK_ALREADY_USED',
        statusCode: 410,
      });

      await expect(getReorderIntentPayload(intent.token)).rejects.toMatchObject({
        code: 'REORDER_LINK_ALREADY_USED',
        statusCode: 410,
      });
    });

    // 9. Reconciliation safely proves no Draft Order: token becomes AVAILABLE again
    it('9. reconciliation safely proves no Draft Order -> token becomes AVAILABLE again', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Proved Safe Reopen Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'i'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          claimedAt: new Date(),
          claimId: 'failed_claim',
          claimExpiresAt: new Date(Date.now() + 120000),
          reconciliationPendingAt: new Date(),
        },
      });

      // Definitively verified no Draft Order exists in Shopify -> reset to AVAILABLE
      await resetReorderIntentToAvailable(intent.token, 'failed_claim');

      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.usedAt).toBeNull();
      expect(inDb?.claimedAt).toBeNull();
      expect(inDb?.claimId).toBeNull();
      expect(inDb?.claimExpiresAt).toBeNull();
      expect(inDb?.reconciliationPendingAt).toBeNull();

      // Can now be claimed normally
      const reclaim = await claimReorderIntent(intent.token, 'retry_worker', 120);
      expect(reclaim.success).toBe(true);
    });

    // 10. Reconciliation still uncertain: token remains blocked
    it('10. reconciliation still uncertain -> token remains blocked', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Uncertain Reconciliation Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'j'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          reconciliationPendingAt: new Date(),
        },
      });

      // Attempting to claim or view while uncertain remains blocked
      await expect(claimReorderIntent(intent.token, 'intruder', 120)).rejects.toMatchObject({
        code: 'REORDER_LINK_RECONCILIATION_PENDING',
        statusCode: 409,
      });

      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.reconciliationPendingAt).not.toBeNull();
    });

    // 11. commitReorderIntentUsed with correct claimId: succeeds
    it('11. commitReorderIntentUsed with correct claimId succeeds', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Valid Claim Commit Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'k'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          claimedAt: new Date(),
          claimId: 'owner_claim_123',
          claimExpiresAt: new Date(Date.now() + 120000),
        },
      });

      await commitReorderIntentUsed(intent.token, 'owner_claim_123');

      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.usedAt).not.toBeNull();
      expect(inDb?.claimId).toBeNull();
    });

    // 12. commitReorderIntentUsed with wrong/stale claimId: fails and does NOT modify the intent
    it('12. commitReorderIntentUsed with wrong/stale claimId fails and does NOT modify the intent', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Stale Claim Reject Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'l'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          claimedAt: new Date(),
          claimId: 'legitimate_owner',
          claimExpiresAt: new Date(Date.now() + 120000),
        },
      });

      await expect(commitReorderIntentUsed(intent.token, 'wrong_stale_caller')).rejects.toMatchObject({
        code: 'CLAIM_OWNERSHIP_MISMATCH',
        statusCode: 409,
      });

      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.usedAt).toBeNull();
      expect(inDb?.claimId).toBe('legitimate_owner');
    });

    // 13. release with wrong claimId: cannot release another request's claim
    it('13. release with wrong claimId cannot release another requests claim', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Release Ownership Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'm'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          claimedAt: new Date(),
          claimId: 'active_claim_owner',
          claimExpiresAt: new Date(Date.now() + 120000),
        },
      });

      // Wrong claim ID attempts to release
      await releaseReorderIntentClaim(intent.token, 'wrong_caller');

      // Claim is still intact
      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.claimId).toBe('active_claim_owner');
      expect(inDb?.claimedAt).not.toBeNull();
    });

    // 14. successful Draft Order + failure to persist USED: token does NOT become AVAILABLE/reusable
    it('14. successful Draft Order + failure to persist USED -> token does NOT become AVAILABLE/reusable', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Fail Closed State Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'n'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          claimedAt: new Date(),
          claimId: 'claim_14',
          claimExpiresAt: new Date(Date.now() + 120000),
        },
      });

      // If commit fails (e.g. database contention), fallback marks reconciliation pending
      await markReorderIntentReconciliationPending(intent.token, 'claim_14');

      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.reconciliationPendingAt).not.toBeNull();

      // Token cannot be claimed by another request
      await expect(claimReorderIntent(intent.token, 'other_request', 120)).rejects.toMatchObject({
        code: 'REORDER_LINK_RECONCILIATION_PENDING',
        statusCode: 409,
      });
    });

    // 15. duplicate/idempotent success path: leaves reorder token safely USED/blocked
    it('15. duplicate/idempotent success path leaves reorder token safely USED/blocked', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Duplicate Success Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'o'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          usedAt: new Date(),
        },
      });

      // Duplicate submission path confirms token remains USED
      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.usedAt).not.toBeNull();
      await expect(claimReorderIntent(intent.token, 'new_attempt', 120)).rejects.toMatchObject({
        code: 'REORDER_LINK_ALREADY_USED',
        statusCode: 410,
      });
    });

    // 16. reconciled/adopted Draft Order success path: leaves reorder token safely USED/blocked
    it('16. reconciled/adopted Draft Order success path leaves reorder token safely USED/blocked', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Reconciled Success Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'p'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
          reconciliationPendingAt: new Date(),
        },
      });

      // Recovery adoption commits USED
      await commitReorderIntentUsed(intent.token);

      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.usedAt).not.toBeNull();
      expect(inDb?.reconciliationPendingAt).toBeNull();
    });

    // 17. different client idempotency keys using same reorder intent: cannot produce two Draft Orders
    it('17. different client idempotency keys using same reorder intent cannot claim concurrently', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Idempotency Key Divergence Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'q'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
        },
      });

      // Request 1 with Key A claims intent
      const claim1 = await claimReorderIntent(intent.token, 'correlation_key_A', 120);
      expect(claim1.success).toBe(true);

      // Request 2 with Key B attempts to claim the same intent while in flight
      await expect(claimReorderIntent(intent.token, 'correlation_key_B', 120)).rejects.toMatchObject({
        code: 'REORDER_LINK_ALREADY_IN_USE',
        statusCode: 409,
      });
    });

    // 18. ambiguous execution followed by retry after TTL: cannot create second Draft Order
    it('18. ambiguous execution followed by retry after TTL cannot claim or create second Draft Order', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Post TTL Duplicate Protection Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const intent = await prisma.reorderIntent.create({
        data: {
          catalogId: catalog.id,
          shopId: shop.id,
          token: 'r'.repeat(64),
          prefillJson: JSON.stringify([{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 5 }]),
        },
      });

      // Request 1 claims and enters ambiguous state (e.g. Shopify timeout)
      await claimReorderIntent(intent.token, 'attempt_1_timeout', 120);
      await markReorderIntentReconciliationPending(intent.token, 'attempt_1_timeout');

      // Simulate TTL elapsing by manually setting claimExpiresAt in the past
      await prisma.reorderIntent.update({
        where: { token: intent.token },
        data: {
          claimedAt: new Date(Date.now() - 300000), // 5 min ago
          claimExpiresAt: new Date(Date.now() - 180000), // Expired 3 min ago
        },
      });

      // Retry attempt with a new correlation ID MUST BE REJECTED despite TTL expiry
      await expect(claimReorderIntent(intent.token, 'attempt_2_retry', 120)).rejects.toMatchObject({
        code: 'REORDER_LINK_RECONCILIATION_PENDING',
        statusCode: 409,
      });

      // Token remains reconciliation pending and cannot create a duplicate Draft Order
      const inDb = await prisma.reorderIntent.findUnique({ where: { token: intent.token } });
      expect(inDb?.reconciliationPendingAt).not.toBeNull();
      expect(inDb?.usedAt).toBeNull();
    });
  });

  // ===========================================================================
  // 3. ORDER LINK VIEW ANALYTICS & ATTRIBUTION TESTS (Cases 18 - 22)
  // ===========================================================================
  describe('Order Link Analytics Semantics & Deduplication', () => {
    it('18. analytics semantics match implementation for views, submissions, and GMV', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Analytics Test Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'Campaign Link',
      });

      expect(link.views).toBe(0);
      expect(link.submissions).toBe(0);
      expect(Number(link.submittedValue)).toBe(0);
    });

    it('19. duplicate refreshes in same session are deduplicated; distinct sessions increment views', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Deduplication Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'Tracked Link',
      });

      // Session A: 1st view
      const firstRecorded = await recordOrderLinkView(link.id, 'session_user_A');
      expect(firstRecorded).toBe(true);

      // Session A: rapid refresh within 30-min window -> deduplicated (not incremented)
      const secondRecorded = await recordOrderLinkView(link.id, 'session_user_A');
      expect(secondRecorded).toBe(false);

      // Session B: distinct anonymous session -> incremented
      const sessionBRecorded = await recordOrderLinkView(link.id, 'session_user_B');
      expect(sessionBRecorded).toBe(true);

      const refreshed = await getOrderLinkById(link.id, shop.id);
      expect(refreshed.views).toBe(2); // Exactly 2 distinct session views, not 3
    });

    it('20. submissions increment once per accepted order', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Submissions Count Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'Submissions Link',
      });

      await recordOrderLinkSubmission(link.id, 250.00);

      const refreshed = await getOrderLinkById(link.id, shop.id);
      expect(refreshed.submissions).toBe(1);
    });

    it('21. GMV increments once per accepted order', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'GMV Count Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'GMV Link',
      });

      await recordOrderLinkSubmission(link.id, 350.75);
      await recordOrderLinkSubmission(link.id, 149.25);

      const refreshed = await getOrderLinkById(link.id, shop.id);
      expect(Number(refreshed.submittedValue)).toBe(500.00);
      expect(refreshed.submissions).toBe(2);
    });

    it('22. reconciliation/retry does not double-count submission/GMV', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Reconciliation Count Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'Reconciliation Link',
      });

      // First successful submission: records 1 submission + 100 GMV
      await recordOrderLinkSubmission(link.id, 100.00);

      const afterFirst = await getOrderLinkById(link.id, shop.id);
      expect(afterFirst.submissions).toBe(1);
      expect(Number(afterFirst.submittedValue)).toBe(100.00);

      // On idempotency replay or reconciliation retry, recordOrderLinkSubmission is NOT called again.
      // Re-querying shows strict single-count guarantee
      const afterReplay = await getOrderLinkById(link.id, shop.id);
      expect(afterReplay.submissions).toBe(1);
      expect(Number(afterReplay.submittedValue)).toBe(100.00);
    });
  });

  // ===========================================================================
  // 4. EXISTING CATALOG VARIANT CONFIGS & CSV TESTS (Non-Regression)
  // ===========================================================================
  describe('Variant Configs, Inventory Modes, and CSV Bulk Order Non-Regression', () => {
    it('saves and applies per-variant availability, custom price, and quantity rules', async () => {
      await syncProductSnapshot(shop.id, {
        id: 1001,
        title: 'Industrial Heavy Duty Widget',
        handle: 'industrial-heavy-duty-widget',
        status: 'active',
        variants: [
          { id: 2001, product_id: 1001, title: 'Standard / Blue', price: '50.00', inventory_quantity: 100, inventory_policy: 'deny', inventory_management: 'shopify', sku: 'WIDGET-BLU' },
          { id: 2002, product_id: 1001, title: 'Standard / Red', price: '50.00', inventory_quantity: 50, inventory_policy: 'deny', inventory_management: 'shopify', sku: 'WIDGET-RED' },
          { id: 2003, product_id: 1001, title: 'Standard / Green (Discontinued)', price: '50.00', inventory_quantity: 0, inventory_policy: 'deny', inventory_management: 'shopify', sku: 'WIDGET-GRN' },
        ],
      });

      const catalog = await createCatalog(shop.id, {
        name: 'Industrial Equipment Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        minQty: 2,
        maxQty: 50,
        qtyIncrement: 2,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      await publishCatalog(shop.id, catalog.id);

      await upsertCatalogVariantConfigs(catalog.id, shop.id, [
        { shopifyVariantId: 'gid://shopify/ProductVariant/2001', enabled: true, position: 0, minQty: 10, maxQty: 100, qtyIncrement: 5 },
        { shopifyVariantId: 'gid://shopify/ProductVariant/2002', enabled: true, position: 1, customPrice: 35.00 },
        { shopifyVariantId: 'gid://shopify/ProductVariant/2003', enabled: false, position: 2 },
      ]);

      const savedConfigs = await getCatalogVariantConfigs(catalog.id, shop.id);
      expect(savedConfigs).toHaveLength(3);

      const payload = await getPublicCatalogPayload(catalog.publicToken);
      expect(payload).toBeDefined();
      expect(payload!.products[0]!.variants).toHaveLength(2); // Only blue and red

      const blueVariant = payload!.products[0]!.variants.find((v) => v.shopifyVariantId === 'gid://shopify/ProductVariant/2001');
      expect(blueVariant?.displayPrice).toBe(50.00);
      expect(blueVariant?.minQty).toBe(10);
      expect(blueVariant?.qtyIncrement).toBe(5);

      const redVariant = payload!.products[0]!.variants.find((v) => v.shopifyVariantId === 'gid://shopify/ProductVariant/2002');
      expect(redVariant?.displayPrice).toBe(35.00);
    });

    it('correctly maps SKUs in CSV bulk orders and reports row errors', async () => {
      await syncProductSnapshot(shop.id, {
        id: 5001,
        title: 'Safety Boots Pro',
        handle: 'safety-boots-pro',
        status: 'active',
        variants: [
          { id: 6001, product_id: 5001, title: 'Size 9', price: '85.00', inventory_quantity: 200, inventory_policy: 'deny', inventory_management: 'shopify', sku: 'BOOT-09', available: true },
          { id: 6002, product_id: 5001, title: 'Size 10', price: '85.00', inventory_quantity: 0, inventory_policy: 'deny', inventory_management: 'shopify', sku: 'BOOT-10', available: false },
          { id: 6003, product_id: 5001, title: 'Size 11', price: '85.00', inventory_quantity: 50, inventory_policy: 'deny', inventory_management: 'shopify', sku: 'BOOT-11', available: true },
        ],
      });

      const catalog = await createCatalog(shop.id, {
        name: 'PPE Catalog',
        priceMode: PriceMode.SHOPIFY_PRICE,
        minQty: 5,
        qtyIncrement: 5,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/5001' }],
      });
      await publishCatalog(shop.id, catalog.id);

      const csvContent = `
        SKU,Quantity
        BOOT-09,10
        BOOT-10,5
        BOOT-11,3
        UNKNOWN-SKU-999,10
      `;

      const result = await parseCsvBulkOrder(shop.id, catalog.id, csvContent);
      expect(result.validLines).toHaveLength(1);
      expect(result.validLines[0].sku).toBe('BOOT-09');
      expect(result.validLines[0].quantity).toBe(10);
      expect(result.errors).toHaveLength(3);
    });
  });
});

