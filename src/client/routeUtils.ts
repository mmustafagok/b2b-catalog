/**
 * Shared route helpers for buyer catalog routing.
 *
 * Canonical buyer URL formats:
 *   /c/<64 hex token>       (Standard public catalog)
 *   /l/<64 hex token>       (Wholesale Order Link)
 * Optionally allow one trailing slash:
 *   /c/<token>/, /l/<token>/
 */

export const CANONICAL_CATALOG_ROUTE_REGEX = /^\/c\/([a-f0-9]{64})\/?$/i;
export const CANONICAL_BUYER_ROUTE_REGEX = CANONICAL_CATALOG_ROUTE_REGEX;
export const CANONICAL_LINK_ROUTE_REGEX = /^\/l\/([a-f0-9]{64})\/?$/i;

export type BuyerRouteType = 'catalog' | 'link';

export interface BuyerRouteParseResult {
  isBuyerRoute: boolean;
  token: string | null;
  routeType: BuyerRouteType | null;
}

/**
 * Parses a pathname to determine if it represents a valid canonical buyer route.
 * Routing is strictly pathname-based; query parameters (?token=, ?id_token=)
 * are never treated as valid buyer routes.
 */
export function parseBuyerRoute(pathname: string): BuyerRouteParseResult {
  if (typeof pathname !== 'string' || !pathname) {
    return { isBuyerRoute: false, token: null, routeType: null };
  }

  // Reject query-only strings (e.g. ?token=... or ?id_token=...)
  if (pathname.startsWith('?')) {
    return { isBuyerRoute: false, token: null, routeType: null };
  }

  // 1. Catalog route (/c/:token)
  const catMatch = pathname.match(CANONICAL_CATALOG_ROUTE_REGEX);
  if (catMatch) {
    return {
      isBuyerRoute: true,
      token: catMatch[1].toLowerCase(),
      routeType: 'catalog',
    };
  }

  // 2. Order Link route (/l/:token)
  const linkMatch = pathname.match(CANONICAL_LINK_ROUTE_REGEX);
  if (linkMatch) {
    return {
      isBuyerRoute: true,
      token: linkMatch[1].toLowerCase(),
      routeType: 'link',
    };
  }

  return { isBuyerRoute: false, token: null, routeType: null };
}

export function isBuyerRoutePath(pathname: string): boolean {
  return parseBuyerRoute(pathname).isBuyerRoute;
}

export function extractBuyerToken(pathname: string): string | null {
  return parseBuyerRoute(pathname).token;
}

