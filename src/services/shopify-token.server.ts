import { prisma } from '../db.js';
import { decryptToken, encryptToken } from './crypto.server.js';
import { sanitizeErrorMessage } from './security.server.js';

export class ShopifyAuthRequiredError extends Error {
  constructor(message: string, public shopDomain?: string) {
    super(message);
    this.name = 'ShopifyAuthRequiredError';
  }
}

// In-flight refresh deduplication per shop to prevent concurrent refresh storms
const inFlightRefreshes = new Map<string, Promise<string>>();

export interface TokenRefreshOptions {
  forceRefresh?: boolean;
  fetchFn?: typeof fetch;
}

/**
 * Centralized credential service: returns a currently valid offline access token.
 * Refreshes expiring tokens automatically using stored refresh tokens (RFC 6749 refresh flow).
 * Rotated refresh token and access token pairs are persisted atomically.
 */
export async function getValidOfflineAccessToken(
  shopId: string,
  options?: TokenRefreshOptions
): Promise<string> {
  const shop = await prisma.shop.findFirst({
    where: {
      id: shopId,
      uninstalledAt: null,
    },
  });

  if (!shop || !shop.accessToken) {
    throw new ShopifyAuthRequiredError(
      'Shop not found, uninstalled, or missing credentials',
      shop?.shopDomain
    );
  }

  const now = Date.now();
  const bufferMs = 5 * 60 * 1000; // 5 minute safety buffer before expiry

  const hasExpiry = Boolean(shop.accessTokenExpiresAt);
  const isExpiring = hasExpiry && (shop.accessTokenExpiresAt!.getTime() - now <= bufferMs);
  const force = Boolean(options?.forceRefresh);

  // If token is still safely usable and not forcing refresh, return decrypted access token immediately
  if (!force && (!hasExpiry || !isExpiring)) {
    try {
      return decryptToken(shop.accessToken);
    } catch (err: any) {
      throw new ShopifyAuthRequiredError(
        `Failed to decrypt access token: ${sanitizeErrorMessage(err)}`,
        shop.shopDomain
      );
    }
  }

  // Token is expired/expiring or forceRefresh requested: must refresh using refresh_token
  if (!shop.refreshToken) {
    // If token has already expired and no refresh token exists, re-auth is mandatory
    if (hasExpiry && shop.accessTokenExpiresAt!.getTime() <= now) {
      throw new ShopifyAuthRequiredError(
        'Offline access token expired and no refresh token available. Re-authentication required.',
        shop.shopDomain
      );
    }
    // Still within safety margin, return current token
    return decryptToken(shop.accessToken);
  }

  // Deduplicate concurrent refreshes for the same shop
  if (inFlightRefreshes.has(shopId)) {
    return inFlightRefreshes.get(shopId)!;
  }

  const refreshPromise = (async () => {
    try {
      const decryptedRefreshToken = decryptToken(shop.refreshToken!);
      const clientId = process.env.SHOPIFY_API_KEY;
      const clientSecret = process.env.SHOPIFY_API_SECRET;

      if (!clientId || !clientSecret) {
        throw new Error('Shopify client ID or secret not configured');
      }

      const cleanDomain = shop.shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const tokenUrl = `https://${cleanDomain}/admin/oauth/access_token`;

      const bodyParams = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: decryptedRefreshToken,
      });

      const customFetch = options?.fetchFn || fetch;
      const response = await customFetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: bodyParams.toString(),
      });

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 400 || response.status === 401) {
          // Refresh token revoked or expired: mark re-auth required
          throw new ShopifyAuthRequiredError(
            `Shopify refresh token rejected (${response.status}). Re-authentication required: ${errText}`,
            shop.shopDomain
          );
        }
        throw new Error(`Token refresh failed (${response.status}): ${errText}`);
      }

      const data: any = await response.json();
      if (!data.access_token) {
        throw new Error('Refresh response missing access_token');
      }

      const rawExpiresIn = Number(data.expires_in);
      if (!data.expires_in || isNaN(rawExpiresIn) || rawExpiresIn <= 0) {
        throw new Error('Refresh response missing valid expires_in');
      }
      const newAccessExpiry = new Date(Date.now() + rawExpiresIn * 1000);

      const rawRefreshExpiresIn = data.refresh_token_expires_in
        ? Number(data.refresh_token_expires_in)
        : undefined;
      const newRefreshExpiry = (rawRefreshExpiresIn !== undefined && !isNaN(rawRefreshExpiresIn) && rawRefreshExpiresIn > 0)
        ? new Date(Date.now() + rawRefreshExpiresIn * 1000)
        : null;

      const encryptedAccessToken = encryptToken(data.access_token);
      const encryptedRefreshToken = data.refresh_token ? encryptToken(data.refresh_token) : undefined;

      // Atomically persist new token pair and updated expiry timestamps
      await prisma.shop.update({
        where: { id: shopId },
        data: {
          accessToken: encryptedAccessToken,
          accessTokenExpiresAt: newAccessExpiry,
          ...(encryptedRefreshToken ? { refreshToken: encryptedRefreshToken } : {}),
          ...(newRefreshExpiry ? { refreshTokenExpiresAt: newRefreshExpiry } : {}),
          updatedAt: new Date(),
        },
      });

      return data.access_token;
    } catch (err: any) {
      if (err instanceof ShopifyAuthRequiredError) {
        throw err;
      }
      throw new Error(`Failed to refresh Shopify access token: ${sanitizeErrorMessage(err)}`);
    }
  })();

  inFlightRefreshes.set(shopId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inFlightRefreshes.delete(shopId);
  }
}
