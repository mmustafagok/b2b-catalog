-- Migration: reorder_intent_concurrency
-- Adds claimedAt, claimId, and claimExpiresAt for atomic single-use concurrency state machine

ALTER TABLE "ReorderIntent"
  ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimId" TEXT,
  ADD COLUMN IF NOT EXISTS "claimExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ReorderIntent_claimId_idx"
  ON "ReorderIntent"("claimId");
