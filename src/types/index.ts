import { z } from 'zod';

export enum PlanTier {
  FREE = 'FREE',
  STARTER = 'STARTER',
  GROWTH = 'GROWTH',
}

export const PLAN_LIMITS = {
  [PlanTier.FREE]: {
    name: 'Free',
    price: 0,
    annualPrice: 0,
    maxLiveCatalogs: 1,
    maxVariants: 50,
    monthlySubmissionsLimit: 5,
  },
  [PlanTier.STARTER]: {
    name: 'Starter',
    price: 14.99,
    annualPrice: 119.99,
    maxLiveCatalogs: 3,
    maxVariants: 500,
    monthlySubmissionsLimit: 50,
  },
  [PlanTier.GROWTH]: {
    name: 'Growth',
    price: 29.99,
    annualPrice: 239.99,
    maxLiveCatalogs: 10,
    maxVariants: 5000,
    monthlySubmissionsLimit: 250,
  },
} as const;

export enum CatalogStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

export enum SubmissionStatus {
  CREATING = 'CREATING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REQUIRES_RECONCILIATION = 'REQUIRES_RECONCILIATION',
}

export enum PriceMode {
  SHOPIFY_PRICE = 'SHOPIFY_PRICE',
  PERCENT_DISCOUNT = 'PERCENT_DISCOUNT',
  CUSTOM_PRICE = 'CUSTOM_PRICE',
}

export enum InventoryMode {
  STATUS_ONLY = 'STATUS_ONLY', // "In stock" / "Out of stock" — no qty number
  EXACT = 'EXACT',             // Show exact qty always
  HIDDEN = 'HIDDEN',           // No inventory information shown at all
  /** @deprecated Legacy value — normalised to STATUS_ONLY at read time. Do not use in new code. */
  CAPPED = 'CAPPED',
}

export enum CatalogSourceType {
  COLLECTION = 'COLLECTION',
  PRODUCT = 'PRODUCT',
}

// ─── Catalog variant config input ─────────────────────────────────────────────

export const CatalogVariantConfigInputSchema = z.object({
  shopifyVariantId: z.string().min(1),
  enabled: z.boolean().default(true),
  customPrice: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() !== '' ? Number(val) : val),
    z.number().min(0).max(999999).optional().nullable()
  ),
  // Omitted preserves legacy API behavior: populated rule fields imply an override.
  // Explicit false resets the variant to catalog-level quantity rules.
  overrideQuantityRules: z.boolean().optional(),
  minQty: z.number().int().min(1).max(10000).optional().nullable(),
  maxQty: z.number().int().min(1).max(100000).optional().nullable(),
  qtyIncrement: z.number().int().min(1).max(1000).optional().nullable(),
  position: z.number().int().min(0).optional().default(0),
}).refine(
  (data) => {
    if (data.minQty && data.qtyIncrement && data.minQty > 1) {
      return data.minQty % data.qtyIncrement === 0;
    }
    return true;
  },
  {
    message: 'Minimum order quantity must be a multiple of pack size',
    path: ['minQty'],
  }
);

// ─── Quantity rule resolution & Canonical Mathematics ──────────────────────────

export interface EffectiveQuantityRules {
  min: number;
  max: number | null;
  step: number;
}

export function resolveEffectiveQuantityRules(
  catalog: { minQty?: number | null; maxQty?: number | null; qtyIncrement?: number | null },
  variantConfig?: { overrideQuantityRules?: boolean | null; minQty?: number | null; maxQty?: number | null; qtyIncrement?: number | null } | null
): EffectiveQuantityRules {
  const hasOverride = Boolean(variantConfig?.overrideQuantityRules);

  const min = hasOverride && variantConfig?.minQty != null ? variantConfig.minQty : (catalog?.minQty ?? 1);
  const max = hasOverride && variantConfig?.maxQty != null ? variantConfig.maxQty : (catalog?.maxQty ?? null);
  const step = hasOverride && variantConfig?.qtyIncrement != null ? variantConfig.qtyIncrement : (catalog?.qtyIncrement ?? 1);

  return {
    min: Math.max(1, min),
    max: max != null && max > 0 ? max : null,
    step: Math.max(1, step),
  };
}

