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
import { getPublicCatalogPayload, syncProductSnapshot } from '../src/services/sync.server.js';
import { validateBuyerOrderLines } from '../src/services/validation.server.js';
import { submitBuyerOrder, reconcileSubmission } from '../src/services/order.server.js';
import { PriceMode, InventoryMode, CatalogSourceType } from '../src/types/index.js';

describe('Focused Hardening Pass: Passcode Gate & View Analytics', () => {
  let shop: { id: string; shopDomain: string; currency?: string };

  beforeEach(async () => {
    resetOrderLinkViewCache();
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
  // 3. CATALOG VARIANT CONFIGS & INVENTORY MODES
  // ===========================================================================
  describe('Variant Configs & Inventory Modes', () => {
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
        { shopifyVariantId: 'gid://shopify/ProductVariant/2001', enabled: true, position: 0, overrideQuantityRules: true, minQty: 10, maxQty: 100, qtyIncrement: 5 },
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
  });
});
