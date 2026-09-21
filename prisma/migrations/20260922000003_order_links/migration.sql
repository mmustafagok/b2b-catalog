-- Migration: order_links
-- New table for Wholesale Order Links. Each catalog can have multiple named links with
-- optional passcode, expiry, source label, and per-link analytics.
-- Backfill: creates a default "Default Link" for each existing Catalog using its publicToken.

CREATE TABLE IF NOT EXISTS "OrderLink" (
  "id"             TEXT        NOT NULL,
  "catalogId"      TEXT        NOT NULL,
  "shopId"         TEXT        NOT NULL,
  "token"          TEXT        NOT NULL,
  "label"          TEXT        NOT NULL DEFAULT 'Default Link',
  "active"         BOOLEAN     NOT NULL DEFAULT true,
  "passcodeHash"   TEXT,
  "expiresAt"      TIMESTAMP(3),
  "source"         TEXT,
  "views"          INTEGER     NOT NULL DEFAULT 0,
  "submissions"    INTEGER     NOT NULL DEFAULT 0,
  "submittedValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderLink_token_key"
  ON "OrderLink"("token");

CREATE INDEX IF NOT EXISTS "OrderLink_catalogId_idx"
  ON "OrderLink"("catalogId");

CREATE INDEX IF NOT EXISTS "OrderLink_shopId_idx"
  ON "OrderLink"("shopId");

ALTER TABLE "OrderLink"
  ADD CONSTRAINT "OrderLink_catalogId_fkey"
  FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderLink"
  ADD CONSTRAINT "OrderLink_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: create a default OrderLink for every existing Catalog using its publicToken.
-- This ensures existing buyer links continue working through the new OrderLink routing.
INSERT INTO "OrderLink" ("id", "catalogId", "shopId", "token", "label", "active", "createdAt", "updatedAt")
SELECT
  'ol-' || SUBSTRING("id", 1, 24),
  "id",
  "shopId",
  "publicToken",
  'Default Link',
  true,
  NOW(),
  NOW()
FROM "Catalog"
ON CONFLICT ("token") DO NOTHING;
