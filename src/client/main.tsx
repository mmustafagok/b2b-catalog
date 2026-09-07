import React from 'react';
import ReactDOM from 'react-dom/client';
import { BuyerCatalogApp } from './buyer/BuyerCatalogApp.js';
import { MerchantAppShell } from './merchant/MerchantAppShell.js';

export function RootRouter() {
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
  const isBuyerRoute = pathname.startsWith('/c/') || (typeof window !== 'undefined' && window.location.search.includes('token='));

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
