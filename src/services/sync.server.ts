import { prisma } from '../db.js';
import { calculateDisplayPrice, toDecimal, formatMoney } from './pricing.server.js';
import { CatalogSourceType, CatalogStatus } from '../types/index.js';
import { ShopifyAdminClient, createShopifyClient } from './shopify-client.server.js';
import { Prisma } from '@prisma/client';

export interface ShopifyWebhookProductVariant {
  id: number | string;
  product_id: number | string;
  title: string;
  price: string | number;
  sku: string | null;
  barcode?: string | null;
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

export interface ShopifyCollectionInput {
  id: number | string;
  title: string;
  handle: string;
  updated_at?: string;
  productIds?: Array<number | string>;
}

/**
 * Normalizes Shopify IDs to standard GraphQL GIDs.
 */
export function normalizeShopifyGid(type: 'Product' | 'ProductVariant' | 'Collection', id: string | number): string {
  const strId = String(id);
  if (strId.startsWith('gid://shopify/')) {
    return strId;
  }
  return `gid://shopify/${type}/${strId}`;
}

/**
 * Syncs a Shopify collection and its product memberships.
 */
export async function syncCollectionSnapshot(shopId: string, collection: ShopifyCollectionInput) {
  const shopifyCollectionId = normalizeShopifyGid('Collection', collection.id);

  return prisma.$transaction(async (tx) => {
    const coll = await tx.collectionSnapshot.upsert({
      where: {
        shopId_shopifyCollectionId: {
          shopId,
          shopifyCollectionId,
        },
      },
      update: {
        title: collection.title,
        handle: collection.handle,
        sourceUpdatedAt: collection.updated_at ? new Date(collection.updated_at) : new Date(),
        syncedAt: new Date(),
      },
      create: {
        shopId,
        shopifyCollectionId,
        title: collection.title,
        handle: collection.handle,
        sourceUpdatedAt: collection.updated_at ? new Date(collection.updated_at) : new Date(),
        syncedAt: new Date(),
      },
    });

    if (collection.productIds) {
      const targetProductGids = collection.productIds.map((pid) => normalizeShopifyGid('Product', pid));

      // Remove memberships no longer present
      await tx.collectionProductMembership.deleteMany({
        where: {
          collectionId: coll.id,
          shopifyProductId: { notIn: targetProductGids },
        },
      });

      // Upsert new memberships
      for (const prodGid of targetProductGids) {
        await tx.collectionProductMembership.upsert({
          where: {
            collectionId_shopifyProductId: {
              collectionId: coll.id,
              shopifyProductId: prodGid,
            },
          },
          update: {},
          create: {
            collectionId: coll.id,
            shopifyProductId: prodGid,
          },
        });
      }
    }

    // Increment dataVersion for catalogs that source this collection
    await tx.catalog.updateMany({
      where: {
        shopId,
        sources: {
          some: {
            shopifyGid: shopifyCollectionId,
          },
        },
      },
      data: {
        dataVersion: { increment: 1 },
      },
    });

    return coll;
  });
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
      const priceDecimal = toDecimal(v.price || 0);

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
          shopifyPrice: priceDecimal,
          inventoryQuantity: v.inventory_quantity ?? 0,
          availableForSale: v.available ?? true,
          selectedOptionsJson: JSON.stringify(options),
          imageUrl: imageUrl,
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
          shopifyPrice: priceDecimal,
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
 * Handles product deletion by deleting local snapshot and cascading to variants and memberships.
 */
export async function deleteProductSnapshot(shopId: string, rawProductId: string | number) {
  const shopifyProductId = normalizeShopifyGid('Product', rawProductId);

  await prisma.$transaction(async (tx) => {
    // Delete memberships
    await tx.collectionProductMembership.deleteMany({
      where: {
        shopifyProductId,
        collection: { shopId },
      },
    });

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
 * Performs a complete initial product and collection sync from Shopify Admin GraphQL.
 */
export async function performInitialShopSync(shopId: string, customClient?: ShopifyAdminClient) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
  });

  if (!shop) {
    throw new Error('Shop not found');
  }

  const client = customClient || createShopifyClient(shop);

  const syncRun = await prisma.syncRun.create({
    data: {
      shopId,
      type: 'INITIAL',
      status: 'IN_PROGRESS',
      startedAt: new Date(),
    },
  });

  try {
    // 1. Fetch shop currency
    const shopQuery = `
      query {
        shop {
          currencyCode
        }
      }
    `;
    const shopData = await client.request<{ shop: { currencyCode: string } }>(shopQuery);
    if (shopData.shop?.currencyCode) {
      await prisma.shop.update({
        where: { id: shopId },
        data: { currency: shopData.shop.currencyCode },
      });
    }

    // 2. Fetch collections with product memberships
    const collectionsQuery = `
      query getCollections($cursor: String) {
        collections(first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              handle
              updatedAt
              products(first: 100) {
                edges {
                  node {
                    id
                  }
                }
              }
            }
          }
        }
      }
    `;

    let collCursor: string | null = null;
    let hasNextColl = true;
    let collectionsSynced = 0;

    while (hasNextColl) {
      const collRes: any = await client.request(collectionsQuery, { cursor: collCursor });
      const edges = collRes.collections?.edges || [];

      for (const edge of edges) {
        const node = edge.node;
        const productIds = (node.products?.edges || []).map((pe: any) => pe.node.id);
        await syncCollectionSnapshot(shopId, {
          id: node.id,
          title: node.title,
          handle: node.handle,
          updated_at: node.updatedAt,
          productIds,
        });
        collectionsSynced++;
      }

      hasNextColl = collRes.collections?.pageInfo?.hasNextPage || false;
      collCursor = collRes.collections?.pageInfo?.endCursor || null;
    }

    // 3. Fetch products and variants
    const productsQuery = `
      query getProducts($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              vendor
              handle
              status
              updatedAt
              images(first: 1) {
                edges {
                  node {
                    url
                  }
                }
              }
              options {
                name
                position
              }
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    sku
                    barcode
                    price
                    availableForSale
                    inventoryQuantity
                    selectedOptions {
                      name
                      value
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    let prodCursor: string | null = null;
    let hasNextProd = true;
    let productsSynced = 0;
    let variantsSynced = 0;

    while (hasNextProd) {
      const prodRes: any = await client.request(productsQuery, { cursor: prodCursor });
      const edges = prodRes.products?.edges || [];

      for (const edge of edges) {
        const node = edge.node;
        const imageUrl = node.images?.edges?.[0]?.node?.url || null;
        const variants = (node.variants?.edges || []).map((ve: any) => ({
          id: ve.node.id,
          product_id: node.id,
          title: ve.node.title,
          price: ve.node.price,
          sku: ve.node.sku,
          barcode: ve.node.barcode,
          inventory_quantity: ve.node.inventoryQuantity,
          available: ve.node.availableForSale,
        }));

        await syncProductSnapshot(shopId, {
          id: node.id,
          title: node.title,
          vendor: node.vendor,
          handle: node.handle,
          status: node.status,
          image: imageUrl ? { src: imageUrl } : null,
          options: node.options,
          variants,
          updated_at: node.updatedAt,
        });

        productsSynced++;
        variantsSynced += variants.length;
      }

      hasNextProd = prodRes.products?.pageInfo?.hasNextPage || false;
      prodCursor = prodRes.products?.pageInfo?.endCursor || null;
    }

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        statsJson: JSON.stringify({ collectionsSynced, productsSynced, variantsSynced }),
      },
    });

    return { collectionsSynced, productsSynced, variantsSynced };
  } catch (err: any) {
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        statsJson: JSON.stringify({ error: err.message }),
      },
    });
    throw err;
  }
}

/**
 * Generates the public catalog payload for buyer ordering with EXACT collection resolution.
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

  // Exact source resolution: Collect all product GIDs from explicit products and collections
  const allowedProductGids = new Set<string>();

  for (const source of catalog.sources) {
    if (source.type === CatalogSourceType.PRODUCT) {
      allowedProductGids.add(source.shopifyGid);
    } else if (source.type === CatalogSourceType.COLLECTION) {
      // Find collection snapshot for this shop
      const coll = await prisma.collectionSnapshot.findFirst({
        where: {
          shopId: catalog.shopId,
          shopifyCollectionId: source.shopifyGid,
        },
        include: {
          productMemberships: true,
        },
      });

      if (coll) {
        for (const membership of coll.productMemberships) {
          allowedProductGids.add(membership.shopifyProductId);
        }
      }
    }
  }

  // If no products match the sources, return empty products list
  if (allowedProductGids.size === 0) {
    return {
      catalog: {
        id: catalog.id,
        name: catalog.name,
        logoUrl: catalog.logoUrl,
        accentColor: catalog.accentColor || '#108043',
        showSku: catalog.showSku,
        showInventory: catalog.showInventory,
        priceMode: catalog.priceMode,
        discountPercent: catalog.discountPercent ? parseFloat(catalog.discountPercent.toFixed(2)) : 0,
      },
      shop: {
        shopDomain: catalog.shop.shopDomain,
        currency: catalog.shop.currency || 'USD',
      },
      products: [],
      totalProducts: 0,
      dataVersion: catalog.dataVersion,
    };
  }

  const productSnapshots = await prisma.productSnapshot.findMany({
    where: {
      shopId: catalog.shopId,
      shopifyProductId: { in: Array.from(allowedProductGids) },
      status: 'ACTIVE',
    },
    include: {
      variants: {
        orderBy: { shopifyPrice: 'asc' },
      },
    },
    orderBy: { title: 'asc' },
  });

  const currency = catalog.shop.currency || 'USD';

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

        const displayPriceDecimal = calculateDisplayPrice(
          v.shopifyPrice,
          catalog.priceMode,
          catalog.discountPercent
        );

        const basePriceNum = parseFloat(v.shopifyPrice.toFixed(2));
        const displayPriceNum = parseFloat(displayPriceDecimal.toFixed(2));

        return {
          id: v.id,
          shopifyVariantId: v.shopifyVariantId,
          title: v.title,
          sku: v.sku,
          basePrice: basePriceNum,
          displayPrice: displayPriceNum,
          formattedPrice: formatMoney(displayPriceDecimal, currency),
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
      discountPercent: catalog.discountPercent ? parseFloat(catalog.discountPercent.toFixed(2)) : 0,
    },
    shop: {
      shopDomain: catalog.shop.shopDomain,
      currency,
    },
    products,
    totalProducts: products.length,
    dataVersion: catalog.dataVersion,
  };
}