/**
 * Validates if quantity satisfies the pack/increment model (min, step, max)
 * or is 0 (special "not in cart" state).
 *
 * Model: the first valid positive quantity is `min`. Subsequent valid values
 * are `min + step`, `min + 2*step`, etc. In other words:
 *   (quantity - min) % step === 0  AND  quantity >= min  AND  quantity <= max (if set)
 *
 * This is the relative-to-min model and is used for both client and server
 * validation to ensure parity.
 */
export function isValidQuantity(quantity: number, min: number, step: number, max: number | null = null): boolean {
  if (!Number.isInteger(quantity)) return false;
  if (quantity === 0) return true; // Special "not in cart" state
  if (quantity < 0) return false;

  const pack = Math.max(1, step);
  // All positive quantities must be integer multiples of pack size
  if (quantity % pack !== 0) return false;

  // Effective positive minimum: if min is provided and > 0, it must be at least min
  const effectiveMin = min && min > 0 ? Math.ceil(min / pack) * pack : pack;
  if (quantity < effectiveMin) return false;

  if (max !== null && max > 0 && quantity > max) return false;

  return true;
}

export function isValidQuantityStep(quantity: number, min: number, step: number, max: number | null = null): boolean {
  return isValidQuantity(quantity, min, step, max);
}

/**
 * Computes the next valid quantity for increment (+) using wholesale pack-size model.
 * - From 0 (or below effective minimum), moves to effective minimum (e.g. 2, 3, or min).
 * - Subsequent steps add pack size (e.g. 3 -> 6 -> 9 -> 12...).
 * - Never exceeds max; if next step would exceed max, remains at current valid quantity.
 */
export function nextValidQuantity(currentQty: number, min: number, step: number, max: number | null = null): number {
  const pack = Math.max(1, step);
  const effectiveMin = min && min > 0 ? Math.ceil(min / pack) * pack : pack;

  if (currentQty <= 0 || currentQty < effectiveMin) {
    if (max !== null && max > 0 && effectiveMin > max) {
      return currentQty <= 0 ? 0 : currentQty;
    }
    return effectiveMin;
  }

  const next = (Math.floor(currentQty / pack) + 1) * pack;

  if (max !== null && max > 0 && next > max) {
    return currentQty;
  }

  return next;
}

/**
 * Computes the previous valid quantity for decrement (-) using wholesale pack-size model.
 * - Steps down by pack size.
 * - If current quantity is at or below effective minimum, returns 0 (removes item from cart).
 */
export function previousValidQuantity(currentQty: number, min: number, step: number): number {
  const pack = Math.max(1, step);
  const effectiveMin = min && min > 0 ? Math.ceil(min / pack) * pack : pack;

  if (currentQty <= effectiveMin) {
    return 0;
  }

  const prev = (Math.ceil(currentQty / pack) - 1) * pack;
  if (prev < effectiveMin) {
    return 0;
  }

  return prev;
}

/**
 * Normalizes an arbitrary quantity input to the nearest valid multiple of pack size.
 * - If <= 0, returns 0.
 * - If < effectiveMin, returns effectiveMin.
 * - Rounds to nearest multiple of pack.
 * - If rounded value exceeds max, clamps down to largest valid multiple <= max.
 */
export function normalizeQuantity(quantity: number, min: number, step: number, max: number | null = null): number {
  if (quantity <= 0) return 0;

  const pack = Math.max(1, step);
  const effectiveMin = min && min > 0 ? Math.ceil(min / pack) * pack : pack;

  if (quantity < effectiveMin) return effectiveMin;

  const rem = quantity % pack;
  let normalized = rem >= pack / 2 ? quantity + (pack - rem) : quantity - rem;

  if (normalized < effectiveMin) normalized = effectiveMin;

  if (max !== null && max > 0 && normalized > max) {
    const maxMultiple = Math.floor(max / pack) * pack;
    if (maxMultiple < effectiveMin) return 0;
    return maxMultiple;
  }

  return normalized;
}

// ─── Central Variant Inventory Resolver ────────────────────────────────────────

export type InventoryDisplayState = 'IN_STOCK' | 'OUT_OF_STOCK' | 'BACKORDER' | 'EXACT' | 'UNTRACKED' | 'HIDDEN';

export interface ResolvedVariantInventory {
  tracked: boolean;
  quantity: number | null; // Effective stock ceiling for ordering (null if untracked or continue)
  sellable: boolean;       // Canonical purchasability state
  displayState: InventoryDisplayState;
  displayText: string | null;
  isCappedOverThreshold?: boolean;
}

