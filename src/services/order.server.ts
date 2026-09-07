import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import { BuyerSubmitOrderSchema, BuyerSubmitOrderInput, CatalogStatus } from '../types/index.js';
import { calculateDisplayPrice, toDecimal, formatMoney } from './pricing.server.js';
import { checkShopQuota } from './shop.server.js';
import { hashIdempotencyKey } from './auth.server.js';
import { ShopifyAdminClient } from './shopify-client.server.js';

export class OrderSubmissionError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public code?: string,
    public details?: any
  ) {
    super(message);
    this.name = 'OrderSubmissionError';
  }
}

export interface ChangedLineItem {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  reason: 'PRICE_CHANGED' | 'OUT_OF_STOCK' | 'DELETED';
  oldPrice?: number;
  newPrice?: number;
  available?: boolean;
}

export class CatalogDataChangedError extends Error {
  public statusCode: number = 409;
  public code: string = 'CATALOG_CHANGED';

  constructor(message: string, public changedLines: ChangedLineItem[]) {
    super(message);
    this.name = 'CatalogDataChangedError';
  }
}

export interface OrderSubmissionResult {
  success: boolean;
  submissionId: string;
  referenceNumber: string;
  draftOrderId: string;
  draftOrderName: string;
  subtotalAmount: number;
  currency: string;
  isDuplicate?: boolean;
}

/**
 * Submits a validated buyer order, revalidates items against Shopify live data,
 * and creates a native Shopify Draft Order.
 * Fully idempotent per catalog and idempotency key.
 */
