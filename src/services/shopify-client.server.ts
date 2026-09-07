import { decryptToken } from './crypto.server.js';
import { sanitizeForLogging } from './security.server.js';

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
  accessToken: string; // Plaintext or encrypted envelope
}

export class ShopifyAdminClient {
  private shopDomain: string;
  private plainAccessToken: string;

  constructor(config: ShopifyClientConfig) {
    if (!config.shopDomain || !config.accessToken) {
      throw new Error('Shop domain and access token are required for ShopifyAdminClient');
    }
    this.shopDomain = config.shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.plainAccessToken = decryptToken(config.accessToken);
  }

  public getShopDomain(): string {
    return this.shopDomain;
  }

  /**
   * Executes a GraphQL query or mutation against Shopify Admin API 2026-07 with throttling awareness.
   */
  public async request<T = any>(
    query: string,
    variables?: Record<string, any>,
    maxRetries: number = 3
  ): Promise<T> {
    const endpoint = `https://${this.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

    let attempt = 0;
    while (attempt < maxRetries) {
      attempt++;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': this.plainAccessToken,
          },
          body: JSON.stringify({ query, variables }),
        });

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
          throw new ShopifyGraphQLError(
            `Shopify Admin API returned HTTP ${response.status}: ${errorText}`,
            undefined,
            undefined,
            response.status
          );
        }

        const json: any = await response.json();

        // Check top-level GraphQL errors
        if (json.errors && json.errors.length > 0) {
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
        if (err instanceof ShopifyGraphQLError) {
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
export function createShopifyClient(shop: { shopDomain: string; accessToken: string }): ShopifyAdminClient {
  return new ShopifyAdminClient(shop);
}
