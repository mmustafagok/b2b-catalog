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
  iss: string;
  sub: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  sid: string;
}

export function verifyAppBridgeJwt(jwtToken: string, apiSecret: string): DecodedSessionToken | null {
  try {
    const parts = jwtToken.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(signatureB64))) {
      return null;
    }

    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload: DecodedSessionToken = JSON.parse(payloadJson);

    // Validate timestamps (exp, nbf)
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null; // Expired
    }
    if (payload.nbf && payload.nbf > now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function extractShopDomainFromDest(dest: string): string {
  return dest.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
