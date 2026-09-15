import { decryptToken } from './crypto.server.js';
import { sanitizeForLogging } from './security.server.js';
import { getValidOfflineAccessToken, ShopifyAuthRequiredError } from './shopify-token.server.js';

export { ShopifyAuthRequiredError };
export const SHOPIFY_API_VERSION = '2026-07';

/**
 * Classification of Shopify mutation result.
 *
 * DEFINITIVE_CLIENT_ERROR:
 *   Shopify rejected the request before any side effects.
 *   Examples: schema validation failure (undefined fields, wrong types),
 *   HTTP 400/401/403/422, mutation userErrors[].
 *   Safe to: mark FAILED, release quota, never retry draftOrderCreate.
 *
 * AMBIGUOUS_EXECUTION:
 *   The request was dispatched but the outcome is uncertain.
 *   Examples: HTTP 200 with top-level errors[] but data is null,
 *   network timeout, socket reset after request dispatch.
 *   Safe to: mark REQUIRES_RECONCILIATION, retain quota, query Shopify by tag.
 *   NEVER: mark FAILED, release quota, retry draftOrderCreate blindly.
 *
 * CONFIRMED_SUCCESS:
 *   Shopify returned a valid draftOrder.id and empty userErrors.
 *   Safe to: persist and finalize.
 */
export type ShopifyMutationClassification =
  | 'DEFINITIVE_CLIENT_ERROR'
  | 'AMBIGUOUS_EXECUTION'
  | 'CONFIRMED_SUCCESS';

export class ShopifyGraphQLError extends Error {
  /**
   * When true, the error represents an ambiguous execution result —
   * Shopify may have created the Draft Order before the error occurred.
   * Callers MUST treat this as REQUIRES_RECONCILIATION, not FAILED.
   */
  public ambiguous: boolean;

  constructor(
    message: string,
    public errors?: any[],
    public userErrors?: any[],
    public statusCode?: number,
    ambiguous: boolean = false
  ) {
    super(message);
    this.name = 'ShopifyGraphQLError';
    this.ambiguous = ambiguous;
  }

  /**
   * Returns true ONLY if Shopify definitively rejected the request due to
   * client/validation errors that are provably pre-execution:
   * - mutation userErrors[] (Shopify executed mutation but rejected input semantics)
   * - HTTP 4xx client errors (400, 401, 403, 422 — schema/auth rejection before execution)
   *
   * Critically: Top-level GraphQL errors[] on HTTP 200 are NOT definitive.
   * They may indicate post-execution field selection failures where the mutation
   * already committed (e.g. unknown field in selection set after object creation).
   */
  public isDefinitiveClientError(): boolean {
    if (this.userErrors && this.userErrors.length > 0) return true;
    // HTTP 4xx (except 429 throttle) = definitive client rejection
    if (this.statusCode && this.statusCode >= 400 && this.statusCode < 500 && this.statusCode !== 429) return true;
    // If this was marked as ambiguous, it is NOT a definitive error
    if (this.ambiguous) return false;
    return false;
  }

  /**
   * Returns true if the error is a temporary rate limit (429 or THROTTLED).
   */
  public isThrottled(): boolean {
    if (this.statusCode === 429) return true;
    if (this.errors && this.errors.some((e: any) => e.extensions?.code === 'THROTTLED' || e.message?.toLowerCase().includes('throttled'))) {
      return true;
    }
    return false;
  }

  /**
   * Returns true if the error was caused by a network timeout or connection abort.
   */
  public isTimeout(): boolean {
    return this.statusCode === 504 || this.message.toLowerCase().includes('timed out');
  }
}

export interface ShopifyClientConfig {
  shopDomain: string;
  shopId?: string;
  accessToken?: string; // Plaintext or encrypted envelope
  tokenProvider?: () => Promise<string>;
  timeoutMs?: number; // Per-request network timeout in milliseconds (default: 15000)
}

export class ShopifyAdminClient {
  private shopDomain: string;
  private shopId?: string;
  private plainAccessToken?: string;
  private tokenProvider?: () => Promise<string>;
  private timeoutMs: number;

