import { prisma } from '../db.js';

export const PCD_AUDIT_ACTIONS = {
  BUYER_EMAIL_PROCESSED_FOR_DRAFT_ORDER: 'BUYER_EMAIL_PROCESSED_FOR_DRAFT_ORDER',
  CUSTOMERS_DATA_REQUEST_RECEIVED: 'CUSTOMERS_DATA_REQUEST_RECEIVED',
  CUSTOMERS_REDACT_RECEIVED: 'CUSTOMERS_REDACT_RECEIVED',
  SHOP_REDACT_RECEIVED: 'SHOP_REDACT_RECEIVED',
  SHOP_DATA_PURGED: 'SHOP_DATA_PURGED',
} as const;

export type PcdAuditAction = (typeof PCD_AUDIT_ACTIONS)[keyof typeof PCD_AUDIT_ACTIONS];

export interface RecordPcdAccessAuditInput {
  shopId: string;
  catalogId?: string | null;
  requestId?: string | null;
  action: PcdAuditAction;
  purpose: string;
  actorType: 'BUYER' | 'SHOPIFY_WEBHOOK' | 'SYSTEM';
}

/**
 * Records a zero-PII audit trail event for Shopify Protected Customer Data Level 2 compliance.
 *
 * CRITICAL INVARIANT:
 * NEVER stores email, customer name, phone, address, business name, PO number,
 * buyer note, request body, or raw variables. Only operational metadata proving
 * the protected data operation occurred for lawful business purposes.
 */
export async function recordPcdAccessAudit(
  input: RecordPcdAccessAuditInput,
  customPrisma?: any
): Promise<void> {
  const db = customPrisma || prisma;

  try {
    await db.pcdAccessAudit.create({
      data: {
        shopId: input.shopId.slice(0, 128),
        catalogId: input.catalogId?.slice(0, 128) || null,
        requestId: input.requestId?.slice(0, 128) || null,
        action: input.action,
        purpose: input.purpose.slice(0, 255),
        actorType: input.actorType,
      },
    });
  } catch (err: any) {
    // Non-throwing resilience: audit recording failure must not break customer order submission
    console.error(
      JSON.stringify({
        level: 'WARN',
        source: 'PcdAccessAuditFallback',
        message: 'Failed to record PCD access audit log',
        action: input.action,
        shopId: input.shopId,
        error: err?.message || 'Database unavailable',
        timestamp: new Date().toISOString(),
      })
    );
  }
}
