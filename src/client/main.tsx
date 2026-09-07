import React from 'react';
import ReactDOM from 'react-dom/client';
import { BuyerCatalogApp } from './buyer/BuyerCatalogApp.js';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <BuyerCatalogApp />
    </React.StrictMode>
  );
}
