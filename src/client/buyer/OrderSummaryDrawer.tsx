import React, { useState } from 'react';
import { ProductItem } from './VariantMatrix.js';
import { BuyerFormConfig, isValidQuantity, resolveVariantInventory } from '../../types/index.js';
import { normalizeBuyerError } from './error-normalizer.js';

interface OrderSummaryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  products: ProductItem[];
  quantities: Record<string, number>;
  subtotal: number;
  totalItems: number;
  currency?: string;
  buyerFormConfig?: BuyerFormConfig;
  inventoryMode?: string;
  inventoryCap?: number | null;
  fieldErrors?: Record<string, string> | null;
  onSubmit: (buyerInfo: {
    businessName: string;
    email: string;
    poNumber?: string;
    note?: string;
  }) => Promise<void>;
  isSubmitting: boolean;
  errorMessage?: string | null;
}

function formatPrice(amount: number, currency: string = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

export const OrderSummaryDrawer: React.FC<OrderSummaryDrawerProps> = ({
  isOpen,
  onClose,
  products,
  quantities,
  subtotal,
  totalItems,
  currency = 'USD',
  buyerFormConfig = {},
  inventoryMode = 'STATUS_ONLY',
  inventoryCap,
  fieldErrors = null,
  onSubmit,
  isSubmitting,
  errorMessage,
}) => {
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [note, setNote] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);

  if (!isOpen) return null;

  // Find all selected variants
  const selectedLines: Array<{
    variantId: string;
    productTitle: string;
    variantTitle: string;
    qty: number;
    price: number;
    lineTotal: number;
  }> = [];

  for (const product of products) {
    for (const variant of product.variants) {
      const qty = quantities[variant.shopifyVariantId] || 0;
      if (qty > 0) {
        selectedLines.push({
          variantId: variant.shopifyVariantId,
          productTitle: product.title,
          variantTitle: variant.title,
          qty,
          price: variant.displayPrice,
          lineTotal: Math.round(variant.displayPrice * qty * 100) / 100,
        });
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setClientError(null);

    if (!businessName.trim()) {
      setClientError('Business name is required.');
      return;
    }

    if (!email.trim() || !email.includes('@')) {
      setClientError('A valid business email address is required.');
      return;
    }

    if (buyerFormConfig.showPoNumber !== false && buyerFormConfig.requirePoNumber && !poNumber.trim()) {
      setClientError('Purchase Order (PO) number is required.');
      return;
    }

    if (buyerFormConfig.showNote !== false && buyerFormConfig.requireNote && !note.trim()) {
      setClientError('Order note is required by supplier.');
      return;
    }

    // Client-side availability and quantity validation
    for (const product of products) {
      for (const variant of product.variants) {
        const qty = quantities[variant.shopifyVariantId] || 0;
        if (qty > 0) {
          if (!Number.isInteger(qty) || qty < 1) {
            setClientError(`Invalid quantity for "${product.title} / ${variant.title}". Must be a positive integer.`);
            return;
          }
          const resolvedInv = resolveVariantInventory(variant, inventoryMode, inventoryCap);
          if (!resolvedInv.sellable) {
            setClientError(`"${product.title} / ${variant.title}" is currently out of stock.`);
            return;
          }
          if (resolvedInv.quantity !== null && qty > resolvedInv.quantity) {
            setClientError(`"${product.title} / ${variant.title}": The requested quantity (${qty}) exceeds available stock (${resolvedInv.quantity} available).`);
            return;
          }
          const min = variant.minQty || 1;
          const step = variant.qtyIncrement || 1;
          const max = variant.maxQty;
          if (!isValidQuantity(qty, min, step, max)) {
            setClientError(`The quantity for "${product.title} / ${variant.title}" isn't valid. Order in multiples of ${step}${min > 1 ? ` (minimum ${min})` : ''}${max ? `, up to ${max}` : ''}.`);
            return;
          }
        }
      }
    }

    await onSubmit({
      businessName: businessName.trim(),
      email: email.trim(),
      poNumber: poNumber.trim() || undefined,
      note: note.trim() || undefined,
    });
  };

  const showPoField = buyerFormConfig.showPoNumber !== false;
  const showNoteField = buyerFormConfig.showNote !== false;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="drawer-content" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Review Wholesale Order</h2>
            <p style={{ fontSize: '0.8125rem', color: '#64748b' }}>
              {selectedLines.length} line item(s) • {totalItems} total unit(s)
            </p>
          </div>
          <button
            type="button"
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.5rem',
              cursor: 'pointer',
              color: '#64748b',
            }}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="drawer-form">
          <div className="review-lines-container">
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem' }}>Selected Items</h3>
            {selectedLines.map((line) => (
              <div key={line.variantId} className="review-line-item">
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{line.productTitle}</div>
                  <div style={{ fontSize: '0.8125rem', color: '#64748b' }}>
                    {line.variantTitle} × {line.qty}
                  </div>
                </div>
                <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>
                  {formatPrice(line.lineTotal, currency)}
                </div>
              </div>
            ))}
          </div>

          <div className="drawer-divider" />

          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.75rem' }}>Buyer Details</h3>
          
          <div className="form-group">
            <label className="form-label" htmlFor="businessName">
              Business / Company Name *
            </label>
            <input
              id="businessName"
              className="form-input"
              type="text"
              required
              placeholder="e.g. Acme Supplies Ltd."
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
            />
            {fieldErrors?.businessName && (
              <div style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                {fieldErrors.businessName}
              </div>
            )}
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="buyerEmail">
              Business Email Address *
            </label>
            <input
              id="buyerEmail"
              className="form-input"
              type="email"
              required
              placeholder="buyer@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {fieldErrors?.email && (
              <div style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                {fieldErrors.email}
              </div>
            )}
          </div>

          {showPoField && (
            <div className="form-group">
              <label className="form-label" htmlFor="poNumber">
                Purchase Order (PO) Number {buyerFormConfig.requirePoNumber ? '*' : '(Optional)'}
              </label>
              <input
                id="poNumber"
                className="form-input"
                type="text"
                required={buyerFormConfig.requirePoNumber}
                placeholder="e.g. PO-2026-883"
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
              />
              {fieldErrors?.poNumber && (
                <div style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                  {fieldErrors.poNumber}
                </div>
              )}
            </div>
          )}

          {showNoteField && (
            <div className="form-group">
              <label className="form-label" htmlFor="orderNotes">
                Special Instructions / Notes {buyerFormConfig.requireNote ? '*' : '(Optional)'}
              </label>
              <textarea
                id="orderNotes"
                className="form-input"
                rows={3}
                required={buyerFormConfig.requireNote}
                placeholder="Add shipping requirements, dock hours, or references..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {fieldErrors?.note && (
                <div style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                  {fieldErrors.note}
                </div>
              )}
            </div>
          )}

          {(() => {
            const rawError = clientError || errorMessage;
            const displayError = rawError ? normalizeBuyerError(rawError).message : null;
            if (!displayError) return null;
            return (
              <div
                style={{
                  padding: '0.75rem',
                  borderRadius: '6px',
                  background: '#fee2e2',
                  color: '#b91c1c',
                  fontSize: '0.875rem',
                  marginBottom: '1rem',
                  whiteSpace: 'pre-line',
                }}
              >
                <div>{displayError}</div>
                {displayError.toLowerCase().includes('changed') && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  style={{
                    marginTop: '0.5rem',
                    background: '#b91c1c',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '4px',
                    padding: '0.35rem 0.75rem',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  ↻ Refresh Catalog with Latest Prices
                </button>
              )}
            </div>
            );
          })()}

          <button
            type="submit"
            className="btn-primary"
            style={{ width: '100%', padding: '0.875rem' }}
            disabled={isSubmitting || selectedLines.length === 0}
          >
            {isSubmitting
              ? 'Submitting Order to Shopify...'
              : `Submit Wholesale Order (${formatPrice(subtotal, currency)})`}
          </button>
        </form>
      </div>
    </div>
  );
};
