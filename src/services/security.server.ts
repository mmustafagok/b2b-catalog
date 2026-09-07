import { Request, Response, NextFunction } from 'express';

const REDACTED_KEYS = new Set([
  'accesstoken',
  'token',
  'secret',
  'authorization',
  'cookie',
  'password',
  'code',
  'client_secret',
  'buyeremail',
  'email',
]);

/**
 * Validates public token format (64 hex characters = 32 bytes).
 */
export function isValidPublicToken(token: string): boolean {
  return typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token);
}

/**
 * Deeply sanitizes logs by redacting sensitive fields and PII.
 */
export function sanitizeForLogging(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // Redact email patterns
    return obj.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]');
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLogging);
  }

  if (typeof obj === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (REDACTED_KEYS.has(lowerKey) || lowerKey.includes('secret') || lowerKey.includes('token')) {
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
 * Sanitizes server errors for public/client responses.
 */
export function sanitizeErrorMessage(err: any): string {
  if (process.env.NODE_ENV === 'production') {
    return 'An unexpected server error occurred. Please try again later.';
  }
  return err?.message || 'Server error';
}
