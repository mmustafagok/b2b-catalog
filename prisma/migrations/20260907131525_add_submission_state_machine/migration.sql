-- AlterTable
ALTER TABLE "OrderSubmission" ADD COLUMN     "correlationRef" TEXT,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'CREATING',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "draftOrderId" DROP NOT NULL,
ALTER COLUMN "itemCount" SET DEFAULT 0,
ALTER COLUMN "lineCount" SET DEFAULT 0,
ALTER COLUMN "subtotalAmount" SET DEFAULT 0;

-- CreateIndex
CREATE INDEX "OrderSubmission_status_idx" ON "OrderSubmission"("status");
