import { decryptToken } from './crypto.server.js';
import { sanitizeForLogging } from './security.server.js';
import { getValidOfflineAccessToken, ShopifyAuthRequiredError } from './shopify-token.server.js';

export { ShopifyAuthRequiredError };
export const SHOPIFY_API_VERSION = '2026-07';

export class ShopifyGraphQLError extends Error {
  constructor(
    message: string,
    public errors?: any[],
    public userErrors?: any[],
    public statusCode?: number
  ) {
    super(message);
    this.name = 'ShopifyGraphQLError';
  }
}

export interface ShopifyClientConfig {
  shopDomain: string;
  shopId?: string;
  accessToken?: string; // Plaintext or encrypted envelope
  tokenProvider?: () => Promise<string>;
}

export class ShopifyAdminClient {
  private shopDomain: string;
  private shopId?: string;
  private plainAccessToken?: string;
  private tokenProvider?: () => Promise<string>;

  constructor(config: ShopifyClientConfig) {
    if (!config.shopDomain) {
      throw new Error('Shop domain is required for ShopifyAdminClient');
    }
    this.shopDomain = config.shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.shopId = config.shopId;
    this.tokenProvider = config.tokenProvider;

    if (config.accessToken) {
      try {
        this.plainAccessToken = decryptToken(config.accessToken);
      } catch {
        this.plainAccessToken = config.accessToken;
      }
    }
  }

  public getShopDomain(): string {
    return this.shopDomain;
  }

  private async resolveAccessToken(forceRefresh: boolean = false): Promise<string> {
    if (this.tokenProvider) {
      return this.tokenProvider();
    }
    if (this.shopId) {
      return getValidOfflineAccessToken(this.shopId, { forceRefresh });
    }
    if (this.plainAccessToken) {
      return this.plainAccessToken;
    }
    throw new ShopifyAuthRequiredError(
      `No access token or shop ID configured for ${this.shopDomain}`,
      this.shopDomain
    );
  }

  /**
   * Executes a GraphQL query or mutation against Shopify Admin API 2026-07 with throttling awareness
   * and expiring token rotation awareness.
   */
  public async request<T = any>(
    query: string,
    variables?: Record<string, any>,
    maxRetries: number = 3
  ): Promise<T> {
    const endpoint = `https://${this.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

    let attempt = 0;
    let hasAttemptedTokenRefresh = false;

    while (attempt < maxRetries) {
      attempt++;

      try {
        const currentToken = await this.resolveAccessToken();

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': currentToken,
          },
          body: JSON.stringify({ query, variables }),
        });

        // Handle 401 Unauthorized (Expired or Revoked Token)
        if (response.status === 401 && !hasAttemptedTokenRefresh && this.shopId) {
          hasAttemptedTokenRefresh = true;
          try {
            // Force refresh credentials through centralized credential service
            await this.resolveAccessToken(true);
            // Retry immediately
            continue;
          } catch (refreshErr) {
            throw new ShopifyAuthRequiredError(
              `Shopify API authentication failed (401) and token refresh failed on ${this.shopDomain}`,
              this.shopDomain
            );
          }
        }

        // Handle Throttling (HTTP 429)
        if (response.status === 429) {
          const retryAfter = parseFloat(response.headers.get('Retry-After') || '1.0');
          const delayMs = Math.ceil(retryAfter * 1000) + 100 * attempt;
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
          throw new ShopifyGraphQLError(`Shopify API rate limit exceeded on ${this.shopDomain}`, undefined, undefined, 429);
        }

        if (!response.ok) {
          const errorText = await response.text();
          if (response.status === 401) {
            throw new ShopifyAuthRequiredError(
              `Shopify Admin API rejected credentials (401): ${errorText}`,
              this.shopDomain
            );
          }
          throw new ShopifyGraphQLError(
            `Shopify Admin API returned HTTP ${response.status}: ${errorText}`,
            undefined,
            undefined,
            response.status
          );
        }

        const json: any = await response.json();

        // Check top-level GraphQL errors (detect THROTTLED cost budget errors for retry)
        if (json.errors && json.errors.length > 0) {
          const isThrottled = json.errors.some((e: any) =>
            e.extensions?.code === 'THROTTLED' || e.message?.toLowerCase().includes('throttled')
          );
          if (isThrottled && attempt < maxRetries) {
            const delayMs = Math.min(5000, Math.pow(2, attempt) * 500);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
          const errorMsg = json.errors.map((e: any) => e.message).join('; ');
          throw new ShopifyGraphQLError(`Shopify GraphQL Error: ${errorMsg}`, json.errors);
        }

        // Check for mutation userErrors if applicable
        const dataKeys = Object.keys(json.data || {});
        for (const key of dataKeys) {
          const mutationPayload = json.data[key];
          if (mutationPayload && Array.isArray(mutationPayload.userErrors) && mutationPayload.userErrors.length > 0) {
            const userErrorMsg = mutationPayload.userErrors.map((e: any) => e.message).join('; ');
            throw new ShopifyGraphQLError(`Shopify UserError: ${userErrorMsg}`, undefined, mutationPayload.userErrors);
          }
        }

        return json.data as T;
      } catch (err: any) {
        if (err instanceof ShopifyGraphQLError || err instanceof ShopifyAuthRequiredError) {
          throw err;
        }

        if (attempt >= maxRetries) {
          throw new ShopifyGraphQLError(
            `Shopify Admin GraphQL connection failed: ${err.message}`,
            undefined,
            undefined,
            500
          );
        }
        // Brief backoff before retry on network error
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }

    throw new ShopifyGraphQLError('Maximum retries exceeded');
  }
}

/**
 * Factory to create a ShopifyAdminClient for a shop.
 */
export function createShopifyClient(shop: { id?: string; shopDomain: string; accessToken?: string }): ShopifyAdminClient {
  return new ShopifyAdminClient({
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    accessToken: shop.accessToken,
  });
}
