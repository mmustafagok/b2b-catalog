import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import { BuyerSubmitOrderSchema, BuyerSubmitOrderInput, CatalogStatus } from '../types/index.js';
import { calculateDisplayPrice, toDecimal, formatMoney } from './pricing.server.js';
import {
  reserveSubmissionQuotaSlot,
  releaseSubmissionQuotaSlot,
  releaseSubmissionQuotaReservation,
  releaseSubmissionQuotaSlotDirect,
  getActiveShopById,
} from './shop.server.js';
import { defaultBillingProvider } from './billing.server.js';
import { resolveCatalogAllowedProductGids } from './sync.server.js';
import { hashIdempotencyKey } from './auth.server.js';
import { ShopifyAdminClient, ShopifyGraphQLError } from './shopify-client.server.js';
import { recordAnalyticsEvent, ANALYTICS_EVENTS } from './analytics.server.js';

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

  constructor(message: string, public changedLines: ChangedLineItem[] = []) {
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
 * Submits a validated buyer order, enforces strict catalog authorization and dataVersion,
 * revalidates items against Shopify live data, and creates a native Shopify Draft Order.
 * Fully backed by an idempotency state machine and Shopify correlation reconciliation.
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
    include: {
      shop: true,
      sources: true,
    },
  });

  if (!catalog || catalog.status !== CatalogStatus.PUBLISHED || catalog.shop.uninstalledAt !== null) {
    throw new OrderSubmissionError('Catalog not found, unpublished, or unavailable', 404, 'CATALOG_NOT_FOUND');
  }

  // 2. Enforce dataVersion Boundary
  if (validated.dataVersion !== catalog.dataVersion) {
    throw new CatalogDataChangedError(
      'Catalog configuration has changed since it was loaded. Please refresh and review latest catalog details.',
      []
    );
  }

  // 3. Enforce Catalog Membership Authorization
  const allowedProductGids = await resolveCatalogAllowedProductGids(catalog.shopId, catalog.sources);
  const variantGids = validated.lines.map((l) => l.variantId);

  const localSnapshots = await prisma.variantSnapshot.findMany({
    where: {
      shopId: catalog.shopId,
      shopifyVariantId: { in: variantGids },
    },
    include: { product: true },
  });
  const localSnapshotMap = new Map(localSnapshots.map((s) => [s.shopifyVariantId, s]));

  const invalidVariants: string[] = [];
  for (const line of validated.lines) {
    const snap = localSnapshotMap.get(line.variantId);
    if (!snap || !allowedProductGids.has(snap.shopifyProductId) || snap.product.status !== 'ACTIVE') {
      invalidVariants.push(line.variantId);
    }
  }

  if (invalidVariants.length > 0) {
    throw new OrderSubmissionError(
      'One or more requested items are not available in this catalog.',
      422,
      'INVALID_LINES',
      { invalidVariants }
    );
  }

  const client = customClient || new ShopifyAdminClient({
    shopDomain: catalog.shop.shopDomain,
    shopId: catalog.shopId,
  });

  // 4. Idempotency State Machine & Pre-Shopify Reservation
  const keyHash = hashIdempotencyKey(catalog.id, idempotencyKey.trim());
  let submission = await prisma.orderSubmission.findUnique({
    where: {
      catalogId_idempotencyKeyHash: {
        catalogId: catalog.id,
        idempotencyKeyHash: keyHash,
      },
    },
  });

  let needsReconciliation = false;

  if (submission) {
    if (submission.status === 'COMPLETED') {
      return {
        success: true,
        submissionId: submission.id,
        referenceNumber: submission.draftOrderName || `REF-${submission.id.substring(0, 8).toUpperCase()}`,
        draftOrderId: submission.draftOrderId || '',
        draftOrderName: submission.draftOrderName || '',
        subtotalAmount: Number(submission.subtotalAmount),
        currency: submission.currency,
        isDuplicate: true,
      };
    }

    if (submission.status === 'CREATING') {
      const leaseStartedAt = submission.processingStartedAt;
      if (!leaseStartedAt) {
        // Missing processingStartedAt for legacy row: fail safe into reconciliation
        needsReconciliation = true;
      } else {
        const elapsedMs = Date.now() - leaseStartedAt.getTime();
        // Lock window: if currently processing within 60s, reject concurrent duplicates
        if (elapsedMs < 60000) {
          throw new OrderSubmissionError(
            'Order submission is currently being processed by another worker',
            409,
            'CONCURRENT_PROCESSING'
          );
        }
        // Stale attempt: ambiguous failure requiring reconciliation
        needsReconciliation = true;
      }
    } else if (submission.status === 'REQUIRES_RECONCILIATION') {
      needsReconciliation = true;
    } else if (submission.status === 'FAILED') {
      // Prior attempt failed before side effects and released its slot.
      // Must reconcile billing cycle and atomically reserve a new quota slot before transitioning back to CREATING.
      const entitlement = await defaultBillingProvider.getEntitlement(catalog.shopId);
      const slotReserved = await reserveSubmissionQuotaSlot(catalog.shopId, entitlement.limits.monthlySubmissionsLimit);
      if (!slotReserved) {
        throw new OrderSubmissionError(
          'Merchant order submission limit reached for their current plan. Please contact the merchant.',
          403,
          'QUOTA_EXCEEDED'
        );
      }
      const activeShop = await getActiveShopById(catalog.shopId);
      submission = await prisma.orderSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'CREATING',
          processingStartedAt: new Date(),
          quotaCycleAnchor: activeShop?.billingCycleAnchor || new Date(),
          quotaReserved: true,
          lastError: null,
        },
      });
    }
  } else {
    // 5. Concurrency-Safe Quota Slot Reservation via Centralized Entitlement Boundary
    const entitlement = await defaultBillingProvider.getEntitlement(catalog.shopId);
    const slotReserved = await reserveSubmissionQuotaSlot(catalog.shopId, entitlement.limits.monthlySubmissionsLimit);
    if (!slotReserved) {
      throw new OrderSubmissionError(
        'Merchant order submission limit reached for their current plan. Please contact the merchant.',
        403,
        'QUOTA_EXCEEDED'
      );
    }

    const activeShop = await getActiveShopById(catalog.shopId);
    const activeAnchor = activeShop?.billingCycleAnchor || new Date();

    // Persist unique reservation BEFORE calling Shopify
    try {
      submission = await prisma.orderSubmission.create({
        data: {
          shopId: catalog.shopId,
          catalogId: catalog.id,
          idempotencyKeyHash: keyHash,
          status: 'CREATING',
          processingStartedAt: new Date(),
          quotaCycleAnchor: activeAnchor,
          quotaReserved: true,
          currency: catalog.shop.currency || 'USD',
        },
      });
    } catch (insertErr: any) {
      await releaseSubmissionQuotaSlotDirect(catalog.shopId, activeAnchor);
      throw new OrderSubmissionError(
        'Order submission is currently being processed by another worker',
        409,
        'CONCURRENT_PROCESSING'
      );
    }
  }

  const correlationTag = `cf-sub:${submission.id}`;
  const correlationReference = `CatalogFlow-Submission:${submission.id}`;

  // 6. Shopify-Side Reconciliation for Ambiguous Retries
  if (needsReconciliation) {
    const findDraftQuery = `
      query findDraftOrderByTag($query: String!) {
        draftOrders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              totalPrice
              currencyCode
            }
          }
        }
      }
    `;

    try {
      const searchRes: any = await client.request(findDraftQuery, { query: `tag:${correlationTag}` });
      const edges = searchRes?.draftOrders?.edges || [];
      if (edges.length > 0 && edges[0]?.node?.id) {
        const foundDraft = edges[0].node;
        const subtotal = new Prisma.Decimal(foundDraft.totalPrice || '0.00');

        const updated = await prisma.orderSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'COMPLETED',
            draftOrderId: foundDraft.id,
            draftOrderName: foundDraft.name || null,
            correlationRef: correlationTag,
            subtotalAmount: subtotal,
            currency: foundDraft.currencyCode || catalog.shop.currency || 'USD',
            processingStartedAt: null,
            quotaReserved: true,
          },
        });

        // Record idempotent North Star event on reconciliation recovery
        await recordAnalyticsEvent(
          catalog.shopId,
          ANALYTICS_EVENTS.DRAFT_ORDER_CREATED,
          catalog.id,
          {
            submissionId: updated.id,
            subtotal: Number(updated.subtotalAmount),
            currency: updated.currency,
          },
          `draft_order_created:${updated.id}`
        );

        return {
          success: true,
          submissionId: updated.id,
          referenceNumber: updated.draftOrderName || `REF-${updated.id.substring(0, 8).toUpperCase()}`,
          draftOrderId: foundDraft.id,
          draftOrderName: foundDraft.name || '',
          subtotalAmount: Number(updated.subtotalAmount),
          currency: updated.currency,
          isDuplicate: true,
        };
      }

      // If edges.length === 0: Draft order not found in search yet!
      // REQUIRES_RECONCILIATION must NEVER automatically call draftOrderCreate!
      // Keep status REQUIRES_RECONCILIATION, keep quota slot reserved, throw RECONCILIATION_PENDING!
      throw new OrderSubmissionError(
        'We are still confirming the previous order attempt. Please retry shortly.',
        409,
        'RECONCILIATION_PENDING'
      );
    } catch (reconcileSearchErr: any) {
      if (reconcileSearchErr instanceof OrderSubmissionError) {
        throw reconcileSearchErr;
      }
      // If query fails, keep attempt in REQUIRES_RECONCILIATION and fail closed
      throw new OrderSubmissionError(
        'Unable to verify prior submission state with Shopify. Please retry in a moment.',
        502,
        'SHOPIFY_API_ERROR'
      );
    }
  }

  // 7. Live Variant Revalidation against Shopify
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
    await releaseSubmissionQuotaReservation(submission.id);
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: { status: 'FAILED', processingStartedAt: null, lastError: 'Live variant verification failed' },
    });
    throw new OrderSubmissionError(
      'Failed to verify current product inventory with Shopify. Please try again.',
      502,
      'SHOPIFY_API_ERROR'
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

    if (!liveVariant) {
      changedLines.push({
        variantId: line.variantId,
        productTitle: localSnapshot?.product.title || 'Product',
        variantTitle: localSnapshot?.title || line.variantId,
        reason: 'DELETED',
      });
      continue;
    }

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

    const liveWholesalePrice = calculateDisplayPrice(
      liveVariant.price,
      catalog.priceMode,
      catalog.discountPercent
    );

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

  if (changedLines.length > 0) {
    await releaseSubmissionQuotaReservation(submission.id);
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: { status: 'FAILED', processingStartedAt: null, lastError: 'Catalog data changed during submit' },
    });
    throw new CatalogDataChangedError(
      'Some product prices or inventory availability changed since this catalog was loaded. Please review updated lines.',
      changedLines
    );
  }

  // 8. Build Shopify draftOrderCreate Mutation
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

  // Strict privacy: No publicToken, no raw idempotency key
  const noteAttributes = [
    { name: 'Business Name', value: validated.buyer.businessName },
    { name: 'Catalog', value: catalog.name },
    { name: 'Catalog ID', value: catalog.id },
    { name: 'Submission Reference', value: correlationReference },
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
    tags: ['B2B-Catalog', 'CatalogFlow', catalog.name, correlationTag],
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

  await recordAnalyticsEvent(
    catalog.shopId,
    ANALYTICS_EVENTS.ORDER_SUBMITTED,
    catalog.id,
    {
      submissionId: submission.id,
      itemCount: totalItems,
      lineCount: validated.lines.length,
    },
    `order_submitted:${submission.id}`
  );

  let draftRes: any;
  try {
    draftRes = await client.request(draftOrderMutation, { input: draftOrderInput });
  } catch (mutationErr: any) {
    // Conclusive rejection: GraphQL userErrors returned by Shopify
    if (mutationErr instanceof ShopifyGraphQLError && mutationErr.userErrors && mutationErr.userErrors.length > 0) {
      await releaseSubmissionQuotaReservation(submission.id);
      await prisma.orderSubmission.update({
        where: { id: submission.id },
        data: { status: 'FAILED', processingStartedAt: null, lastError: 'Shopify rejected draft order creation' },
      });
      throw new OrderSubmissionError(
        'Shopify Draft Order creation was rejected. Please review order items.',
        422,
        'VALIDATION_FAILED'
      );
    }

    // Ambiguous failure: transport failure, timeout, ECONNRESET, HTTP 5xx, or socket disconnect.
    // The request may have reached Shopify and created the draft order before the connection was lost.
    // DO NOT release quota.
    // Mark submission as REQUIRES_RECONCILIATION and preserve correlationRef for subsequent tag-based reconciliation.
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'REQUIRES_RECONCILIATION',
        processingStartedAt: null,
        correlationRef: correlationTag,
        lastError: 'Ambiguous transport failure during draft order creation',
      },
    });
    throw new OrderSubmissionError(
      'Draft order creation encountered a network error or timeout. Please retry to confirm order status.',
      502,
      'SHOPIFY_API_ERROR'
    );
  }

  if (draftRes.draftOrderCreate?.userErrors?.length > 0) {
    await releaseSubmissionQuotaReservation(submission.id);
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: { status: 'FAILED', processingStartedAt: null, lastError: 'Shopify rejected draft order creation' },
    });
    throw new OrderSubmissionError(
      'Shopify Draft Order creation was rejected. Please review order items.',
      422,
      'VALIDATION_FAILED'
    );
  }

  const createdDraft = draftRes.draftOrderCreate?.draftOrder;
  if (!createdDraft || !createdDraft.id) {
    // Ambiguous response: response was received without userErrors but missing draftOrder id
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'REQUIRES_RECONCILIATION',
        processingStartedAt: null,
        correlationRef: correlationTag,
        lastError: 'Shopify returned ambiguous response without draft order id',
      },
    });
    throw new OrderSubmissionError('Shopify Draft Order creation returned an invalid response', 502, 'SHOPIFY_API_ERROR');
  }

  const currency = catalog.shop.currency || createdDraft.currencyCode || 'USD';
  const subtotalNumber = parseFloat(subtotalDecimal.toFixed(2));

  // 9. Mark Submission COMPLETED
  // If local DB fails here, mark status as REQUIRES_RECONCILIATION so retry recovers draft order without duplicate creation
  try {
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'COMPLETED',
        draftOrderId: createdDraft.id,
        draftOrderName: createdDraft.name || null,
        correlationRef: correlationTag,
        itemCount: totalItems,
        lineCount: validated.lines.length,
        subtotalAmount: subtotalDecimal,
        currency,
        processingStartedAt: null,
        quotaReserved: true,
      },
    });
  } catch (postMutationDbErr: any) {
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'REQUIRES_RECONCILIATION',
        draftOrderId: createdDraft.id,
        draftOrderName: createdDraft.name || null,
        correlationRef: correlationTag,
        processingStartedAt: null,
      },
    }).catch(() => {});
    throw postMutationDbErr;
  }

  await recordAnalyticsEvent(
    catalog.shopId,
    ANALYTICS_EVENTS.DRAFT_ORDER_CREATED,
    catalog.id,
    {
      submissionId: submission.id,
      draftOrderId: createdDraft.id,
      subtotal: subtotalNumber,
      itemCount: totalItems,
      currency,
    },
    `draft_order_created:${submission.id}`
  );

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
    status?: string;
  }
) {
  const page = Math.max(1, options?.page || 1);
  const pageSize = Math.min(100, Math.max(1, options?.pageSize || 20));
  const skip = (page - 1) * pageSize;

  const statusFilter = options?.status && options.status !== 'ALL'
    ? options.status
    : options?.status === 'ALL'
      ? undefined
      : 'COMPLETED';

  const whereClause: Prisma.OrderSubmissionWhereInput = {
    shopId,
    ...(statusFilter ? { status: statusFilter } : {}),
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
    const match = sub.draftOrderId ? sub.draftOrderId.match(/\/DraftOrder\/(\d+)/) : null;
    const numericId = match ? match[1] : '';
    const draftOrderUrl = numericId && shopDomain
      ? `https://${shopDomain}/admin/draft_orders/${numericId}`
      : '';

    return {
      id: sub.id,
      catalogId: sub.catalogId,
      catalogName: sub.catalog.name,
      catalogPublicToken: sub.catalog.publicToken,
      status: sub.status,
      lastError: sub.lastError,
      draftOrderId: sub.draftOrderId || '',
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
    prisma.orderSubmission.count({ where: { shopId, status: 'COMPLETED' } }),
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

/**
 * Merchant-initiated submission reconciliation (M9.7).
 * Checks Shopify for existing Draft Order by deterministic correlation tag (cf-sub:<submissionId>).
 * If found: marks COMPLETED and records North Star analytics event.
 * If not found: leaves status as REQUIRES_RECONCILIATION.
 * INVARIANT: NEVER calls draftOrderCreate or creates duplicate orders.
 */
export async function reconcileSubmission(
  shopId: string,
  submissionId: string,
  customClient?: ShopifyAdminClient
) {
  const submission = await prisma.orderSubmission.findFirst({
    where: { id: submissionId, shopId },
    include: {
      catalog: {
        include: { shop: true },
      },
    },
  });

  if (!submission) {
    throw new OrderSubmissionError('Submission not found or unauthorized', 404, 'NOT_FOUND');
  }

  if (submission.status === 'COMPLETED') {
    return {
      reconciled: true,
      status: 'COMPLETED',
      draftOrderId: submission.draftOrderId,
      draftOrderName: submission.draftOrderName,
      message: 'Submission is already completed.',
    };
  }

  if (submission.status !== 'REQUIRES_RECONCILIATION') {
    throw new OrderSubmissionError(
      `Cannot reconcile submission with status: ${submission.status}`,
      400,
      'INVALID_STATUS'
    );
  }

  const shop = submission.catalog.shop;
  const client = customClient || new ShopifyAdminClient({ shopId: shop.id, shopDomain: shop.shopDomain });
  const correlationTag = `cf-sub:${submission.id}`;

  const findDraftQuery = `
    query findDraftOrderByCorrelationTag($query: String!) {
      draftOrders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            totalPrice
            currencyCode
          }
        }
      }
    }
  `;

  const searchRes: any = await client.request(findDraftQuery, { query: `tag:${correlationTag}` });
  const edges = searchRes?.draftOrders?.edges || [];

  if (edges.length > 0 && edges[0]?.node?.id) {
    const foundDraft = edges[0].node;
    const subtotal = new Prisma.Decimal(foundDraft.totalPrice || '0.00');

    const updated = await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'COMPLETED',
        draftOrderId: foundDraft.id,
        draftOrderName: foundDraft.name || null,
        correlationRef: correlationTag,
        subtotalAmount: subtotal,
        currency: foundDraft.currencyCode || shop.currency || 'USD',
        processingStartedAt: null,
        quotaReserved: true,
        lastError: null,
      },
    });

    // Record idempotent North Star event on reconciliation recovery
    await recordAnalyticsEvent(
      shop.id,
      ANALYTICS_EVENTS.DRAFT_ORDER_CREATED,
      submission.catalogId,
      {
        submissionId: updated.id,
        subtotal: Number(updated.subtotalAmount),
        currency: updated.currency,
      },
      `draft_order_created:${updated.id}`
    );

    return {
      reconciled: true,
      status: 'COMPLETED',
      draftOrderId: foundDraft.id,
      draftOrderName: foundDraft.name,
      message: 'Draft order successfully recovered from Shopify!',
    };
  }

  // Not found yet: remain in REQUIRES_RECONCILIATION, never create a draft order!
  return {
    reconciled: false,
    status: 'REQUIRES_RECONCILIATION',
    message: 'Draft order not yet found in Shopify. Mutation may still be in transit or was rejected upstream.',
  };
}
