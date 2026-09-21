import { prisma } from '../db.js';
import { calculateDisplayPrice, toDecimal, formatMoney, roundDecimal } from './pricing.server.js';
import { CatalogSourceType, CatalogStatus } from '../types/index.js';
import { ShopifyAdminClient, createShopifyClient } from './shopify-client.server.js';
import { Prisma } from '@prisma/client';

export interface ShopifyWebhookProductVariant {
  id: number | string;
  product_id: number | string;
  title: string;
  price: string | number;
  sku?: string | null;
  barcode?: string | null;
  inventory_quantity?: number;
  inventory_policy?: string;
  inventoryPolicy?: string;
  inventory_tracked?: boolean;
  inventoryTracked?: boolean;
  inventoryItem?: { tracked?: boolean };
  inventory_management?: string | null;
  available?: boolean;
  image_id?: number | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  selectedOptions?: Array<{ name: string; value: string }>;
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

      // Reconcile complete membership: remove products no longer present
      await tx.collectionProductMembership.deleteMany({
        where: {
          collectionId: coll.id,
          shopifyProductId: { notIn: targetProductGids },
        },
      });

      // Upsert full target membership set
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

    // Increment dataVersion for catalogs sourcing this collection
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
 * Deletes a collection snapshot and cascades memberships.
 */
export async function deleteCollectionSnapshot(shopId: string, rawCollectionId: string | number) {
  const shopifyCollectionId = normalizeShopifyGid('Collection', rawCollectionId);

  await prisma.$transaction(async (tx) => {
    const coll = await tx.collectionSnapshot.findFirst({
      where: { shopId, shopifyCollectionId },
    });

    if (coll) {
      await tx.collectionProductMembership.deleteMany({
        where: { collectionId: coll.id },
      });

      await tx.collectionSnapshot.delete({
        where: { id: coll.id },
      });
    }

    // Increment dataVersion for catalogs that sourced this deleted collection
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
  });
}

/**
 * Ingests or updates a product and its complete variant set into snapshot tables.
 *
 * IMPORTANT: Shopify REST webhooks cap variant payloads at 100 items.
 * For products with >=100 variants in the webhook payload, we MUST NOT prune
 * variants based on the possibly-truncated payload — doing so would delete
 * valid variants for large products.
 * Instead, we accept an optional `refetchFn` (used in production for GraphQL
 * re-fetch) to get the authoritative variant list before any destructive reconciliation.
 */
export async function syncProductSnapshot(
  shopId: string,
  product: ShopifyWebhookProduct,
  refetchFn?: (shopId: string, productGid: string) => Promise<ShopifyWebhookProductVariant[] | null>
) {
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

    // Determine authoritative variant list.
    // Shopify REST webhooks cap at 100 variants. If the payload has exactly 100 variants,
    // it may be truncated. We MUST NOT destructively prune based on a truncated list.
    // When a refetchFn is provided and variants >= 100, use it to get the full list.
    let incomingVariants = product.variants || [];
    const payloadMayBeTruncated = incomingVariants.length >= 100;

    if (payloadMayBeTruncated && refetchFn) {
      try {
        const refetched = await refetchFn(shopId, shopifyProductId);
        if (refetched && refetched.length > 0) {
          incomingVariants = refetched;
        }
        // If refetch returns null/empty, keep the webhook payload (best-effort)
      } catch {
        // Refetch failed — do NOT prune variants at all; skip the deleteMany below
        // by keeping the payloadMayBeTruncated flag true and incomingVariants as-is
      }
    }

    const incomingVariantGids = incomingVariants.map((v) => normalizeShopifyGid('ProductVariant', v.id));

    // Only prune variants if we have an authoritative (non-truncated) list.
    // When the payload is possibly truncated and no refetch was done, skip pruning
    // to avoid deleting valid variants from large products.
    if (!payloadMayBeTruncated || incomingVariants.length !== (product.variants || []).length) {
      await tx.variantSnapshot.deleteMany({
        where: {
          shopId,
          shopifyProductId,
          shopifyVariantId: {
            notIn: incomingVariantGids,
          },
        },
      });
    }

    // Upsert variant snapshots, strictly preserving selectedOptions
    for (const v of incomingVariants) {
      const shopifyVariantId = normalizeShopifyGid('ProductVariant', v.id);
      const priceDecimal = toDecimal(v.price || 0);

      let options: Array<{ name: string; value: string }> = [];

      // 1. Prefer explicit GraphQL selectedOptions if available
      if (v.selectedOptions && v.selectedOptions.length > 0) {
        options = v.selectedOptions;
      } else if (product.options) {
        // 2. Fallback to webhook option1/2/3 mapping
        if (v.option1 && product.options[0]) options.push({ name: product.options[0].name, value: v.option1 });
        if (v.option2 && product.options[1]) options.push({ name: product.options[1].name, value: v.option2 });
        if (v.option3 && product.options[2]) options.push({ name: product.options[2].name, value: v.option3 });
      }

      const inventoryPolicy = (v.inventoryPolicy || v.inventory_policy || 'DENY').toUpperCase();
      const inventoryTracked = v.inventoryTracked !== undefined
        ? Boolean(v.inventoryTracked)
        : v.inventory_tracked !== undefined
        ? Boolean(v.inventory_tracked)
        : v.inventoryItem?.tracked !== undefined
        ? Boolean(v.inventoryItem.tracked)
        : v.inventory_management !== null && v.inventory_management !== undefined && v.inventory_management !== '';

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
          inventoryPolicy,
          inventoryTracked,
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
          inventoryPolicy,
          inventoryTracked,
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
 * Completely paginates all product IDs for a collection.
 */
export async function fetchAllCollectionProductIds(
  client: ShopifyAdminClient,
  collectionGid: string,
  initialEdges: any[] = [],
  initialPageInfo?: { hasNextPage: boolean; endCursor: string | null }
): Promise<string[]> {
  const productGids = new Set<string>();

  for (const edge of initialEdges) {
    if (edge?.node?.id) {
      productGids.add(edge.node.id);
    }
  }

  let hasNextPage = initialPageInfo !== undefined ? initialPageInfo.hasNextPage : true;
  let cursor = initialPageInfo !== undefined ? initialPageInfo.endCursor : null;

  // If no initial pageInfo was provided, we must query from the beginning
  if (initialPageInfo === undefined) {
    hasNextPage = true;
    cursor = null;
  }

  const query = `
    query getCollectionProductsPage($collectionId: ID!, $cursor: String) {
      collection(id: $collectionId) {
        products(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
            }
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const res: any = await client.request(query, {
      collectionId: collectionGid,
      cursor,
    });

    const productsConn = res.collection?.products;
    const edges = productsConn?.edges || [];

    for (const edge of edges) {
      if (edge?.node?.id) {
        productGids.add(edge.node.id);
      }
    }

    hasNextPage = productsConn?.pageInfo?.hasNextPage || false;
    cursor = productsConn?.pageInfo?.endCursor || null;
  }

  return Array.from(productGids);
}

/**
 * Completely paginates all variants for a product.
 */
export async function fetchAllProductVariants(
  client: ShopifyAdminClient,
  productGid: string,
  initialEdges: any[] = [],
  initialPageInfo?: { hasNextPage: boolean; endCursor: string | null }
): Promise<ShopifyWebhookProductVariant[]> {
  const variantsMap = new Map<string, ShopifyWebhookProductVariant>();

  for (const edge of initialEdges) {
    if (edge?.node?.id) {
      const v = edge.node;
      variantsMap.set(v.id, {
        id: v.id,
        product_id: productGid,
        title: v.title,
        price: v.price,
        sku: v.sku,
        barcode: v.barcode,
        inventory_quantity: v.inventoryQuantity,
        available: v.availableForSale,
        selectedOptions: v.selectedOptions,
      });
    }
  }

  let hasNextPage = initialPageInfo !== undefined ? initialPageInfo.hasNextPage : true;
  let cursor = initialPageInfo !== undefined ? initialPageInfo.endCursor : null;

  // If no initial pageInfo was provided, we must query from the beginning
  if (initialPageInfo === undefined) {
    hasNextPage = true;
    cursor = null;
  }

  const query = `
    query getProductVariantsPage($productId: ID!, $cursor: String) {
      product(id: $productId) {
        variants(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              sku
              barcode
              price
              availableForSale
              inventoryQuantity
              inventoryPolicy
              inventoryItem {
                tracked
              }
              selectedOptions {
                name
                value
              }
            }
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const res: any = await client.request(query, {
      productId: productGid,
      cursor,
    });

    const variantsConn = res.product?.variants;
    const edges = variantsConn?.edges || [];

    for (const edge of edges) {
      if (edge?.node?.id) {
        const v = edge.node;
        variantsMap.set(v.id, {
          id: v.id,
          product_id: productGid,
          title: v.title,
          price: v.price,
          sku: v.sku,
          barcode: v.barcode,
          inventory_quantity: v.inventoryQuantity,
          inventory_policy: v.inventoryPolicy,
          inventory_tracked: v.inventoryItem?.tracked,
          available: v.availableForSale,
          selectedOptions: v.selectedOptions,
        });
      }
    }

    hasNextPage = variantsConn?.pageInfo?.hasNextPage || false;
    cursor = variantsConn?.pageInfo?.endCursor || null;
  }

  return Array.from(variantsMap.values());
}

/**
 * Fetches and syncs a single collection from Shopify Admin GraphQL (e.g. for collection webhooks).
 */
export async function syncSingleCollectionFromShopify(
  shopId: string,
  rawCollectionId: string | number,
  customClient?: ShopifyAdminClient
) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error('Shop not found');

  const client = customClient || createShopifyClient(shop);
  const collectionGid = normalizeShopifyGid('Collection', rawCollectionId);

  const query = `
    query getCollectionDetails($id: ID!) {
      collection(id: $id) {
        id
        title
        handle
        updatedAt
        products(first: 100) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
            }
          }
        }
      }
    }
  `;

  const res: any = await client.request(query, { id: collectionGid });
  const collNode = res.collection;

  if (!collNode) {
    // Collection was deleted on Shopify
    await deleteCollectionSnapshot(shopId, collectionGid);
    return null;
  }

  const initialEdges = collNode.products?.edges || [];
  const initialPageInfo = collNode.products?.pageInfo;

  const productIds = await fetchAllCollectionProductIds(
    client,
    collectionGid,
    initialEdges,
    initialPageInfo
  );

  return syncCollectionSnapshot(shopId, {
    id: collNode.id,
    title: collNode.title,
    handle: collNode.handle,
    updated_at: collNode.updatedAt,
    productIds,
  });
}

/**
 * Reconciles collection memberships for all collections sourced by active catalogs.
 * Used during product updates to prevent smart collections from being stale.
 */
export async function reconcileSourcedCollectionsForShop(
  shopId: string,
  customClient?: ShopifyAdminClient
) {
  const sourcedCollections = await prisma.catalogSource.findMany({
    where: {
      type: CatalogSourceType.COLLECTION,
      catalog: {
        shopId,
        status: CatalogStatus.PUBLISHED,
      },
    },
    select: {
      shopifyGid: true,
    },
    distinct: ['shopifyGid'],
  });

  for (const item of sourcedCollections) {
    try {
      await syncSingleCollectionFromShopify(shopId, item.shopifyGid, customClient);
    } catch (err) {
      // Non-blocking collection refresh
    }
  }
}

/**
 * Reconciles inventory level update from webhook or worker.
 * Queries Shopify GraphQL for authoritative variant availability and updates local snapshot transactionally.
 */
export async function syncInventoryLevelUpdate(
  shopId: string,
  payload: { inventoryItemId: string; available?: number; locationId?: string },
  customClient?: ShopifyAdminClient
) {
  if (!shopId || !payload?.inventoryItemId) {
    return null;
  }

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
  });
  if (!shop || shop.uninstalledAt !== null) {
    return null;
  }

  const client = customClient || createShopifyClient(shop);
  const inventoryItemGid = normalizeShopifyGid('InventoryItem' as any, payload.inventoryItemId);

  const query = `
    query getInventoryItemVariants($id: ID!) {
      inventoryItem(id: $id) {
        id
        tracked
        variants(first: 10) {
          nodes {
            id
            title
            availableForSale
            inventoryQuantity
            inventoryPolicy
            product {
              id
              status
            }
          }
        }
      }
    }
  `;

  let variantData: any = null;
  let tracked: boolean | undefined = undefined;

  try {
    const res: any = await client.request(query, { id: inventoryItemGid });
    if (res?.inventoryItem) {
      tracked = res.inventoryItem.tracked;
      const variantNodes = res.inventoryItem.variants?.nodes || (res.inventoryItem.variant ? [res.inventoryItem.variant] : []);
      variantData = variantNodes[0] || null;
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes('Not Found') || msg.includes('does not exist') || msg.includes('INVALID')) {
      return null;
    }
    throw err;
  }

  // If Shopify returned no variant, variant was deleted or unlinked on Shopify — safe no-op
  if (!variantData || !variantData.id) {
    return null;
  }

  const shopifyVariantId = variantData.id;
  const shopifyProductId = variantData.product?.id;
  const authoritativeQty = typeof variantData.inventoryQuantity === 'number'
    ? variantData.inventoryQuantity
    : (typeof payload.available === 'number' ? Math.max(0, payload.available) : 0);
  const availableForSale = typeof variantData.availableForSale === 'boolean'
    ? variantData.availableForSale
    : (authoritativeQty > 0);
  const inventoryPolicy = (variantData.inventoryPolicy || 'DENY').toUpperCase();

  return prisma.$transaction(async (tx) => {
    // Check if variant exists in local snapshot for this shop (enforce strict shop isolation)
    const existing = await tx.variantSnapshot.findUnique({
      where: {
        shopId_shopifyVariantId: {
          shopId,
          shopifyVariantId,
        },
      },
    });

    if (!existing) {
      // Variant not tracked locally for this shop — safe no-op
      return null;
    }

    const updated = await tx.variantSnapshot.update({
      where: {
        shopId_shopifyVariantId: {
          shopId,
          shopifyVariantId,
        },
      },
      data: {
        inventoryQuantity: authoritativeQty,
        availableForSale,
        inventoryPolicy,
        inventoryTracked: tracked !== undefined ? Boolean(tracked) : existing.inventoryTracked,
        sourceUpdatedAt: new Date(),
        syncedAt: new Date(),
      },
    });

    // Bump dataVersion for all catalogs in this shop sourcing this product
    const targetProdGid = shopifyProductId || existing.shopifyProductId;
    if (targetProdGid) {
      await tx.catalog.updateMany({
        where: {
          shopId,
          sources: {
            some: {
              shopifyGid: targetProdGid,
            },
          },
        },
        data: {
          dataVersion: { increment: 1 },
        },
      });
    }

    return updated;
  });
}

export interface SyncStats {
  collectionsSynced: number;
  productsSynced: number;
  variantsSynced: number;
}

/**
 * Reusable full-store sync engine. Performs data fetching and snapshot updates only.
 * Does not create or manage SyncRun records.
 */
export async function executeFullShopSync(
  shopId: string,
  customClient?: ShopifyAdminClient
): Promise<SyncStats> {
  const currentShop = await prisma.shop.findUnique({
    where: { id: shopId },
  });
  if (!currentShop || currentShop.uninstalledAt !== null) {
    return { collectionsSynced: 0, productsSynced: 0, variantsSynced: 0 };
  }

  const client = customClient || createShopifyClient(currentShop);

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

  // 2. Fetch collections with complete product pagination
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
              pageInfo {
                hasNextPage
                endCursor
              }
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
      const initialEdges = node.products?.edges || [];
      const initialPageInfo = node.products?.pageInfo;

      // Fully paginate product memberships for this collection
      const productIds = await fetchAllCollectionProductIds(
        client,
        node.id,
        initialEdges,
        initialPageInfo
      );

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

  // 3. Fetch products with complete variant pagination
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
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  title
                  sku
                  barcode
                  price
                  availableForSale
                  inventoryQuantity
                  inventoryPolicy
                  inventoryItem {
                    tracked
                  }
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
      const initialVariantEdges = node.variants?.edges || [];
      const initialVariantPageInfo = node.variants?.pageInfo;

      // Fully paginate all variants for this product
      const allVariants = await fetchAllProductVariants(
        client,
        node.id,
        initialVariantEdges,
        initialVariantPageInfo
      );

      await syncProductSnapshot(shopId, {
        id: node.id,
        title: node.title,
        vendor: node.vendor,
        handle: node.handle,
        status: node.status,
        image: imageUrl ? { src: imageUrl } : null,
        options: node.options,
        variants: allVariants,
        updated_at: node.updatedAt,
      });

      productsSynced++;
      variantsSynced += allVariants.length;
    }

