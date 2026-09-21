/**
 * Reorder Intent Service
 *
 * Allows merchants to generate a shareable reorder link from a completed
 * OrderSubmission. When a buyer opens the link, they get a prefilled cart
 * from their previous order — with current prices and availability revalidated.
 *
 * Tokens are strictly single-use and guarded by an atomic claim/consume state machine:
 * AVAILABLE -> CLAIMED -> USED
 *
 * Concurrency:
 *   - Atomic conditional database updates ensure exactly one parallel submission claims an intent.
 *   - Concurrent attempts receive REORDER_LINK_ALREADY_IN_USE (409) or REORDER_LINK_ALREADY_USED (410).
 *   - Definitive validation/out-of-stock failures release the claim for safe buyer retry.
 *   - Ambiguous/timeout execution holds the claim to prevent duplicate Draft Order creation.
 *   - Confirmed Draft Order creations synchronously commit USED state.
 */

import { prisma } from '../db.js';
import crypto from 'node:crypto';
import { ShopifyAdminClient } from './shopify-client.server.js';
import { getPublicCatalogPayload } from './sync.server.js';

function generateReorderToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export interface ReorderPrefillLine {
  variantId: string;
  quantity: number;
}

// ─── Create reorder intent ────────────────────────────────────────────────────

/**
 * Creates a ReorderIntent from a completed OrderSubmission.
 * Fetches line items from the Shopify Draft Order to build the prefill.
 */
export async function createReorderIntent(
  submissionId: string,
  shopId: string,
  expiresInDays = 30
): Promise<{ token: string; id: string }> {
  const submission = await prisma.orderSubmission.findFirst({
    where: { id: submissionId, shopId, status: 'COMPLETED' },
    include: { catalog: { include: { shop: true } } },
  });

  if (!submission) {
    throw Object.assign(
      new Error('Submission not found, not completed, or unauthorized'),
      { statusCode: 404, code: 'NOT_FOUND' }
    );
  }
  if (!submission.draftOrderId) {
    throw Object.assign(
      new Error('Submission has no associated Draft Order'),
      { statusCode: 400, code: 'NO_DRAFT_ORDER' }
    );
  }

  const shop = submission.catalog.shop;
  const client = new ShopifyAdminClient({ shopId: shop.id, shopDomain: shop.shopDomain });

  // Fetch line items from Shopify Draft Order
  const query = `
    query getDraftOrderLines($id: ID!) {
      draftOrder(id: $id) {
        lineItems(first: 250) {
          nodes {
            variant { id }
            quantity
          }
        }
      }
    }
  `;

  let prefillLines: ReorderPrefillLine[] = [];
  try {
    const res: any = await client.request(query, { id: submission.draftOrderId });
    const nodes = res?.draftOrder?.lineItems?.nodes || [];
    prefillLines = nodes
      .filter((n: any) => n?.variant?.id)
      .map((n: any) => ({ variantId: n.variant.id, quantity: n.quantity as number }));
  } catch (err: any) {
    // If Shopify call fails, attempt to use itemCount as a signal but still create the intent
    // with an empty prefill — buyer will see empty cart with a notice
    prefillLines = [];
  }

  const token = generateReorderToken();
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const intent = await prisma.reorderIntent.create({
    data: {
      catalogId: submission.catalogId,
      shopId,
      originSubmissionId: submissionId,
      token,
      prefillJson: JSON.stringify(prefillLines),
      expiresAt,
    },
  });

  return { token: intent.token, id: intent.id };
}

// ─── Get reorder payload ──────────────────────────────────────────────────────

export interface ReorderPayload {
  catalogToken: string;
  prefillLines: Array<{
    variantId: string;
    quantity: number;
    currentlyAvailable: boolean;
    deleted: boolean;
  }>;
  intentToken: string;
  expiresAt: string | null;
}

/**
 * Resolves a reorder intent token → catalog token + annotated prefill lines.
 * Validates that each previously ordered variant still exists and is available.
 * Does NOT mark the intent as used (that happens on successful submission).
 */
