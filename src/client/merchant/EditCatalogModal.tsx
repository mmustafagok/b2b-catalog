import React, { useState } from 'react';
import { BuyerFormConfig } from '../../types/index.js';

export interface CatalogSummary {
  id: string;
  name: string;
  publicToken: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  priceMode: 'SHOPIFY_PRICE' | 'PERCENT_DISCOUNT' | 'CUSTOM_PRICE';
  discountPercent: number | null;
  customPriceAmount?: number | null;
  accentColor: string;
  showSku: boolean;
  showInventory: boolean;
  inventoryMode?: 'STATUS_ONLY' | 'CAPPED' | 'EXACT' | 'HIDDEN';
  inventoryCap?: number | null;
  minQty?: number;
  maxQty?: number | null;
  qtyIncrement?: number;
  buyerFormConfig?: BuyerFormConfig;
  createdAt: string;
  updatedAt: string;
  productCount?: number;
  variantCount?: number;
  sources: Array<{ type: 'COLLECTION' | 'PRODUCT'; shopifyGid: string }>;
}

interface EditCatalogModalProps {
  catalog: CatalogSummary;
  onSave: (updates: Record<string, any>) => Promise<void>;
  onClose: () => void;
}

export const EditCatalogModal: React.FC<EditCatalogModalProps> = ({
  catalog,
  onSave,
  onClose,
}) => {
  const [name, setName] = useState(catalog.name);
  const [priceMode, setPriceMode] = useState<'SHOPIFY_PRICE' | 'PERCENT_DISCOUNT' | 'CUSTOM_PRICE'>(
    (catalog.priceMode as any) || 'SHOPIFY_PRICE'
  );
  const [discountPercent, setDiscountPercent] = useState<number>(catalog.discountPercent || 10);
  const [customPriceAmount, setCustomPriceAmount] = useState<string>(
    catalog.customPriceAmount ? String(catalog.customPriceAmount) : ''
  );
  const [accentColor, setAccentColor] = useState(catalog.accentColor || '#108043');
  const [inventoryMode, setInventoryMode] = useState<'STATUS_ONLY' | 'CAPPED' | 'EXACT' | 'HIDDEN'>(
    catalog.inventoryMode || 'STATUS_ONLY'
  );
  const [inventoryCap, setInventoryCap] = useState<string>(
    catalog.inventoryCap ? String(catalog.inventoryCap) : '50'
  );
  const [minQty, setMinQty] = useState<number>(catalog.minQty || 1);
  const [maxQty, setMaxQty] = useState<string>(catalog.maxQty ? String(catalog.maxQty) : '');
  const [qtyIncrement, setQtyIncrement] = useState<number>(catalog.qtyIncrement || 1);
  const [showSku, setShowSku] = useState(catalog.showSku !== false);

  // Buyer Form Configuration
  const initialFormConfig: BuyerFormConfig = typeof catalog.buyerFormConfig === 'string'
    ? JSON.parse(catalog.buyerFormConfig || '{}')
    : catalog.buyerFormConfig || {};

  const [showPhone, setShowPhone] = useState(initialFormConfig.showPhone !== false);
  const [requirePhone, setRequirePhone] = useState(!!initialFormConfig.requirePhone);
  const [showTaxId, setShowTaxId] = useState(initialFormConfig.showTaxId !== false);
  const [requireTaxId, setRequireTaxId] = useState(!!initialFormConfig.requireTaxId);
  const [showPoNumber, setShowPoNumber] = useState(initialFormConfig.showPoNumber !== false);
  const [requirePoNumber, setRequirePoNumber] = useState(!!initialFormConfig.requirePoNumber);
  const [showNote, setShowNote] = useState(initialFormConfig.showNote !== false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;

    try {
      setSaving(true);
      setError(null);

      const updates: Record<string, any> = {
        name: name.trim(),
        priceMode,
        discountPercent: priceMode === 'PERCENT_DISCOUNT' ? discountPercent : 0,
        customPriceAmount: priceMode === 'CUSTOM_PRICE' ? (parseFloat(customPriceAmount) || null) : null,
        accentColor,
        showSku,
        inventoryMode,
        inventoryCap: inventoryMode === 'CAPPED' ? (parseInt(inventoryCap, 10) || 50) : null,
        minQty: Math.max(1, minQty),
        maxQty: maxQty ? parseInt(maxQty, 10) : null,
        qtyIncrement: Math.max(1, qtyIncrement),
        buyerFormConfig: {
          showPhone,
          requirePhone,
          showTaxId,
          requireTaxId,
          showPoNumber,
          requirePoNumber,
          showNote,
        },
      };

      await onSave(updates);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to update catalog');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cf-modal-backdrop" onClick={onClose}>
      <div className="cf-modal cf-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="cf-modal-header">
          <h3>Edit Catalog: {catalog.name}</h3>
          <button type="button" className="cf-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div className="cf-modal-body" style={{ maxHeight: '72vh', overflowY: 'auto', overflowX: 'hidden' }}>
            {error && <div className="cf-alert cf-alert-danger" style={{ marginBottom: '1rem' }}>{error}</div>}

            {/* General */}
            <div className="cf-form-group">
              <label className="cf-label" htmlFor="cat-name">Catalog Name</label>
              <input
                id="cat-name"
                className="cf-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            {/* Pricing Mode */}
            <div className="cf-form-group">
              <label className="cf-label">Pricing Rule</label>
              <div className="cf-pricing-cards">
                <label className={`cf-pricing-card ${priceMode === 'SHOPIFY_PRICE' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="editPriceMode"
                    value="SHOPIFY_PRICE"
                    checked={priceMode === 'SHOPIFY_PRICE'}
                    onChange={() => setPriceMode('SHOPIFY_PRICE')}
                  />
                  <div className="cf-pricing-card-inner">
                    <span className="cf-pricing-icon">🏷️</span>
                    <span className="cf-pricing-name">Retail Price</span>
                  </div>
                </label>

                <label className={`cf-pricing-card ${priceMode === 'PERCENT_DISCOUNT' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="editPriceMode"
                    value="PERCENT_DISCOUNT"
                    checked={priceMode === 'PERCENT_DISCOUNT'}
                    onChange={() => setPriceMode('PERCENT_DISCOUNT')}
                  />
                  <div className="cf-pricing-card-inner">
                    <span className="cf-pricing-icon">💸</span>
                    <span className="cf-pricing-name">% Discount</span>
                  </div>
                </label>

                <label className={`cf-pricing-card ${priceMode === 'CUSTOM_PRICE' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="editPriceMode"
                    value="CUSTOM_PRICE"
                    checked={priceMode === 'CUSTOM_PRICE'}
                    onChange={() => setPriceMode('CUSTOM_PRICE')}
                  />
                  <div className="cf-pricing-card-inner">
                    <span className="cf-pricing-icon">💲</span>
                    <span className="cf-pricing-name">Fixed Custom Price</span>
                  </div>
                </label>
              </div>

              {priceMode === 'PERCENT_DISCOUNT' && (
                <div style={{ marginTop: '0.75rem' }}>
                  <label className="cf-label" htmlFor="edit-discount">Discount %</label>
                  <input
                    id="edit-discount"
                    type="number"
                    min="1"
                    max="90"
                    className="cf-input cf-input-sm"
                    value={discountPercent}
                    onChange={(e) => setDiscountPercent(Number(e.target.value))}
                  />
                </div>
              )}

              {priceMode === 'CUSTOM_PRICE' && (
                <div style={{ marginTop: '0.75rem' }}>
                  <label className="cf-label" htmlFor="edit-custom-price">Fixed Price for all items ($)</label>
                  <input
                    id="edit-custom-price"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="e.g. 25.00"
                    className="cf-input"
                    style={{ maxWidth: '140px' }}
                    value={customPriceAmount}
                    onChange={(e) => setCustomPriceAmount(e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* Inventory Privacy & Display */}
            <div className="cf-form-group">
              <label className="cf-label" htmlFor="edit-inv-mode">Inventory Display Mode</label>
              <select
                id="edit-inv-mode"
                className="cf-select"
                value={inventoryMode}
                onChange={(e) => setInventoryMode(e.target.value as any)}
              >
                <option value="STATUS_ONLY">Status Only ("In Stock" / "Out of Stock")</option>
                <option value="CAPPED">Capped Numbers (e.g. "50+ available")</option>
                <option value="EXACT">Exact Inventory Counts</option>
                <option value="HIDDEN">Hide Stock Indicators</option>
              </select>

              {inventoryMode === 'CAPPED' && (
                <div style={{ marginTop: '0.5rem' }}>
                  <label className="cf-label" htmlFor="edit-cap" style={{ fontSize: '0.8rem' }}>Threshold Cap</label>
                  <input
                    id="edit-cap"
                    type="number"
                    min="1"
                    className="cf-input cf-input-sm"
                    value={inventoryCap}
                    onChange={(e) => setInventoryCap(e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* Quantity Rules */}
            <div className="cf-form-group">
              <label className="cf-label">Default Quantity Rules</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem' }}>
                <div>
                  <label style={{ fontSize: '0.8rem', color: '#64748b' }}>Min Quantity</label>
                  <input
                    type="number"
                    min="1"
                    className="cf-input"
                    value={minQty}
                    onChange={(e) => setMinQty(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '0.8rem', color: '#64748b' }}>Max Quantity</label>
                  <input
                    type="number"
                    min="1"
                    placeholder="Unlimited"
                    className="cf-input"
                    value={maxQty}
                    onChange={(e) => setMaxQty(e.target.value)}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '0.8rem', color: '#64748b' }}>Step Increment</label>
                  <input
                    type="number"
                    min="1"
                    className="cf-input"
                    value={qtyIncrement}
                    onChange={(e) => setQtyIncrement(Number(e.target.value))}
                  />
                </div>
              </div>
            </div>

            {/* Buyer Form Fields */}
            <div className="cf-form-group">
              <label className="cf-label">Buyer Checkout Form Fields</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: '#f8fafc', padding: '0.75rem', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                  <input type="checkbox" checked={showPhone} onChange={(e) => setShowPhone(e.target.checked)} />
                  Show Phone Number Field
                  {showPhone && (
                    <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem', color: '#64748b' }}>
                      <input type="checkbox" checked={requirePhone} onChange={(e) => setRequirePhone(e.target.checked)} />
                      Required
                    </label>
                  )}
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                  <input type="checkbox" checked={showTaxId} onChange={(e) => setShowTaxId(e.target.checked)} />
                  Show Tax ID / VAT Field
                  {showTaxId && (
                    <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem', color: '#64748b' }}>
                      <input type="checkbox" checked={requireTaxId} onChange={(e) => setRequireTaxId(e.target.checked)} />
                      Required
                    </label>
                  )}
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                  <input type="checkbox" checked={showPoNumber} onChange={(e) => setShowPoNumber(e.target.checked)} />
                  Show Purchase Order (PO) Field
                  {showPoNumber && (
                    <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem', color: '#64748b' }}>
                      <input type="checkbox" checked={requirePoNumber} onChange={(e) => setRequirePoNumber(e.target.checked)} />
                      Required
                    </label>
                  )}
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                  <input type="checkbox" checked={showNote} onChange={(e) => setShowNote(e.target.checked)} />
                  Show Order Notes / Special Instructions
                </label>
              </div>
            </div>

            {/* Accent Color */}
            <div className="cf-form-group">
              <label className="cf-label" htmlFor="edit-accent">Buyer Portal Accent Color</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  id="edit-accent"
                  type="color"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="cf-color-input"
                />
                <span style={{ fontSize: '0.85rem', color: '#64748b' }}>{accentColor}</span>
              </div>
            </div>
          </div>

          <div className="cf-modal-footer">
            <button type="button" className="cf-btn cf-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="cf-btn cf-btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