    hasNextProd = prodRes.products?.pageInfo?.hasNextPage || false;
    prodCursor = prodRes.products?.pageInfo?.endCursor || null;
  }

  return { collectionsSynced, productsSynced, variantsSynced };
}

/**
 * Performs a complete initial product and collection sync from Shopify Admin GraphQL.
 * Creates an INITIAL SyncRun and sets initialSyncAt on completion.
 */
export async function performInitialShopSync(shopId: string, customClient?: ShopifyAdminClient): Promise<SyncStats> {
  const currentShop = await prisma.shop.findUnique({
    where: { id: shopId },
  });
  if (!currentShop || currentShop.uninstalledAt !== null) {
    return { collectionsSynced: 0, productsSynced: 0, variantsSynced: 0 };
  }

  let syncRun;
  try {
    syncRun = await prisma.syncRun.create({
      data: {
        shopId,
        type: 'INITIAL',
        status: 'IN_PROGRESS',
        startedAt: new Date(),
      },
    });
  } catch {
    return { collectionsSynced: 0, productsSynced: 0, variantsSynced: 0 };
  }

  try {
    const stats = await executeFullShopSync(shopId, customClient);

    try {
      const runExists = await prisma.syncRun.findUnique({ where: { id: syncRun.id } });
      if (runExists) {
        await prisma.$transaction([
          prisma.syncRun.update({
            where: { id: syncRun.id },
            data: {
              status: 'COMPLETED',
              finishedAt: new Date(),
              statsJson: JSON.stringify(stats),
            },
          }),
          prisma.shop.update({
            where: { id: shopId },
            data: {
              initialSyncAt: new Date(),
            },
          }),
        ]);
      }
    } catch {
      // Record may have been deleted by cascade on shop deletion
    }

    return stats;
  } catch (err: any) {
    try {
      const existingRun = await prisma.syncRun.findUnique({ where: { id: syncRun.id } });
      if (existingRun) {
        await prisma.syncRun.update({
          where: { id: syncRun.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            statsJson: JSON.stringify({ error: err.message }),
          },
        });
      }
    } catch {
      // Record may have been deleted by cascade on shop deletion
    }
    throw err;
  }
}

