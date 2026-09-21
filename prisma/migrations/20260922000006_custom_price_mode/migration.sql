-- Migration: custom_price_mode
-- Adds customPriceAmount field to Catalog for CUSTOM_PRICE priceMode.
-- The CUSTOM_PRICE priceMode applies a single catalog-level wholesale price,
-- which can be overridden per-variant via CatalogVariantConfig.customPrice.

ALTER TABLE "Catalog"
  ADD COLUMN IF NOT EXISTS "customPriceAmount" DECIMAL(12,2);