/**
 * Canonical derivation of inventory purchasability and display mode.
 * Strictly separates purchasability from display formatting.
 * Never coerces undefined/missing inventory to 0 in STATUS_ONLY/HIDDEN modes.
 */
export function resolveVariantInventory(
  variant: {
    inventoryTracked?: boolean | null;
    inventoryPolicy?: string | null;
    inventoryQuantity?: number | null;
    effectiveAvailable?: number | null;
    availableForSale?: boolean | null;
    isCappedOverThreshold?: boolean | null;
  },
  inventoryMode: string = 'STATUS_ONLY',
  inventoryCap: number | null = 50
): ResolvedVariantInventory {
  const tracked = variant.inventoryTracked !== false;
  const policy = (variant.inventoryPolicy || 'DENY').toUpperCase();
  const isContinue = policy === 'CONTINUE';
  const isAvailableForSale = variant.availableForSale !== false;

  const hasExactStock = typeof variant.inventoryQuantity === 'number' || typeof variant.effectiveAvailable === 'number';
  const rawStock = variant.inventoryQuantity ?? variant.effectiveAvailable ?? null;
  const numericStock = rawStock !== null ? Math.max(0, rawStock) : null;

  // 1. Purchasability State
  let sellable = false;
  let isBackorderable = false;
  let orderableCeiling: number | null = null; // null means no local stock ceiling

  if (!tracked) {
    // Untracked inventory is orderable (never 0-stock) unless availableForSale is false
    sellable = isAvailableForSale;
    orderableCeiling = null;
  } else if (isContinue) {
    // Tracked + CONTINUE: orderable/backorderable even if stock <= 0
    sellable = isAvailableForSale;
    isBackorderable = (numericStock !== null && numericStock <= 0);
    orderableCeiling = null;
  } else {
    // Tracked + DENY:
    if (hasExactStock) {
      sellable = isAvailableForSale && numericStock! > 0;
      orderableCeiling = numericStock;
    } else {
      // Exact stock hidden for privacy (STATUS_ONLY / HIDDEN) — trust availableForSale
      sellable = isAvailableForSale;
      orderableCeiling = null;
    }
  }

  // 2. Display Mode
  if (inventoryMode === 'HIDDEN') {
    return {
      tracked: tracked && !isContinue,
      quantity: orderableCeiling,
      sellable,
      displayState: 'HIDDEN',
      displayText: null,
      isCappedOverThreshold: false,
    };
  }

  if (!sellable) {
    return {
      tracked: tracked && !isContinue,
      quantity: 0,
      sellable: false,
      displayState: 'OUT_OF_STOCK',
      displayText: 'Out of stock',
      isCappedOverThreshold: false,
    };
  }

  if (isBackorderable) {
    return {
      tracked: true,
      quantity: orderableCeiling,
      sellable: true,
      displayState: 'BACKORDER',
      displayText: 'Available for backorder',
      isCappedOverThreshold: false,
    };
  }

  if (inventoryMode === 'STATUS_ONLY') {
    return {
      tracked: tracked && !isContinue,
      quantity: orderableCeiling,
      sellable: true,
      displayState: 'IN_STOCK',
      displayText: 'In stock',
      isCappedOverThreshold: false,
    };
  }

  if (inventoryMode === 'EXACT') {
    if (numericStock !== null && tracked && !isContinue) {
      return {
        tracked: true,
        quantity: orderableCeiling,
        sellable: true,
        displayState: 'EXACT',
        displayText: `${numericStock} available`,
        isCappedOverThreshold: false,
      };
    }
    return {
      tracked: false,
      quantity: orderableCeiling,
      sellable: true,
      displayState: 'UNTRACKED',
      displayText: 'In stock',
      isCappedOverThreshold: false,
    };
  }

  // Legacy CAPPED mode is normalised to STATUS_ONLY at display time.
  // (Backward-compat: existing catalogs with inventoryMode=CAPPED are treated as STATUS_ONLY.)
  // Fall through to STATUS_ONLY display below.

  // STATUS_ONLY (default) or any unknown/legacy mode:
  return {
    tracked: tracked && !isContinue,
    quantity: orderableCeiling,
    sellable: true,
    displayState: 'IN_STOCK',
    displayText: 'In stock',
    isCappedOverThreshold: false,
  };
}

// ─── Buyer form config ────────────────────────────────────────────────────────

