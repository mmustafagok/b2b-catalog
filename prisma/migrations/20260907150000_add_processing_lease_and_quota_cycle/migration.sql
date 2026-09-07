-- AlterTable
ALTER TABLE "OrderSubmission" ADD COLUMN "processingStartedAt" TIMESTAMP(3),
ADD COLUMN "quotaCycleAnchor" TIMESTAMP(3),
ADD COLUMN "quotaReserved" BOOLEAN NOT NULL DEFAULT false;