// In-process deduplication map for active initial sync runs per shop
const activeInitialSyncs = new Map<string, Promise<any>>();

/**
 * Centralized lifecycle helper for initial shop sync.
 * - if initialSyncAt exists -> do nothing
 * - if an INITIAL SyncRun is already IN_PROGRESS -> do not start another
 * - if previous sync FAILED -> allow retry
 * - new shop -> run once
 * - reinstalled shop -> reset initialSyncAt to null and run once
 */
export async function ensureInitialShopSync(shopId: string, customClient?: ShopifyAdminClient) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
  });

  if (!shop || shop.uninstalledAt !== null) {
    return null;
  }

  // 1. If initialSyncAt already exists, initial sync has succeeded -> do nothing
  if (shop.initialSyncAt) {
    return null;
  }

  // 2. If an INITIAL SyncRun is already actively running in this process -> deduplicate
  if (activeInitialSyncs.has(shopId)) {
    return activeInitialSyncs.get(shopId)!;
  }

  // 3. If an INITIAL SyncRun is already IN_PROGRESS in the database -> do not start another
  const inProgressRun = await prisma.syncRun.findFirst({
    where: {
      shopId,
      type: 'INITIAL',
      status: 'IN_PROGRESS',
    },
  });

  if (inProgressRun) {
    const elapsedMs = Date.now() - inProgressRun.startedAt.getTime();
    if (elapsedMs < 15 * 60 * 1000) {
      return null;
    }
  }

  // 4. Run initial sync (allows retry if previous was FAILED, or fresh run if new/reinstalled)
  const syncPromise = (async () => {
    try {
      return await performInitialShopSync(shopId, customClient);
    } finally {
      activeInitialSyncs.delete(shopId);
    }
  })();

  activeInitialSyncs.set(shopId, syncPromise);
  return syncPromise;
}