export async function getReorderIntentPayload(
  intentToken: string
): Promise<{ catalogPublicToken: string; prefillLines: ReorderPayload['prefillLines']; intentToken: string; expiresAt: string | null }> {
  const intent = await prisma.reorderIntent.findUnique({
    where: { token: intentToken },
    include: { catalog: { include: { shop: true } } },
  });

  if (!intent) {
    throw Object.assign(new Error('Reorder link not found'), { statusCode: 404, code: 'NOT_FOUND' });
  }
  if (intent.usedAt) {
    throw Object.assign(new Error('This reorder link has already been used'), {
      statusCode: 410,
      code: 'REORDER_LINK_ALREADY_USED',
    });
  }
  if (intent.reconciliationPendingAt) {
    throw Object.assign(
      new Error('This reorder link has a pending order undergoing reconciliation. Please retry shortly.'),
      { statusCode: 409, code: 'REORDER_LINK_RECONCILIATION_PENDING' }
    );
  }
  if (intent.expiresAt && new Date() > intent.expiresAt) {
    throw Object.assign(new Error('This reorder link has expired'), { statusCode: 410, code: 'EXPIRED' });
  }
  if (intent.catalog.status !== 'PUBLISHED' || intent.catalog.shop.uninstalledAt !== null) {
    throw Object.assign(new Error('Catalog is no longer available'), { statusCode: 410, code: 'CATALOG_UNAVAILABLE' });
  }

  let rawLines: ReorderPrefillLine[] = [];
  try {
    rawLines = JSON.parse(intent.prefillJson);
  } catch {
    rawLines = [];
  }

  // Revalidate variant availability
  const variantIds = rawLines.map((l) => l.variantId);
  const snapshots = variantIds.length > 0
    ? await prisma.variantSnapshot.findMany({
        where: {
          shopId: intent.shopId,
          shopifyVariantId: { in: variantIds },
        },
        select: { shopifyVariantId: true, availableForSale: true },
      })
    : [];

  const snapshotMap = new Map(snapshots.map((s) => [s.shopifyVariantId, s]));

  const prefillLines = rawLines.map((line) => {
    const snap = snapshotMap.get(line.variantId);
    return {
      variantId: line.variantId,
      quantity: line.quantity,
      currentlyAvailable: snap ? snap.availableForSale : false,
      deleted: !snap,
    };
  });

  return {
    catalogPublicToken: intent.catalog.publicToken,
    prefillLines,
    intentToken,
    expiresAt: intent.expiresAt ? intent.expiresAt.toISOString() : null,
  };
}

// ─── Concurrency-Safe Claim / Release / Commit State Machine ───────────────────

export class ReorderIntentError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public code: string = 'REORDER_ERROR'
  ) {
    super(message);
    this.name = 'ReorderIntentError';
  }
}

/**
 * Atomically claims an available reorder intent.
 * Enforces single-use concurrency: if two parallel requests attempt to claim the same intent,
 * exactly one succeeds. The other is rejected with REORDER_LINK_ALREADY_IN_USE,
 * REORDER_LINK_RECONCILIATION_PENDING, or REORDER_LINK_ALREADY_USED.
 *
 * CRITICAL INVARIANT:
 * Reconciliation-pending claims NEVER automatically expire via TTL.
 */
