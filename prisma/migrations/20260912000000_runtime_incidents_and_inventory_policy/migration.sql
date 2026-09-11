-- AlterTable
ALTER TABLE "VariantSnapshot" ADD COLUMN     "inventoryPolicy" TEXT NOT NULL DEFAULT 'DENY',
ADD COLUMN     "inventoryTracked" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "RuntimeIncident" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "requestId" TEXT,
    "shopDomain" TEXT,
    "catalogId" TEXT,
    "route" TEXT,
    "stage" TEXT,
    "errorCode" TEXT,
    "message" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "RuntimeIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuntimeIncident_createdAt_idx" ON "RuntimeIncident"("createdAt");

-- CreateIndex
CREATE INDEX "RuntimeIncident_shopDomain_idx" ON "RuntimeIncident"("shopDomain");

-- CreateIndex
CREATE INDEX "RuntimeIncident_type_idx" ON "RuntimeIncident"("type");

-- CreateIndex
CREATE INDEX "RuntimeIncident_requestId_idx" ON "RuntimeIncident"("requestId");
