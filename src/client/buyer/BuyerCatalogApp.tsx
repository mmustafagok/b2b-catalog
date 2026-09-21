import React, { useState, useEffect, useMemo } from 'react';
import { VariantMatrix, ProductItem } from './VariantMatrix.js';
import { QuickOrderView } from './QuickOrderView.js';
import { CsvBulkUpload } from './CsvBulkUpload.js';
import { PasscodeGate } from './PasscodeGate.js';
import { OrderSummaryDrawer } from './OrderSummaryDrawer.js';
import { parseBuyerRoute, BuyerRouteType } from '../routeUtils.js';
import { getOrCreateBuyerIdempotencyKey, clearBuyerIdempotencyKey } from './idempotencySession.js';
import { BuyerFormConfig } from '../../types/index.js';
import './buyer.css';

interface CatalogData {
  catalog: {
    id: string;
    name: string;
    logoUrl: string | null;
    accentColor: string;
    showSku: boolean;
    showInventory: boolean;
    inventoryMode?: string;
    inventoryCap?: number | null;
    minQty?: number | null;
    maxQty?: number | null;
    qtyIncrement?: number | null;
    priceMode: string;
    discountPercent: number;
    buyerFormConfig?: BuyerFormConfig;
  };
  shop: {
    id: string;
    shopDomain: string;
    currency: string;
  };
  orderLink?: {
    id: string;
    token: string;
    label: string;
    requiresPasscode?: boolean;
  };
  requiresPasscode?: boolean;
  products: ProductItem[];
  totalProducts: number;
  dataVersion: number;
}