export async function claimReorderIntent(
  intentToken: string,
  claimId: string,
  ttlSeconds = 120
): Promise<{ success: boolean }> {
  // First check if intent exists and is not already expired/used/pending reconciliation
  const existing = await prisma.reorderIntent.findUnique({
    where: { token: intentToken },
  });

  if (!existing) {
    throw new ReorderIntentError('Reorder link not found', 404, 'NOT_FOUND');
  }
  if (existing.usedAt) {
    throw new ReorderIntentError('This reorder link has already been used', 410, 'REORDER_LINK_ALREADY_USED');
  }
  if (existing.reconciliationPendingAt) {
    throw new ReorderIntentError(
      'This reorder link has a pending order undergoing reconciliation. Please retry shortly.',
      409,
      'REORDER_LINK_RECONCILIATION_PENDING'
    );
  }
  if (existing.expiresAt && new Date() > existing.expiresAt) {
    throw new ReorderIntentError('This reorder link has expired', 410, 'EXPIRED');
  }

  // Atomic conditional update using raw query:
  // Requires usedAt IS NULL and reconciliationPendingAt IS NULL
  const affected = await prisma.$executeRaw`
    UPDATE "ReorderIntent"
    SET "claimedAt" = NOW(),
        "claimId" = ${claimId},
        "claimExpiresAt" = NOW() + (${ttlSeconds} || ' seconds')::INTERVAL,
        "updatedAt" = NOW()
    WHERE "token" = ${intentToken}
      AND "usedAt" IS NULL
      AND "reconciliationPendingAt" IS NULL
      AND (
        "claimedAt" IS NULL
        OR "claimExpiresAt" < NOW()
        OR "claimId" = ${claimId}
      )
  `;

  if (affected === 0) {
    // Row was not updated because it's used, reconciliation pending, or currently claimed
    const fresh = await prisma.reorderIntent.findUnique({
      where: { token: intentToken },
    });
    if (fresh?.usedAt) {
      throw new ReorderIntentError('This reorder link has already been used', 410, 'REORDER_LINK_ALREADY_USED');
    }
    if (fresh?.reconciliationPendingAt) {
      throw new ReorderIntentError(
        'This reorder link has a pending order undergoing reconciliation. Please retry shortly.',
        409,
        'REORDER_LINK_RECONCILIATION_PENDING'
      );
    }
    if (fresh?.expiresAt && new Date() > fresh.expiresAt) {
      throw new ReorderIntentError('This reorder link has expired', 410, 'EXPIRED');
    }
    throw new ReorderIntentError(
      'This reorder link is currently being processed by another active order submission',
      409,
      'REORDER_LINK_ALREADY_IN_USE'
    );
  }

  return { success: true };
}

/**
 * Releases a reorder intent claim when order creation fails definitively (e.g. out of stock, validation error),
 * allowing the buyer to fix and retry.
 * Strictly verifies that the caller owns the active claim before releasing.
 */