export const BuyerFormConfigSchema = z.object({
  showPoNumber: z.boolean().optional().default(true),
  requirePoNumber: z.boolean().optional().default(false),
  showNote: z.boolean().optional().default(true),
  requireNote: z.boolean().optional().default(false),
}).passthrough().default({});

// ─── Catalog CRUD schemas ──────────────────────────────────────────────────────

// Zod validation schemas
export const CatalogSourceSchema = z.object({
  type: z.enum([CatalogSourceType.COLLECTION, CatalogSourceType.PRODUCT]),
  shopifyGid: z.string().min(1, 'Shopify GID is required'),
});

const optionalNullableInt = (minVal = 1, maxVal?: number) =>
  z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    (maxVal ? z.number().int().min(minVal).max(maxVal) : z.number().int().min(minVal)).optional().nullable()
  );

const numericInput = (schema: z.ZodNumber) =>
  z.preprocess(
    (val) => (typeof val === 'string' && val.trim() !== '' ? Number(val) : val),
    schema
  );

export const CreateCatalogInputSchema = z.object({
  name: z.string().trim().min(1, 'Catalog name is required').max(100),
  priceMode: z.enum([PriceMode.SHOPIFY_PRICE, PriceMode.PERCENT_DISCOUNT, PriceMode.CUSTOM_PRICE]).default(PriceMode.SHOPIFY_PRICE),
  discountPercent: numericInput(z.number().min(0).max(90)).optional().default(0),
  customPriceAmount: numericInput(z.number().min(0).max(999999)).optional().nullable(),
  logoUrl: z.preprocess(
    (val) => (typeof val === 'string' && val.trim().length === 0 ? null : val),
    z.string().url('Logo must be a valid URL').optional().nullable()
  ),
  accentColor: z.string().regex(/^#([0-9a-fA-F]{3}){1,2}$/, 'Valid hex color required').optional().default('#108043'),
  showSku: z.boolean().default(true),
  showInventory: z.boolean().optional(),
  inventoryMode: z.enum([InventoryMode.STATUS_ONLY, InventoryMode.EXACT, InventoryMode.HIDDEN, 'CAPPED' as any]).optional(),
  inventoryCap: optionalNullableInt(1, 100000),
  minQty: z.number().int().min(1).max(10000).optional().default(1),
  maxQty: optionalNullableInt(1, 100000),
  qtyIncrement: z.number().int().min(1).max(1000).optional().default(1),
  buyerFormConfig: z.union([z.string(), BuyerFormConfigSchema]).optional(),
  sources: z.array(CatalogSourceSchema).min(1, 'At least one collection or product source is required'),
  variantConfigs: z.array(CatalogVariantConfigInputSchema).optional(),
}).refine(
  (data) => {
    if (data.minQty && data.qtyIncrement && data.minQty > 1) {
      return data.minQty % data.qtyIncrement === 0;
    }
    return true;
  },
  {
    message: 'Minimum order quantity must be a multiple of pack size',
    path: ['minQty'],
  }
);

export const UpdateCatalogInputSchema = z.object({
  name: z.string().trim().min(1, 'Catalog name is required').max(100).optional(),
  priceMode: z.enum([PriceMode.SHOPIFY_PRICE, PriceMode.PERCENT_DISCOUNT, PriceMode.CUSTOM_PRICE]).optional(),
  discountPercent: numericInput(z.number().min(0).max(90)).optional(),
  customPriceAmount: numericInput(z.number().min(0).max(999999)).optional().nullable(),
  logoUrl: z.preprocess(
    (val) => (typeof val === 'string' && val.trim().length === 0 ? null : val),
    z.string().url('Logo must be a valid URL').optional().nullable()
  ),
  accentColor: z.string().regex(/^#([0-9a-fA-F]{3}){1,2}$/, 'Valid hex color required').optional(),
  showSku: z.boolean().optional(),
  showInventory: z.boolean().optional(),
  inventoryMode: z.enum([InventoryMode.STATUS_ONLY, InventoryMode.EXACT, InventoryMode.HIDDEN, 'CAPPED' as any]).optional(),
  inventoryCap: optionalNullableInt(1, 100000),
  minQty: z.number().int().min(1).max(10000).optional(),
  maxQty: optionalNullableInt(1, 100000),
  qtyIncrement: z.number().int().min(1).max(1000).optional(),
  buyerFormConfig: z.union([z.string(), BuyerFormConfigSchema]).optional(),
  sources: z.array(CatalogSourceSchema).min(1, 'At least one collection or product source is required').optional(),
  variantConfigs: z.array(CatalogVariantConfigInputSchema).optional(),
}).refine(
  (data) => {
    if (data.minQty && data.qtyIncrement && data.minQty > 1) {
      return data.minQty % data.qtyIncrement === 0;
    }
    return true;
  },
  {
    message: 'Minimum order quantity must be a multiple of pack size',
    path: ['minQty'],
  }
);

// ─── Order Link schemas ────────────────────────────────────────────────────────

export const CreateOrderLinkInputSchema = z.object({
  label: z.string().trim().min(1).max(100).default('Default Link'),
  passcode: z.string().min(4).max(50).optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
  source: z.string().max(100).optional().nullable(),
});

export const UpdateOrderLinkInputSchema = CreateOrderLinkInputSchema.partial().extend({
  active: z.boolean().optional(),
});

// ─── Buyer order schemas ───────────────────────────────────────────────────────

export const BuyerOrderLineSchema = z.object({
  variantId: z.string().min(1, 'Variant ID is required').max(150, 'Variant ID exceeds maximum length'),
  quantity: z.number().int().min(1, 'Quantity must be at least 1').max(100000, 'Quantity exceeds maximum allowable line limit (100,000)'),
});

const optionalTrimmedString = (maxLength: number, customMessage?: string) =>
  z.preprocess(
    (val) => (typeof val === 'string' && val.trim().length === 0 ? null : val),
    z.string().trim().max(maxLength, customMessage).optional().nullable()
  );

export const BuyerInfoSchema = z.object({
  businessName: z.string().trim().min(1, 'Business name is required').max(150, 'Business name exceeds maximum length'),
  email: z.string().trim().email('Valid buyer email is required').max(150, 'Email exceeds maximum length'),
  poNumber: optionalTrimmedString(50, 'PO number exceeds maximum length'),
  note: optionalTrimmedString(1000, 'Note exceeds maximum length'),
});

// Shopify Draft Orders support at most 500 line items; cap at 499 to stay safely within the limit.
export const BuyerSubmitOrderSchema = z.preprocess(
  (raw: any) => {
    if (raw && typeof raw === 'object') {
      const copy = { ...raw };
      if (!copy.lines && Array.isArray(copy.items)) {
        copy.lines = copy.items;
      }
      return copy;
    }
    return raw;
  },
  z.object({
    dataVersion: z.number().int().positive(),
    lines: z.array(BuyerOrderLineSchema).min(1, 'At least one line item is required').max(499, 'Maximum allowable line items per order is 499 (Shopify limit)'),
    buyer: BuyerInfoSchema,
    orderLinkToken: z.string().optional().nullable(),
    linkAccessToken: z.string().optional().nullable(),
    passcode: z.string().optional().nullable(),
  })
);

export const BuyerValidateOrderSchema = z.preprocess(
  (raw: any) => {
    if (raw && typeof raw === 'object') {
      const copy = { ...raw };
      if (!copy.lines && Array.isArray(copy.items)) {
        copy.lines = copy.items;
      }
      return copy;
    }
    return raw;
  },
  z.object({
    dataVersion: z.number().int().positive(),
    lines: z.array(BuyerOrderLineSchema).min(1, 'At least one line item is required').max(499, 'Maximum allowable line items per order is 499 (Shopify limit)'),
    orderLinkToken: z.string().optional().nullable(),
    linkAccessToken: z.string().optional().nullable(),
  })
);

// ─── Type exports ──────────────────────────────────────────────────────────────

export type BuyerOrderLine = z.infer<typeof BuyerOrderLineSchema>;
export type BuyerInfo = z.infer<typeof BuyerInfoSchema>;
export type BuyerSubmitOrderInput = z.infer<typeof BuyerSubmitOrderSchema>;
export type BuyerValidateOrderInput = z.infer<typeof BuyerValidateOrderSchema>;
export type CreateCatalogInput = z.infer<typeof CreateCatalogInputSchema>;
export type UpdateCatalogInput = z.infer<typeof UpdateCatalogInputSchema>;
export type CatalogVariantConfigInput = z.input<typeof CatalogVariantConfigInputSchema>;
export type BuyerFormConfig = z.infer<typeof BuyerFormConfigSchema>;
export type CreateOrderLinkInput = z.infer<typeof CreateOrderLinkInputSchema>;
export type UpdateOrderLinkInput = z.infer<typeof UpdateOrderLinkInputSchema>;
