-- CreateTable
CREATE TABLE "BackgroundJob" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackgroundJob_status_availableAt_idx" ON "BackgroundJob"("status", "availableAt");

-- CreateIndex
CREATE INDEX "BackgroundJob_shopId_idx" ON "BackgroundJob"("shopId");

-- CreateIndex
CREATE INDEX "BackgroundJob_type_idx" ON "BackgroundJob"("type");

-- CreateIndex
CREATE INDEX "Catalog_shopId_status_idx" ON "Catalog"("shopId", "status");

-- CreateIndex
CREATE INDEX "OrderSubmission_shopId_status_idx" ON "OrderSubmission"("shopId", "status");

-- CreateIndex
CREATE INDEX "OrderSubmission_shopId_createdAt_idx" ON "OrderSubmission"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