export async function submitBuyerOrder(
  publicToken: string,
  idempotencyKey: string,
  input: BuyerSubmitOrderInput,
  customClient?: ShopifyAdminClient
): Promise<OrderSubmissionResult> {
  const validated = BuyerSubmitOrderSchema.parse(input);

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new OrderSubmissionError('Idempotency-Key header is required for order submission', 400, 'INVALID_INPUT');
  }
  if (idempotencyKey.length > 128) {
    throw new OrderSubmissionError('Idempotency-Key header exceeds maximum length', 400, 'INVALID_INPUT');
  }

  // 1. Fetch Catalog & Shop
  const catalog = await prisma.catalog.findUnique({
    where: { publicToken },
    include: { shop: true },
  });

  if (!catalog || catalog.status !== CatalogStatus.PUBLISHED || catalog.shop.uninstalledAt !== null) {
    throw new OrderSubmissionError('Catalog not found, unpublished, or unavailable', 404, 'CATALOG_NOT_FOUND');
  }

  // 2. Check Monthly Quota
  const quota = await checkShopQuota(catalog.shopId);
  if (!quota.allowed.canAcceptSubmission) {
    throw new OrderSubmissionError(
      'Merchant order submission limit reached for their current plan. Please contact the merchant.',
      403,
      'QUOTA_EXCEEDED'
    );
  }

  // 3. Idempotency Check
  const keyHash = hashIdempotencyKey(catalog.id, idempotencyKey.trim());
  const existingSubmission = await prisma.orderSubmission.findUnique({
    where: {
      catalogId_idempotencyKeyHash: {
        catalogId: catalog.id,
        idempotencyKeyHash: keyHash,
      },
    },
  });

  if (existingSubmission) {
    return {
      success: true,
      submissionId: existingSubmission.id,
      referenceNumber: existingSubmission.draftOrderName || `REF-${existingSubmission.id.substring(0, 8).toUpperCase()}`,
      draftOrderId: existingSubmission.draftOrderId,
      draftOrderName: existingSubmission.draftOrderName || '',
      subtotalAmount: Number(existingSubmission.subtotalAmount),
      currency: existingSubmission.currency,
      isDuplicate: true,
    };
  }

  // 4. Live Revalidation against Shopify
  const client = customClient || new ShopifyAdminClient({
    shopDomain: catalog.shop.shopDomain,
    shopId: catalog.shopId,
  });

  const variantGids = validated.lines.map((l) => l.variantId);

  // Fetch local snapshots for comparison
  const localSnapshots = await prisma.variantSnapshot.findMany({
    where: {
      shopId: catalog.shopId,
      shopifyVariantId: { in: variantGids },
    },
    include: { product: true },
  });
  const localSnapshotMap = new Map(localSnapshots.map((s) => [s.shopifyVariantId, s]));

  // Live GraphQL query for current variants
  const liveVariantsQuery = `
    query getVariantsByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          price
          availableForSale
          inventoryQuantity
          product {
            id
            title
            status
          }
        }
      }
    }
  `;

  let liveNodes: any[] = [];
  try {
    const res: any = await client.request(liveVariantsQuery, { ids: variantGids });
    liveNodes = res.nodes || [];
  } catch (liveQueryErr: any) {
    // If Shopify query fails, surface error cleanly
    throw new OrderSubmissionError(
      `Failed to verify current product inventory with Shopify: ${liveQueryErr.message}`,
      502
    );
  }

  const liveVariantMap = new Map<string, any>();
  for (const node of liveNodes) {
    if (node && node.id) {
      liveVariantMap.set(node.id, node);
    }
  }

  const changedLines: ChangedLineItem[] = [];
  let totalItems = 0;
  let subtotalDecimal = new Prisma.Decimal('0.00');

  for (const line of validated.lines) {
    const liveVariant = liveVariantMap.get(line.variantId);
    const localSnapshot = localSnapshotMap.get(line.variantId);

    // Check Deleted
    if (!liveVariant) {
      changedLines.push({
        variantId: line.variantId,
        productTitle: localSnapshot?.product.title || 'Product',
        variantTitle: localSnapshot?.title || line.variantId,
        reason: 'DELETED',
      });
      continue;
    }

    // Check Out of Stock / Unavailable
    if (!liveVariant.availableForSale || liveVariant.product?.status !== 'ACTIVE') {
      changedLines.push({
        variantId: line.variantId,
        productTitle: liveVariant.product?.title || localSnapshot?.product.title || 'Product',
        variantTitle: liveVariant.title,
        reason: 'OUT_OF_STOCK',
        available: false,
      });
      continue;
    }

    // Calculate live price
    const liveWholesalePrice = calculateDisplayPrice(
      liveVariant.price,
      catalog.priceMode,
      catalog.discountPercent
    );

    // If local snapshot price exists and differs from live wholesale price
    if (localSnapshot) {
      const localWholesalePrice = calculateDisplayPrice(
        localSnapshot.shopifyPrice,
        catalog.priceMode,
        catalog.discountPercent
      );
      if (!localWholesalePrice.equals(liveWholesalePrice)) {
        changedLines.push({
          variantId: line.variantId,
          productTitle: liveVariant.product?.title || localSnapshot.product.title,
          variantTitle: liveVariant.title,
          reason: 'PRICE_CHANGED',
          oldPrice: Number(localWholesalePrice),
          newPrice: Number(liveWholesalePrice),
        });
        continue;
      }
    }

    totalItems += line.quantity;
    subtotalDecimal = subtotalDecimal.plus(liveWholesalePrice.times(line.quantity));
  }

  // If any line changed, abort and return 409
  if (changedLines.length > 0) {
    throw new CatalogDataChangedError(
      'Some product prices or inventory availability changed since this catalog was loaded. Please review updated lines.',
      changedLines
    );
  }

  // 5. Build Shopify draftOrderCreate Mutation
  const hasDiscount =
    catalog.priceMode === 'PERCENT_DISCOUNT' &&
    catalog.discountPercent !== null &&
    Number(catalog.discountPercent) > 0;

  const lineItemsInput = validated.lines.map((l) => {
    const item: any = {
      variantId: l.variantId,
      quantity: l.quantity,
    };
    if (hasDiscount) {
      item.appliedDiscount = {
        value: Number(catalog.discountPercent),
        valueType: 'PERCENTAGE',
        title: `${Number(catalog.discountPercent)}% B2B Catalog Discount`,
      };
    }
    return item;
  });

  const noteAttributes = [
    { name: 'Business Name', value: validated.buyer.businessName },
    { name: 'Catalog', value: catalog.name },
    { name: 'CatalogFlow Public Token', value: publicToken },
  ];
  if (validated.buyer.poNumber) {
    noteAttributes.push({ name: 'PO Number', value: validated.buyer.poNumber });
  }

  let noteBody = `[B2B Catalog Order]\nBusiness: ${validated.buyer.businessName}`;
  if (validated.buyer.poNumber) {
    noteBody += `\nPO Number: ${validated.buyer.poNumber}`;
  }
  if (validated.buyer.note) {
    noteBody += `\nBuyer Notes: ${validated.buyer.note}`;
  }

  const draftOrderInput: any = {
    email: validated.buyer.email,
    note: noteBody,
    tags: ['B2B-Catalog', 'CatalogFlow', catalog.name],
    customAttributes: noteAttributes,
    lineItems: lineItemsInput,
    useCustomerDefaultAddress: false,
  };

  if (validated.buyer.poNumber) {
    draftOrderInput.poNumber = validated.buyer.poNumber;
  }

  const draftOrderMutation = `
    mutation createDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
          totalPrice
          currencyCode
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const draftRes: any = await client.request(draftOrderMutation, { input: draftOrderInput });

  if (draftRes.draftOrderCreate?.userErrors?.length > 0) {
    const errMessages = draftRes.draftOrderCreate.userErrors.map((e: any) => e.message).join('; ');
    throw new OrderSubmissionError(`Shopify Draft Order creation rejected: ${errMessages}`, 422);
  }

  const createdDraft = draftRes.draftOrderCreate?.draftOrder;
  if (!createdDraft || !createdDraft.id) {
    throw new OrderSubmissionError('Shopify Draft Order creation returned invalid response', 502);
  }

  const currency = catalog.shop.currency || createdDraft.currencyCode || 'USD';
  const subtotalNumber = parseFloat(subtotalDecimal.toFixed(2));

  // 6. Transactional Persistence of OrderSubmission & Quota Increment
  // Zero buyer PII stored in local database
  const [submission] = await prisma.$transaction([
    prisma.orderSubmission.create({
      data: {
        shopId: catalog.shopId,
        catalogId: catalog.id,
        draftOrderId: createdDraft.id,
        draftOrderName: createdDraft.name || null,
        idempotencyKeyHash: keyHash,
        itemCount: totalItems,
        lineCount: validated.lines.length,
        subtotalAmount: subtotalDecimal,
        currency,
      },
    }),
    prisma.shop.update({
      where: { id: catalog.shopId },
      data: {
        monthlySubmissionsCount: { increment: 1 },
      },
    }),
  ]);

  return {
    success: true,
    submissionId: submission.id,
    referenceNumber: createdDraft.name || `REF-${submission.id.substring(0, 8).toUpperCase()}`,
    draftOrderId: createdDraft.id,
    draftOrderName: createdDraft.name || '',
    subtotalAmount: subtotalNumber,
    currency,
  };
}

/**
 * Retrieves paginated submissions for the merchant admin operations view.
 * Scoped strictly to the authenticated shop.
 */
export async function getSubmissionsByShop(
  shopId: string,
  options?: {
    page?: number;
    pageSize?: number;
    catalogId?: string;
  }
) {
  const page = Math.max(1, options?.page || 1);
  const pageSize = Math.min(100, Math.max(1, options?.pageSize || 20));
  const skip = (page - 1) * pageSize;

  const whereClause: Prisma.OrderSubmissionWhereInput = {
    shopId,
    ...(options?.catalogId ? { catalogId: options.catalogId } : {}),
  };

  const [totalCount, submissions, shop] = await Promise.all([
    prisma.orderSubmission.count({ where: whereClause }),
    prisma.orderSubmission.findMany({
      where: whereClause,
      include: {
        catalog: {
          select: {
            id: true,
            name: true,
            publicToken: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.shop.findUnique({
      where: { id: shopId },
      select: { shopDomain: true },
    }),
  ]);

  const shopDomain = shop?.shopDomain || '';

  const formattedSubmissions = submissions.map((sub) => {
    // Extract numeric ID from Shopify GID gid://shopify/DraftOrder/12345
    const match = sub.draftOrderId.match(/\/DraftOrder\/(\d+)/);
    const numericId = match ? match[1] : '';
    const draftOrderUrl = numericId && shopDomain
      ? `https://${shopDomain}/admin/draft_orders/${numericId}`
      : '';

    return {
      id: sub.id,
      catalogId: sub.catalogId,
      catalogName: sub.catalog.name,
      catalogPublicToken: sub.catalog.publicToken,
      draftOrderId: sub.draftOrderId,
      draftOrderName: sub.draftOrderName,
      draftOrderUrl,
      itemCount: sub.itemCount,
      lineCount: sub.lineCount,
      subtotalAmount: Number(sub.subtotalAmount),
      formattedSubtotal: formatMoney(sub.subtotalAmount, sub.currency),
      currency: sub.currency,
      createdAt: sub.createdAt.toISOString(),
    };
  });

  return {
    submissions: formattedSubmissions,
    totalCount,
    page,
    pageSize,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}

