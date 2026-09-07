-- AlterTable
ALTER TABLE "WebhookReceipt" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PROCESSING';

-- CreateIndex
CREATE INDEX "WebhookReceipt_status_idx" ON "WebhookReceipt"("status");