/**
 * Resolves the deterministic set of allowed product GIDs for a catalog based on its sources.
 */
export async function resolveCatalogAllowedProductGids(
  shopId: string,
  sources: Array<{ type: CatalogSourceType | string; shopifyGid: string }>
): Promise<Set<string>> {
  const allowedProductGids = new Set<string>();
  const collectionGids: string[] = [];

  for (const source of sources) {
    if (source.type === CatalogSourceType.PRODUCT) {
      allowedProductGids.add(source.shopifyGid);
    } else if (source.type === CatalogSourceType.COLLECTION) {
      collectionGids.push(source.shopifyGid);
    }
  }

  if (collectionGids.length > 0) {
    const collections = await prisma.collectionSnapshot.findMany({
      where: {
        shopId,
        shopifyCollectionId: { in: collectionGids },
      },
      include: {
        productMemberships: {
          select: { shopifyProductId: true },
        },
      },
    });

    for (const coll of collections) {
      for (const membership of coll.productMemberships) {
        allowedProductGids.add(membership.shopifyProductId);
      }
    }
  }

  return allowedProductGids;
}

export class SyncInProgressError extends Error {
  public statusCode: number = 409;
  public code: string = 'SYNC_IN_PROGRESS';
  constructor(message: string = 'A catalog sync is currently in progress for this store') {
    super(message);
    this.name = 'SyncInProgressError';
  }
}

