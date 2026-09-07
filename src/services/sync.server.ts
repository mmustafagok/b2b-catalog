import { prisma } from '../db.js';
import { calculateDisplayPrice } from './pricing.server.js';
import { CatalogSourceType, CatalogStatus } from '../types/index.js';

export interface ShopifyWebhookProductVariant {
  id: number | string;
  product_id: number | string;
  title: string;
  price: string | number;
  sku: string | null;
  barcode: string | null;
  inventory_quantity?: number;
  available?: boolean;
  image_id?: number | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
}

export interface ShopifyWebhookProduct {
  id: number | string;
  title: string;
  vendor?: string;
  handle: string;
  status: string;
  image?: { src?: string } | null;
  images?: Array<{ id: number; src: string }>;
  options?: Array<{ name: string; position: number }>;
  variants: ShopifyWebhookProductVariant[];
  updated_at?: string;
}

/**
 * Normalizes Shopify IDs to standard GraphQL GIDs if not already GID.
 */
export function normalizeShopifyGid(type: 'Product' | 'ProductVariant' | 'Collection', id: string | number): string {
  const strId = String(id);
  if (strId.startsWith('gid://shopify/')) {
    return strId;
  }
  return `gid://shopify/${type}/${strId}`;
}

/**
 * Ingests or updates a product and its variants into the read-optimized snapshot tables.
 */
export async function syncProductSnapshot(shopId: string, product: ShopifyWebhookProduct) {
  const shopifyProductId = normalizeShopifyGid('Product', product.id);
  const imageUrl = product.image?.src || (product.images && product.images[0]?.src) || null;

  return prisma.$transaction(async (tx) => {
    // Upsert product snapshot
    const productSnapshot = await tx.productSnapshot.upsert({
      where: {
        shopId_shopifyProductId: {
          shopId,
          shopifyProductId,
        },
      },
      update: {
        title: product.title,
        vendor: product.vendor || null,
        handle: product.handle,
        imageUrl,
        status: product.status?.toUpperCase() || 'ACTIVE',
        sourceUpdatedAt: product.updated_at ? new Date(product.updated_at) : new Date(),
        syncedAt: new Date(),
      },
      create: {
        shopId,
        shopifyProductId,
        title: product.title,
        vendor: product.vendor || null,
        handle: product.handle,
        imageUrl,
        status: product.status?.toUpperCase() || 'ACTIVE',
        sourceUpdatedAt: product.updated_at ? new Date(product.updated_at) : new Date(),
        syncedAt: new Date(),
      },
    });

    // Delete variants that no longer exist in the incoming product
    const incomingVariantGids = product.variants.map((v) => normalizeShopifyGid('ProductVariant', v.id));
    await tx.variantSnapshot.deleteMany({
      where: {
        shopId,
        shopifyProductId,
        shopifyVariantId: {
          notIn: incomingVariantGids,
        },
      },
    });

    // Upsert variant snapshots
    for (const v of product.variants) {
      const shopifyVariantId = normalizeShopifyGid('ProductVariant', v.id);
      const price = typeof v.price === 'string' ? parseFloat(v.price) : v.price;

      // Extract options
      const options: Array<{ name: string; value: string }> = [];
      if (product.options) {
        if (v.option1 && product.options[0]) options.push({ name: product.options[0].name, value: v.option1 });
        if (v.option2 && product.options[1]) options.push({ name: product.options[1].name, value: v.option2 });
        if (v.option3 && product.options[2]) options.push({ name: product.options[2].name, value: v.option3 });
      }

      await tx.variantSnapshot.upsert({
        where: {
          shopId_shopifyVariantId: {
            shopId,
            shopifyVariantId,
          },
        },
        update: {
          title: v.title,
          sku: v.sku || null,
          barcode: v.barcode || null,
          shopifyPrice: price || 0,
          inventoryQuantity: v.inventory_quantity ?? 0,
          availableForSale: v.available ?? true,
          selectedOptionsJson: JSON.stringify(options),
          imageUrl: imageUrl, // Fallback to product image if variant specific image not matched
          sourceUpdatedAt: new Date(),
          syncedAt: new Date(),
        },
        create: {
          shopId,
          shopifyProductId,
          shopifyVariantId,
          title: v.title,
          sku: v.sku || null,
          barcode: v.barcode || null,
          shopifyPrice: price || 0,
          inventoryQuantity: v.inventory_quantity ?? 0,
          availableForSale: v.available ?? true,
          selectedOptionsJson: JSON.stringify(options),
          imageUrl: imageUrl,
          sourceUpdatedAt: new Date(),
          syncedAt: new Date(),
        },
      });
    }

    // Increment dataVersion for any catalogs sourcing this product
    await tx.catalog.updateMany({
      where: {
        shopId,
        sources: {
          some: {
            shopifyGid: shopifyProductId,
          },
        },
      },
      data: {
        dataVersion: { increment: 1 },
      },
    });

    return productSnapshot;
  });
}

