-- Migration: 20260922000009_add_variant_quantity_rule_override
-- Add overrideQuantityRules column to CatalogVariantConfig

ALTER TABLE "CatalogVariantConfig"
ADD COLUMN IF NOT EXISTS "overrideQuantityRules" BOOLEAN NOT NULL DEFAULT false;

-- Clean up legacy rows where quantity fields were auto-populated defaults (minQty=1, qtyIncrement=1, maxQty=NULL)
UPDATE "CatalogVariantConfig"
SET
  "overrideQuantityRules" = false,
  "minQty" = NULL,
  "maxQty" = NULL,
  "qtyIncrement" = NULL
WHERE
  "overrideQuantityRules" = false
  OR ("minQty" = 1 AND "qtyIncrement" = 1 AND "maxQty" IS NULL);

