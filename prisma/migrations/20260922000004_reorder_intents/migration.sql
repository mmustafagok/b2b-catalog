-- Migration: reorder_intents
-- New table for buyer Reorder Links. A merchant creates a reorder intent from a completed
-- submission. The buyer opens the link, gets prefilled quantities, and submits a new order.

CREATE TABLE IF NOT EXISTS "ReorderIntent" (
  "id"                TEXT        NOT NULL,
  "catalogId"         TEXT        NOT NULL,
  "shopId"            TEXT        NOT NULL,
  "originSubmissionId" TEXT,
  "token"             TEXT        NOT NULL,
  "prefillJson"       TEXT        NOT NULL,
  "expiresAt"         TIMESTAMP(3),
  "usedAt"            TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReorderIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReorderIntent_token_key"
  ON "ReorderIntent"("token");

CREATE INDEX IF NOT EXISTS "ReorderIntent_catalogId_idx"
  ON "ReorderIntent"("catalogId");

CREATE INDEX IF NOT EXISTS "ReorderIntent_shopId_idx"
  ON "ReorderIntent"("shopId");

ALTER TABLE "ReorderIntent"
  ADD CONSTRAINT "ReorderIntent_catalogId_fkey"
  FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReorderIntent"
  ADD CONSTRAINT "ReorderIntent_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
