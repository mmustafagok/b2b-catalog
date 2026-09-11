/**
 * Client authentication helpers for embedded Shopify Admin App Bridge.
 */

export interface AppBridgeTokenOptions {
  maxPolls?: number;
  pollInterval?: number;
  getWindow?: () => any;
}

/**
 * Polls for Shopify App Bridge readiness and retrieves a session ID token.
 *
 * App Bridge initializes asynchronously. Transient failures in idToken()
 * (e.g. handshake in progress or transient bridge error) continue polling
 * until the bounded timeout (maxPolls * pollInterval, default 30 * 100ms = 3000ms).
 */
export async function getAppBridgeToken(options: AppBridgeTokenOptions = {}): Promise<string | null> {
  const maxPolls = options.maxPolls ?? 30;
  const pollInterval = options.pollInterval ?? 100;
  const getWin = options.getWindow ?? (() => (typeof window !== 'undefined' ? (window as any) : undefined));

  for (let i = 0; i < maxPolls; i++) {
    const win = getWin();
    const shopify = win?.shopify;
    if (shopify && typeof shopify.idToken === 'function') {
      try {
        const token = await shopify.idToken();
        if (token && typeof token === 'string' && token.trim().length > 0) {
          return token.trim();
        }
      } catch {
        // Transient error from App Bridge; continue polling until bounded timeout
      }
    }
    if (i < maxPolls - 1 && pollInterval > 0) {
      await new Promise((r) => setTimeout(r, pollInterval));
    }
  }

  return null;
}

export interface AuthenticatedFetchDeps {
  tokenFetcher?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
}

/**
 * Executes an authenticated API request to /api/admin/*.
 *
 * Invariants:
 * 1. Requires a valid App Bridge token; throws immediately without calling fetch if token unavailable.
 * 2. Owns Authorization and Content-Type headers.
 * 3. Handles session expiry retry (X-Shopify-Retry-Invalid-Session-Request: 1) by fetching a fresh token
 *    and retrying exactly once.
 * 4. Throws a clear auth error if session refresh fails on retry (never returns stale unauthenticated response).
 */
export async function authenticatedFetch(
  url: string,
  options: RequestInit = {},
  deps: AuthenticatedFetchDeps = {}
): Promise<Response> {
  const tokenFetcher = deps.tokenFetcher ?? (() => getAppBridgeToken());
  const fetchImpl = deps.fetchFn ?? fetch;

  const token = await tokenFetcher();
  if (!token) {
    throw new Error('Shopify session token unavailable. Please reload the app.');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
    'Authorization': `Bearer ${token}`,
  };

  const firstRes = await fetchImpl(url, { ...options, headers });

  // Backend signals stale/invalid session token — retry once with a fresh token
  if (firstRes.headers?.get?.('X-Shopify-Retry-Invalid-Session-Request') === '1') {
    const retryToken = await tokenFetcher();
    if (!retryToken) {
      throw new Error('Shopify session expired and could not be refreshed. Please reload the app.');
    }
    const retryHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
      'Authorization': `Bearer ${retryToken}`,
    };
    return fetchImpl(url, { ...options, headers: retryHeaders });
  }

  return firstRes;
}
