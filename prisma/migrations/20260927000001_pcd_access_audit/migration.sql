-- CreateTable
CREATE TABLE "PcdAccessAudit" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "catalogId" TEXT,
    "requestId" TEXT,
    "action" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PcdAccessAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PcdAccessAudit_shopId_idx" ON "PcdAccessAudit"("shopId");

-- CreateIndex
CREATE INDEX "PcdAccessAudit_createdAt_idx" ON "PcdAccessAudit"("createdAt");

-- CreateIndex
CREATE INDEX "PcdAccessAudit_shopId_createdAt_idx" ON "PcdAccessAudit"("shopId", "createdAt");
