import React, { useState, useEffect, useMemo } from 'react';
import { VariantMatrix, ProductItem } from './VariantMatrix.js';
import { OrderSummaryDrawer } from './OrderSummaryDrawer.js';
import './buyer.css';

interface CatalogHeader {
  id: string;
  name: string;
  logoUrl: string | null;
  accentColor: string;
  showSku: boolean;
  showInventory: boolean;
  priceMode: string;
  discountPercent: number;
}

interface CatalogData {
  catalog: CatalogHeader;
  shop: { shopDomain: string; currency?: string };
  products: ProductItem[];
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
  const [submittedOrder, setSubmittedOrder] = useState<{
    submissionId: string;
    reference: string;
    subtotal: number;
  } | null>(null);

  // Extract publicToken from URL path (e.g. /c/token_here)
  const publicToken = useMemo(() => {
    const parts = window.location.pathname.split('/');
    const cIndex = parts.indexOf('c');
    if (cIndex !== -1 && parts[cIndex + 1]) {
      return parts[cIndex + 1];
    }
    // Fallback to query param ?token=...
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('token') || '';
  }, []);

  useEffect(() => {
    if (!publicToken) {
      setError('Missing catalog token in URL.');
      setLoading(false);
      return;
    }

    const fetchCatalog = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/public/catalog/${publicToken}`);
        if (!res.ok) {
          if (res.status === 404) {
            setError('This wholesale catalog is currently unavailable or unpublished.');
          } else {
            setError('Failed to load wholesale catalog.');
          }
          return;
        }
        const json: CatalogData = await res.json();
        setData(json);

        // Apply merchant custom accent color
        if (json.catalog.accentColor) {
          document.documentElement.style.setProperty('--accent-color', json.catalog.accentColor);
        }
      } catch (err: any) {
        setError(err.message || 'Network error loading catalog.');
      } finally {
        setLoading(false);
      }
    };

    fetchCatalog();
  }, [publicToken]);

  const handleQuantityChange = (variantId: string, qty: number) => {
    setQuantities((prev) => ({
      ...prev,
      [variantId]: Math.max(0, qty),
    }));
  };

  // High-performance search filtering (p95 < 250ms)
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
    email: string;
    poNumber?: string;
    note?: string;
  }) => {
    if (!data) return;

    setIsSubmitting(true);
    setSubmitError(null);

    const lines = Object.entries(quantities)
      .filter(([_, qty]) => qty > 0)
      .map(([variantId, qty]) => ({ variantId, quantity: qty }));

    // Generate unique client idempotency key
    const idempotencyKey = `idemp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    try {
      // Send to server submit endpoint
      const res = await fetch(`/api/public/catalog/${publicToken}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          dataVersion: data.dataVersion,
          lines,
          buyer: buyerInfo,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        if (res.status === 409) {
          setSubmitError(
            errJson.message ||
              'Some product prices or stock changed since this catalog was loaded. Please review updated lines.'
          );
        } else {
          setSubmitError(errJson.error || errJson.message || 'Submission failed. Please try again.');
        }
        return;
      }

      const result = await res.json();
      setSubmittedOrder({
        submissionId: result.submissionId,
        reference: result.referenceNumber || result.submissionId,
        subtotal: result.subtotalAmount || subtotal,
      });
      setIsDrawerOpen(false);
    } catch (err: any) {
      setSubmitError(err.message || 'Network error occurred during submission.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="portal-container" style={{ textAlign: 'center', padding: '4rem' }}>
        <p style={{ color: '#64748b', fontSize: '1.125rem' }}>Loading wholesale catalog...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="portal-container" style={{ textAlign: 'center', padding: '4rem' }}>
        <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem', color: '#0f172a' }}>Catalog Unavailable</h2>
        <p style={{ color: '#64748b' }}>{error || 'Catalog not found'}</p>
      </div>
    );
  }

  // Success screen
  if (submittedOrder) {
    return (
      <div className="portal-container" style={{ maxWidth: '600px', margin: '4rem auto', textAlign: 'center' }}>
        <div
          style={{
            background: '#ffffff',
            padding: '3rem 2rem',
            borderRadius: '16px',
            border: '1px solid #e2e8f0',
            boxShadow: '0 10px 25px -5px rgba(0,0,0,0.05)',
          }}
        >
          <div
            style={{
              width: '64px',
              height: '64px',
              background: '#dcfce7',
              borderRadius: '50%',
              margin: '0 auto 1.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '2rem',
              color: '#15803d',
            }}
          >
            ✓
          </div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '0.75rem' }}>
            Wholesale Order Submitted!
          </h1>
          <p style={{ color: '#64748b', marginBottom: '1.5rem', lineHeight: 1.6 }}>
            Your wholesale order request has been received by <strong>{data.shop.shopDomain}</strong> and is being
            processed directly in Shopify.
          </p>
          <div
            style={{
              background: '#f8fafc',
              borderRadius: '8px',
              padding: '1rem',
              marginBottom: '2rem',
              textAlign: 'left',
              fontSize: '0.9rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ color: '#64748b' }}>Reference ID:</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{submittedOrder.reference}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#64748b' }}>Order Subtotal:</span>
              <span style={{ fontWeight: 600 }}>
                {formatPrice(submittedOrder.subtotal, data.shop.currency || 'USD')}
              </span>
            </div>
          </div>
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
    <div className="portal-container">
      {/* Brand Header */}
      <header className="portal-header">
        <div className="brand-info">
          {data.catalog.logoUrl && (
            <img src={data.catalog.logoUrl} alt={data.catalog.name} className="brand-logo" />
          )}
          <div>
            <h1 className="brand-title">{data.catalog.name}</h1>
            <p className="brand-subtitle">
              Wholesale Order Portal • {data.shop.shopDomain}
              {data.catalog.discountPercent > 0 && (
                <span style={{ marginLeft: '0.5rem', color: 'var(--accent-color)', fontWeight: 600 }}>
                  ({data.catalog.discountPercent}% Wholesale Discount Applied)
                </span>
              )}
            </p>
          </div>
        </div>
      </header>

      {/* Search Bar */}
      <div className="search-filter-bar">
        <div className="search-input-wrapper">
          <input
            type="text"
            className="search-input"
            placeholder="Search by product title, SKU, or vendor..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Product List */}
      <div className="product-list">
        {filteredProducts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', background: '#fff', borderRadius: '12px' }}>
            <p style={{ color: '#64748b' }}>No products matching "{searchQuery}"</p>
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
            />
          ))
        )}
      </div>

      {/* Sticky Order Summary Bar */}
      {selectedLinesCount > 0 && (
        <div className="sticky-summary-bar">
          <div className="sticky-summary-content">
            <div className="summary-stats">
              <div className="stat-item">
                <span className="stat-label">Selected</span>
                <span className="stat-value">{selectedLinesCount} items ({totalItems} units)</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Estimated Subtotal</span>
                <span className="stat-value highlight">
                  {formatPrice(subtotal, data.shop.currency || 'USD')}
                </span>
              </div>
            </div>

            <button
              type="button"
              className="btn-primary"
              onClick={() => setIsDrawerOpen(true)}
            >
              Review Order ({selectedLinesCount}) →
            </button>
          </div>
        </div>
      )}

      {/* Slide-out Order Review Drawer */}
      <OrderSummaryDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        products={data.products}
        quantities={quantities}
        subtotal={subtotal}
        totalItems={totalItems}
        currency={data.shop.currency || 'USD'}
        onSubmit={handleSubmitOrder}
        isSubmitting={isSubmitting}
        errorMessage={submitError}
      />
    </div>
  );
};
