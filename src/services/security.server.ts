import { Request, Response, NextFunction } from 'express';

const REDACTED_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'token',
  'publictoken',
  'linkaccesstoken',
  'secret',
  'client_secret',
  'apisecret',
  'partnersecret',
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passcode',
  'passcodehash',
  'code',
  'oauthcode',
  'buyeremail',
  'email',
  'customeremail',
  'businessname',
  'buyerbusinessname',
  'company',
  'companyname',
  'ponumber',
  'purchaseorder',
  'purchaseordernumber',
  'buyernote',
  'ordernote',
  'note',
  'notes',
  'buyer',
  'database_url',
  'databaseurl',
  'worker_database_url',
]);

/**
 * Validates public token format (64 hex characters = 32 bytes).
 */
export function isValidPublicToken(token: string): boolean {
  return typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token);
}

/**
 * Redacts PII, tokens, and credentials from arbitrary string content.
 */
export function redactSensitiveString(str: string): string {
  if (!str || typeof str !== 'string') return '';

  return str
    // 1. Database connection strings with credentials (run before email so user:pass@host is not matched as email)
    .replace(/(?:postgres(?:ql)?|mysql|sqlite):\/\/[^:]+:[^@]+@[^\/\s"']+/gi, 'postgresql://[REDACTED_USER]:[REDACTED_PASSWORD]@[REDACTED_HOST]')
    // 2. Email addresses
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '[REDACTED_EMAIL]')
    // 3. Shopify shared secrets (shpss_) and tokens (shpat_, shpca_, shppa_, shppat_) + encrypted ciphertext markers
    .replace(/shpss_[a-zA-Z0-9_\-]+/gi, '[REDACTED_SECRET]')
    .replace(/(?:shpat_|shpca_|shppa_|shppat_|enc:v1:)[a-zA-Z0-9_\-:]+/gi, '[REDACTED_SHOPIFY_TOKEN]')
    // 4. Authorization headers (Bearer / Basic)
    .replace(/(?:Bearer|Basic)\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED_TOKEN]')
    // 5. PO number patterns (e.g. PO-SECRET-123 or poNumber: "...")
    .replace(/\bPO-[A-Z0-9_-]+\b/gi, '[REDACTED_PO]')
    .replace(/(?:po[-_]?number|purchase[-_]?order(?:[-_]?number)?|po)\s*[:=]\s*["']?([^\s"',;]+)["']?/gi, 'poNumber=[REDACTED_PO]')
    // 6. Business name key-value assignments
    .replace(/(?:business[-_]?name|company(?:[-_]?name)?)\s*[:=]\s*["']?([^"',;\r\n]+?)["']?(?:,|\r|\n|$)/gi, 'businessName=[REDACTED_BUSINESS]')
    // 7. Buyer/order note key-value assignments
    .replace(/(?:buyer[-_]?notes?|order[-_]?notes?)\s*[:=]\s*["']?([^"',;\r\n]+?)["']?(?:,|\r|\n|$)/gi, 'buyerNote=[REDACTED_NOTE]')
    // 8. Passwords / secrets / passcodes
    .replace(/(?:password|passcode|secret|api[-_]?key)\s*[:=]\s*["']?([^\s"',;]+)["']?/gi, 'password=[REDACTED]');
}

/**
 * Deeply sanitizes logs by redacting sensitive fields and PII.
 * Handles strings, arrays, objects, Error instances, and nested structures.
 */
export function sanitizeForLogging(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return redactSensitiveString(obj);
  }

  if (obj instanceof Error) {
    return {
      name: redactSensitiveString(obj.name),
      message: redactSensitiveString(obj.message),
      code: (obj as any).code,
      statusCode: (obj as any).statusCode || (obj as any).status,
      stack: obj.stack ? redactSensitiveString(obj.stack) : undefined,
      cause: (obj as any).cause ? sanitizeForLogging((obj as any).cause) : undefined,
    };
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLogging);
  }

  if (typeof obj === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (
        REDACTED_KEYS.has(lowerKey) ||
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('password') ||
        lowerKey.includes('passcode') ||
        lowerKey.includes('cookie') ||
        lowerKey.includes('email')
      ) {
        cleaned[key] = '[REDACTED]';
      } else {
        cleaned[key] = sanitizeForLogging(val);
      }
    }
    return cleaned;
  }

  return obj;
}

