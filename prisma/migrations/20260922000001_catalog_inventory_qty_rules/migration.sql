-- Migration: catalog_inventory_qty_rules
-- Adds inventory display mode, quantity rules, and buyer form config to Catalog.
-- All additive. No existing data is modified.

ALTER TABLE "Catalog"
  ADD COLUMN IF NOT EXISTS "inventoryMode"   TEXT    NOT NULL DEFAULT 'STATUS_ONLY',
  ADD COLUMN IF NOT EXISTS "inventoryCap"    INTEGER,
  ADD COLUMN IF NOT EXISTS "minQty"          INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "maxQty"          INTEGER,
  ADD COLUMN IF NOT EXISTS "qtyIncrement"    INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "buyerFormConfig" TEXT    NOT NULL DEFAULT '{}';