/**
 * Returns comprehensive sync health and merchant dashboard summary metrics.
 */
export async function getSyncHealthSummary(shopId: string) {
  const [
    catalogsTotal,
    catalogsPublished,
    productsCount,
    variantsCount,
    collectionsCount,
    submissionsTotal,
    lastSyncRun,
    shop,
  ] = await Promise.all([
    prisma.catalog.count({ where: { shopId } }),
    prisma.catalog.count({ where: { shopId, status: CatalogStatus.PUBLISHED } }),
    prisma.productSnapshot.count({ where: { shopId } }),
    prisma.variantSnapshot.count({ where: { shopId } }),
    prisma.collectionSnapshot.count({ where: { shopId } }),
    prisma.orderSubmission.count({ where: { shopId } }),
    prisma.syncRun.findFirst({
      where: { shopId },
      orderBy: { startedAt: 'desc' },
    }),
    prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        shopDomain: true,
        plan: true,
        currency: true,
        monthlySubmissionsCount: true,
        initialSyncAt: true,
        installedAt: true,
      },
    }),
  ]);

  let syncStats = null;
  if (lastSyncRun?.statsJson) {
    try {
      syncStats = JSON.parse(lastSyncRun.statsJson);
    } catch {
      syncStats = null;
    }
  }

  return {
    shop: {
      shopDomain: shop?.shopDomain || '',
      plan: shop?.plan || 'STARTER',
      currency: shop?.currency || 'USD',
      monthlySubmissionsCount: shop?.monthlySubmissionsCount || 0,
      initialSyncAt: shop?.initialSyncAt ? shop.initialSyncAt.toISOString() : null,
      installedAt: shop?.installedAt ? shop.installedAt.toISOString() : null,
    },
    catalogs: {
      total: catalogsTotal,
      published: catalogsPublished,
      draft: catalogsTotal - catalogsPublished,
    },
    inventory: {
      productsCount,
      variantsCount,
      collectionsCount,
    },
    submissions: {
      total: submissionsTotal,
      monthly: shop?.monthlySubmissionsCount || 0,
    },
    sync: {
      status: lastSyncRun?.status || (shop?.initialSyncAt ? 'COMPLETED' : 'PENDING'),
      lastSyncAt: lastSyncRun?.finishedAt ? lastSyncRun.finishedAt.toISOString() : (shop?.initialSyncAt ? shop.initialSyncAt.toISOString() : null),
      lastSyncStats: syncStats,
    },
  };
}