/**
 * Concurrency-protected manual sync launcher.
 * Rejects overlapping clicks if a sync run is currently IN_PROGRESS (within 15 minute lock window).
 * Executes executeFullShopSync directly, creating exactly ONE SyncRun of type MANUAL.
 */
export async function triggerManualShopSync(
  shopId: string,
  customClient?: ShopifyAdminClient
): Promise<{ syncRunId: string; promise: Promise<SyncStats> }> {
  const activeSync = await prisma.syncRun.findFirst({
    where: {
      shopId,
      status: 'IN_PROGRESS',
    },
  });

  if (activeSync) {
    const elapsedMs = Date.now() - activeSync.startedAt.getTime();
    if (elapsedMs < 15 * 60 * 1000) {
      throw new SyncInProgressError('A catalog sync is currently in progress for this store');
    }
    await prisma.syncRun.update({
      where: { id: activeSync.id },
      data: { status: 'FAILED', finishedAt: new Date() },
    });
  }

  const syncRun = await prisma.syncRun.create({
    data: {
      shopId,
      type: 'MANUAL',
      status: 'IN_PROGRESS',
      startedAt: new Date(),
    },
  });

  // Execute full sync directly under the single MANUAL SyncRun
  const syncPromise = (async () => {
    try {
      const stats = await executeFullShopSync(shopId, customClient);
      try {
        const runExists = await prisma.syncRun.findUnique({ where: { id: syncRun.id } });
        if (runExists) {
          await prisma.syncRun.update({
            where: { id: syncRun.id },
            data: {
              status: 'COMPLETED',
              finishedAt: new Date(),
              statsJson: JSON.stringify(stats),
            },
          });
        }
      } catch {
        // Record may have been deleted by cascade or test cleanup
      }
      return stats;
    } catch (err: any) {
      try {
        const runExists = await prisma.syncRun.findUnique({ where: { id: syncRun.id } });
        if (runExists) {
          await prisma.syncRun.update({
            where: { id: syncRun.id },
            data: {
              status: 'FAILED',
              finishedAt: new Date(),
              statsJson: JSON.stringify({ error: err.message }),
            },
          });
        }
      } catch {
        // Record may have been deleted by cascade or test cleanup
      }
      return null;
    }
  })();

  return { syncRunId: syncRun.id, promise: syncPromise as Promise<SyncStats> };
}

