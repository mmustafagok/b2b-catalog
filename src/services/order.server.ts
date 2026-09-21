import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import { BuyerSubmitOrderSchema, BuyerSubmitOrderInput, CatalogStatus, PriceMode } from '../types/index.js';
import { calculateDisplayPrice, toDecimal, formatMoney, roundDecimal } from './pricing.server.js';
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
import { sanitizeErrorMessage } from './security.server.js';
import { SubmitStageTracker, recordRuntimeIncident } from './incident.server.js';
import { validateOrderLinkAccess, recordOrderLinkSubmission, isOrderLinkExpired } from './orderlink.server.js';
import {
  claimReorderIntent,
  releaseReorderIntentClaim,
  commitReorderIntentUsed,
  markReorderIntentReconciliationPending,
  resetReorderIntentToAvailable,
  ReorderIntentError,
} from './reorder.server.js';
import crypto from 'crypto';

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

/**
 * Validates strictly whether an ID is a Shopify ProductVariant GraphQL GID.
 */
export function isShopifyProductVariantGid(id: unknown): id is string {
  return typeof id === 'string' && /^gid:\/\/shopify\/ProductVariant\/[a-zA-Z0-9_-]+$/.test(id.trim());
}

/**
 * Validates strictly whether an ID is a Shopify DraftOrder GraphQL GID.
 */
export function isShopifyDraftOrderGid(id: unknown): id is string {
  return typeof id === 'string' && /^gid:\/\/shopify\/DraftOrder\/[a-zA-Z0-9_/-]+$/.test(id.trim());
}

/**
 * Canonical helper for generating deterministic, collision-resistant Draft Order idempotency tags.
 * Ensures the generated tag is strictly <= 40 characters to comply with Shopify's tag length limit.
 *
 * Design: cfb2b-<sha256(idempotencyKey).slice(0, 32)>
 * Length: 6 ('cfb2b-') + 32 (hex) = 38 characters.
 *
 * IMPORTANT: Uses a dash separator (not colon) because Shopify's Lucene-style tag search
 * treats ':' as a field separator. `tag:cfb2b:abc` would be misinterpreted as field `tag:cfb2b`
 * with value `abc`, breaking reconciliation lookups. A dash is a safe, literal character.
 */
export function buildDraftOrderIdempotencyTag(idempotencyKey: string): string {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('idempotencyKey is required to generate Draft Order idempotency tag');
  }
  const hash = crypto
    .createHash('sha256')
    .update(idempotencyKey.trim())
    .digest('hex')
    .slice(0, 32);
  const tag = `cfb2b-${hash}`;
  if (tag.length > 40) {
    throw new Error(`Generated Draft Order idempotency tag exceeds Shopify 40-character limit: ${tag.length}`);
  }
  return tag;
}

/**
 * Sanitizes and bounds any dynamic or user-provided tag to guarantee it never exceeds Shopify's 40-character limit.
 */
export function sanitizeShopifyTag(tag: string, maxLength = 40): string {
  const cleaned = String(tag || '').trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.slice(0, maxLength);
}

/**
 * Centralized Draft Order tag builder ensuring every single generated tag strictly satisfies length <= 40.
 */
export function buildDraftOrderTags(catalogName: string, idempotencyKey: string): string[] {
  const idempotencyTag = buildDraftOrderIdempotencyTag(idempotencyKey);
  const sanitizedCatalogName = sanitizeShopifyTag(catalogName, 40);

  const candidateTags = ['B2B-Catalog', 'CatalogFlow', sanitizedCatalogName, idempotencyTag];

  const uniqueTags: string[] = [];
  for (const raw of candidateTags) {
    const sanitized = sanitizeShopifyTag(raw, 40);
    if (sanitized.length > 0 && !uniqueTags.includes(sanitized)) {
      if (sanitized.length > 40) {
        throw new Error(`Shopify tag exceeds 40 characters: "${sanitized}" (${sanitized.length})`);
      }
      uniqueTags.push(sanitized);
    }
  }

  return uniqueTags;
}

export interface InventoryChangedItem {
  variantId: string;
  title: string;
  requested: number;
  available: number;
}

export class InventoryChangedError extends Error {
  public statusCode: number = 409;
  public code: string = 'INVENTORY_CHANGED';

  constructor(
    message: string,
    public details: InventoryChangedItem[] = []
  ) {
    super(message);
    this.name = 'InventoryChangedError';
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
  customClient?: ShopifyAdminClient,
  requestId?: string
): Promise<OrderSubmissionResult> {
  const correlationId = requestId || (crypto.randomUUID ? crypto.randomUUID() : `req_${Date.now()}`);
  const tracker = new SubmitStageTracker(correlationId);

  const validated = BuyerSubmitOrderSchema.parse(input);

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    tracker.transition('SUBMISSION_FAILED', 'INVALID_INPUT');
    throw new OrderSubmissionError('Idempotency-Key header is required for order submission', 400, 'INVALID_INPUT');
  }
  if (idempotencyKey.length > 128) {
    tracker.transition('SUBMISSION_FAILED', 'INVALID_INPUT');
    throw new OrderSubmissionError('Idempotency-Key header exceeds maximum length', 400, 'INVALID_INPUT');
  }

  // 1. Fetch Catalog & Shop
  const catalog = await prisma.catalog.findUnique({
    where: { publicToken },
    include: {
      shop: true,
      sources: true,
      variantConfigs: true,
    },
  });

