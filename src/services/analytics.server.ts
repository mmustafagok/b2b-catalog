import { prisma } from '../db.js';

export const ANALYTICS_EVENTS = {
  CATALOG_VIEWED: 'catalog_viewed',
  ORDER_SUMMARY_STARTED: 'order_summary_started',
  ORDER_SUBMITTED: 'order_submitted',
  DRAFT_ORDER_CREATED: 'draft_order_created_from_buyer_submission', // North Star metric
} as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

/**
 * Strict allowlist schema sanitizer for product analytics metadata.
 * Prohibits PII (emails, names, notes, PO numbers, public tokens, IPs, user agents).
 * Silently discards unknown and nested keys.
 */
export function sanitizeAnalyticsMetadata(
  eventName: string,
  rawMetadata?: any
): string | null {
  if (!rawMetadata || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) {
    return null;
  }

  const clean: Record<string, any> = {};

  if (eventName === ANALYTICS_EVENTS.ORDER_SUMMARY_STARTED) {
    // Only allow non-PII operational counts
    if (typeof rawMetadata.itemCount === 'number' && Number.isFinite(rawMetadata.itemCount)) {
      clean.itemCount = Math.max(0, Math.floor(rawMetadata.itemCount));
    }
    if (typeof rawMetadata.lineCount === 'number' && Number.isFinite(rawMetadata.lineCount)) {
      clean.lineCount = Math.max(0, Math.floor(rawMetadata.lineCount));
    }
  } else if (
    eventName === ANALYTICS_EVENTS.ORDER_SUBMITTED ||
    eventName === ANALYTICS_EVENTS.DRAFT_ORDER_CREATED
  ) {
    // Only allow approved operational fields
    if (typeof rawMetadata.submissionId === 'string' && rawMetadata.submissionId.length <= 64) {
      clean.submissionId = rawMetadata.submissionId;
    }
    if (typeof rawMetadata.itemCount === 'number' && Number.isFinite(rawMetadata.itemCount)) {
      clean.itemCount = Math.max(0, Math.floor(rawMetadata.itemCount));
    }
    if (typeof rawMetadata.lineCount === 'number' && Number.isFinite(rawMetadata.lineCount)) {
      clean.lineCount = Math.max(0, Math.floor(rawMetadata.lineCount));
    }
    if (typeof rawMetadata.subtotal === 'number' && Number.isFinite(rawMetadata.subtotal)) {
      clean.subtotal = Math.round(rawMetadata.subtotal * 100) / 100;
    }
    if (typeof rawMetadata.currency === 'string' && rawMetadata.currency.length <= 5) {
      clean.currency = rawMetadata.currency.toUpperCase();
    }
  }

  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : null;
}

/**
 * Records a product analytics event into PostgreSQL.
 * If an eventKey is provided, performs an idempotent upsert to guarantee
 * that exactly one North Star event exists per unique Draft Order submission.
 * Non-blocking / safe: swallows all errors to prevent breaking core order flows.
 */
export async function recordAnalyticsEvent(
  shopId: string,
  eventName: string,
  catalogId?: string | null,
  metadata?: Record<string, any>,
  eventKey?: string | null
): Promise<void> {
  try {
    const shopExists = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { id: true },
    });
    if (!shopExists) return;

    const sanitizedMetadataJson = sanitizeAnalyticsMetadata(eventName, metadata);

    // Verify catalogId exists to avoid foreign key violations if an ephemeral catalog was used
    let validCatalogId: string | null = null;
    if (catalogId) {
      const catExists = await prisma.catalog.findUnique({
        where: { id: catalogId },
        select: { id: true },
      });
      if (catExists) {
        validCatalogId = catExists.id;
      }
    }

    if (eventKey) {
      await prisma.analyticsEvent.upsert({
        where: { eventKey },
        create: {
          shopId,
          catalogId: validCatalogId,
          eventName,
          eventKey,
          metadataJson: sanitizedMetadataJson,
        },
        update: {}, // Deduplicated: no-op if already recorded
      });
    } else {
      await prisma.analyticsEvent.create({
        data: {
          shopId,
          catalogId: validCatalogId,
          eventName,
          metadataJson: sanitizedMetadataJson,
        },
      });
    }
  } catch (err: any) {
    // Non-blocking log: analytics recording failure must never crash core order workflows
    console.error(`[Analytics] Failed to record event ${eventName}:`, err.message);
  }
}

export interface AnalyticsFunnelSummary {
  periodDays: number;
  counts: {
    catalogViews: number;
    orderSummariesStarted: number;
    ordersSubmitted: number;
    draftOrdersCreated: number; // North Star
  };
  conversionRates: {
    viewToSummaryPct: number;
    summaryToSubmitPct: number;
    submitToDraftPct: number;
    overallConversionPct: number;
  };
}

export async function getShopAnalyticsSummary(
  shopId: string,
  rawDays: number = 30
): Promise<AnalyticsFunnelSummary> {
  // Enforce bounded range: 1 <= days <= 90
  const days = Math.min(90, Math.max(1, Math.floor(Number(rawDays)) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const events = await prisma.analyticsEvent.findMany({
    where: {
      shopId,
      createdAt: { gte: since },
    },
    select: {
      eventName: true,
    },
  });

  let catalogViews = 0;
  let orderSummariesStarted = 0;
  let ordersSubmitted = 0;
  let draftOrdersCreated = 0;

  for (const ev of events) {
    if (ev.eventName === ANALYTICS_EVENTS.CATALOG_VIEWED) {
      catalogViews++;
    } else if (ev.eventName === ANALYTICS_EVENTS.ORDER_SUMMARY_STARTED) {
      orderSummariesStarted++;
    } else if (ev.eventName === ANALYTICS_EVENTS.ORDER_SUBMITTED) {
      ordersSubmitted++;
    } else if (ev.eventName === ANALYTICS_EVENTS.DRAFT_ORDER_CREATED) {
      draftOrdersCreated++;
    }
  }

  const roundPct = (num: number) => Math.round(num * 100) / 100;

  const viewToSummaryPct = catalogViews > 0 ? roundPct((orderSummariesStarted / catalogViews) * 100) : 0;
  const summaryToSubmitPct = orderSummariesStarted > 0 ? roundPct((ordersSubmitted / orderSummariesStarted) * 100) : 0;
  const submitToDraftPct = ordersSubmitted > 0 ? roundPct((draftOrdersCreated / ordersSubmitted) * 100) : 0;
  const overallConversionPct = catalogViews > 0 ? roundPct((draftOrdersCreated / catalogViews) * 100) : 0;

  return {
    periodDays: days,
    counts: {
      catalogViews,
      orderSummariesStarted,
      ordersSubmitted,
      draftOrdersCreated,
    },
    conversionRates: {
      viewToSummaryPct,
      summaryToSubmitPct,
      submitToDraftPct,
      overallConversionPct,
    },
  };
}
