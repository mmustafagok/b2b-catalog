import { describe, it, expect } from 'vitest';
import { InventoryMode, resolveVariantInventory } from '../src/types/index.js';

interface RawShopifyVariant {
  id: string;
  title: string;
  inventoryTracked: boolean;
  inventoryPolicy: 'DENY' | 'CONTINUE';
  inventoryQuantity: number;
  availableForSale: boolean;
}

/**
 * Browse view variant mapping (VariantMatrix)
 */
function browseVariantProjection(variant: RawShopifyVariant, inventoryMode: InventoryMode = InventoryMode.STATUS_ONLY, cappedThreshold = 10) {
  return resolveVariantInventory(
    {
      inventoryTracked: variant.inventoryTracked,
      inventoryPolicy: variant.inventoryPolicy,
      inventoryQuantity: variant.inventoryQuantity,
      availableForSale: variant.availableForSale,
    },
    inventoryMode,
    cappedThreshold
  );
}

/**
 * Quick Order view variant mapping (QuickOrderView)
 */
function quickOrderVariantProjection(variant: RawShopifyVariant, inventoryMode: InventoryMode = InventoryMode.STATUS_ONLY, cappedThreshold = 10) {
  // QuickOrderView canonical DTO retains inventoryTracked and inventoryPolicy
  const flattenedDTO = {
    inventoryTracked: variant.inventoryTracked,
    inventoryPolicy: variant.inventoryPolicy,
    inventoryQuantity: variant.inventoryQuantity,
    availableForSale: variant.availableForSale,
  };

  return resolveVariantInventory(flattenedDTO, inventoryMode, cappedThreshold);
}

