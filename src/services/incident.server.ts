import { prisma } from '../db.js';
import { sanitizeForLogging } from './security.server.js';

export interface IncidentRecordInput {
  type: string;
  requestId?: string | null;
  shopDomain?: string | null;
  catalogId?: string | null;
  route?: string | null;
  stage?: string | null;
  errorCode?: string | null;
  message: string;
  metadata?: Record<string, any> | null;
}

/**
 * Sanitizes messages and metadata to ensure no secrets or PII are persisted.
 */
function sanitizeIncidentMessage(msg: string): string {
  if (!msg || typeof msg !== 'string') return '';
  return msg
    .replace(/shpat_[a-zA-Z0-9]+/g, '[REDACTED_TOKEN]')
    .replace(/shpss_[a-zA-Z0-9]+/g, '[REDACTED_SECRET]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .slice(0, 1000);
}

/**
 * Persists an operational incident to PostgreSQL RuntimeIncident table.
 * If database write fails, safely falls back to console.error without crashing.
 */
export async function recordRuntimeIncident(input: IncidentRecordInput, customPrisma?: any): Promise<void> {
  const safeMessage = sanitizeIncidentMessage(input.message);
  const safeMetadata = input.metadata ? sanitizeForLogging(input.metadata) : null;
  const db = customPrisma || prisma;

  try {
    await db.runtimeIncident.create({
      data: {
        type: input.type.slice(0, 64),
        requestId: input.requestId?.slice(0, 128) || null,
        shopDomain: input.shopDomain?.slice(0, 255) || null,
        catalogId: input.catalogId?.slice(0, 128) || null,
        route: input.route?.slice(0, 255) || null,
        stage: input.stage?.slice(0, 64) || null,
        errorCode: input.errorCode?.slice(0, 64) || null,
        message: safeMessage,
        metadata: safeMetadata ?? undefined,
      },
    });
  } catch (dbErr: any) {
    // Non-throwing fallback — never crash while attempting to record an incident
    try {
      console.error(
        JSON.stringify({
          level: 'ERROR',
          source: 'RuntimeIncidentFallback',
          type: input.type,
          requestId: input.requestId,
          shopDomain: input.shopDomain,
          message: safeMessage,
          dbError: dbErr?.message || 'Database unavailable',
          timestamp: new Date().toISOString(),
        })
      );
    } catch {
      // Ignore fallback serialization failure
    }
  }
}

/**
 * Fetches recent operational incidents isolated to a specific merchant's shop domain.
 * Enforces strict multi-tenant isolation and bounds response to at most 50 items.
 */
export async function getShopRuntimeIncidents(shopDomain: string, limit: number = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 50));
  return prisma.runtimeIncident.findMany({
    where: { shopDomain },
    take: safeLimit,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      type: true,
      requestId: true,
      catalogId: true,
      route: true,
      stage: true,
      errorCode: true,
      message: true,
      metadata: true,
    },
  });
}

let diagnosticsRegistered = false;

/**
 * Registers production-safe process-level diagnostic handlers for uncaughtException,
 * unhandledRejection, SIGTERM, and SIGINT.
 */
export function registerProcessDiagnostics(): void {
  if (diagnosticsRegistered) return;
  diagnosticsRegistered = true;

  process.on('uncaughtException', (err: Error) => {
    const errorInfo = {
      event: 'uncaughtException',
      timestamp: new Date().toISOString(),
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      errorName: err?.name || 'Error',
      message: sanitizeIncidentMessage(err?.message || 'Uncaught exception occurred'),
      stack: err?.stack ? sanitizeIncidentMessage(err.stack.slice(0, 1000)) : undefined,
    };

    try {
      console.error(JSON.stringify({ level: 'FATAL', ...errorInfo }));
    } catch {
      console.error('Fatal uncaughtException:', errorInfo.message);
    }

    void recordRuntimeIncident({
      type: 'PROCESS_CRASH',
      message: errorInfo.message,
      errorCode: 'UNCAUGHT_EXCEPTION',
      metadata: {
        errorName: errorInfo.errorName,
        uptimeSeconds: errorInfo.uptimeSeconds,
        pid: errorInfo.pid,
      },
    }).finally(() => {
      // Terminate cleanly after a short flush window
      setTimeout(() => {
        process.exit(1);
      }, 500).unref();
    });
  });

  process.on('unhandledRejection', (reason: any) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const errorInfo = {
      event: 'unhandledRejection',
      timestamp: new Date().toISOString(),
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      errorName: reason instanceof Error ? reason.name : 'UnhandledRejection',
      message: sanitizeIncidentMessage(message),
      stack: reason instanceof Error && reason.stack ? sanitizeIncidentMessage(reason.stack.slice(0, 1000)) : undefined,
    };

    try {
      console.error(JSON.stringify({ level: 'ERROR', ...errorInfo }));
    } catch {
      console.error('Unhandled rejection:', errorInfo.message);
    }

    void recordRuntimeIncident({
      type: 'UNHANDLED_REJECTION',
      message: errorInfo.message,
      errorCode: 'UNHANDLED_REJECTION',
      metadata: {
        errorName: errorInfo.errorName,
        uptimeSeconds: errorInfo.uptimeSeconds,
        pid: errorInfo.pid,
      },
    });
  });

  process.on('SIGTERM', () => {
    try {
      console.log(
        JSON.stringify({
          level: 'INFO',
          event: 'SIGTERM_RECEIVED',
          timestamp: new Date().toISOString(),
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
        })
      );
    } catch {
      console.log('SIGTERM received');
    }
  });

  process.on('SIGINT', () => {
    try {
      console.log(
        JSON.stringify({
          level: 'INFO',
          event: 'SIGINT_RECEIVED',
          timestamp: new Date().toISOString(),
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
        })
      );
    } catch {
      console.log('SIGINT received');
    }
  });
}

