import { z } from 'zod';

export enum PlanTier {
  STARTER = 'STARTER',
  GROWTH = 'GROWTH',
  SCALE = 'SCALE',
}

export const PLAN_LIMITS = {
  [PlanTier.STARTER]: {
    name: 'Starter',
    price: 14.99,
    maxLiveCatalogs: 1,
    maxVariants: 500,
    monthlySubmissionsLimit: 50,
  },
  [PlanTier.GROWTH]: {
    name: 'Growth',
    price: 29.99,
    maxLiveCatalogs: 5,
    maxVariants: 5000,
    monthlySubmissionsLimit: 250,
  },
  [PlanTier.SCALE]: {
    name: 'Scale',
    price: 49.99,
    maxLiveCatalogs: 20,
    maxVariants: 25000,
    monthlySubmissionsLimit: 1000,
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
  minQty: z.number().int().min(1).max(10000).optional().nullable(),
  maxQty: z.number().int().min(1).max(100000).optional().nullable(),
  qtyIncrement: z.number().int().min(1).max(1000).optional().nullable(),
  position: z.number().int().min(0).default(0),
});

// ─── Buyer form config ────────────────────────────────────────────────────────

export const BuyerFormConfigSchema = z.object({
  showPhone: z.boolean().default(false),
  requirePhone: z.boolean().default(false),
  showTaxId: z.boolean().default(false),
  requireTaxId: z.boolean().default(false),
  showPoNumber: z.boolean().default(true),
  requirePoNumber: z.boolean().default(false),
  showNote: z.boolean().default(true),
}).default({});

// ─── Catalog CRUD schemas ──────────────────────────────────────────────────────

// Zod validation schemas
export const CatalogSourceSchema = z.object({
  type: z.enum([CatalogSourceType.COLLECTION, CatalogSourceType.PRODUCT]),
  shopifyGid: z.string().min(1, 'Shopify GID is required'),
});

export const CreateCatalogInputSchema = z.object({
  name: z.string().trim().min(1, 'Catalog name is required').max(100),
  priceMode: z.enum([PriceMode.SHOPIFY_PRICE, PriceMode.PERCENT_DISCOUNT, PriceMode.CUSTOM_PRICE]).default(PriceMode.SHOPIFY_PRICE),
  discountPercent: z.number().min(0).max(90).optional().default(0),
  customPriceAmount: z.number().min(0).max(999999).optional().nullable(),
  logoUrl: z.string().url().optional().nullable(),
  accentColor: z.string().regex(/^#([0-9a-fA-F]{3}){1,2}$/, 'Valid hex color required').optional().default('#108043'),
  showSku: z.boolean().default(true),
  showInventory: z.boolean().default(false),
  inventoryMode: z.enum([InventoryMode.STATUS_ONLY, InventoryMode.CAPPED, InventoryMode.EXACT, InventoryMode.HIDDEN]).optional().default(InventoryMode.STATUS_ONLY),
  inventoryCap: z.number().int().min(1).optional().nullable(),
  minQty: z.number().int().min(1).max(10000).optional().default(1),
  maxQty: z.number().int().min(1).max(100000).optional().nullable(),
  qtyIncrement: z.number().int().min(1).max(1000).optional().default(1),
  buyerFormConfig: z.union([z.string(), BuyerFormConfigSchema]).optional(),
  sources: z.array(CatalogSourceSchema).min(1, 'At least one collection or product source is required'),
  variantConfigs: z.array(CatalogVariantConfigInputSchema).optional(),
});

export const UpdateCatalogInputSchema = CreateCatalogInputSchema.partial();

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

export const BuyerInfoSchema = z.object({
  businessName: z.string().trim().min(1, 'Business name is required').max(150, 'Business name exceeds maximum length'),
  email: z.string().trim().email('Valid buyer email is required').max(150, 'Email exceeds maximum length'),
  buyerName: z.string().trim().max(100).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  taxId: z.string().trim().max(50).optional().nullable(),
  poNumber: z.string().trim().max(50, 'PO number exceeds maximum length').optional().nullable(),
  note: z.string().trim().max(1000, 'Note exceeds maximum length').optional().nullable(),
});

// Shopify Draft Orders support at most 500 line items; cap at 499 to stay safely within the limit.
export const BuyerSubmitOrderSchema = z.object({
  dataVersion: z.number().int().positive(),
  lines: z.array(BuyerOrderLineSchema).min(1, 'At least one line item is required').max(499, 'Maximum allowable line items per order is 499 (Shopify limit)'),
  buyer: BuyerInfoSchema,
  orderLinkToken: z.string().optional().nullable(),
  linkAccessToken: z.string().optional().nullable(),
  passcode: z.string().optional().nullable(),
  reorderIntentToken: z.string().optional().nullable(),
});

export const BuyerValidateOrderSchema = z.object({
  dataVersion: z.number().int().positive(),
  lines: z.array(BuyerOrderLineSchema).min(1, 'At least one line item is required').max(499, 'Maximum allowable line items per order is 499 (Shopify limit)'),
  orderLinkToken: z.string().optional().nullable(),
  linkAccessToken: z.string().optional().nullable(),
});

// ─── CSV Bulk Order schema ─────────────────────────────────────────────────────

export const CsvBulkOrderSchema = z.object({
  csvText: z.string().min(1).max(500_000, 'CSV input too large (max 500KB)'),
});

// ─── Type exports ──────────────────────────────────────────────────────────────

export type BuyerOrderLine = z.infer<typeof BuyerOrderLineSchema>;
export type BuyerInfo = z.infer<typeof BuyerInfoSchema>;
export type BuyerSubmitOrderInput = z.infer<typeof BuyerSubmitOrderSchema>;
export type BuyerValidateOrderInput = z.infer<typeof BuyerValidateOrderSchema>;
export type CreateCatalogInput = z.infer<typeof CreateCatalogInputSchema>;
export type UpdateCatalogInput = z.infer<typeof UpdateCatalogInputSchema>;
export type CatalogVariantConfigInput = z.infer<typeof CatalogVariantConfigInputSchema>;
export type BuyerFormConfig = z.infer<typeof BuyerFormConfigSchema>;
export type CreateOrderLinkInput = z.infer<typeof CreateOrderLinkInputSchema>;
export type UpdateOrderLinkInput = z.infer<typeof UpdateOrderLinkInputSchema>;
