-- Migration: catalog_variant_config
-- New table for per-variant catalog configuration: enabled/disabled, custom price, qty rule overrides.

CREATE TABLE IF NOT EXISTS "CatalogVariantConfig" (
  "id"               TEXT        NOT NULL,
  "catalogId"        TEXT        NOT NULL,
  "shopifyVariantId" TEXT        NOT NULL,
  "enabled"          BOOLEAN     NOT NULL DEFAULT true,
  "customPrice"      DECIMAL(12,2),
  "minQty"           INTEGER,
  "maxQty"           INTEGER,
  "qtyIncrement"     INTEGER,
  "position"         INTEGER     NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CatalogVariantConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CatalogVariantConfig_catalogId_shopifyVariantId_key"
  ON "CatalogVariantConfig"("catalogId", "shopifyVariantId");

CREATE INDEX IF NOT EXISTS "CatalogVariantConfig_catalogId_idx"
  ON "CatalogVariantConfig"("catalogId");

CREATE INDEX IF NOT EXISTS "CatalogVariantConfig_shopifyVariantId_idx"
  ON "CatalogVariantConfig"("shopifyVariantId");

ALTER TABLE "CatalogVariantConfig"
  ADD CONSTRAINT "CatalogVariantConfig_catalogId_fkey"
  FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
