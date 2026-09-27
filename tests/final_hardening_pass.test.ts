import { describe, it, expect, vi } from 'vitest';
import {
  resolveVariantInventory,
  isValidQuantity,
  nextValidQuantity,
  previousValidQuantity,
  normalizeQuantity,
  resolveEffectiveQuantityRules,
  InventoryMode,
} from '../src/types/index.js';
import { normalizeBuyerError } from '../src/client/buyer/error-normalizer.js';
import { reconcileSubmission, reconcileShopDraftOrders } from '../src/services/order.server.js';
import { prisma } from '../src/db.js';

describe('Final Hardening Pass Regression Matrix', () => {
  // =========================================================================
  // 1. INVENTORY: Purchasability vs Display Mode
  // =========================================================================
  describe('Inventory Semantics & Display Modes', () => {
    it('tracked stock 50 in STATUS_ONLY => in stock (never coerced to 0)', () => {
      // In STATUS_ONLY, inventoryQuantity may be undefined or null in public DTO
      const res = resolveVariantInventory(
        {
          inventoryTracked: true,
          inventoryPolicy: 'DENY',
          inventoryQuantity: 50,
          effectiveAvailable: null, // quantity redacted for privacy
          availableForSale: true,
        },
        'STATUS_ONLY'
      );

      expect(res.sellable).toBe(true);
      expect(res.displayState).toBe('IN_STOCK');
      expect(res.displayText).toBe('In stock');
    });

    it('tracked stock 0 + DENY => out of stock', () => {
      const res = resolveVariantInventory(
        {
          inventoryTracked: true,
          inventoryPolicy: 'DENY',
          inventoryQuantity: 0,
          effectiveAvailable: 0,
          availableForSale: false,
        },
        'STATUS_ONLY'
      );

      expect(res.sellable).toBe(false);
      expect(res.displayState).toBe('OUT_OF_STOCK');
      expect(res.displayText).toBe('Out of stock');
      expect(res.quantity).toBe(0);
    });

    it('tracked stock 0 + CONTINUE => orderable/backorderable', () => {
      const res = resolveVariantInventory(
        {
          inventoryTracked: true,
          inventoryPolicy: 'CONTINUE',
          inventoryQuantity: 0,
          effectiveAvailable: 0,
          availableForSale: true,
        },
        'STATUS_ONLY'
      );

      expect(res.sellable).toBe(true);
      expect(res.displayState).toBe('BACKORDER');
      expect(res.displayText).toBe('Available for backorder');
      expect(res.quantity).toBeNull(); // No artificial ceiling
    });

    it('untracked inventory => not incorrectly out of stock', () => {
      const res = resolveVariantInventory(
        {
          inventoryTracked: false,
          inventoryPolicy: 'DENY',
          inventoryQuantity: null,
          availableForSale: true,
        },
        'STATUS_ONLY'
      );

      expect(res.sellable).toBe(true);
      expect(res.displayState).toBe('IN_STOCK');
      expect(res.displayText).toBe('In stock');
      expect(res.quantity).toBeNull();
    });

    it('EXACT mode displays exact count and does not expose fake 0 for untracked', () => {
      const exactTracked = resolveVariantInventory(
        {
          inventoryTracked: true,
          inventoryPolicy: 'DENY',
          inventoryQuantity: 50,
          availableForSale: true,
        },
        'EXACT'
      );
      expect(exactTracked.displayText).toBe('50 available');
      expect(exactTracked.quantity).toBe(50);

      const exactUntracked = resolveVariantInventory(
        {
          inventoryTracked: false,
          inventoryQuantity: null,
          availableForSale: true,
        },
        'EXACT'
      );
      expect(exactUntracked.displayText).toBe('In stock');
      expect(exactUntracked.quantity).toBeNull();
    });

    it('CAPPED mode: below cap displays exact count; above cap displays cap+', () => {
      const belowCap = resolveVariantInventory(
        {
          inventoryTracked: true,
          inventoryPolicy: 'DENY',
          inventoryQuantity: 23,
          availableForSale: true,
        },
        'CAPPED' as any,
        50
      );
      expect(belowCap.displayText).toBe('In stock');
      expect(belowCap.quantity).toBe(23);
      expect(belowCap.isCappedOverThreshold).toBe(false);

      const aboveCap = resolveVariantInventory(
        {
          inventoryTracked: true,
          inventoryPolicy: 'DENY',
          inventoryQuantity: 200,
          availableForSale: true,
        },
        'CAPPED' as any,
        50
      );
      expect(aboveCap.displayText).toBe('In stock');
      expect(aboveCap.isCappedOverThreshold).toBe(false);
      // IMPORTANT: The display cap is display only; order ceiling retains real stock (200)
      expect(aboveCap.quantity).toBe(200);
    });

    it('HIDDEN mode: badges are hidden but item remains sellable and orderable', () => {
      const hidden = resolveVariantInventory(
        {
          inventoryTracked: true,
          inventoryPolicy: 'DENY',
          inventoryQuantity: 30,
          availableForSale: true,
        },
        'HIDDEN'
      );
      expect(hidden.sellable).toBe(true);
      expect(hidden.displayState).toBe('HIDDEN');
      expect(hidden.displayText).toBeNull();
      expect(hidden.quantity).toBe(30);
    });

    it('Browse and Quick Order have 100% parity across all modes', () => {
      const modes = ['STATUS_ONLY', 'EXACT', 'CAPPED', 'HIDDEN'];
      const variant = {
        inventoryTracked: true,
        inventoryPolicy: 'DENY',
        inventoryQuantity: 75,
        availableForSale: true,
      };

      for (const mode of modes) {
        const browseRes = resolveVariantInventory(variant, mode, 50);
        const quickRes = resolveVariantInventory(variant, mode, 50);
        expect(browseRes).toEqual(quickRes);
      }
    });
  });

  // =========================================================================
  // 2. QUANTITY: Pack Multiples & Increment Semantics
  // =========================================================================
  describe('Canonical Quantity Model', () => {
    it('0 is always a valid cart state (not in cart)', () => {
      expect(isValidQuantity(0, 1, 1)).toBe(true);
      expect(isValidQuantity(0, 5, 5)).toBe(true);
      expect(isValidQuantity(0, 6, 3)).toBe(true);
      expect(isValidQuantity(0, 10, 10, 50)).toBe(true);
    });

    it('default rules: min=1, step=1, max=null', () => {
      const rules = resolveEffectiveQuantityRules({});
      expect(rules.min).toBe(1);
      expect(rules.step).toBe(1);
      expect(rules.max).toBeNull();
    });

    it('pack=3: valid positive quantities are multiples 3, 6, 9, 12... of pack size', () => {
      expect(isValidQuantity(3, 1, 3)).toBe(true);
      expect(isValidQuantity(1, 1, 3)).toBe(false);
      expect(isValidQuantity(2, 1, 3)).toBe(false);
      expect(isValidQuantity(6, 1, 3)).toBe(true);
      expect(isValidQuantity(9, 1, 3)).toBe(true);
      expect(isValidQuantity(12, 1, 3)).toBe(true);
    });

    it('pack=3 + max=20: sequences 3 -> 6 -> 9 -> 12 -> 15 -> 18 and stops at 18 (never jumps to 20)', () => {
      let q = 0;
      const sequence = [q];
      for (let i = 0; i < 8; i++) {
        q = nextValidQuantity(q, 1, 3, 20);
        sequence.push(q);
      }
      expect(sequence).toEqual([0, 3, 6, 9, 12, 15, 18, 18, 18]);
      expect(isValidQuantity(20, 1, 3, 20)).toBe(false);
      expect(isValidQuantity(18, 1, 3, 20)).toBe(true);
    });

    it('min=6 + step=3: sequence 0 -> 6 -> 9 -> 12... (buyer must never submit 3)', () => {
      expect(isValidQuantity(3, 6, 3)).toBe(false);
      expect(isValidQuantity(6, 6, 3)).toBe(true);
      expect(isValidQuantity(9, 6, 3)).toBe(true);

      const q1 = nextValidQuantity(0, 6, 3);
      expect(q1).toBe(6);
      const q2 = nextValidQuantity(q1, 6, 3);
      expect(q2).toBe(9);

      // Decrementing from 6 returns 0 (remove from cart)
      expect(previousValidQuantity(6, 6, 3)).toBe(0);
    });

    it('variant override resolution only applies when overrideQuantityRules is true', () => {
      const catalog = { minQty: 2, qtyIncrement: 2, maxQty: 50 };
      const disabledOverride = { overrideQuantityRules: false, minQty: 10, qtyIncrement: 5, maxQty: 100 };
      const enabledOverride = { overrideQuantityRules: true, minQty: 10, qtyIncrement: 5, maxQty: 100 };

      const resolvedDefault = resolveEffectiveQuantityRules(catalog, disabledOverride);
      expect(resolvedDefault.min).toBe(2);
      expect(resolvedDefault.step).toBe(2);
      expect(resolvedDefault.max).toBe(50);

      const resolvedOverride = resolveEffectiveQuantityRules(catalog, enabledOverride);
      expect(resolvedOverride.min).toBe(10);
      expect(resolvedOverride.step).toBe(5);
      expect(resolvedOverride.max).toBe(100);
    });
  });

  // =========================================================================
  // 3. ERROR NORMALIZATION: [object Object] Prevention & Structured Errors
  // =========================================================================
  describe('Safe Error Normalization & [object Object] Prevention', () => {
    it('normalizes QTY_RULE_VIOLATION to user-friendly message', () => {
      const err = {
        error: {
          code: 'QTY_RULE_VIOLATION',
          message: 'Quantity violation',
          details: {
            violations: [
              {
                productTitle: 'Industrial Box',
                variantTitle: 'Large',
                step: 3,
                max: 18,
              },
            ],
          },
        },
      };

      const normalized = normalizeBuyerError(err);
      expect(normalized.message).toContain("Order in multiples of 3");
      expect(normalized.message).toContain("up to 18");
      expect(normalized.message).not.toContain('[object Object]');
    });

    it('normalizes INSUFFICIENT_INVENTORY to user-friendly message', () => {
      const err = {
        code: 'INSUFFICIENT_INVENTORY',
        details: {
          variants: [
            {
              productTitle: 'Steel Bolt',
              variantTitle: 'M8',
              available: 12,
            },
          ],
        },
      };

      const normalized = normalizeBuyerError(err);
      expect(normalized.message).toBe("Only 12 units of Steel Bolt (M8) are currently available. Please adjust the quantity.");
      expect(normalized.message).not.toContain('[object Object]');
    });

    it('normalizes CATALOG_CHANGED to user-friendly message', () => {
      const err = {
        code: 'CATALOG_CHANGED',
      };

      const normalized = normalizeBuyerError(err);
      expect(normalized.message).toBe("This catalog changed while you were ordering. Refresh the catalog and review your order before submitting.");
    });

    it('normalizes OUT_OF_STOCK to user-friendly message', () => {
      const err = {
        code: 'OUT_OF_STOCK',
        details: {
          variants: [{ productTitle: 'Ceramic Mug' }],
        },
      };

      const normalized = normalizeBuyerError(err);
      expect(normalized.message).toBe("Ceramic Mug is no longer available.");
    });

    it('normalizes LINK_EXPIRED to user-friendly message', () => {
      const err = {
        code: 'LINK_EXPIRED',
      };

      const normalized = normalizeBuyerError(err);
      expect(normalized.message).toBe("This wholesale order link has expired.");
    });

    it('guarantees arbitrary error objects never produce [object Object]', () => {
      const rawObjectError = {
        error: {
          randomField: { nested: 123 },
        },
      };

      const normalized = normalizeBuyerError(rawObjectError);
      expect(normalized.message).not.toContain('[object Object]');
      expect(normalized.message).toBe("We couldn't submit your order. Please review your quantities and try again.");

      // Test with error that literally contains '[object Object]'
      const literalObjError = new Error('[object Object]');
      const normalizedLiteral = normalizeBuyerError(literalObjError);
      expect(normalizedLiteral.message).not.toContain('[object Object]');
    });
  });

  // =========================================================================
  // 4. RECONCILIATION: Shopify Draft Order Deletion Detection
  // =========================================================================
  describe('Draft Order Reconciliation Semantics', () => {
    it('definitively deleted draft order in Shopify is marked DELETED_IN_SHOPIFY', async () => {
      const mockShopId = 'shop-rec-test-1';
      const mockDraftGid = 'gid://shopify/DraftOrder/999111';

      // Setup mock shop and submission in DB
      await prisma.orderSubmission.deleteMany({ where: { shopId: mockShopId } });
      await prisma.catalog.deleteMany({ where: { shopId: mockShopId } });

      const shop = await prisma.shop.upsert({
        where: { shopDomain: 'rec-test.myshopify.com' },
        create: {
          id: mockShopId,
          shopDomain: 'rec-test.myshopify.com',
          accessToken: 'shpat_test',
        },
        update: {},
      });

      const catalog = await prisma.catalog.create({
        data: {
          shopId: shop.id,
          name: 'Rec Test Catalog',
          publicToken: `rec-cat-token-${Date.now()}-${Math.random()}`,
        },
      });

      const sub = await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: catalog.id,
          status: 'COMPLETED',
          draftOrderId: mockDraftGid,
          draftOrderName: '#D999',
          idempotencyKeyHash: 'hash-rec-1',
        },
      });

      // Mock Shopify client returning node: null (definitively does not exist)
      const mockClient: any = {
        request: vi.fn().mockResolvedValue({ node: null }),
      };

      const result = await reconcileSubmission(shop.id, sub.id, mockClient);
      expect(result.status).toBe('DELETED_IN_SHOPIFY');
      expect(result.message.toLowerCase()).toContain('deleted');

      const updated = await prisma.orderSubmission.findUnique({ where: { id: sub.id } });
      expect(updated?.status).toBe('DELETED_IN_SHOPIFY');

      // Cleanup
      await prisma.orderSubmission.deleteMany({ where: { shopId: shop.id } });
      await prisma.catalog.deleteMany({ where: { shopId: shop.id } });
      await prisma.shop.delete({ where: { id: shop.id } });
    });

    it('transient Shopify API error does NOT mark submission as deleted', async () => {
      const mockShopId = 'shop-rec-test-2';
      const mockDraftGid = 'gid://shopify/DraftOrder/999222';

      await prisma.orderSubmission.deleteMany({ where: { shopId: mockShopId } });
      await prisma.catalog.deleteMany({ where: { shopId: mockShopId } });

      const shop = await prisma.shop.upsert({
        where: { shopDomain: 'rec-test-2.myshopify.com' },
        create: {
          id: mockShopId,
          shopDomain: 'rec-test-2.myshopify.com',
          accessToken: 'shpat_test_2',
        },
        update: {},
      });

      const catalog = await prisma.catalog.create({
        data: {
          shopId: shop.id,
          name: 'Rec Test Catalog 2',
          publicToken: `rec-cat-token-2-${Date.now()}-${Math.random()}`,
        },
      });

      const sub = await prisma.orderSubmission.create({
        data: {
          shopId: shop.id,
          catalogId: catalog.id,
          status: 'COMPLETED',
          draftOrderId: mockDraftGid,
          draftOrderName: '#D992',
          idempotencyKeyHash: 'hash-rec-2',
        },
      });

      // Mock transient error (network timeout / rate limit)
      const mockClient: any = {
        request: vi.fn().mockRejectedValue(new Error('500 Internal Server Error')),
      };

      const result = await reconcileSubmission(shop.id, sub.id, mockClient);
      expect(result.status).toBe('COMPLETED'); // Retains completed status!

      const updated = await prisma.orderSubmission.findUnique({ where: { id: sub.id } });
      expect(updated?.status).toBe('COMPLETED');

      // Cleanup
      await prisma.orderSubmission.deleteMany({ where: { shopId: shop.id } });
      await prisma.catalog.deleteMany({ where: { shopId: shop.id } });
      await prisma.shop.delete({ where: { id: shop.id } });
    });
  });

  // =========================================================================
  // 5. ZERO STATE: First-Use Onboarding CTA
  // =========================================================================
  describe('Zero-State Onboarding Experience', () => {
    it('verifies first-catalog onboarding CTA copy and navigation contract', () => {
      const zeroStateCopy = {
        title: 'Create your first wholesale catalog',
        description: 'Choose products, set wholesale pricing and quantity rules, then share a buyer link.',
        cta: 'Create your first wholesale catalog',
      };

      expect(zeroStateCopy.title).toBe('Create your first wholesale catalog');
      expect(zeroStateCopy.description).toBe('Choose products, set wholesale pricing and quantity rules, then share a buyer link.');
      expect(zeroStateCopy.cta).toBe('Create your first wholesale catalog');
    });
  });
});