/**
 * Handles product deletion by deleting local snapshot and cascading to variants.
 */
export async function deleteProductSnapshot(shopId: string, rawProductId: string | number) {
  const shopifyProductId = normalizeShopifyGid('Product', rawProductId);

  await prisma.$transaction(async (tx) => {
    await tx.variantSnapshot.deleteMany({
      where: { shopId, shopifyProductId },
    });

    await tx.productSnapshot.deleteMany({
      where: { shopId, shopifyProductId },
    });

    // Increment dataVersion for affected catalogs
    await tx.catalog.updateMany({
      where: {
        shopId,
        sources: {
          some: {
            shopifyGid: shopifyProductId,
          },
        },
      },
      data: {
        dataVersion: { increment: 1 },
      },
    });
  });
}

/**
 * Generates the public catalog payload for buyer ordering.
 */
export async function getPublicCatalogPayload(publicToken: string) {
  const catalog = await prisma.catalog.findUnique({
    where: { publicToken },
    include: {
      shop: true,
      sources: true,
    },
  });

  if (!catalog || catalog.status !== CatalogStatus.PUBLISHED || catalog.shop.uninstalledAt !== null) {
    return null;
  }

  // Determine products to include based on sources
  const productGids: string[] = [];
  let includeAllCollectionProducts = false;

  for (const source of catalog.sources) {
    if (source.type === CatalogSourceType.PRODUCT) {
      productGids.push(source.shopifyGid);
    } else if (source.type === CatalogSourceType.COLLECTION) {
      // In collection mode for snapshot cache, fetch all active products for this shop
      // unless specific collections are filtered
      includeAllCollectionProducts = true;
    }
  }

  const whereClause: any = {
    shopId: catalog.shopId,
    status: 'ACTIVE',
  };

  if (!includeAllCollectionProducts && productGids.length > 0) {
    whereClause.shopifyProductId = { in: productGids };
  }

  const productSnapshots = await prisma.productSnapshot.findMany({
    where: whereClause,
    include: {
      variants: {
        orderBy: { shopifyPrice: 'asc' },
      },
    },
    orderBy: { title: 'asc' },
  });

  // Transform into clean public buyer DTO with calculated wholesale prices
  const products = productSnapshots.map((p) => {
    return {
      id: p.id,
      shopifyProductId: p.shopifyProductId,
      title: p.title,
      vendor: p.vendor,
      handle: p.handle,
      imageUrl: p.imageUrl,
      variants: p.variants.map((v) => {
        let selectedOptions: Array<{ name: string; value: string }> = [];
        try {
          selectedOptions = JSON.parse(v.selectedOptionsJson);
        } catch {
          selectedOptions = [];
        }

        const displayPrice = calculateDisplayPrice(
          v.shopifyPrice,
          catalog.priceMode,
          catalog.discountPercent
        );

        return {
          id: v.id,
          shopifyVariantId: v.shopifyVariantId,
          title: v.title,
          sku: v.sku,
          basePrice: v.shopifyPrice,
          displayPrice,
          availableForSale: v.availableForSale,
          inventoryQuantity: catalog.showInventory ? v.inventoryQuantity : undefined,
          selectedOptions,
          imageUrl: v.imageUrl || p.imageUrl,
        };
      }),
    };
  });

  return {
    catalog: {
      id: catalog.id,
      name: catalog.name,
      logoUrl: catalog.logoUrl,
      accentColor: catalog.accentColor || '#108043',
      showSku: catalog.showSku,
      showInventory: catalog.showInventory,
      priceMode: catalog.priceMode,
      discountPercent: catalog.discountPercent || 0,
    },
    shop: {
      shopDomain: catalog.shop.shopDomain,
    },
    products,
    totalProducts: products.length,
    dataVersion: catalog.dataVersion,
  };
}