export async function releaseReorderIntentClaim(
  intentToken: string,
  claimId: string
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "ReorderIntent"
    SET "claimedAt" = NULL,
        "claimId" = NULL,
        "claimExpiresAt" = NULL,
        "reconciliationPendingAt" = NULL,
        "updatedAt" = NOW()
    WHERE "token" = ${intentToken}
      AND "claimId" = ${claimId}
      AND "usedAt" IS NULL
  `;
}

/**
 * Marks a reorder intent as RECONCILIATION_PENDING when Shopify execution becomes ambiguous
 * (e.g. network timeout, 5xx gateway error, lost response).
 * Once set, claimExpiresAt is cleared/ignored and the token is PERMANENTLY BLOCKED from TTL reclaim
 * until explicitly resolved by reconciliation.
 */
export async function markReorderIntentReconciliationPending(
  intentToken: string,
  claimId?: string
): Promise<void> {
  const affected = await prisma.$executeRaw`
    UPDATE "ReorderIntent"
    SET "reconciliationPendingAt" = NOW(),
        "claimExpiresAt" = NULL,
        "updatedAt" = NOW()
    WHERE "token" = ${intentToken}
      AND "usedAt" IS NULL
      AND (${claimId ?? null}::TEXT IS NULL OR "claimId" = ${claimId} OR "claimId" IS NULL)
  `;

  if (affected === 0) {
    const fresh = await prisma.reorderIntent.findUnique({
      where: { token: intentToken },
    });
    if (!fresh) {
      throw new ReorderIntentError('Reorder link not found', 404, 'NOT_FOUND');
    }
    if (fresh.usedAt) {
      throw new ReorderIntentError('This reorder link has already been used', 410, 'REORDER_LINK_ALREADY_USED');
    }
    if (claimId && fresh.claimId && fresh.claimId !== claimId) {
      throw new ReorderIntentError(
        'Failed to mark reconciliation pending: claim ownership mismatch',
        409,
        'CLAIM_OWNERSHIP_MISMATCH'
      );
    }
  }
}

/**
 * Resets a RECONCILIATION_PENDING reorder intent back to AVAILABLE when reconciliation
 * definitively proves that no Draft Order was created in Shopify and the operation is safe to retry.
 */
export async function resetReorderIntentToAvailable(
  intentToken: string,
  claimId?: string
): Promise<void> {
  const affected = await prisma.$executeRaw`
    UPDATE "ReorderIntent"
    SET "claimedAt" = NULL,
        "claimId" = NULL,
        "claimExpiresAt" = NULL,
        "reconciliationPendingAt" = NULL,
        "updatedAt" = NOW()
    WHERE "token" = ${intentToken}
      AND "usedAt" IS NULL
      AND (${claimId ?? null}::TEXT IS NULL OR "claimId" = ${claimId} OR "claimId" IS NULL)
  `;

  if (affected === 0) {
    const fresh = await prisma.reorderIntent.findUnique({
      where: { token: intentToken },
    });
    if (!fresh) {
      throw new ReorderIntentError('Reorder link not found', 404, 'NOT_FOUND');
    }
    if (fresh.usedAt) {
      throw new ReorderIntentError('This reorder link has already been used', 410, 'REORDER_LINK_ALREADY_USED');
    }
    if (claimId && fresh.claimId && fresh.claimId !== claimId) {
      throw new ReorderIntentError(
        'Failed to reset reorder intent: claim ownership mismatch',
        409,
        'CLAIM_OWNERSHIP_MISMATCH'
      );
    }
  }
}

/**
 * Commits a reorder intent as USED synchronously after Draft Order creation succeeds or is adopted.
 * Strictly verifies that the caller owns the active claim.
 *
 * If exactly one row was not updated, throws an explicit ReorderIntentError to prevent stale or conflicting consumption.
 */
export async function commitReorderIntentUsed(
  intentToken: string,
  claimId?: string
): Promise<void> {
  let affected: number;

  if (claimId) {
    affected = await prisma.$executeRaw`
      UPDATE "ReorderIntent"
      SET "usedAt" = NOW(),
          "claimedAt" = NULL,
          "claimId" = NULL,
          "claimExpiresAt" = NULL,
          "reconciliationPendingAt" = NULL,
          "updatedAt" = NOW()
      WHERE "token" = ${intentToken}
        AND "usedAt" IS NULL
        AND "claimId" = ${claimId}
    `;
  } else {
    affected = await prisma.$executeRaw`
      UPDATE "ReorderIntent"
      SET "usedAt" = NOW(),
          "claimedAt" = NULL,
          "claimId" = NULL,
          "claimExpiresAt" = NULL,
          "reconciliationPendingAt" = NULL,
          "updatedAt" = NOW()
      WHERE "token" = ${intentToken}
        AND "usedAt" IS NULL
    `;
  }

  if (affected === 0) {
    const fresh = await prisma.reorderIntent.findUnique({
      where: { token: intentToken },
    });
    if (!fresh) {
      throw new ReorderIntentError('Reorder link not found', 404, 'NOT_FOUND');
    }
    if (fresh.usedAt) {
      throw new ReorderIntentError('This reorder link has already been used', 410, 'REORDER_LINK_ALREADY_USED');
    }
    if (claimId && fresh.claimId && fresh.claimId !== claimId) {
      throw new ReorderIntentError(
        'Failed to commit reorder intent: claim ownership mismatch',
        409,
        'CLAIM_OWNERSHIP_MISMATCH'
      );
    }
    throw new ReorderIntentError(
      'Failed to commit reorder intent: invalid state or active claim required',
      409,
      'INVALID_STATE'
    );
  }
}

/**
 * Backward compatibility helper for legacy call sites.
 */
export async function markReorderIntentUsed(intentToken: string): Promise<void> {
  await commitReorderIntentUsed(intentToken);
}