/**
 * Ingests a public catalog snapshot and transforms into buyer DTO.
 * Supports all inventory modes, variant-level enables, qty rules, custom prices.
 */
export async function getPublicCatalogPayload(publicToken: string) {
  const catalog = await prisma.catalog.findUnique({
    where: { publicToken },
    include: {
      shop: true,
      sources: true,
      variantConfigs: true,
    },
  });

  if (!catalog || catalog.status !== CatalogStatus.PUBLISHED || catalog.shop.uninstalledAt !== null) {
    return null;
  }

  return _buildCatalogPayload(catalog);
}

/**
 * Resolves an OrderLink token → catalog payload (for link-based buyer URLs).
 */
export async function getPublicCatalogPayloadByLinkToken(linkToken: string) {
  const link = await prisma.orderLink.findUnique({
    where: { token: linkToken },
    include: {
      catalog: {
        include: {
          shop: true,
          sources: true,
          variantConfigs: true,
        },
      },
    },
  });

  if (!link || !link.active) return null;
  if (link.expiresAt && new Date() > link.expiresAt) return null;

  const { catalog } = link;
  if (catalog.status !== CatalogStatus.PUBLISHED || catalog.shop.uninstalledAt !== null) {
    return null;
  }

  const payload = await _buildCatalogPayload(catalog);
  if (!payload) return null;

  return {
    ...payload,
    orderLink: {
      id: link.id,
      token: link.token,
      label: link.label,
      requiresPasscode: !!link.passcodeHash,
      source: link.source,
      expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
    },
  };
}

