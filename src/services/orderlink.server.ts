/**
 * Order Link Service
 *
 * Manages Wholesale Order Links — shareable, optionally passcode-protected
 * catalog URLs with per-link analytics (views, submissions, GMV).
 *
 * Security:
 *   - Tokens are cryptographically random (64 hex chars from 32 bytes of entropy)
 *   - Passcodes are stored as scrypt hashes, never plaintext
 *   - Passcodes are NEVER accepted in query strings or URLs
 *   - Unlocking generates a short-lived, scoped access credential (HMAC-SHA256)
 *   - All mutations are shop-scoped for multi-tenant isolation
 */

import { prisma } from '../db.js';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { CreateOrderLinkInput, UpdateOrderLinkInput } from '../types/index.js';

// ─── Token generation ──────────────────────────────────────────────────────────

export function generateOrderLinkToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ─── Passcode hashing ──────────────────────────────────────────────────────────

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, dkLen: 32 };
const SCRYPT_SALT_BYTES = 16;

export function hashPasscode(passcode: string): string {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const hash = crypto.scryptSync(passcode, salt, SCRYPT_PARAMS.dkLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPasscode(passcode: string, storedHash: string): boolean {
  try {
    const [saltHex, hashHex] = storedHash.split(':');
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(passcode, salt, SCRYPT_PARAMS.dkLen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ─── Scoped Access Credential (Token) for Passcode Protected Links ───────────

function getLinkSigningSecret(): string {
  return (
    process.env.SHOPIFY_API_SECRET ||
    process.env.SESSION_SECRET ||
    'catalogflow-link-access-token-secret-2026'
  );
}

export interface LinkAccessTokenPayload {
  linkId: string;
  linkToken: string;
  iat: number;
  exp: number;
}

/**
 * Generates a short-lived, cryptographically signed access credential
 * strictly scoped to a specific OrderLink after successful passcode verification.
 */
export function generateOrderLinkAccessToken(
  link: { id: string; token: string },
  expiresInSeconds = 4 * 3600 // 4 hours
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: LinkAccessTokenPayload = {
    linkId: link.id,
    linkToken: link.token,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const secret = getLinkSigningSecret();
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');

  return `${payloadB64}.${signature}`;
}

/**
 * Validates a scoped access credential against the specific OrderLink.
 */
export function verifyOrderLinkAccessToken(
  tokenString: string,
  link: { id: string; token: string }
): { valid: boolean; reason?: string } {
  try {
    if (!tokenString || typeof tokenString !== 'string') {
      return { valid: false, reason: 'PASSCODE_REQUIRED' };
    }

    const parts = tokenString.split('.');
    if (parts.length !== 2) {
      return { valid: false, reason: 'INVALID_ACCESS_TOKEN' };
    }

    const [payloadB64, signature] = parts;
    const secret = getLinkSigningSecret();
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payloadB64)
      .digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: 'INVALID_ACCESS_TOKEN' };
    }

    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload: LinkAccessTokenPayload = JSON.parse(payloadJson);

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return { valid: false, reason: 'ACCESS_TOKEN_EXPIRED' };
    }

    // Strict link scope check
    if (payload.linkId !== link.id || payload.linkToken !== link.token) {
      return { valid: false, reason: 'ACCESS_TOKEN_SCOPE_MISMATCH' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'INVALID_ACCESS_TOKEN' };
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createOrderLink(
  catalogId: string,
  shopId: string,
  input: CreateOrderLinkInput
) {
  const catalog = await prisma.catalog.findFirst({ where: { id: catalogId, shopId } });
  if (!catalog) {
    throw Object.assign(new Error('Catalog not found or unauthorized'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  const token = generateOrderLinkToken();
  const passcodeHash = input.passcode ? hashPasscode(input.passcode) : null;
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

  return prisma.orderLink.create({
    data: {
      catalogId,
      shopId,
      token,
      label: input.label ?? 'Default Link',
      active: true,
      passcodeHash,
      expiresAt,
      source: input.source ?? null,
    },
  });
}

export async function getOrderLinksForCatalog(catalogId: string, shopId: string) {
  return prisma.orderLink.findMany({
    where: { catalogId, shopId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getOrderLinkById(linkId: string, shopId: string) {
  const link = await prisma.orderLink.findFirst({ where: { id: linkId, shopId } });
  if (!link) {
    throw Object.assign(new Error('Order link not found'), { statusCode: 404, code: 'NOT_FOUND' });
  }
  return link;
}

export async function getOrderLinkByToken(token: string) {
  return prisma.orderLink.findUnique({
    where: { token },
    include: {
      catalog: { include: { shop: true, sources: true } },
    },
  });
}

export async function updateOrderLink(
  linkId: string,
  shopId: string,
  input: UpdateOrderLinkInput
) {
  const existing = await prisma.orderLink.findFirst({ where: { id: linkId, shopId } });
  if (!existing) {
    throw Object.assign(new Error('Order link not found or unauthorized'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  const data: Record<string, any> = {};
  if (input.label !== undefined) data.label = input.label;
  if (input.active !== undefined) data.active = input.active;
  if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (input.source !== undefined) data.source = input.source ?? null;
  // passcode: empty string clears it; any other value re-hashes
  if (input.passcode !== undefined) {
    data.passcodeHash = input.passcode ? hashPasscode(input.passcode) : null;
  }

  return prisma.orderLink.update({ where: { id: linkId }, data });
}

export async function deleteOrderLink(linkId: string, shopId: string) {
  const existing = await prisma.orderLink.findFirst({ where: { id: linkId, shopId } });
  if (!existing) {
    throw Object.assign(new Error('Order link not found or unauthorized'), { statusCode: 404, code: 'NOT_FOUND' });
  }
  await prisma.orderLink.delete({ where: { id: linkId } });
}

// ─── Analytics (Session Deduplication) ────────────────────────────────────────

const VIEW_DEDUPLICATION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const sessionViewCache = new Map<string, number>();

/**
 * Resets the session view deduplication cache (useful for automated testing).
 */
export function resetOrderLinkViewCache(): void {
  sessionViewCache.clear();
}

/**
 * Atomically increments the view counter for an order link with session deduplication.
 * If sessionIdentifier is provided, multiple views from the same session within 30 minutes
 * are counted at most once, preserving privacy without PII.
 */
export async function recordOrderLinkView(linkId: string, sessionIdentifier?: string): Promise<boolean> {
  const now = Date.now();

  if (sessionIdentifier) {
    const key = `${linkId}:${sessionIdentifier}`;
    const lastView = sessionViewCache.get(key);
    if (lastView && now - lastView < VIEW_DEDUPLICATION_WINDOW_MS) {
      // Deduplicated within session window
      return false;
    }
    sessionViewCache.set(key, now);

    // Prune stale cache entries if cache grows
    if (sessionViewCache.size > 5000) {
      for (const [k, ts] of sessionViewCache.entries()) {
        if (now - ts >= VIEW_DEDUPLICATION_WINDOW_MS) {
          sessionViewCache.delete(k);
        }
      }
    }
  }

  await prisma.$executeRaw`
    UPDATE "OrderLink"
    SET "views" = "views" + 1, "updatedAt" = NOW()
    WHERE "id" = ${linkId}
  `;
  return true;
}

/**
 * Atomically increments submissions counter and adds submitted GMV.
 */
export async function recordOrderLinkSubmission(linkId: string, value: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "OrderLink"
    SET "submissions" = "submissions" + 1,
        "submittedValue" = "submittedValue" + ${value}::numeric,
        "updatedAt" = NOW()
    WHERE "id" = ${linkId}
  `;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

export function isOrderLinkExpired(link: { expiresAt: Date | null }): boolean {
  if (!link.expiresAt) return false;
  return new Date() > link.expiresAt;
}

export function validateOrderLinkAccess(
  link: { id: string; token: string; active: boolean; expiresAt: Date | null; passcodeHash: string | null },
  linkAccessToken?: string | null
): { ok: boolean; reason?: string } {
  if (!link.active) return { ok: false, reason: 'LINK_INACTIVE' };
  if (isOrderLinkExpired(link)) return { ok: false, reason: 'LINK_EXPIRED' };
  if (link.passcodeHash) {
    if (!linkAccessToken) return { ok: false, reason: 'PASSCODE_REQUIRED' };
    const verification = verifyOrderLinkAccessToken(linkAccessToken, link);
    if (!verification.valid) {
      return { ok: false, reason: verification.reason || 'PASSCODE_REQUIRED' };
    }
  }
  return { ok: true };
}

// ─── QR Code ─────────────────────────────────────────────────────────────────

/**
 * Generates a QR code as a PNG data URL for the given buyer URL.
 */
export async function generateQrCodeDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 300,
  });
}

