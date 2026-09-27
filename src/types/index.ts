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
  CAPPED = 'CAPPED',           // Show qty but cap at inventoryCap ("50+ available")
  EXACT = 'EXACT',             // Show exact qty always
  HIDDEN = 'HIDDEN',           // No inventory information shown at all
}

export enum CatalogSourceType {
  COLLECTION = 'COLLECTION',
  PRODUCT = 'PRODUCT',
}

// ─── Catalog variant config input ─────────────────────────────────────────────

export const CatalogVariantConfigInputSchema = z.object({
  shopifyVariantId: z.string().min(1),
  enabled: z.boolean().default(true),
  customPrice: z.number().min(0).max(999999).optional().nullable(),
  overrideQuantityRules: z.boolean().optional().default(false),
  minQty: z.number().int().min(1).max(10000).optional().nullable(),
  maxQty: z.number().int().min(1).max(100000).optional().nullable(),
  qtyIncrement: z.number().int().min(1).max(1000).optional().nullable(),
  position: z.number().int().min(0).optional().default(0),
});

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
 * Validates if quantity satisfies min + n * step (n >= 0) and <= max limit.
 */
export function isValidQuantity(quantity: number, min: number, step: number, max: number | null = null): boolean {
  if (!Number.isInteger(quantity) || quantity < min) return false;
  if (max !== null && quantity > max) return false;
  return (quantity - min) % step === 0;
}

export function isValidQuantityStep(quantity: number, min: number, step: number, max: number | null = null): boolean {
  return isValidQuantity(quantity, min, step, max);
}

/**
 * Computes the next valid quantity for increment (+).
 * From 0 -> min.
 * From currentQty >= min -> min + (n + 1) * step (capped at max if set).
 */
export function nextValidQuantity(currentQty: number, min: number, step: number, max: number | null = null): number {
  const effectiveMin = Math.max(1, min);
  const effectiveStep = Math.max(1, step);

  if (currentQty <= 0) {
    if (max !== null && effectiveMin > max) return 0;
    return effectiveMin;
  }

  if (currentQty < effectiveMin) {
    if (max !== null && effectiveMin > max) return currentQty;
    return effectiveMin;
  }

  const offset = (currentQty - effectiveMin) % effectiveStep;
  let next: number;
  if (offset !== 0) {
    next = currentQty + (effectiveStep - offset);
  } else {
    next = currentQty + effectiveStep;
  }

  if (max !== null && next > max) {
    // If next valid step exceeds max, we MUST NOT clamp to an invalid max.
    // Invariant: isValidQuantity(nextValidQuantity(...)) === true.
    return currentQty;
  }

  return next;
}

/**
 * Computes the previous valid quantity for decrement (-).
 * From <= min -> 0 (remove from cart).
 * From currentQty > min -> step down by step aligned with min.
 */
export function previousValidQuantity(currentQty: number, min: number, step: number): number {
  const effectiveMin = Math.max(1, min);
  const effectiveStep = Math.max(1, step);

  if (currentQty <= effectiveMin) {
    return 0;
  }

  const offset = (currentQty - effectiveMin) % effectiveStep;
  let prev: number;
  if (offset !== 0) {
    prev = currentQty - offset;
  } else {
    prev = currentQty - effectiveStep;
  }

  return Math.max(0, prev);
}

/**
 * Normalizes an arbitrary quantity input to the nearest valid step at or above min.
 */
export function normalizeQuantity(quantity: number, min: number, step: number, max: number | null = null): number {
  if (quantity <= 0) return 0;
  const effectiveMin = Math.max(1, min);
  const effectiveStep = Math.max(1, step);

  if (quantity < effectiveMin) return effectiveMin;

  const offset = (quantity - effectiveMin) % effectiveStep;
  let normalized = offset === 0 ? quantity : quantity - offset;

  if (max !== null && normalized > max) {
    const maxOffset = (max - effectiveMin) % effectiveStep;
    normalized = max - maxOffset;
    if (normalized < effectiveMin) return 0;
  }

  return Math.max(effectiveMin, normalized);
}

// ─── Central Variant Inventory Resolver ────────────────────────────────────────

export type InventoryDisplayState = 'IN_STOCK' | 'OUT_OF_STOCK' | 'EXACT' | 'CAPPED' | 'UNTRACKED' | 'HIDDEN';