  constructor(config: ShopifyClientConfig) {
    if (!config.shopDomain) {
      throw new Error('Shop domain is required for ShopifyAdminClient');
    }
    this.shopDomain = config.shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.shopId = config.shopId;
    this.tokenProvider = config.tokenProvider;
    this.timeoutMs = config.timeoutMs ?? 15000;

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
   *
   * Error classification contract:
   * - HTTP 4xx or userErrors → ShopifyGraphQLError with ambiguous=false (definitive)
   * - HTTP 200 + top-level errors[] with no draftOrder.id → ShopifyGraphQLError with ambiguous=true
   * - HTTP 200 + top-level errors[] WITH draftOrder.id present → return data (adopt the order)
   * - Timeout / network abort → ShopifyGraphQLError(504) with ambiguous=true
   * - HTTP 5xx → ShopifyGraphQLError(5xx) with ambiguous=true
   */
  public async request<T = any>(
    query: string,
    variables?: Record<string, any>,
    maxRetries: number = 3,
    overrideTimeoutMs?: number
  ): Promise<T> {
    const endpoint = `https://${this.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const timeoutMs = overrideTimeoutMs ?? this.timeoutMs;

    let attempt = 0;
    let hasAttemptedTokenRefresh = false;

    while (attempt < maxRetries) {
      attempt++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const currentToken = await this.resolveAccessToken();

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': currentToken,
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

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
          // HTTP 5xx = ambiguous (server-side failure after potential side effects)
          const isServerError = response.status >= 500;
          throw new ShopifyGraphQLError(
            `Shopify Admin API returned HTTP ${response.status}: ${errorText}`,
            undefined,
            undefined,
            response.status,
            isServerError // ambiguous if server error
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

          // CRITICAL: If the mutation payload actually created a draftOrder with a valid ID,
          // do NOT throw — the order exists. Adopt it immediately.
          const createdDraft = json.data?.draftOrderCreate?.draftOrder;
          if (createdDraft && createdDraft.id) {
            // Log warning (no buyer PII) for diagnostics — not an error
            const sanitizedErrors = json.errors.map((e: any) => ({
              message: e.message,
              extensions: e.extensions ? { code: e.extensions.code } : undefined,
            }));
            console.warn(
              '[ShopifyAdminClient] Top-level GraphQL errors present but draftOrder.id confirmed — adopting created order.',
              JSON.stringify({ errorCount: json.errors.length, sanitizedErrors })
            );
            return json.data as T;
          }

          // HTTP 200 + top-level errors + no draftOrder = AMBIGUOUS execution.
          // The mutation may have executed (created the order) before the field resolution failed.
          // Mark as ambiguous so callers route to REQUIRES_RECONCILIATION.
          const errorMsg = json.errors.map((e: any) => e.message).join('; ');
          const graphErr = new ShopifyGraphQLError(
            `Shopify GraphQL Error: ${errorMsg}`,
            json.errors,
            undefined,
            response.status || 200,
            true // ambiguous=true: do NOT classify as definitive failure
          );
          // Attach any partial data so callers can inspect if needed
          (graphErr as any).data = json.data;
          throw graphErr;
        }

        // Check for mutation userErrors if applicable
        const dataKeys = Object.keys(json.data || {});
        for (const key of dataKeys) {
          const mutationPayload = json.data[key];
          if (mutationPayload && Array.isArray(mutationPayload.userErrors) && mutationPayload.userErrors.length > 0) {
            const userErrorMsg = mutationPayload.userErrors.map((e: any) => {
              const fieldStr = Array.isArray(e.field) ? e.field.join('.') : e.field ? String(e.field) : '';
              return fieldStr ? `[${fieldStr}] ${e.message}` : e.message;
            }).join('; ');
            // userErrors are DEFINITIVE: Shopify rejected the mutation semantics
            throw new ShopifyGraphQLError(
              `Shopify UserError: ${userErrorMsg}`,
              undefined,
              mutationPayload.userErrors,
              422,
              false // ambiguous=false: definitive rejection
            );
          }
        }

        return json.data as T;
      } catch (err: any) {
        clearTimeout(timeoutId);

        if (err instanceof ShopifyGraphQLError || err instanceof ShopifyAuthRequiredError) {
          throw err;
        }

        const isTimeout = err?.name === 'AbortError' || controller.signal.aborted;
        if (isTimeout) {
          // Timeout = ambiguous: request was dispatched, may have reached Shopify
          throw new ShopifyGraphQLError(
            `Shopify Admin API network request timed out after ${timeoutMs}ms on ${this.shopDomain}`,
            undefined,
            undefined,
            504,
            true // ambiguous=true
          );
        }

        if (attempt >= maxRetries) {
          // Network failure after max retries = ambiguous
          throw new ShopifyGraphQLError(
            `Shopify Admin GraphQL connection failed: ${err.message}`,
            undefined,
            undefined,
            500,
            true // ambiguous=true
          );
        }
        // Brief backoff before retry on network error
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }

    throw new ShopifyGraphQLError('Maximum retries exceeded', undefined, undefined, 500, true);
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