import crypto from 'crypto';

/**
 * In-memory sliding window rate limiter for public endpoints (M9.2).
 * Keys are hashed representations of (IP + route category + optional token) so
 * raw IP addresses are never stored persistently or in plain text.
 */
interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  routeCategory?: string;
  message?: string;
}) {
  const store = new Map<string, RateLimitRecord>();
  const routeCategory = options.routeCategory || 'generic';

  // Periodic cleanup of expired entries every 60 seconds to prevent unbounded memory growth
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of store.entries()) {
      if (record.resetAt <= now) {
        store.delete(key);
      }
    }
  }, 60000);
  cleanupTimer.unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    const rawIp = req.ip || req.socket.remoteAddress || 'unknown-ip';
    const publicToken = req.params?.publicToken || '';

    // Non-reversible hashed identifier: IP + route + publicToken hash
    const bucketKey = crypto
      .createHash('sha256')
      .update(`${rawIp}:${routeCategory}:${publicToken}`)
      .digest('hex')
      .slice(0, 32);

    const now = Date.now();

    let record = store.get(bucketKey);
    if (!record || record.resetAt <= now) {
      record = { count: 1, resetAt: now + options.windowMs };
      store.set(bucketKey, record);
    } else {
      record.count++;
    }

    const remaining = Math.max(0, options.max - record.count);
    const resetSeconds = Math.ceil(record.resetAt / 1000);
    const retryAfter = Math.max(1, Math.ceil((record.resetAt - now) / 1000));

    // Standard RFC-compliant and Shopify-standard rate limit headers
    res.setHeader('X-RateLimit-Limit', options.max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetSeconds);

    if (record.count > options.max) {
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: options.message || 'Too many requests. Please slow down and try again.',
        code: 'RATE_LIMITED',
        retryAfterSeconds: retryAfter,
      });
    }

    return next();
  };
}

// Tiered public rate limiters configured for wholesale traffic patterns (M9.2)
export const publicCatalogGetLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120, // 120 views per minute per hashed IP bucket
  routeCategory: 'catalog_view',
  message: 'Too many catalog load requests. Please wait a moment before reloading.',
});

export const publicValidateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60, // 60 cart validations per minute
  routeCategory: 'catalog_validate',
  message: 'Too many cart revalidation checks. Please wait a few seconds.',
});

export const publicSubmitLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30, // 30 order submit attempts per minute
  routeCategory: 'catalog_submit',
  message: 'Order submission rate limit exceeded. Please wait a moment before trying again.',
});

export const publicEventLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60, // 60 client-side telemetry events per minute
  routeCategory: 'catalog_event',
  message: 'Event rate limit exceeded. Please slow down.',
});

/**
 * Sanitizes server errors for public/client responses, persistent database fields, and logs.
 * Guarantees that raw emails, tokens, secrets, PO numbers, and business names are redacted.
 */
export function sanitizeErrorMessage(err: any): string {
  let raw = '';
  if (typeof err === 'string') {
    raw = err;
  } else if (!err) {
    return 'An unexpected error occurred';
  } else if (Array.isArray(err.issues)) {
    // ZodError extends Error and its default message is a raw JSON issue array.
    // Prefer concise field-level text for every API/UI consumer.
    raw = err.issues
      .map((issue: any) => `${issue.path?.join('.') || 'field'}: ${issue.message}`)
      .join(', ');
  } else if (err instanceof Error) {
    raw = err.message || 'An error occurred';
  } else if (typeof err === 'object') {
    if (typeof err.message === 'string') raw = err.message;
    else if (typeof err.error === 'string') raw = err.error;
    else {
      raw = 'An unexpected server error occurred. Please try again.';
    }
  } else {
    raw = String(err);
  }

  return redactSensitiveString(raw);
}

export function parseApiErrorMessage(jsonOrErr: any, defaultMsg = 'An error occurred'): string {
  if (!jsonOrErr) return defaultMsg;
  if (typeof jsonOrErr === 'string') return jsonOrErr;

  const raw = jsonOrErr.error ?? jsonOrErr.message ?? jsonOrErr;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null) {
    if (typeof raw.message === 'string') return raw.message;
    if (typeof raw.error === 'string') return raw.error;
    if (typeof raw.detail === 'string') return raw.detail;
  }
  return defaultMsg;
}
