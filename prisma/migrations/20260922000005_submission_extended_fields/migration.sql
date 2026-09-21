-- Migration: submission_extended_fields
-- Extends OrderSubmission with optional buyer contact fields, link attribution,
-- and reorder intent tracking. All fields nullable for backwards compatibility.

ALTER TABLE "OrderSubmission"
  ADD COLUMN IF NOT EXISTS "orderLinkId"     TEXT,
  ADD COLUMN IF NOT EXISTS "buyerName"       TEXT,
  ADD COLUMN IF NOT EXISTS "buyerPhone"      TEXT,
  ADD COLUMN IF NOT EXISTS "taxId"           TEXT,
  ADD COLUMN IF NOT EXISTS "reorderIntentId" TEXT;

CREATE INDEX IF NOT EXISTS "OrderSubmission_orderLinkId_idx"
  ON "OrderSubmission"("orderLinkId");

-- Note: FK constraints are intentionally omitted here to avoid cascading deletes
-- on legacy submissions when an order link is deleted. Application-level enforcement only.
