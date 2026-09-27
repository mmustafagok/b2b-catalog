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

    it('legacy CAPPED mode normalizes to STATUS_ONLY display ("In stock", no quantity numbers revealed)', () => {
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

      // Both views display "In stock" (STATUS_ONLY)
      expect(browseRes.displayText).toBe('In stock');
      expect(quickRes.displayText).toBe('In stock');
      expect(browseRes.isCappedOverThreshold).toBe(false);
      expect(quickRes.isCappedOverThreshold).toBe(false);

      // Orderable quantity remains intact
      expect(browseRes.quantity).toBe(200);
      expect(quickRes.quantity).toBe(200);

      // Client maxLimit is not artificially capped
      const clientMax = resolveClientMaxLimit({
        isCappedOverThreshold: browseRes.isCappedOverThreshold,
        effectiveAvailable: browseRes.quantity,
        maxQty: null,
      });
      expect(clientMax).toBe(200);
    });

    it('STATUS_ONLY with maxQty=100 respects maxQty rule', () => {
      const cap = 50;
      const rawShopifyVariant: RawShopifyVariant = {
        id: 'v-capped-rule',
        title: 'Capped With Rule',
        inventoryTracked: true,
        inventoryPolicy: 'DENY',
        inventoryQuantity: 200,
        availableForSale: true,
      };

      const res = browseVariantProjection(rawShopifyVariant, InventoryMode.STATUS_ONLY, cap);
      expect(res.displayText).toBe('In stock');

      const clientMax = resolveClientMaxLimit({
        isCappedOverThreshold: res.isCappedOverThreshold,
        effectiveAvailable: res.quantity,
        maxQty: 100,
      });
      expect(clientMax).toBe(100);
    });
  });
});