export interface ResolvedVariantInventory {
  tracked: boolean;
  quantity: number | null;
  sellable: boolean;
  displayState: InventoryDisplayState;
  displayText: string | null;
  isCappedOverThreshold?: boolean;
}

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
  const rawQty = variant.inventoryQuantity ?? variant.effectiveAvailable ?? null;

  const isUntracked = !tracked || policy === 'CONTINUE';

  let sellable = Boolean(variant.availableForSale ?? true);
  let effectiveQty: number | null = null;

  if (isUntracked) {
    effectiveQty = null;
    sellable = true;
  } else {
    effectiveQty = Math.max(0, rawQty ?? 0);
    sellable = sellable && effectiveQty > 0;
  }

  const isOutOfStock = !sellable;

  if (inventoryMode === 'HIDDEN') {
    return {
      tracked: !isUntracked,
      quantity: effectiveQty,
      sellable,
      displayState: 'HIDDEN',
      displayText: null,
      isCappedOverThreshold: false,
    };
  }

  if (isOutOfStock) {
    return {
      tracked: !isUntracked,
      quantity: effectiveQty,
      sellable: false,
      displayState: 'OUT_OF_STOCK',
      displayText: 'Out of stock',
      isCappedOverThreshold: false,
    };
  }

  if (inventoryMode === 'STATUS_ONLY') {
    return {
      tracked: !isUntracked,
      quantity: effectiveQty,
      sellable: true,
      displayState: 'IN_STOCK',
      displayText: 'In stock',
      isCappedOverThreshold: false,
    };
  }

  if (inventoryMode === 'EXACT') {
    if (effectiveQty !== null) {
      return {
        tracked: true,
        quantity: effectiveQty,
        sellable: true,
        displayState: 'EXACT',
        displayText: `${effectiveQty} available`,
        isCappedOverThreshold: false,
      };
    }
    return {
      tracked: false,
      quantity: null,
      sellable: true,
      displayState: 'UNTRACKED',
      displayText: 'In stock',
      isCappedOverThreshold: false,
    };
  }

  if (inventoryMode === 'CAPPED') {
    const cap = inventoryCap ?? 50;
    if (effectiveQty !== null) {
      const overCap = Boolean(variant.isCappedOverThreshold || effectiveQty >= cap);
      return {
        tracked: true,
        quantity: Math.min(effectiveQty, cap),
        sellable: true,
        displayState: overCap ? 'CAPPED' : 'EXACT',
        displayText: overCap ? `${cap}+ available` : `${effectiveQty} available`,
        isCappedOverThreshold: overCap,
      };
    }
    return {
      tracked: false,
      quantity: null,
      sellable: true,
      displayState: 'UNTRACKED',
      displayText: `${cap}+ available`,
      isCappedOverThreshold: true,
    };
  }

  return {
    tracked: !isUntracked,
    quantity: effectiveQty,
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

export const CreateCatalogInputSchema = z.object({
  name: z.string().trim().min(1, 'Catalog name is required').max(100),
  priceMode: z.enum([PriceMode.SHOPIFY_PRICE, PriceMode.PERCENT_DISCOUNT, PriceMode.CUSTOM_PRICE]).default(PriceMode.SHOPIFY_PRICE),
  discountPercent: z.number().min(0).max(90).optional().default(0),
  customPriceAmount: z.number().min(0).max(999999).optional().nullable(),
  logoUrl: z.preprocess(
    (val) => (typeof val === 'string' && val.trim().length === 0 ? null : val),
    z.string().url('Logo must be a valid URL').optional().nullable()
  ),
  accentColor: z.string().regex(/^#([0-9a-fA-F]{3}){1,2}$/, 'Valid hex color required').optional().default('#108043'),
  showSku: z.boolean().default(true),
  showInventory: z.boolean().default(false),
  inventoryMode: z.enum([InventoryMode.STATUS_ONLY, InventoryMode.CAPPED, InventoryMode.EXACT, InventoryMode.HIDDEN]).optional(),
  inventoryCap: optionalNullableInt(1),
  minQty: z.number().int().min(1).max(10000).optional().default(1),
  maxQty: optionalNullableInt(1, 100000),
  qtyIncrement: z.number().int().min(1).max(1000).optional().default(1),
  buyerFormConfig: z.union([z.string(), BuyerFormConfigSchema]).optional(),
  sources: z.array(CatalogSourceSchema).min(1, 'At least one collection or product source is required'),
  variantConfigs: z.array(CatalogVariantConfigInputSchema).optional(),
}).superRefine((data, ctx) => {
  if (data.inventoryMode === InventoryMode.CAPPED && (!data.inventoryCap || data.inventoryCap < 1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Inventory cap is required and must be at least 1 when Inventory Display Mode is CAPPED',
      path: ['inventoryCap'],
    });
  }
});

export const UpdateCatalogInputSchema = z.object({
  name: z.string().trim().min(1, 'Catalog name is required').max(100).optional(),
  priceMode: z.enum([PriceMode.SHOPIFY_PRICE, PriceMode.PERCENT_DISCOUNT, PriceMode.CUSTOM_PRICE]).optional(),
  discountPercent: z.number().min(0).max(90).optional(),
  customPriceAmount: z.number().min(0).max(999999).optional().nullable(),
  logoUrl: z.preprocess(
    (val) => (typeof val === 'string' && val.trim().length === 0 ? null : val),
    z.string().url('Logo must be a valid URL').optional().nullable()
  ),
  accentColor: z.string().regex(/^#([0-9a-fA-F]{3}){1,2}$/, 'Valid hex color required').optional(),
  showSku: z.boolean().optional(),
  showInventory: z.boolean().optional(),
  inventoryMode: z.enum([InventoryMode.STATUS_ONLY, InventoryMode.CAPPED, InventoryMode.EXACT, InventoryMode.HIDDEN]).optional(),
  inventoryCap: optionalNullableInt(1),
  minQty: z.number().int().min(1).max(10000).optional(),
  maxQty: optionalNullableInt(1, 100000),
  qtyIncrement: z.number().int().min(1).max(1000).optional(),
  buyerFormConfig: z.union([z.string(), BuyerFormConfigSchema]).optional(),
  sources: z.array(CatalogSourceSchema).min(1, 'At least one collection or product source is required').optional(),
  variantConfigs: z.array(CatalogVariantConfigInputSchema).optional(),
}).superRefine((data, ctx) => {
  if (data.inventoryMode === InventoryMode.CAPPED && (!data.inventoryCap || data.inventoryCap < 1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Inventory cap is required and must be at least 1 when Inventory Display Mode is CAPPED',
      path: ['inventoryCap'],
    });
  }
});

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