  if (!catalog || catalog.status !== CatalogStatus.PUBLISHED || catalog.shop.uninstalledAt !== null) {
    tracker.transition('SUBMISSION_FAILED', 'CATALOG_NOT_FOUND');
    throw new OrderSubmissionError('Catalog not found, unpublished, or unavailable', 404, 'CATALOG_NOT_FOUND');
  }

  tracker.setContext({
    shopDomain: catalog.shop.shopDomain,
    catalogId: catalog.id,
    lineCount: validated.lines.length,
  });
  tracker.transition('CATALOG_VALIDATED');

  // 1b. Order Link validation (if order was submitted via a link token)
  let resolvedOrderLinkId: string | null = null;
  if (validated.orderLinkToken) {
    const orderLink = await prisma.orderLink.findUnique({
      where: { token: validated.orderLinkToken },
    });
    if (!orderLink || orderLink.catalogId !== catalog.id) {
      tracker.transition('SUBMISSION_FAILED', 'INVALID_LINK');
      throw new OrderSubmissionError('Order link not found or does not belong to this catalog', 403, 'INVALID_LINK');
    }
    const linkAccess = validateOrderLinkAccess(orderLink, validated.passcode);
    if (!linkAccess.ok) {
      tracker.transition('SUBMISSION_FAILED', linkAccess.reason || 'LINK_INVALID');
      const msg = linkAccess.reason === 'PASSCODE_REQUIRED' ? 'A passcode is required to submit this order'
        : linkAccess.reason === 'PASSCODE_INVALID' ? 'Incorrect passcode'
        : linkAccess.reason === 'LINK_EXPIRED' ? 'This order link has expired'
        : 'This order link is inactive';
      throw new OrderSubmissionError(msg, 403, linkAccess.reason || 'LINK_INVALID');
    }
    resolvedOrderLinkId = orderLink.id;
  }

  // 1c. Build variant config map (for disabled variant and qty rule enforcement)
  const variantConfigMap = new Map(
    (catalog as any).variantConfigs?.map((vc: any) => [vc.shopifyVariantId, vc]) ?? []
  );
  const catalogMinQty: number = (catalog as any).minQty ?? 1;
  const catalogMaxQty: number | null = (catalog as any).maxQty ?? null;
  const catalogQtyIncrement: number = (catalog as any).qtyIncrement ?? 1;
  const catalogCustomPrice = (catalog as any).customPriceAmount ?? null;

  // 2. Enforce dataVersion Boundary
  if (validated.dataVersion !== catalog.dataVersion) {
    tracker.transition('SUBMISSION_FAILED', 'CATALOG_CHANGED');
    throw new CatalogDataChangedError(
      'Catalog configuration has changed since it was loaded. Please refresh and review latest catalog details.',
      []
    );
  }

  // 3. Enforce Catalog Membership Authorization & Variant GID Integrity
  const malformedGids: string[] = [];
  for (const line of validated.lines) {
    if (!isShopifyProductVariantGid(line.variantId)) {
      malformedGids.push(line.variantId);
    }
  }
  if (malformedGids.length > 0) {
    tracker.transition('SUBMISSION_FAILED', 'INVALID_LINES');
    throw new OrderSubmissionError(
      'One or more requested items have invalid variant identifiers.',
      422,
      'INVALID_LINES',
      { invalidVariants: malformedGids }
    );
  }

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
  const disabledVariants: string[] = [];
  const qtyRuleViolations: Array<{ variantId: string; detail: string }> = [];

  for (const line of validated.lines) {
    const snap = localSnapshotMap.get(line.variantId);
    if (!snap || !allowedProductGids.has(snap.shopifyProductId) || snap.product.status !== 'ACTIVE') {
      invalidVariants.push(line.variantId);
      continue;
    }

    // Server-side: reject disabled variants regardless of client
    const vcfg: any = variantConfigMap.get(line.variantId);
    if (vcfg && !vcfg.enabled) {
      disabledVariants.push(line.variantId);
      continue;
    }

    // Server-side: enforce quantity rules
    const effectiveMin = vcfg?.minQty ?? catalogMinQty;
    const effectiveMax = vcfg?.maxQty ?? catalogMaxQty;
    const effectiveIncrement = vcfg?.qtyIncrement ?? catalogQtyIncrement;
    if (line.quantity < effectiveMin) {
      qtyRuleViolations.push({ variantId: line.variantId, detail: `Minimum quantity for ${snap.sku || line.variantId} is ${effectiveMin}` });
    } else if (effectiveMax !== null && line.quantity > effectiveMax) {
      qtyRuleViolations.push({ variantId: line.variantId, detail: `Maximum quantity for ${snap.sku || line.variantId} is ${effectiveMax}` });
    } else if (effectiveIncrement > 1 && line.quantity % effectiveIncrement !== 0) {
      qtyRuleViolations.push({ variantId: line.variantId, detail: `Quantity for ${snap.sku || line.variantId} must be a multiple of ${effectiveIncrement}` });
    }
  }

  if (invalidVariants.length > 0) {
    tracker.transition('SUBMISSION_FAILED', 'INVALID_LINES');
    throw new OrderSubmissionError(
      'One or more requested items are not available in this catalog.',
      422,
      'INVALID_LINES',
      { invalidVariants }
    );
  }

  if (disabledVariants.length > 0) {
    tracker.transition('SUBMISSION_FAILED', 'INVALID_LINES');
    throw new OrderSubmissionError(
      'One or more items are no longer available in this catalog.',
      422,
      'ITEMS_DISABLED',
      { disabledVariants }
    );
  }

  if (qtyRuleViolations.length > 0) {
    tracker.transition('SUBMISSION_FAILED', 'QTY_RULE_VIOLATION');
    throw new OrderSubmissionError(
      'One or more items violate quantity rules for this catalog.',
      422,
      'QTY_RULE_VIOLATION',
      { violations: qtyRuleViolations }
    );
  }

