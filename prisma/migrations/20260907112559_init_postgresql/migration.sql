-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "plan" TEXT NOT NULL DEFAULT 'STARTER',
    "billingCycleAnchor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monthlySubmissionsCount" INTEGER NOT NULL DEFAULT 0,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Catalog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "priceMode" TEXT NOT NULL DEFAULT 'SHOPIFY_PRICE',
    "discountPercent" DECIMAL(5,2) DEFAULT 0,
    "logoUrl" TEXT,
    "accentColor" TEXT DEFAULT '#108043',
    "showSku" BOOLEAN NOT NULL DEFAULT true,
    "showInventory" BOOLEAN NOT NULL DEFAULT false,
    "dataVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogSource" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItemOverride" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogItemOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionSnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyCollectionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionProductMembership" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionProductMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "vendor" TEXT,
    "handle" TEXT NOT NULL,
    "imageUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "sourceUpdatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantSnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "shopifyPrice" DECIMAL(12,2) NOT NULL,
    "inventoryQuantity" INTEGER NOT NULL DEFAULT 0,
    "availableForSale" BOOLEAN NOT NULL DEFAULT true,
    "selectedOptionsJson" TEXT NOT NULL DEFAULT '[]',
    "imageUrl" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VariantSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderSubmission" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "draftOrderId" TEXT NOT NULL,
    "draftOrderName" TEXT,
    "idempotencyKeyHash" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "subtotalAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "statsJson" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_shopDomain_idx" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_uninstalledAt_idx" ON "Shop"("uninstalledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Catalog_publicToken_key" ON "Catalog"("publicToken");

-- CreateIndex
CREATE INDEX "Catalog_shopId_idx" ON "Catalog"("shopId");

-- CreateIndex
CREATE INDEX "Catalog_publicToken_idx" ON "Catalog"("publicToken");

-- CreateIndex
CREATE INDEX "Catalog_status_idx" ON "Catalog"("status");

-- CreateIndex
CREATE INDEX "CatalogSource_catalogId_idx" ON "CatalogSource"("catalogId");

-- CreateIndex
CREATE INDEX "CatalogSource_shopifyGid_idx" ON "CatalogSource"("shopifyGid");

-- CreateIndex
CREATE INDEX "CatalogItemOverride_catalogId_idx" ON "CatalogItemOverride"("catalogId");

-- CreateIndex
CREATE INDEX "CatalogItemOverride_shopifyProductId_idx" ON "CatalogItemOverride"("shopifyProductId");

-- CreateIndex
CREATE INDEX "CollectionSnapshot_shopId_idx" ON "CollectionSnapshot"("shopId");

-- CreateIndex
CREATE INDEX "CollectionSnapshot_shopifyCollectionId_idx" ON "CollectionSnapshot"("shopifyCollectionId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionSnapshot_shopId_shopifyCollectionId_key" ON "CollectionSnapshot"("shopId", "shopifyCollectionId");

-- CreateIndex
CREATE INDEX "CollectionProductMembership_collectionId_idx" ON "CollectionProductMembership"("collectionId");

-- CreateIndex
CREATE INDEX "CollectionProductMembership_shopifyProductId_idx" ON "CollectionProductMembership"("shopifyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionProductMembership_collectionId_shopifyProductId_key" ON "CollectionProductMembership"("collectionId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "ProductSnapshot_shopId_idx" ON "ProductSnapshot"("shopId");

-- CreateIndex
CREATE INDEX "ProductSnapshot_shopifyProductId_idx" ON "ProductSnapshot"("shopifyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSnapshot_shopId_shopifyProductId_key" ON "ProductSnapshot"("shopId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "VariantSnapshot_shopId_idx" ON "VariantSnapshot"("shopId");

-- CreateIndex
CREATE INDEX "VariantSnapshot_shopifyVariantId_idx" ON "VariantSnapshot"("shopifyVariantId");

-- CreateIndex
CREATE INDEX "VariantSnapshot_shopifyProductId_idx" ON "VariantSnapshot"("shopifyProductId");

-- CreateIndex
CREATE INDEX "VariantSnapshot_sku_idx" ON "VariantSnapshot"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "VariantSnapshot_shopId_shopifyVariantId_key" ON "VariantSnapshot"("shopId", "shopifyVariantId");

-- CreateIndex
CREATE INDEX "OrderSubmission_shopId_idx" ON "OrderSubmission"("shopId");

-- CreateIndex
CREATE INDEX "OrderSubmission_catalogId_idx" ON "OrderSubmission"("catalogId");

-- CreateIndex
CREATE INDEX "OrderSubmission_draftOrderId_idx" ON "OrderSubmission"("draftOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderSubmission_catalogId_idempotencyKeyHash_key" ON "OrderSubmission"("catalogId", "idempotencyKeyHash");

-- CreateIndex
CREATE INDEX "SyncRun_shopId_idx" ON "SyncRun"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_webhookId_key" ON "WebhookReceipt"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookReceipt_webhookId_idx" ON "WebhookReceipt"("webhookId");

-- AddForeignKey
ALTER TABLE "Catalog" ADD CONSTRAINT "Catalog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogSource" ADD CONSTRAINT "CatalogSource_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItemOverride" ADD CONSTRAINT "CatalogItemOverride_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionSnapshot" ADD CONSTRAINT "CollectionSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionProductMembership" ADD CONSTRAINT "CollectionProductMembership_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "CollectionSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSnapshot" ADD CONSTRAINT "ProductSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantSnapshot" ADD CONSTRAINT "VariantSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantSnapshot" ADD CONSTRAINT "VariantSnapshot_shopId_shopifyProductId_fkey" FOREIGN KEY ("shopId", "shopifyProductId") REFERENCES "ProductSnapshot"("shopId", "shopifyProductId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderSubmission" ADD CONSTRAINT "OrderSubmission_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderSubmission" ADD CONSTRAINT "OrderSubmission_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
