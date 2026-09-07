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

/**
 * In-memory sliding window rate limiter for public endpoints.
 */
interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: { windowMs: number; max: number; message?: string }) {
  const store = new Map<string, RateLimitRecord>();

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown-ip';
    const now = Date.now();

    let record = store.get(ip);
    if (!record || record.resetAt <= now) {
      record = { count: 1, resetAt: now + options.windowMs };
      store.set(ip, record);
    } else {
      record.count++;
    }

    // Set standard rate limit headers
    res.setHeader('X-RateLimit-Limit', options.max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, options.max - record.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetAt / 1000));

    if (record.count > options.max) {
      return res.status(429).json({
        error: options.message || 'Too many requests. Please slow down and try again.',
      });
    }

    return next();
  };
}

/**
 * Sanitizes server errors for public/client responses.
 */
export function sanitizeErrorMessage(err: any): string {
  if (process.env.NODE_ENV === 'production') {
    return 'An unexpected server error occurred. Please try again later.';
  }
  return err?.message || 'Server error';
}
