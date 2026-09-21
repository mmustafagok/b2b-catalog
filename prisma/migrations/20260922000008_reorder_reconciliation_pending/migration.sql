-- Migration: reorder_reconciliation_pending
-- Adds reconciliationPendingAt to ReorderIntent to permanently prevent TTL expiration on ambiguous Shopify execution

ALTER TABLE "ReorderIntent"
  ADD COLUMN IF NOT EXISTS "reconciliationPendingAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ReorderIntent_reconciliationPendingAt_idx"
  ON "ReorderIntent"("reconciliationPendingAt");