  tracker.transition('CATALOG_MEMBERSHIP_VALIDATED');

  const client = customClient || new ShopifyAdminClient({
    shopDomain: catalog.shop.shopDomain,
    shopId: catalog.shopId,
  });

  // 4. Claim Reorder Intent Atomically if provided
  if (validated.reorderIntentToken) {
    try {
      await claimReorderIntent(validated.reorderIntentToken, correlationId);
    } catch (reorderErr: any) {
      tracker.transition('SUBMISSION_FAILED', reorderErr.code || 'REORDER_ERROR');
      if (reorderErr instanceof ReorderIntentError) {
        throw new OrderSubmissionError(reorderErr.message, reorderErr.statusCode, reorderErr.code);
      }
      throw reorderErr;
    }
  }

  // 5. Idempotency State Machine & Pre-Shopify Reservation
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
      if (validated.reorderIntentToken) {
        try {
          await commitReorderIntentUsed(validated.reorderIntentToken, correlationId);
        } catch (commitErr: any) {
          if (commitErr?.code !== 'REORDER_LINK_ALREADY_USED') {
            await markReorderIntentReconciliationPending(validated.reorderIntentToken, correlationId).catch(() => {});
          }
        }
      }
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

    // EXTERNAL COMMIT POINT: If submission already has draftOrderId recorded, adopt it immediately!
    if (submission.draftOrderId && isShopifyDraftOrderGid(submission.draftOrderId)) {
      const completedSub = await prisma.orderSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'COMPLETED',
          processingStartedAt: null,
          quotaReserved: true,
        },
      });
      if (validated.reorderIntentToken) {
        try {
          await commitReorderIntentUsed(validated.reorderIntentToken, correlationId);
        } catch (commitErr: any) {
          if (commitErr?.code !== 'REORDER_LINK_ALREADY_USED') {
            await markReorderIntentReconciliationPending(validated.reorderIntentToken, correlationId).catch(() => {});
          }
        }
      }
      return {
        success: true,
        submissionId: completedSub.id,
        referenceNumber: completedSub.draftOrderName || `REF-${completedSub.id.substring(0, 8).toUpperCase()}`,
        draftOrderId: completedSub.draftOrderId!,
        draftOrderName: completedSub.draftOrderName || '',
        subtotalAmount: Number(completedSub.subtotalAmount),
        currency: completedSub.currency,
        isDuplicate: true,
      };
    }

    if (submission.status === 'CREATING') {
      const leaseStartedAt = submission.processingStartedAt;
      if (!leaseStartedAt) {
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
        needsReconciliation = true;
      }
    } else {
      // For REQUIRES_RECONCILIATION or FAILED:
      // ALWAYS reconcile against Shopify first using deterministic tag!
      // If a previous attempt succeeded in creating a Draft Order in Shopify before failing locally,
      // reconciliation will find and adopt it, strictly preventing duplicate Draft Orders.
      needsReconciliation = true;
    }
  } else {
    // 5. Concurrency-Safe Quota Slot Reservation via Centralized Entitlement Boundary
    const entitlement = await defaultBillingProvider.getEntitlement(catalog.shopId);
    const slotReserved = await reserveSubmissionQuotaSlot(catalog.shopId, entitlement.limits.monthlySubmissionsLimit);
    if (!slotReserved) {
      if (validated.reorderIntentToken) {
        await releaseReorderIntentClaim(validated.reorderIntentToken, correlationId).catch(() => {});
      }
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
          correlationRef: buildDraftOrderIdempotencyTag(idempotencyKey),
          orderLinkId: resolvedOrderLinkId,
          buyerName: validated.buyer.buyerName ?? null,
          buyerPhone: validated.buyer.phone ?? null,
          taxId: validated.buyer.taxId ?? null,
          reorderIntentId: validated.reorderIntentToken ?? null,
        },
      });
    } catch (insertErr: any) {
      await releaseSubmissionQuotaSlotDirect(catalog.shopId, activeAnchor);
      if (validated.reorderIntentToken) {
        await releaseReorderIntentClaim(validated.reorderIntentToken, correlationId).catch(() => {});
      }
      tracker.transition('SUBMISSION_FAILED', 'CONCURRENT_PROCESSING');
      throw new OrderSubmissionError(
        'Order submission is currently being processed by another worker',
        409,
        'CONCURRENT_PROCESSING'
      );
    }
  }

  tracker.transition('QUOTA_RESERVED');

  const correlationTag = buildDraftOrderIdempotencyTag(idempotencyKey);
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
              subtotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    `;

    try {
      // Wrap correlationTag in double quotes for Shopify Lucene safety.
      // Without quotes, Shopify may mis-tokenize the dash-separated tag value.
      const searchRes: any = await client.request(findDraftQuery, { query: `tag:"${correlationTag}"` });
      const edges = searchRes?.draftOrders?.edges || [];
      if (edges.length > 0 && edges[0]?.node?.id) {
        const foundDraft = edges[0].node;
        const rawAmount =
          foundDraft.subtotalPriceSet?.shopMoney?.amount ??
          foundDraft.subtotalPrice ??
          foundDraft.totalPriceSet?.shopMoney?.amount ??
          foundDraft.totalPrice ??
          '0.00';
        const subtotal = new Prisma.Decimal(rawAmount);
        const resolvedCurrency =
          foundDraft.subtotalPriceSet?.shopMoney?.currencyCode ||
          foundDraft.totalPriceSet?.shopMoney?.currencyCode ||
          foundDraft.currencyCode ||
          catalog.shop.currency ||
          'USD';

        const updated = await prisma.orderSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'COMPLETED',
            draftOrderId: foundDraft.id,
            draftOrderName: foundDraft.name || null,
            correlationRef: correlationTag,
            subtotalAmount: subtotal,
            currency: resolvedCurrency,
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

        if (validated.reorderIntentToken) {
          try {
            await commitReorderIntentUsed(validated.reorderIntentToken, correlationId);
          } catch (commitErr: any) {
            if (commitErr?.code !== 'REORDER_LINK_ALREADY_USED') {
              await markReorderIntentReconciliationPending(validated.reorderIntentToken, correlationId).catch(() => {});
            }
          }
        }

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

      // If edges.length === 0: Draft order was not found in Shopify by correlation tag.
      if (submission.status === 'FAILED') {
        // Confirmed: Shopify does not have an existing Draft Order for this failed attempt.
        // Re-reserve quota slot atomically and transition to CREATING to proceed.
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
      } else {
        // REQUIRES_RECONCILIATION or CREATING must NEVER automatically call draftOrderCreate!
        // Keep status REQUIRES_RECONCILIATION, keep quota slot reserved, throw RECONCILIATION_PENDING!
        if (validated.reorderIntentToken) {
          await markReorderIntentReconciliationPending(validated.reorderIntentToken, correlationId).catch(() => {});
        }
        throw new OrderSubmissionError(
          'We are still confirming the previous order attempt. Please retry shortly.',
          409,
          'RECONCILIATION_PENDING'
        );
      }
    } catch (reconcileSearchErr: any) {
      if (validated.reorderIntentToken) {
        await markReorderIntentReconciliationPending(validated.reorderIntentToken, correlationId).catch(() => {});
      }
      if (reconcileSearchErr instanceof OrderSubmissionError) {
        throw reconcileSearchErr;
      }
      // Reconciliation query failed — keep REQUIRES_RECONCILIATION and fail closed
      // Log sanitized error for diagnostics (no buyer PII)
      void recordRuntimeIncident({
        type: 'RECONCILIATION_QUERY_FAILED',
        requestId: correlationId,
        route: '/api/public/catalog/submit',
        errorCode: 'SHOPIFY_API_ERROR',
        message: reconcileSearchErr?.message ? reconcileSearchErr.message.slice(0, 200) : 'Reconciliation query failed',
        metadata: {
          submissionId: submission.id,
          shopDomain: catalog.shop.shopDomain,
          catalogId: catalog.id,
        },
      });
      throw new OrderSubmissionError(
        'Unable to verify prior submission state with Shopify. Please retry in a moment.',
        502,
        'SHOPIFY_API_ERROR'
      );
    }
  }

  // 7. Live Variant Revalidation against Shopify
  tracker.transition('LIVE_REVALIDATION_STARTED');
  const liveVariantsQuery = `
    query getVariantsByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          price
          availableForSale
          inventoryQuantity
          inventoryPolicy
          inventoryItem {
            tracked
          }
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
    if (validated.reorderIntentToken) {
      await releaseReorderIntentClaim(validated.reorderIntentToken, correlationId).catch(() => {});
    }
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: { status: 'FAILED', processingStartedAt: null, lastError: 'Live variant verification failed' },
    });
    tracker.transition('SUBMISSION_FAILED', 'SHOPIFY_API_ERROR');
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

  const inventoryChangedItems: InventoryChangedItem[] = [];
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

    const variantTitle = liveVariant.title || localSnapshot?.title || 'Variant';
    const itemTitle = `${liveVariant.product?.title || localSnapshot?.product.title || 'Product'} / ${variantTitle}`;

    if (!liveVariant.availableForSale || liveVariant.product?.status !== 'ACTIVE') {
      changedLines.push({
        variantId: line.variantId,
        productTitle: liveVariant.product?.title || localSnapshot?.product.title || 'Product',
        variantTitle,
        reason: 'OUT_OF_STOCK',
        available: false,
      });
      continue;
    }

    // Enforce Shopify inventory availability ceiling:
    // Only if inventory is tracked (tracked === true) and policy !== CONTINUE and inventoryQuantity is a number:
    const isTracked = liveVariant.inventoryItem?.tracked === true;
    const policy = (liveVariant.inventoryPolicy || 'DENY').toUpperCase();

    if (isTracked && policy !== 'CONTINUE' && typeof liveVariant.inventoryQuantity === 'number') {
      const liveQty = liveVariant.inventoryQuantity;
      const liveAvailable = Math.max(0, liveQty);
      if (line.quantity > liveAvailable) {
        inventoryChangedItems.push({
          variantId: line.variantId,
          title: itemTitle,
          requested: line.quantity,
          available: liveAvailable,
        });
        continue;
      }
    }

    // Price calculation: custom per-variant price > catalog custom price > percent discount > Shopify price
    const vcfg: any = variantConfigMap.get(line.variantId);
    let liveWholesalePrice: Prisma.Decimal;
    if (vcfg?.customPrice) {
      liveWholesalePrice = roundDecimal(vcfg.customPrice);
    } else if (catalog.priceMode === PriceMode.CUSTOM_PRICE && catalogCustomPrice) {
      liveWholesalePrice = roundDecimal(catalogCustomPrice);
    } else {
      liveWholesalePrice = calculateDisplayPrice(
        liveVariant.price,
        catalog.priceMode,
        catalog.discountPercent
      );
    }

    if (localSnapshot) {
      const localWholesalePrice = vcfg?.customPrice
        ? roundDecimal(vcfg.customPrice)
        : catalog.priceMode === PriceMode.CUSTOM_PRICE && catalogCustomPrice
          ? roundDecimal(catalogCustomPrice)
          : calculateDisplayPrice(
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

  if (inventoryChangedItems.length > 0) {
    await releaseSubmissionQuotaReservation(submission.id);
    if (validated.reorderIntentToken) {
      await releaseReorderIntentClaim(validated.reorderIntentToken, correlationId).catch(() => {});
    }
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: { status: 'FAILED', processingStartedAt: null, lastError: 'Inventory changed during submit' },
    });
    tracker.transition('SUBMISSION_FAILED', 'INVENTORY_CHANGED');
    throw new InventoryChangedError(
      'Requested quantity exceeds currently available inventory. Please review and update your order.',
      inventoryChangedItems
    );
  }

  if (changedLines.length > 0) {
    await releaseSubmissionQuotaReservation(submission.id);
    if (validated.reorderIntentToken) {
      await releaseReorderIntentClaim(validated.reorderIntentToken, correlationId).catch(() => {});
    }
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: { status: 'FAILED', processingStartedAt: null, lastError: 'Catalog data changed during submit' },
    });
    tracker.transition('SUBMISSION_FAILED', 'CATALOG_CHANGED');
    throw new CatalogDataChangedError(
      'Some product prices or inventory availability changed since this catalog was loaded. Please review updated lines.',
      changedLines
    );
  }

  tracker.transition('LIVE_REVALIDATION_COMPLETED');

  // 8. Build Shopify draftOrderCreate Mutation
  tracker.transition('DRAFT_ORDER_CREATE_STARTED');
  const hasDiscount =
    catalog.priceMode === 'PERCENT_DISCOUNT' &&
    catalog.discountPercent !== null &&
    Number(catalog.discountPercent) > 0;

  const lineItemsInput = validated.lines.map((l) => {
    const liveVariant = liveVariantMap.get(l.variantId);
    const resolvedVariantGid = (liveVariant && liveVariant.id) || l.variantId;
    const item: any = {
      variantId: resolvedVariantGid,
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
  // Custom attributes must strictly follow AttributeInput { key, value }
  const customAttributes: Array<{ key: string; value: string }> = [
    { key: 'Business Name', value: String(validated.buyer.businessName).trim() },
    { key: 'Catalog', value: String(catalog.name).trim() },
    { key: 'Catalog ID', value: String(catalog.id).trim() },
    { key: 'Submission Reference', value: String(correlationReference).trim() },
  ];
  if (validated.buyer.poNumber && validated.buyer.poNumber.trim().length > 0) {
    customAttributes.push({ key: 'PO Number', value: validated.buyer.poNumber.trim() });
  }

  let noteBody = `[B2B Catalog Order]\nBusiness: ${validated.buyer.businessName.trim()}`;
  if (validated.buyer.poNumber && validated.buyer.poNumber.trim().length > 0) {
    noteBody += `\nPO Number: ${validated.buyer.poNumber.trim()}`;
  }
  if (validated.buyer.note && validated.buyer.note.trim().length > 0) {
    noteBody += `\nBuyer Notes: ${validated.buyer.note.trim()}`;
  }

  // Minimal, standards-compliant DraftOrderInput
  const draftOrderInput: any = {
    email: validated.buyer.email.trim(),
    note: noteBody,
    tags: buildDraftOrderTags(catalog.name, idempotencyKey),
    customAttributes,
    lineItems: lineItemsInput,
  };

  if (validated.buyer.poNumber && validated.buyer.poNumber.trim().length > 0) {
    draftOrderInput.poNumber = validated.buyer.poNumber.trim();
  }

  const draftOrderMutation = `
    mutation createDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
          status
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
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
    // ─── CLASSIFICATION LOGIC ───────────────────────────────────────────────────
    //
    // DEFINITIVE: Shopify provably rejected before any side effect.
    //   → mark FAILED, release quota, safe to retry from scratch.
    //
    // AMBIGUOUS: Shopify may have created the Draft Order before the error/disconnect.
    //   → mark REQUIRES_RECONCILIATION, RETAIN quota, never retry draftOrderCreate.
    //
    // The `mutationErr.ambiguous` flag is set by ShopifyAdminClient:
    //  - HTTP 200 + top-level errors[] (mutation may have executed) → ambiguous=true
    //  - HTTP 5xx (server may have processed before crashing) → ambiguous=true
    //  - Network timeout after dispatch → ambiguous=true (504)
    //  - HTTP 4xx or userErrors[] → ambiguous=false (definitive)
    // ────────────────────────────────────────────────────────────────────────────

    const isAmbiguous = mutationErr instanceof ShopifyGraphQLError && mutationErr.ambiguous === true;
    const isDefinitive = !isAmbiguous && mutationErr instanceof ShopifyGraphQLError && mutationErr.isDefinitiveClientError();

    if (isDefinitive) {
      // Conclusive rejection: Shopify rejected the mutation before creating any Draft Order.
      // Quota MUST be released exactly once.
      await releaseSubmissionQuotaReservation(submission.id);

      const rawMsg = mutationErr.message || 'Shopify rejected draft order creation';
      const isPermissionDenied =
        mutationErr.statusCode === 401 ||
        mutationErr.statusCode === 403 ||
        rawMsg.toLowerCase().includes('access denied') ||
        rawMsg.toLowerCase().includes('permission');

      const errorCode = isPermissionDenied
        ? 'DRAFT_ORDER_PERMISSION_DENIED'
        : mutationErr.userErrors && mutationErr.userErrors.length > 0
        ? 'DRAFT_ORDER_VALIDATION_FAILED'
        : 'DRAFT_ORDER_CREATE_FAILED';

      await prisma.orderSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'FAILED',
          processingStartedAt: null,
          quotaReserved: false,
          lastError: sanitizeErrorMessage(rawMsg),
        },
      });

      tracker.transition('SUBMISSION_FAILED', errorCode);

      const structuralDiagnostics = {
        requestId: correlationId,
        stage: 'DRAFT_ORDER_MUTATION_DEFINITIVE_FAILURE',
        hasResult: false,
        hasDraftOrderCreate: false,
        hasDraftOrder: false,
        draftOrderIdPresent: false,
        draftOrderIdValid: false,
        userErrorCount: Array.isArray(mutationErr.userErrors) ? mutationErr.userErrors.length : 0,
        topLevelErrorCount: Array.isArray(mutationErr.errors) ? mutationErr.errors.length : 0,
        shopDomain: catalog.shop.shopDomain,
        catalogId: catalog.id,
      };

      console.warn('[DraftOrder:Diagnostic]', JSON.stringify(structuralDiagnostics));

      void recordRuntimeIncident({
        type: 'DRAFT_ORDER_MUTATION_FAILED',
        requestId: correlationId,
        route: '/api/public/catalog/submit',
        errorCode,
        message: sanitizeErrorMessage(rawMsg),
        metadata: {
          submissionId: submission.id,
          shopDomain: catalog.shop.shopDomain,
          catalogId: catalog.id,
          userErrors: mutationErr.userErrors || null,
          graphQLErrors: mutationErr.errors
            ? mutationErr.errors.map((e: any) => ({ message: e.message, code: e.extensions?.code }))
            : null,
          statusCode: mutationErr.statusCode || null,
          structuralDiagnostics,
        },
      });

      const userFacingMsg = isPermissionDenied
        ? 'Draft Order creation failed due to store permissions. Please contact the merchant.'
        : "We couldn't create the Shopify Draft Order. Your order was not confirmed.";

      const details =
        mutationErr.userErrors && mutationErr.userErrors.length > 0
          ? mutationErr.userErrors
          : mutationErr.errors && mutationErr.errors.length > 0
          ? mutationErr.errors.map((e: any) => ({ message: sanitizeErrorMessage(e.message || String(e)) }))
          : [{ message: sanitizeErrorMessage(rawMsg), diagnostics: structuralDiagnostics }];

      throw new OrderSubmissionError(
        userFacingMsg,
        isPermissionDenied ? 403 : 422,
        errorCode,
        details
      );
    }

    // ─── AMBIGUOUS EXECUTION PATH ─────────────────────────────────────────────
    // Reaches here for:
    //  - isAmbiguous === true (HTTP 200 + top-level errors[], HTTP 5xx, timeout)
    //  - Non-ShopifyGraphQLError network errors (ECONNRESET, etc.)
    //
    // The Draft Order may exist in Shopify. We MUST NOT:
    //  - Release quota (the order slot may be consumed)
    //  - Mark FAILED (that would allow bypassing reconciliation on retry)
    //  - Retry draftOrderCreate (would create a duplicate)
    //
    // We MUST:
    //  - Mark REQUIRES_RECONCILIATION
    //  - Preserve correlationRef for Shopify tag-based lookup
    //  - Return 502 so buyer knows to retry via reconciliation
    // ─────────────────────────────────────────────────────────────────────────
    const isTimeout = mutationErr instanceof ShopifyGraphQLError && mutationErr.isTimeout();
    const ambiguousCode = isTimeout ? 'SHOPIFY_TIMEOUT' : 'SHOPIFY_API_ERROR';

    const ambiguousStructuralDiag = {
      requestId: correlationId,
      stage: 'DRAFT_ORDER_MUTATION_AMBIGUOUS',
      isAmbiguous: true,
      isTimeout,
      statusCode: mutationErr?.statusCode || null,
      topLevelErrorCount: Array.isArray(mutationErr?.errors) ? mutationErr.errors.length : 0,
      shopDomain: catalog.shop.shopDomain,
      catalogId: catalog.id,
    };

    console.warn('[DraftOrder:Diagnostic]', JSON.stringify(ambiguousStructuralDiag));

    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'REQUIRES_RECONCILIATION',
        processingStartedAt: null,
        correlationRef: correlationTag,
        lastError: isTimeout
          ? 'Request timed out during draft order creation'
          : `Ambiguous execution failure: ${sanitizeErrorMessage((mutationErr as any)?.message || 'Unknown error').slice(0, 200)}`,
      },
    });

    if (validated.reorderIntentToken) {
      await markReorderIntentReconciliationPending(validated.reorderIntentToken, correlationId).catch(() => {});
    }

    tracker.transition('SUBMISSION_FAILED', ambiguousCode);

    void recordRuntimeIncident({
      type: 'DRAFT_ORDER_TRANSPORT_ERROR',
      requestId: correlationId,
      route: '/api/public/catalog/submit',
      errorCode: ambiguousCode,
      message: sanitizeErrorMessage((mutationErr as any)?.message || 'Ambiguous draft order error'),
      metadata: {
        submissionId: submission.id,
        shopDomain: catalog.shop.shopDomain,
        catalogId: catalog.id,
        isTimeout,
        isAmbiguous: true,
        statusCode: mutationErr?.statusCode || null,
      },
    });

    throw new OrderSubmissionError(
      'Draft order creation encountered a network error or timeout. Please retry to confirm order status.',
      502,
      ambiguousCode
    );
  }

  // Safe structural diagnostics around mutation result (supports both direct and data-nested shapes)
  const payload = draftRes?.draftOrderCreate ?? draftRes?.data?.draftOrderCreate ?? (draftRes?.id ? { draftOrder: draftRes, userErrors: [] } : draftRes);
  const userErrors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
  const createdDraft = payload?.draftOrder;
  const rawDraftId = createdDraft?.id;
  const isDraftIdValid = isShopifyDraftOrderGid(rawDraftId);
  const resultTopLevelKeys = draftRes && typeof draftRes === 'object' ? Object.keys(draftRes) : [];

  const structuralDiagnostics = {
    requestId: correlationId,
    stage: 'DRAFT_ORDER_RESPONSE_RECEIVED',
    hasResult: Boolean(draftRes),
    resultTopLevelKeys,
    hasData: Boolean(draftRes?.data || draftRes?.draftOrderCreate),
    hasDraftOrderCreate: Boolean(payload),
    hasDraftOrder: Boolean(createdDraft),
    draftOrderIdPresent: Boolean(rawDraftId),
    draftOrderIdValid: isDraftIdValid,
    userErrorCount: userErrors.length,
  };

  console.info('[DraftOrder:Diagnostic]', JSON.stringify(structuralDiagnostics));

  if (userErrors.length > 0) {
    const userErrorMsg = userErrors.map((e: any) => {
      const fieldStr = Array.isArray(e.field) ? e.field.join('.') : e.field ? String(e.field) : '';
      return fieldStr ? `[${fieldStr}] ${e.message}` : e.message;
    }).join('; ');

    await releaseSubmissionQuotaReservation(submission.id);
    if (validated.reorderIntentToken) {
      await releaseReorderIntentClaim(validated.reorderIntentToken, correlationId).catch(() => {});
    }
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'FAILED',
        processingStartedAt: null,
        quotaReserved: false,
        lastError: sanitizeErrorMessage(userErrorMsg),
      },
    });

    tracker.transition('SUBMISSION_FAILED', 'DRAFT_ORDER_VALIDATION_FAILED');

    void recordRuntimeIncident({
      type: 'DRAFT_ORDER_MUTATION_FAILED',
      requestId: correlationId,
      route: '/api/public/catalog/submit',
      errorCode: 'DRAFT_ORDER_VALIDATION_FAILED',
      message: sanitizeErrorMessage(userErrorMsg),
      metadata: {
        submissionId: submission.id,
        userErrors,
        structuralDiagnostics,
      },
    });

    throw new OrderSubmissionError(
      "We couldn't create the Shopify Draft Order. Your order was not confirmed.",
      422,
      'DRAFT_ORDER_VALIDATION_FAILED',
      userErrors
    );
  }

  if (!createdDraft || !isDraftIdValid) {
    // Ambiguous response: response was received without userErrors but missing valid draftOrder id.
    // The Draft Order may have been created Shopify-side before response framing failed.
    // Preserve reconciliation and retain quota.
    const reasonMsg = !createdDraft
      ? 'Shopify returned null draftOrder with empty userErrors'
      : `Shopify returned draftOrder with invalid GID format: "${String(rawDraftId).slice(0, 50)}"`;

    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'REQUIRES_RECONCILIATION',
        processingStartedAt: null,
        correlationRef: correlationTag,
        lastError: sanitizeErrorMessage(reasonMsg),
      },
    });

    if (validated.reorderIntentToken) {
      await markReorderIntentReconciliationPending(validated.reorderIntentToken, correlationId).catch(() => {});
    }

    tracker.transition('SUBMISSION_FAILED', 'SHOPIFY_API_ERROR');

    void recordRuntimeIncident({
      type: 'DRAFT_ORDER_MUTATION_FAILED',
      requestId: correlationId,
      route: '/api/public/catalog/submit',
      errorCode: 'SHOPIFY_API_ERROR',
      message: sanitizeErrorMessage(reasonMsg),
      metadata: {
        submissionId: submission.id,
        structuralDiagnostics,
      },
    });

    throw new OrderSubmissionError(
      'Shopify Draft Order creation returned an invalid response',
      502,
      'SHOPIFY_API_ERROR',
      [{ message: sanitizeErrorMessage(reasonMsg), diagnostics: structuralDiagnostics }]
    );
  }

  // 7. EXTERNAL COMMIT POINT:
  // If Shopify returns: draftOrder != null, valid DraftOrder GID, userErrors = []
  // The Draft Order definitely exists. MUST be treated as success!
  // From this point onward, NEVER classify any error as DRAFT_ORDER_CREATE_FAILED.
  tracker.transition('DRAFT_ORDER_CREATE_COMPLETED');

  const draftMoney = createdDraft.subtotalPriceSet?.shopMoney ?? createdDraft.totalPriceSet?.shopMoney;
  let draftSubtotal = subtotalDecimal;
  try {
    const rawAmount = draftMoney?.amount ?? createdDraft.subtotalPrice ?? createdDraft.totalPrice;
    if (rawAmount !== undefined && rawAmount !== null && String(rawAmount).trim() !== '') {
      draftSubtotal = new Prisma.Decimal(String(rawAmount));
    }
  } catch {
    draftSubtotal = subtotalDecimal;
  }
  const currency = draftMoney?.currencyCode || createdDraft.currencyCode || catalog.shop.currency || 'USD';
  const subtotalNumber = parseFloat(draftSubtotal.toFixed(2));

  // 9. Mark Submission COMPLETED
  // If local DB fails here, mark status as REQUIRES_RECONCILIATION so retry adopts draft order without duplicate creation
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
        subtotalAmount: draftSubtotal,
        currency,
        processingStartedAt: null,
        quotaReserved: true,
      },
    });
  } catch (postMutationDbErr: any) {
    // EXTERNAL COMMIT POINT GUARANTEE:
    // Draft order exists in Shopify. We MUST NEVER classify this as DRAFT_ORDER_CREATE_FAILED.
    // Preserve Shopify Draft Order ID and mark as REQUIRES_RECONCILIATION.
    await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'REQUIRES_RECONCILIATION',
        draftOrderId: createdDraft.id,
        draftOrderName: createdDraft.name || null,
        correlationRef: correlationTag,
        processingStartedAt: null,
        quotaReserved: true,
        lastError: 'Local database update failed after Shopify Draft Order creation',
      },
    }).catch(() => {});

    if (validated.reorderIntentToken) {
      await markReorderIntentReconciliationPending(validated.reorderIntentToken, correlationId).catch(() => {});
    }

    throw new OrderSubmissionError(
      `Your draft order was created in Shopify with reference ${createdDraft.name || 'pending'}. Please refresh to view order status.`,
      502,
      'SHOPIFY_API_ERROR'
    );
  }

  // Record analytics asynchronously without risking order confirmation failure
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
  ).catch((analyticsErr: any) => {
    console.warn('[Analytics:DraftOrderCreated] Non-fatal error recording analytics event:', analyticsErr?.message);
  });

  // Record order link analytics if this order was submitted via a named link
  if (resolvedOrderLinkId) {
    void recordOrderLinkSubmission(resolvedOrderLinkId, subtotalNumber).catch(() => {});
  }

  // Mark reorder intent as used if one was provided
  if (validated.reorderIntentToken) {
    try {
      await commitReorderIntentUsed(validated.reorderIntentToken, correlationId);
    } catch (commitErr: any) {
      console.error('[ReorderIntent:CommitUsedFailed]', commitErr?.message);
      // Invariant: Draft Order exists in Shopify. Never leave token AVAILABLE / reclaimable.
      await markReorderIntentReconciliationPending(validated.reorderIntentToken, correlationId).catch(() => {});
    }
  }

  tracker.transition('SUBMISSION_COMPLETED');

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
    jobsPendingCount,
    jobsFailedCount,
    latestFailedJob,
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
    prisma.backgroundJob.count({
      where: {
        shopId,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
    }),
    prisma.backgroundJob.count({
      where: {
        shopId,
        status: 'FAILED',
      },
    }),
    prisma.backgroundJob.findFirst({
      where: {
        shopId,
        status: 'FAILED',
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        updatedAt: true,
        lastError: true,
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
    jobs: {
      pending: jobsPendingCount,
      failed: jobsFailedCount,
      lastFailedAt: latestFailedJob?.updatedAt ? latestFailedJob.updatedAt.toISOString() : null,
      lastError: latestFailedJob?.lastError ? sanitizeErrorMessage(latestFailedJob.lastError) : null,
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
  const correlationTag =
    submission.correlationRef ||
    (submission.idempotencyKeyHash
      ? `cfb2b-${submission.idempotencyKeyHash.slice(0, 32)}`
      : buildDraftOrderIdempotencyTag(submission.id));

  const findDraftQuery = `
    query findDraftOrderByCorrelationTag($query: String!) {
      draftOrders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            subtotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 250) {
              nodes {
                quantity
              }
            }
          }
        }
      }
    }
  `;

  // Wrap tag value in double quotes for Shopify Lucene safety
  const searchRes: any = await client.request(findDraftQuery, { query: `tag:"${correlationTag}"` });
  const edges = searchRes?.draftOrders?.edges || [];

  if (edges.length > 0 && edges[0]?.node?.id) {
    const foundDraft = edges[0].node;
    const rawAmount =
      foundDraft.subtotalPriceSet?.shopMoney?.amount ??
      foundDraft.subtotalPrice ??
      foundDraft.totalPriceSet?.shopMoney?.amount ??
      foundDraft.totalPrice ??
      '0.00';
    const subtotal = new Prisma.Decimal(rawAmount);
    const resolvedCurrency =
      foundDraft.subtotalPriceSet?.shopMoney?.currencyCode ||
      foundDraft.totalPriceSet?.shopMoney?.currencyCode ||
      foundDraft.currencyCode ||
      shop.currency ||
      'USD';

    // Hydrate item/line counts from live Shopify lineItems
    const lineNodes: Array<{ quantity: number }> = foundDraft.lineItems?.nodes || [];
    const reconciledLineCount = lineNodes.length;
    const reconciledItemCount = lineNodes.reduce((sum: number, n: { quantity: number }) => sum + (n.quantity || 0), 0);

    const updated = await prisma.orderSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'COMPLETED',
        draftOrderId: foundDraft.id,
        draftOrderName: foundDraft.name || null,
        correlationRef: correlationTag,
        subtotalAmount: subtotal,
        currency: resolvedCurrency,
        processingStartedAt: null,
        quotaReserved: true,
        lastError: null,
        // Fix reconciliation bug: hydrate item/line counts from Shopify data
        ...(reconciledLineCount > 0 && { lineCount: reconciledLineCount }),
        ...(reconciledItemCount > 0 && { itemCount: reconciledItemCount }),
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

    if (submission.reorderIntentId) {
      try {
        await commitReorderIntentUsed(submission.reorderIntentId);
      } catch (commitErr: any) {
        if (commitErr?.code !== 'REORDER_LINK_ALREADY_USED') {
          await markReorderIntentReconciliationPending(submission.reorderIntentId).catch(() => {});
        }
      }
    }

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
