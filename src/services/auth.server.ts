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

export interface TokenExchangeResult {
  accessToken: string;
  scope: string;
}

/**
 * Exchanges an App Bridge session token (ID token) for an offline access token
 * using Shopify Managed Installation token exchange (RFC 8693).
 */
export async function exchangeSessionTokenForOfflineToken(params: {
  shopDomain: string;
  sessionToken: string;
  clientId?: string;
  clientSecret?: string;
  fetchFn?: typeof fetch;
}): Promise<TokenExchangeResult> {
  const { shopDomain, sessionToken, clientId, clientSecret, fetchFn } = params;
  const targetClientId = clientId || process.env.SHOPIFY_API_KEY;
  const targetClientSecret = clientSecret || process.env.SHOPIFY_API_SECRET;

  if (!targetClientId || !targetClientSecret) {
    throw new Error('Shopify client ID or secret is not configured');
  }

  if (!isValidShopifyDomain(shopDomain)) {
    throw new Error(`Invalid shop domain: ${shopDomain}`);
  }

  const cleanDomain = shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const tokenUrl = `https://${cleanDomain}/admin/oauth/access_token`;
  const body = {
    client_id: targetClientId,
    client_secret: targetClientSecret,
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: sessionToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id-token',
    requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
  };

  const customFetch = fetchFn || fetch;
  const response = await customFetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  const data: any = await response.json();
  if (!data.access_token) {
    throw new Error('Token exchange response missing access_token');
  }

  return {
    accessToken: data.access_token,
    scope: data.scope || '',
  };
}

