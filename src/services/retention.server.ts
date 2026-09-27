import { prisma } from '../db.js';
import { sanitizeErrorMessage } from './security.server.js';

export const RETENTION_RUNTIME_INCIDENT_DAYS = 30;
export const RETENTION_WEBHOOK_RECEIPT_DAYS = 30;
export const RETENTION_BACKGROUND_JOB_DAYS = 14;
export const RETENTION_ANALYTICS_EVENT_DAYS = 90;
export const RETENTION_PCD_ACCESS_AUDIT_DAYS = 90;

/**
 * Architectural property: Raw buyer Protected Customer Data (email, business name,
 * PO number, buyer note) has ZERO persistent retention in the application database.
 * Form inputs exist transiently in memory only to transmit to the Shopify Draft Order API.
 */
export const RETENTION_BUYER_PCD_PERSISTENT_DAYS = 0;

export interface RetentionEnforcementResult {
  deletedIncidents: number;
  deletedWebhooks: number;
  deletedJobs: number;
  deletedAnalytics: number;
  deletedAudits: number;
  durationMs: number;
}

/**
 * Enforces data retention policies for operational, non-PII application tables.
 *
 * Rules:
 * 1. RuntimeIncident: Purged after 30 days.
 * 2. WebhookReceipt: Purged after 30 days.
 * 3. BackgroundJob: COMPLETED or FAILED jobs purged after 14 days (PENDING/PROCESSING retained).
 * 4. AnalyticsEvent: Purged after 90 days.
 * 5. PcdAccessAudit: Purged after 90 days.
 * 6. OrderSubmission & Snapshots: Retained during active merchant installation (zero raw PII).
 *
 * Cleanup is idempotent, bounded, non-destructive, and shop-safe.
 */
export async function enforceDataRetention(options?: {
  customPrisma?: any;
  now?: Date;
}): Promise<RetentionEnforcementResult> {
  const db = options?.customPrisma || prisma;
  const now = options?.now || new Date();
  const startTime = Date.now();

  const cutoffIncidents = new Date(now.getTime() - RETENTION_RUNTIME_INCIDENT_DAYS * 24 * 60 * 60 * 1000);
  const cutoffWebhooks = new Date(now.getTime() - RETENTION_WEBHOOK_RECEIPT_DAYS * 24 * 60 * 60 * 1000);
  const cutoffJobs = new Date(now.getTime() - RETENTION_BACKGROUND_JOB_DAYS * 24 * 60 * 60 * 1000);
  const cutoffAnalytics = new Date(now.getTime() - RETENTION_ANALYTICS_EVENT_DAYS * 24 * 60 * 60 * 1000);
  const cutoffAudits = new Date(now.getTime() - RETENTION_PCD_ACCESS_AUDIT_DAYS * 24 * 60 * 60 * 1000);

  // 1. Purge stale runtime incidents older than 30 days
  const incidentsRes = await db.runtimeIncident.deleteMany({
    where: {
      createdAt: { lt: cutoffIncidents },
    },
  }).catch((err: any) => {
    console.warn('[Retention] Error purging runtime incidents:', sanitizeErrorMessage(err));
    return { count: 0 };
  });

  // 2. Purge stale webhook receipts older than 30 days
  const webhooksRes = await db.webhookReceipt.deleteMany({
    where: {
      processedAt: { lt: cutoffWebhooks },
    },
  }).catch((err: any) => {
    console.warn('[Retention] Error purging webhook receipts:', sanitizeErrorMessage(err));
    return { count: 0 };
  });

  // 3. Purge terminal background jobs (COMPLETED / FAILED) older than 14 days
  const jobsRes = await db.backgroundJob.deleteMany({
    where: {
      status: { in: ['COMPLETED', 'FAILED'] },
      createdAt: { lt: cutoffJobs },
    },
  }).catch((err: any) => {
    console.warn('[Retention] Error purging background jobs:', sanitizeErrorMessage(err));
    return { count: 0 };
  });

  // 4. Purge aggregated analytics events older than 90 days
  const analyticsRes = await db.analyticsEvent.deleteMany({
    where: {
      createdAt: { lt: cutoffAnalytics },
    },
  }).catch((err: any) => {
    console.warn('[Retention] Error purging analytics events:', sanitizeErrorMessage(err));
    return { count: 0 };
  });

  // 5. Purge PCD access audit logs older than 90 days
  const auditsRes = await db.pcdAccessAudit.deleteMany({
    where: {
      createdAt: { lt: cutoffAudits },
    },
  }).catch((err: any) => {
    console.warn('[Retention] Error purging PCD access audits:', sanitizeErrorMessage(err));
    return { count: 0 };
  });

  const durationMs = Date.now() - startTime;

  return {
    deletedIncidents: incidentsRes.count,
    deletedWebhooks: webhooksRes.count,
    deletedJobs: jobsRes.count,
    deletedAnalytics: analyticsRes.count,
    deletedAudits: auditsRes.count,
    durationMs,
  };
}
