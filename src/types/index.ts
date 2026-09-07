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

export enum PriceMode {
  SHOPIFY_PRICE = 'SHOPIFY_PRICE',
  PERCENT_DISCOUNT = 'PERCENT_DISCOUNT',
}

export enum CatalogSourceType {
  COLLECTION = 'COLLECTION',
  PRODUCT = 'PRODUCT',
}

// Zod validation schemas
export const CatalogSourceSchema = z.object({
  type: z.enum([CatalogSourceType.COLLECTION, CatalogSourceType.PRODUCT]),
  shopifyGid: z.string().min(1, 'Shopify GID is required'),
});

export const CreateCatalogInputSchema = z.object({
  name: z.string().trim().min(1, 'Catalog name is required').max(100),
  priceMode: z.enum([PriceMode.SHOPIFY_PRICE, PriceMode.PERCENT_DISCOUNT]).default(PriceMode.SHOPIFY_PRICE),
  discountPercent: z.number().min(0).max(90).optional().default(0),
  logoUrl: z.string().url().optional().nullable(),
  accentColor: z.string().regex(/^#([0-9a-fA-F]{3}){1,2}$/, 'Valid hex color required').optional().default('#108043'),
  showSku: z.boolean().default(true),
  showInventory: z.boolean().default(false),
  sources: z.array(CatalogSourceSchema).min(1, 'At least one collection or product source is required'),
});

export const UpdateCatalogInputSchema = CreateCatalogInputSchema.partial();

export const BuyerOrderLineSchema = z.object({
  variantId: z.string().min(1, 'Variant ID is required'),
  quantity: z.number().int().positive('Quantity must be an integer greater than 0'),
});

export const BuyerInfoSchema = z.object({
  businessName: z.string().trim().min(1, 'Business name is required').max(150),
  email: z.string().trim().email('Valid buyer email is required'),
  poNumber: z.string().trim().max(50).optional().nullable(),
  note: z.string().trim().max(1000).optional().nullable(),
});

export const BuyerSubmitOrderSchema = z.object({
  dataVersion: z.number().int().positive(),
  lines: z.array(BuyerOrderLineSchema).min(1, 'At least one line item is required').max(499, 'Shopify Draft Order line item limit is 499'),
  buyer: BuyerInfoSchema,
});

export const BuyerValidateOrderSchema = z.object({
  dataVersion: z.number().int().positive(),
  lines: z.array(BuyerOrderLineSchema).min(1, 'At least one line item is required'),
});

export type BuyerOrderLine = z.infer<typeof BuyerOrderLineSchema>;
export type BuyerInfo = z.infer<typeof BuyerInfoSchema>;
export type BuyerSubmitOrderInput = z.infer<typeof BuyerSubmitOrderSchema>;
export type BuyerValidateOrderInput = z.infer<typeof BuyerValidateOrderSchema>;