/**
 * Shared internal builder for catalog → buyer DTO.
 * Applies: inventory mode, variant config (enable/disable, custom price, qty rules).
 */
async function _buildCatalogPayload(
  catalog: Awaited<ReturnType<typeof prisma.catalog.findUnique>> & {
    shop: { shopDomain: string; currency: string; uninstalledAt: Date | null };
    sources: Array<{ type: string; shopifyGid: string }>;
    variantConfigs: Array<{
      shopifyVariantId: string;
      enabled: boolean;
      customPrice: any;
      minQty: number | null;
      maxQty: number | null;
      qtyIncrement: number | null;
    }>;
  }
) {
  if (!catalog) return null;

  // Exact source resolution: Collect all product GIDs from explicit products and collections
  const allowedProductGids = await resolveCatalogAllowedProductGids(catalog.shopId, catalog.sources);

  // Build variant config map
  const variantConfigMap = new Map(
    catalog.variantConfigs.map((vc) => [vc.shopifyVariantId, vc])
  );

  // Parse buyer form config
  let buyerFormConfig: Record<string, boolean> = {};
  try {
    buyerFormConfig = JSON.parse((catalog as any).buyerFormConfig || '{}');
  } catch {
    buyerFormConfig = {};
  }

  const inventoryMode: string = (catalog as any).inventoryMode || 'STATUS_ONLY';
  const inventoryCap: number | null = (catalog as any).inventoryCap ?? null;
  const catalogMinQty: number = (catalog as any).minQty ?? 1;
  const catalogMaxQty: number | null = (catalog as any).maxQty ?? null;
  const catalogQtyIncrement: number = (catalog as any).qtyIncrement ?? 1;
  const customPriceAmount = (catalog as any).customPriceAmount ?? null;

  const catalogSection = {
    id: catalog.id,
    name: catalog.name,
    logoUrl: catalog.logoUrl,
    accentColor: catalog.accentColor || '#108043',
    showSku: catalog.showSku,
    showInventory: catalog.showInventory,
    inventoryMode,
    inventoryCap,
    priceMode: catalog.priceMode,
    discountPercent: catalog.discountPercent ? parseFloat(catalog.discountPercent.toFixed(2)) : 0,
    customPriceAmount: customPriceAmount ? parseFloat(Number(customPriceAmount).toFixed(2)) : null,
    minQty: catalogMinQty,
    maxQty: catalogMaxQty,
    qtyIncrement: catalogQtyIncrement,
    buyerFormConfig,
  };

  // If no products match the sources, return empty products list
  if (allowedProductGids.size === 0) {
    return {
      catalog: catalogSection,
      shop: {
        id: catalog.shopId,
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
    // Filter to only enabled variants for this product
    const enabledVariants = p.variants.filter((v) => {
      const vcfg = variantConfigMap.get(v.shopifyVariantId);
      // Default enabled if no config exists
      return vcfg ? vcfg.enabled : true;
    });

    const mappedVariants = enabledVariants.map((v) => {
      const vcfg = variantConfigMap.get(v.shopifyVariantId);

      let selectedOptions: Array<{ name: string; value: string }> = [];
      try {
        selectedOptions = JSON.parse(v.selectedOptionsJson);
      } catch {
        selectedOptions = [];
      }

      // Pricing: custom per-variant price > catalog custom price > percent discount > shopify price
      let displayPriceDecimal: ReturnType<typeof calculateDisplayPrice>;
      if (vcfg?.customPrice) {
        displayPriceDecimal = roundDecimal(vcfg.customPrice);
      } else if (catalog.priceMode === 'CUSTOM_PRICE' && customPriceAmount) {
        displayPriceDecimal = roundDecimal(customPriceAmount);
      } else {
        displayPriceDecimal = calculateDisplayPrice(
          v.shopifyPrice,
          catalog.priceMode,
          catalog.discountPercent
        );
      }

      const basePriceNum = parseFloat(v.shopifyPrice.toFixed(2));
      const displayPriceNum = parseFloat(displayPriceDecimal.toFixed(2));

      // Inventory display logic by mode
      const inventoryTracked = v.inventoryTracked;
      const inventoryPolicy = v.inventoryPolicy || 'DENY';
      let effectiveAvailable: number | null = null;
      let isAvailable = v.availableForSale;

      if (!inventoryTracked || inventoryPolicy === 'CONTINUE') {
        effectiveAvailable = null;
        isAvailable = true;
      } else {
        effectiveAvailable = Math.max(0, v.inventoryQuantity);
        isAvailable = v.availableForSale && effectiveAvailable > 0;
      }

      // Inventory qty to expose based on inventoryMode
      let exposedQty: number | null | undefined = undefined;
      let exposedEffective: number | null | undefined = undefined;

      if (inventoryMode === 'EXACT' || (catalog.showInventory && inventoryMode !== 'HIDDEN' && inventoryMode !== 'CAPPED')) {
        exposedQty = v.inventoryQuantity;
        exposedEffective = effectiveAvailable;
      } else if (inventoryMode === 'CAPPED' && inventoryCap !== null) {
        exposedQty = effectiveAvailable !== null ? Math.min(effectiveAvailable, inventoryCap) : null;
        exposedEffective = exposedQty;
      } else {
        // STATUS_ONLY or HIDDEN: never expose exact qty
        exposedQty = undefined;
        exposedEffective = undefined;
      }

      // Quantity rules: variant override → catalog default
      const variantMinQty = vcfg?.minQty ?? catalogMinQty;
      const variantMaxQty = vcfg?.maxQty ?? catalogMaxQty;
      const variantQtyIncrement = vcfg?.qtyIncrement ?? catalogQtyIncrement;

      return {
        id: v.id,
        shopifyVariantId: v.shopifyVariantId,
        title: v.title,
        sku: v.sku,
        basePrice: basePriceNum,
        displayPrice: displayPriceNum,
        formattedPrice: formatMoney(displayPriceDecimal, currency),
        availableForSale: isAvailable,
        inventoryQuantity: exposedQty,
        effectiveAvailable: exposedEffective,
        inventoryPolicy,
        inventoryTracked,
        selectedOptions,
        imageUrl: v.imageUrl || p.imageUrl,
        minQty: variantMinQty,
        maxQty: variantMaxQty,
        qtyIncrement: variantQtyIncrement,
      };
    });

    // Only include product if it has at least one enabled variant
    if (mappedVariants.length === 0) return null;

    return {
      id: p.id,
      shopifyProductId: p.shopifyProductId,
      title: p.title,
      vendor: p.vendor,
      handle: p.handle,
      imageUrl: p.imageUrl,
      variants: mappedVariants,
    };
  }).filter(Boolean);

  return {
    catalog: catalogSection,
    shop: {
      id: catalog.shopId,
      shopDomain: catalog.shop.shopDomain,
      currency,
    },
    products,
    totalProducts: products.length,
    dataVersion: catalog.dataVersion,
  };
}