function formatPrice(amount: number, currency: string = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

export const BuyerCatalogApp: React.FC = () => {
  const [data, setData] = useState<CatalogData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'matrix' | 'quick'>('matrix');
  const [showCsvModal, setShowCsvModal] = useState(false);

  // Passcode gating (scoped access credential, NO passcodes in URLs)
  const [passcodeRequired, setPasscodeRequired] = useState(false);
  const [linkAccessToken, setLinkAccessToken] = useState<string | null>(() => {
    try {
      const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
      return (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(`cf_link_token_${pathname}`)) || null;
    } catch {
      return null;
    }
  });
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const [passcodeLoading, setPasscodeLoading] = useState(false);

  // Reorder tracking
  const [reorderIntentToken, setReorderIntentToken] = useState<string | null>(null);
  const [reorderNotice, setReorderNotice] = useState<string | null>(null);

  const [submittedOrder, setSubmittedOrder] = useState<{
    submissionId: string;
    reference: string;
    subtotal: number;
  } | null>(null);

  // Parse current route
  const { routeToken, routeType } = useMemo(() => {
    const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
    const parsed = parseBuyerRoute(pathname);
    return {
      routeToken: parsed.token || '',
      routeType: (parsed.routeType || 'catalog') as BuyerRouteType,
    };
  }, []);

  const fetchCatalogData = async (overrideAccessToken?: string | null) => {
    if (!routeToken) {
      setError('Missing catalog link in URL.');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      let url = '';
      const headers: Record<string, string> = {};

      const tokenToUse = overrideAccessToken !== undefined ? overrideAccessToken : linkAccessToken;
      if (tokenToUse) {
        headers['X-Link-Access-Token'] = tokenToUse;
      }

      if (routeType === 'reorder') {
        // First fetch reorder intent payload
        const reorderRes = await fetch(`/api/public/reorder/${routeToken}`);
        if (!reorderRes.ok) {
          const errJson = await reorderRes.json().catch(() => ({}));
          throw new Error(errJson.error || 'Reorder link expired or invalid');
        }
        const reorderData = await reorderRes.json();
        setReorderIntentToken(reorderData.intentToken);

        // Prepopulate cart
        const prefill: Record<string, number> = {};
        let unavailableCount = 0;
        for (const line of reorderData.prefillLines || []) {
          if (line.currentlyAvailable && !line.deleted) {
            prefill[line.variantId] = line.quantity;
          } else {
            unavailableCount++;
          }
        }
        setQuantities(prefill);

        if (unavailableCount > 0) {
          setReorderNotice(`${unavailableCount} previously ordered item(s) are currently out of stock or unavailable.`);
        }

        // Now load the underlying catalog
        url = `/api/public/catalog/${reorderData.catalogPublicToken}`;
      } else if (routeType === 'link') {
        // Passcode is NEVER in the query string or URL
        url = `/api/public/link/${routeToken}`;
      } else {
        url = `/api/public/catalog/${routeToken}`;
      }

      const res = await fetch(url, { headers });

      if (res.status === 401) {
        setPasscodeRequired(true);
        setPasscodeError('Access credential expired or invalid. Please re-enter passcode.');
        setLoading(false);
        return;
      }

      if (!res.ok) {
        if (res.status === 404) {
          setError('This wholesale catalog is currently unavailable, expired, or unpublished.');
        } else if (res.status === 410) {
          setError('This wholesale order link or catalog has expired.');
        } else {
          setError('Failed to load wholesale catalog.');
        }
        return;
      }

      const json: CatalogData = await res.json();

      if (json.requiresPasscode) {
        setPasscodeRequired(true);
        setData(json);
        setLoading(false);
        return;
      }

      setPasscodeRequired(false);
      setData(json);

      // Apply merchant accent color if specified
      if (json.catalog.accentColor) {
        document.documentElement.style.setProperty('--accent-color', json.catalog.accentColor);
      }
    } catch (err: any) {
      setError(err.message || 'Network error loading catalog.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCatalogData();
  }, [routeToken, routeType]);

  const handlePasscodeSubmit = async (enteredPasscode: string) => {
    try {
      setPasscodeLoading(true);
      setPasscodeError(null);

      // Passcode verification happens via POST request body ONLY
      const unlockRes = await fetch(`/api/public/link/${routeToken}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: enteredPasscode }),
      });

      if (!unlockRes.ok) {
        const errJson = await unlockRes.json().catch(() => ({}));
        setPasscodeError(errJson.error || 'Invalid passcode. Please try again.');
        return;
      }

      const unlockData = await unlockRes.json();
      const newToken = unlockData.linkAccessToken;
      setLinkAccessToken(newToken);
      try {
        const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(`cf_link_token_${pathname}`, newToken);
        }
      } catch {}

      await fetchCatalogData(newToken);
    } finally {
      setPasscodeLoading(false);
    }
  };

  const handleQuantityChange = (variantId: string, qty: number) => {
    setQuantities((prev) => ({
      ...prev,
      [variantId]: Math.max(0, qty),
    }));
  };

  const handleApplyCsvLines = (lines: Array<{ variantId: string; quantity: number }>) => {
    setQuantities((prev) => {
      const next = { ...prev };
      for (const line of lines) {
        next[line.variantId] = line.quantity;
      }
      return next;
    });
  };

  // Search filtering
  const filteredProducts = useMemo(() => {
    if (!data?.products) return [];
    if (!searchQuery.trim()) return data.products;

    const q = searchQuery.toLowerCase().trim();
    return data.products.filter((p) => {
      const matchTitle = p.title.toLowerCase().includes(q);
      const matchVendor = p.vendor?.toLowerCase().includes(q);
      const matchVariant = p.variants.some(
        (v) => v.title.toLowerCase().includes(q) || (v.sku && v.sku.toLowerCase().includes(q))
      );
      return matchTitle || matchVendor || matchVariant;
    });
  }, [data?.products, searchQuery]);

  // Live order calculations
  const { totalItems, subtotal, selectedLinesCount } = useMemo(() => {
    if (!data?.products) return { totalItems: 0, subtotal: 0, selectedLinesCount: 0 };

    let items = 0;
    let sum = 0;
    let lines = 0;

    for (const product of data.products) {
      for (const variant of product.variants) {
        const qty = quantities[variant.shopifyVariantId] || 0;
        if (qty > 0) {
          items += qty;
          sum += variant.displayPrice * qty;
          lines += 1;
        }
      }
    }

    return {
      totalItems: items,
      subtotal: Math.round(sum * 100) / 100,
      selectedLinesCount: lines,
    };
  }, [data?.products, quantities]);

  const handleSubmitOrder = async (buyerInfo: {
    businessName: string;
    buyerName?: string;
    email: string;
    phone?: string;
    taxId?: string;
    poNumber?: string;
    note?: string;
  }) => {
    if (!data) return;

    try {
      setIsSubmitting(true);
      setSubmitError(null);

      const items = Object.entries(quantities)
        .filter(([_, qty]) => qty > 0)
        .map(([variantId, qty]) => ({
          variantId,
          quantity: qty,
        }));

      if (items.length === 0) {
        setSubmitError('Please select at least one item to order.');
        return;
      }

      const tokenKey = routeToken || data.catalog.id;
      const idempotencyKey = getOrCreateBuyerIdempotencyKey(tokenKey, items);

      const payload = {
        buyer: buyerInfo,
        items,
        dataVersion: data.dataVersion,
        orderLinkToken: routeType === 'link' ? routeToken : undefined,
        linkAccessToken: routeType === 'link' ? (linkAccessToken || undefined) : undefined,
        reorderIntentToken: reorderIntentToken || undefined,
      };

      const submitEndpoint = routeType === 'link'
        ? `/api/public/link/${routeToken}/submit`
        : `/api/public/catalog/${routeToken}/submit`;

      const submitHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      };
      if (routeType === 'link' && linkAccessToken) {
        submitHeaders['X-Link-Access-Token'] = linkAccessToken;
      }

      const res = await fetch(submitEndpoint, {
        method: 'POST',
        headers: submitHeaders,
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (!res.ok) {
        if (res.status === 409) {
          throw new Error(
            json.error?.message || json.message || 'Product catalog or inventory changed. Please refresh and review.'
          );
        }
        throw new Error(
          json.error?.message || json.message || json.error || 'Failed to submit order to Shopify.'
        );
      }

      clearBuyerIdempotencyKey(tokenKey);
      setSubmittedOrder({
        submissionId: json.submissionId,
        reference: json.reference || json.draftOrderName || 'DRAFT-ORDER',
        subtotal,
      });
      setIsDrawerOpen(false);
    } catch (err: any) {
      setSubmitError(err.message || 'Submission error');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="buyer-loading-container">
        <div className="spinner" />
        <p>Loading wholesale catalog...</p>
      </div>
    );
  }

  if (passcodeRequired) {
    return (
      <PasscodeGate
        catalogName={data?.catalog?.name}
        linkLabel={data?.orderLink?.label}
        onSubmitPasscode={handlePasscodeSubmit}
        error={passcodeError}
        loading={passcodeLoading}
      />
    );
  }

  if (error || !data) {
    return (
      <div className="buyer-error-container">
        <div className="error-card">
          <h2>Catalog Unavailable</h2>
          <p>{error || 'This wholesale catalog could not be loaded.'}</p>
        </div>
      </div>
    );
  }

  if (submittedOrder) {
    return (
      <div className="buyer-success-container">
        <div className="success-card">
          <div className="success-icon">✓</div>
          <h2>Wholesale Order Submitted!</h2>
          <p className="success-reference">
            Reference: <strong>{submittedOrder.reference}</strong>
          </p>
          <p className="success-text">
            Thank you for your order. A Shopify draft invoice will be sent to your email with payment and shipping terms.
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setSubmittedOrder(null);
              setQuantities({});
            }}
          >
            Place Another Order
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="buyer-app">
      {/* Header */}
      <header className="buyer-header">
        <div className="buyer-header-content">
          <div className="buyer-brand">
            {data.catalog.logoUrl ? (
              <img src={data.catalog.logoUrl} alt={data.catalog.name} className="catalog-logo" />
            ) : (
              <div className="brand-dot" />
            )}
            <div>
              <h1 className="catalog-name">{data.catalog.name}</h1>
              <p className="catalog-subtitle">B2B Wholesale Order Portal</p>
            </div>
          </div>

          <div className="header-actions">
            {/* View Mode Switcher */}
            <div className="view-mode-toggle">
              <button
                type="button"
                className={`view-toggle-btn ${viewMode === 'matrix' ? 'active' : ''}`}
                onClick={() => setViewMode('matrix')}
                title="Visual Card Matrix"
              >
                ⊞ Grid
              </button>
              <button
                type="button"
                className={`view-toggle-btn ${viewMode === 'quick' ? 'active' : ''}`}
                onClick={() => setViewMode('quick')}
                title="Quick Order Table"
              >
                ☰ Quick Order
              </button>
            </div>

            {/* CSV Bulk Upload Button */}
            <button
              type="button"
              className="csv-upload-trigger-btn"
              onClick={() => setShowCsvModal(true)}
            >
              📄 CSV Bulk Upload
            </button>

            {/* Cart Trigger */}
            <button
              type="button"
              className="cart-trigger-btn"
              onClick={() => setIsDrawerOpen(true)}
              disabled={selectedLinesCount === 0}
            >
              🛒 Order Cart ({totalItems})
              {selectedLinesCount > 0 && (
                <span className="cart-total-badge">{formatPrice(subtotal, data.shop.currency)}</span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="buyer-main">
        {reorderNotice && (
          <div className="reorder-notice-banner">
            ℹ️ {reorderNotice}
          </div>
        )}

        {viewMode === 'matrix' ? (
          <>
            {/* Search Bar for Matrix */}
            <div className="search-bar-container">
              <input
                type="text"
                className="search-input"
                placeholder="Search catalog products, variants, or SKUs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="clear-search-btn"
                  onClick={() => setSearchQuery('')}
                >
                  ✕
                </button>
              )}
            </div>

            {/* Product Cards List */}
            <div className="products-grid">
              {filteredProducts.length === 0 ? (
                <div className="empty-search">
                  <p>No products found matching "{searchQuery}"</p>
                </div>
              ) : (
                filteredProducts.map((product) => (
                  <VariantMatrix
                    key={product.id}
                    product={product}
                    quantities={quantities}
                    onQuantityChange={handleQuantityChange}
                    showSku={data.catalog.showSku}
                    showInventory={data.catalog.showInventory}
                    inventoryMode={data.catalog.inventoryMode}
                    inventoryCap={data.catalog.inventoryCap}
                  />
                ))
              )}
            </div>
          </>
        ) : (
          <QuickOrderView
            products={data.products}
            quantities={quantities}
            onQuantityChange={handleQuantityChange}
            showSku={data.catalog.showSku}
            showInventory={data.catalog.showInventory}
            currency={data.shop.currency}
          />
        )}
      </main>

      {/* Sticky Bottom Order Bar for Mobile & Desktop */}
      {selectedLinesCount > 0 && (
        <div className="sticky-order-bar">
          <div className="sticky-bar-content">
            <div className="order-stats">
              <strong>{totalItems}</strong> units ({selectedLinesCount} items) •{' '}
              <strong className="order-subtotal">{formatPrice(subtotal, data.shop.currency)}</strong>
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setIsDrawerOpen(true)}
            >
              Review &amp; Place Order →
            </button>
          </div>
        </div>
      )}

      {/* CSV Bulk Upload Modal */}
      {showCsvModal && (
        <CsvBulkUpload
          token={routeToken}
          isLinkRoute={routeType === 'link'}
          linkAccessToken={linkAccessToken || undefined}
          onApplyLines={handleApplyCsvLines}
          onClose={() => setShowCsvModal(false)}
        />
      )}

      {/* Review & Submit Drawer */}
      <OrderSummaryDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        products={data.products}
        quantities={quantities}
        subtotal={subtotal}
        totalItems={totalItems}
        currency={data.shop.currency}
        buyerFormConfig={data.catalog.buyerFormConfig}
        onSubmit={handleSubmitOrder}
        isSubmitting={isSubmitting}
        errorMessage={submitError}
      />
    </div>
  );
};
