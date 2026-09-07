import crypto from 'crypto';

export function verifyShopifyWebhookHmac(
  rawBody: string | Buffer,
  hmacHeader: string,
  secret: string
): boolean {
  if (!hmacHeader || !secret) {
    return false;
  }

  const generatedHmac = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(generatedHmac, 'utf8'),
      Buffer.from(hmacHeader, 'utf8')
    );
  } catch {
    return false;
  }
}

export function generateOpaqueToken(byteLength: number = 32): string {
  // 32 bytes = 256 bits of cryptographically secure randomness
  return crypto.randomBytes(byteLength).toString('hex');
}

export function hashIdempotencyKey(publicToken: string, idempotencyKey: string): string {
  return crypto
    .createHash('sha256')
    .update(`${publicToken}:${idempotencyKey}`)
    .digest('hex');
}

export interface DecodedSessionToken {
  dest: string; // e.g. https://example.myshopify.com
  iss: string;  // e.g. https://example.myshopify.com/admin
  aud: string;  // Shopify Client ID
  sub: string;  // User GID
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  sid: string;
  shopDomain: string;
}

const MYSHOPIFY_DOMAIN_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;

/**
 * Validates whether a domain is a safe, valid myshopify.com domain.
 */
export function isValidShopifyDomain(domain: string): boolean {
  if (!domain || typeof domain !== 'string') return false;
  const cleaned = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return MYSHOPIFY_DOMAIN_REGEX.test(cleaned);
}

/**
 * Verifies App Bridge JWT session tokens strictly against all required Shopify claims.
 */
export function verifyAppBridgeJwt(
  jwtToken: string,
  apiSecret: string,
  expectedClientId?: string
): DecodedSessionToken | null {
  if (!jwtToken || !apiSecret) {
    return null;
  }

  try {
    const parts = jwtToken.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature with timing-safe comparison
    const expectedSignature = crypto
      .createHmac('sha256', apiSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    if (
      signatureB64.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(Buffer.from(signatureB64), Buffer.from(expectedSignature))
    ) {
      return null;
    }

    const payload: DecodedSessionToken = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    );

    const now = Math.floor(Date.now() / 1000);
    const clockSkew = 10; // 10 seconds leeway

    // 1. Validate expiration (exp)
    if (typeof payload.exp !== 'number' || payload.exp < now - clockSkew) {
      return null;
    }

    // 2. Validate not-before (nbf)
    if (typeof payload.nbf === 'number' && payload.nbf > now + clockSkew) {
      return null;
    }

    // 3. Validate audience (aud)
    const targetAudience = expectedClientId || process.env.SHOPIFY_API_KEY;
    if (targetAudience && payload.aud !== targetAudience) {
      return null;
    }

    // 4. Validate dest format (must be https://{shop}.myshopify.com)
    if (!payload.dest || typeof payload.dest !== 'string') {
      return null;
    }
    const destHost = payload.dest.replace(/^https:\/\//, '').replace(/\/$/, '');
    if (!isValidShopifyDomain(destHost)) {
      return null;
    }

    // 5. Validate iss format (must be https://{shop}.myshopify.com/admin)
    if (!payload.iss || typeof payload.iss !== 'string') {
      return null;
    }
    const issHost = payload.iss
      .replace(/^https:\/\//, '')
      .replace(/\/admin\/?$/, '')
      .replace(/\/$/, '');

    // 6. dest and iss host must match exactly
    if (destHost.toLowerCase() !== issHost.toLowerCase()) {
      return null;
    }

    payload.shopDomain = destHost.toLowerCase();
    return payload;
  } catch {
    return null;
  }
}

/**
 * Validates Shopify OAuth callback query signature.
 */
export function verifyShopifyOauthHmac(queryParams: Record<string, string | string[]>, secret: string): boolean {
  const { hmac, ...rest } = queryParams;
  if (!hmac || typeof hmac !== 'string' || !secret) {
    return false;
  }

  // Sort keys alphabetically and format as key=value
  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const val = Array.isArray(rest[key]) ? (rest[key] as string[]).join(',') : rest[key];
      return `${key}=${val}`;
    })
    .join('&');

  const generatedHmac = crypto.createHmac('sha256', secret).update(message).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(generatedHmac, 'utf8'), Buffer.from(hmac, 'utf8'));
  } catch {
    return false;
  }
}