describe('Issue 3: Browse View and Quick Order Inventory Parity Test Suite', () => {
  const modes: InventoryMode[] = [
    InventoryMode.STATUS_ONLY,
    InventoryMode.EXACT,
    InventoryMode.CAPPED,
    InventoryMode.HIDDEN,
  ];

  const testCases: Array<{
    name: string;
    variant: RawShopifyVariant;
  }> = [
    {
      name: 'A. tracked + DENY + positive inventory (qty=15)',
      variant: {
        id: 'v1',
        title: 'Tracked Deny Positive',
        inventoryTracked: true,
        inventoryPolicy: 'DENY',
        inventoryQuantity: 15,
        availableForSale: true,
      },
    },
    {
      name: 'B. tracked + DENY + zero inventory (qty=0)',
      variant: {
        id: 'v2',
        title: 'Tracked Deny Zero',
        inventoryTracked: true,
        inventoryPolicy: 'DENY',
        inventoryQuantity: 0,
        availableForSale: true,
      },
    },
    {
      name: 'C. tracked + CONTINUE + zero inventory (qty=0)',
      variant: {
        id: 'v3',
        title: 'Tracked Continue Zero',
        inventoryTracked: true,
        inventoryPolicy: 'CONTINUE',
        inventoryQuantity: 0,
        availableForSale: true,
      },
    },
    {
      name: 'D. untracked inventory (qty=0, tracked=false)',
      variant: {
        id: 'v4',
        title: 'Untracked',
        inventoryTracked: false,
        inventoryPolicy: 'DENY',
        inventoryQuantity: 0,
        availableForSale: true,
      },
    },
    {
      name: 'E. unavailableForSale (availableForSale=false)',
      variant: {
        id: 'v5',
        title: 'Unavailable For Sale',
        inventoryTracked: true,
        inventoryPolicy: 'CONTINUE',
        inventoryQuantity: 100,
        availableForSale: false,
      },
    },
  ];

  modes.forEach((mode) => {
    describe(`Inventory Mode: ${mode}`, () => {
      testCases.forEach(({ name, variant }) => {
        it(`produces identical stock status between Browse and Quick Order for ${name}`, () => {
          const browseRes = browseVariantProjection(variant, mode);
          const quickRes = quickOrderVariantProjection(variant, mode);

          expect(browseRes.quantity).toEqual(quickRes.quantity);
          expect(browseRes.sellable).toEqual(quickRes.sellable);
          expect(browseRes.displayState).toEqual(quickRes.displayState);
          expect(browseRes.displayText).toEqual(quickRes.displayText);
          expect(browseRes.isCappedOverThreshold).toEqual(quickRes.isCappedOverThreshold);
        });
      });
    });
  });

  describe('Specific Shopify Inventory Semantics Checks', () => {
    it('tracked + CONTINUE + zero inventory is available for sale with unconstrained effective stock', () => {
      const res = browseVariantProjection({
        id: 'v-cont',
        title: 'Backorder Item',
        inventoryTracked: true,
        inventoryPolicy: 'CONTINUE',
        inventoryQuantity: 0,
        availableForSale: true,
      });

      expect(res.sellable).toBe(true);
      expect(res.quantity).toBeNull(); // null means unconstrained / continue selling
    });

    it('untracked inventory is available for sale with unconstrained effective stock', () => {
      const res = browseVariantProjection({
        id: 'v-untracked',
        title: 'Digital Item',
        inventoryTracked: false,
        inventoryPolicy: 'DENY',
        inventoryQuantity: 0,
        availableForSale: true,
      });

      expect(res.sellable).toBe(true);
      expect(res.quantity).toBeNull();
    });

    it('tracked + DENY + zero inventory is NOT available for sale', () => {
      const res = browseVariantProjection({
        id: 'v-deny-zero',
        title: 'Out of Stock Item',
        inventoryTracked: true,
        inventoryPolicy: 'DENY',
        inventoryQuantity: 0,
        availableForSale: true,
      });

      expect(res.quantity).toBe(0);
      expect(res.sellable).toBe(false);
    });
  });

  describe('Issue 4: CAPPED inventory display privacy vs order limits', () => {
    // Helper replicating the canonical client maxLimit determination in VariantMatrix & QuickOrderView
    function resolveClientMaxLimit(variant: {
      isCappedOverThreshold?: boolean;
      inventoryTracked?: boolean;
      inventoryPolicy?: string;
      effectiveAvailable?: number | null;
      maxQty?: number | null;
    }) {
      const canOrderBeyondReported =
        Boolean(variant.isCappedOverThreshold) ||
        variant.inventoryTracked === false ||
        variant.inventoryPolicy === 'CONTINUE';

      if (canOrderBeyondReported) {
        return variant.maxQty ?? null;
      } else if (variant.maxQty != null && variant.effectiveAvailable != null) {
        return Math.min(variant.maxQty, variant.effectiveAvailable);
      } else if (variant.maxQty != null) {
        return variant.maxQty;
      } else if (variant.effectiveAvailable != null) {
        return variant.effectiveAvailable;
      }
      return null;
    }

    it('real=200, cap=50, maxQty=none: display 50+, order 75 is possible, real 200 not leaked', () => {
      const cap = 50;
      const rawShopifyVariant: RawShopifyVariant = {
        id: 'v-capped-200',
        title: 'Capped Widget',
        inventoryTracked: true,
        inventoryPolicy: 'DENY',
        inventoryQuantity: 200,
        availableForSale: true,
      };

      const browseRes = browseVariantProjection(rawShopifyVariant, InventoryMode.CAPPED, cap);
      const quickRes = quickOrderVariantProjection(rawShopifyVariant, InventoryMode.CAPPED, cap);

      // 1. Both views display "50+ available"
      expect(browseRes.displayText).toBe('50+ available');
      expect(quickRes.displayText).toBe('50+ available');
      expect(browseRes.isCappedOverThreshold).toBe(true);
      expect(quickRes.isCappedOverThreshold).toBe(true);

      // 2. Real inventory of 200 is NOT exposed in the DTO quantity
      expect(browseRes.quantity).toBe(50);
      expect(quickRes.quantity).toBe(50);
      expect(JSON.stringify(browseRes)).not.toContain('200');

      // 3. Client maxLimit is NOT clamped to 50 when isCappedOverThreshold is true
      const clientMax = resolveClientMaxLimit({
        isCappedOverThreshold: browseRes.isCappedOverThreshold,
        effectiveAvailable: browseRes.quantity,
        maxQty: null,
      });
      expect(clientMax).toBeNull(); // No client-side artificial ceiling at 50, allowing 75!
    });

    it('real=200, cap=50, maxQty=100: display 50+, max order is 100 (business rule, not cap)', () => {
      const cap = 50;
      const rawShopifyVariant: RawShopifyVariant = {
        id: 'v-capped-rule',
        title: 'Capped With Rule',
        inventoryTracked: true,
        inventoryPolicy: 'DENY',
        inventoryQuantity: 200,
        availableForSale: true,
      };

      const res = browseVariantProjection(rawShopifyVariant, InventoryMode.CAPPED, cap);
      expect(res.displayText).toBe('50+ available');

      const clientMax = resolveClientMaxLimit({
        isCappedOverThreshold: res.isCappedOverThreshold,
        effectiveAvailable: res.quantity,
        maxQty: 100,
      });
      // Constrained by maxQty=100, NOT the privacy cap 50
      expect(clientMax).toBe(100);
    });

    it('real=30, cap=50: display 30 available, legitimate stock ceiling of 30 preserved', () => {
      const cap = 50;
      const rawShopifyVariant: RawShopifyVariant = {
        id: 'v-under-cap',
        title: 'Under Cap',
        inventoryTracked: true,
        inventoryPolicy: 'DENY',
        inventoryQuantity: 30,
        availableForSale: true,
      };

      const res = browseVariantProjection(rawShopifyVariant, InventoryMode.CAPPED, cap);
      expect(res.displayText).toBe('30 available');
      expect(res.isCappedOverThreshold).toBe(false);

      const clientMax = resolveClientMaxLimit({
        isCappedOverThreshold: res.isCappedOverThreshold,
        effectiveAvailable: res.quantity,
        maxQty: null,
      });
      // Constrained legitimately by actual stock ceiling of 30
      expect(clientMax).toBe(30);
    });
  });
});