export type SubmitStage =
  | 'SUBMIT_RECEIVED'
  | 'CATALOG_VALIDATED'
  | 'CATALOG_MEMBERSHIP_VALIDATED'
  | 'QUOTA_RESERVED'
  | 'LIVE_REVALIDATION_STARTED'
  | 'LIVE_REVALIDATION_COMPLETED'
  | 'DRAFT_ORDER_CREATE_STARTED'
  | 'DRAFT_ORDER_CREATE_COMPLETED'
  | 'SUBMISSION_COMPLETED'
  | 'SUBMISSION_FAILED';

export class SubmitStageTracker {
  public requestId: string;
  public shopDomain?: string;
  public catalogId?: string;
  public lineCount: number = 0;
  private startTime: number;
  private currentStage: SubmitStage = 'SUBMIT_RECEIVED';
  private stageStartTime: number;

  constructor(requestId: string, shopDomain?: string, catalogId?: string, lineCount: number = 0) {
    this.requestId = requestId;
    this.shopDomain = shopDomain;
    this.catalogId = catalogId;
    this.lineCount = lineCount;
    this.startTime = Date.now();
    this.stageStartTime = this.startTime;
    this.logStage('SUBMIT_RECEIVED');
  }

  public setContext(context: { shopDomain?: string; catalogId?: string; lineCount?: number }) {
    if (context.shopDomain) this.shopDomain = context.shopDomain;
    if (context.catalogId) this.catalogId = context.catalogId;
    if (context.lineCount !== undefined) this.lineCount = context.lineCount;
  }

  public transition(stage: SubmitStage, errorCode?: string) {
    const now = Date.now();
    const stageElapsedMs = now - this.stageStartTime;
    const totalElapsedMs = now - this.startTime;

    // Check slow stage milestones (>5s, >10s, >20s)
    if (stageElapsedMs > 5000) {
      void recordRuntimeIncident({
        type: 'SLOW_STAGE',
        requestId: this.requestId,
        shopDomain: this.shopDomain,
        catalogId: this.catalogId,
        route: '/api/public/catalog/submit',
        stage: this.currentStage,
        message: `Stage ${this.currentStage} took ${stageElapsedMs}ms (>5s milestone)`,
        metadata: {
          previousStage: this.currentStage,
          nextStage: stage,
          stageElapsedMs,
          totalElapsedMs,
          lineCount: this.lineCount,
        },
      });
    }

    this.currentStage = stage;
    this.stageStartTime = now;
    this.logStage(stage, totalElapsedMs, errorCode);

    if (stage === 'SUBMISSION_FAILED') {
      void recordRuntimeIncident({
        type: 'SUBMISSION_FAILED',
        requestId: this.requestId,
        shopDomain: this.shopDomain,
        catalogId: this.catalogId,
        route: '/api/public/catalog/submit',
        stage: this.currentStage,
        errorCode,
        message: `Buyer submission failed at stage ${this.currentStage} (${totalElapsedMs}ms)`,
        metadata: {
          totalElapsedMs,
          lineCount: this.lineCount,
          errorCode,
        },
      });
    }
  }

  private logStage(stage: SubmitStage, elapsedMs?: number, errorCode?: string) {
    try {
      console.log(
        JSON.stringify({
          level: 'INFO',
          source: 'SubmitStageTrace',
          requestId: this.requestId,
          shopDomain: this.shopDomain,
          catalogId: this.catalogId,
          stage,
          lineCount: this.lineCount,
          elapsedMs: elapsedMs ?? 0,
          errorCode: errorCode || undefined,
          timestamp: new Date().toISOString(),
        })
      );
    } catch {
      // Ignore logging serialization failure
    }
  }
}
