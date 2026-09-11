/**
 * Shared route helpers for buyer catalog routing.
 *
 * Canonical buyer URL format:
 *   /c/<64 hex token>
 * Optionally allow one trailing slash:
 *   /c/<64 hex token>/
 *
 * Reject:
 *   /c/foo
 *   /c/<token>/anything
 *   /foo/c/<token>
 *   ?token=
 *   ?id_token=
 */

export const CANONICAL_BUYER_ROUTE_REGEX = /^\/c\/([a-f0-9]{64})\/?$/i;

export interface BuyerRouteParseResult {
  isBuyerRoute: boolean;
  token: string | null;
}

/**
 * Parses a pathname to determine if it represents a valid canonical buyer route.
 * Routing is strictly pathname-based; query parameters (?token=, ?id_token=)
 * are never treated as valid buyer routes.
 */
export function parseBuyerRoute(pathname: string): BuyerRouteParseResult {
  if (typeof pathname !== 'string' || !pathname) {
    return { isBuyerRoute: false, token: null };
  }

  // Reject query-only strings (e.g. ?token=... or ?id_token=...)
  if (pathname.startsWith('?')) {
    return { isBuyerRoute: false, token: null };
  }

  // Match against canonical route pattern
  const match = pathname.match(CANONICAL_BUYER_ROUTE_REGEX);
  if (!match) {
    return { isBuyerRoute: false, token: null };
  }

  return {
    isBuyerRoute: true,
    token: match[1].toLowerCase(),
  };
}

export function isBuyerRoutePath(pathname: string): boolean {
  return parseBuyerRoute(pathname).isBuyerRoute;
}

export function extractBuyerToken(pathname: string): string | null {
  return parseBuyerRoute(pathname).token;
}
