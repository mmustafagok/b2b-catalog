import React, { useState } from 'react';
import { ProductItem } from './VariantMatrix.js';

interface OrderSummaryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  products: ProductItem[];
  quantities: Record<string, number>;
  subtotal: number;
  totalItems: number;
  currency?: string;
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

    await onSubmit({
      businessName: businessName.trim(),
      email: email.trim(),
      poNumber: poNumber.trim() || undefined,
      note: note.trim() || undefined,
    });
  };

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

        {/* Selected Items Review */}
        <div className="review-lines-box">
          {selectedLines.map((line) => (
            <div key={line.variantId} className="review-line-item">
              <div>
                <strong>{line.productTitle}</strong>
                <div style={{ color: '#64748b', fontSize: '0.75rem' }}>
                  {line.variantTitle} × {line.qty}
                </div>
              </div>
              <div style={{ fontWeight: 600 }}>{formatPrice(line.lineTotal, currency)}</div>
            </div>
          ))}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '0.75rem 0',
            borderTop: '2px dashed #e2e8f0',
            borderBottom: '2px dashed #e2e8f0',
            marginBottom: '1.5rem',
            fontSize: '1.125rem',
            fontWeight: 700,
          }}
        >
          <span>Estimated Subtotal:</span>
          <span>{formatPrice(subtotal, currency)}</span>
        </div>

        {/* Buyer Information Form */}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">
              Company / Business Name <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              type="text"
              required
              className="form-input"
              placeholder="e.g. Acme Retailers Inc"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">
              Buyer Email Address <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              type="email"
              required
              className="form-input"
              placeholder="buyer@acmeretail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">PO Number (Optional)</label>
            <input
              type="text"
              className="form-input"
              placeholder="e.g. PO-2026-0841"
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Order Notes / Instructions</label>
            <textarea
              rows={3}
              className="form-textarea"
              placeholder="Add shipping requirements, dock hours, or references..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {(clientError || errorMessage) && (
            <div
              style={{
                padding: '0.75rem',
                borderRadius: '6px',
                background: '#fee2e2',
                color: '#b91c1c',
                fontSize: '0.875rem',
                marginBottom: '1rem',
              }}
            >
              {clientError || errorMessage}
            </div>
          )}

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
