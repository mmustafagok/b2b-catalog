-- Migration: 20260922000009_add_variant_quantity_rule_override
-- Add overrideQuantityRules column to CatalogVariantConfig and backfill existing custom rules.

ALTER TABLE "CatalogVariantConfig"
ADD COLUMN IF NOT EXISTS "overrideQuantityRules" BOOLEAN NOT NULL DEFAULT false;

-- Backfill legacy records: if any quantity rule fields are populated, mark overrideQuantityRules = true
UPDATE "CatalogVariantConfig"
SET "overrideQuantityRules" = true
WHERE
  "minQty" IS NOT NULL
  OR "maxQty" IS NOT NULL
  OR "qtyIncrement" IS NOT NULL;
