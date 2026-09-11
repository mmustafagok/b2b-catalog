import React from 'react';
import ReactDOM from 'react-dom/client';
import { BuyerCatalogApp } from './buyer/BuyerCatalogApp.js';
import { MerchantAppShell } from './merchant/MerchantAppShell.js';

import { parseBuyerRoute } from './routeUtils.js';

/**
 * RootRouter: routes between MerchantAppShell (embedded Shopify Admin) and BuyerCatalogApp (public portal).
 *
 * Routing is PURELY pathname-based via canonical route parser. Shopify App Bridge embeds pass query params like
 * `?shop=`, `?host=`, `?embedded=1`, `?id_token=` — NONE of these should select BuyerCatalogApp.
 *
 * Canonical buyer route: /c/:publicToken (exact 64 hex chars, optional single trailing slash)
 * Merchant routes: / /app /app/* → MerchantAppShell
 */
export function RootRouter() {
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
  const { isBuyerRoute } = parseBuyerRoute(pathname);

  if (isBuyerRoute) {
    return <BuyerCatalogApp />;
  }

  return <MerchantAppShell />;
}

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <RootRouter />
    </React.StrictMode>
  );
}
