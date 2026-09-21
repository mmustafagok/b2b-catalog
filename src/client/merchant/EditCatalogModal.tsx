import React, { useState } from 'react';
import { BuyerFormConfig } from '../../types/index.js';
import { CatalogConfigurationForm, CatalogFormState } from './CatalogConfigurationForm.js';

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
  sources: Array<{ type: 'COLLECTION' | 'PRODUCT'; shopifyGid: string; title?: string; imageUrl?: string | null }>;
}

interface EditCatalogModalProps {
  catalog: CatalogSummary;
  onSave: (updates: Record<string, any>) => Promise<void>;
  onClose: () => void;
}

type EditTab = 'sources' | 'pricing' | 'rules' | 'form';

export const EditCatalogModal: React.FC<EditCatalogModalProps> = ({
  catalog,
  onSave,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<EditTab>('sources');

  const initialBuyerForm: BuyerFormConfig =
    typeof catalog.buyerFormConfig === 'string'
      ? JSON.parse(catalog.buyerFormConfig || '{}')
      : catalog.buyerFormConfig || {};

  const [formState, setFormState] = useState<CatalogFormState>({
    name: catalog.name || '',
    priceMode: (catalog.priceMode as any) || 'SHOPIFY_PRICE',
    discountPercent: catalog.discountPercent || 10,
    customPriceAmount: catalog.customPriceAmount ? String(catalog.customPriceAmount) : '',
    accentColor: catalog.accentColor || '#108043',
    showSku: catalog.showSku !== false,
    inventoryMode: catalog.inventoryMode || 'STATUS_ONLY',
    inventoryCap: catalog.inventoryCap ? String(catalog.inventoryCap) : '50',
    minQty: catalog.minQty || 1,
    maxQty: catalog.maxQty ? String(catalog.maxQty) : '',
    qtyIncrement: catalog.qtyIncrement || 1,
    buyerFormConfig: initialBuyerForm,
    sources: (catalog.sources || []).map((s) => ({
      type: s.type,
      id: s.shopifyGid,
      title: s.title || s.shopifyGid,
      imageUrl: s.imageUrl || null,
    })),
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFormChange = (updates: Partial<CatalogFormState>) => {
    setFormState((prev) => ({ ...prev, ...updates }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formState.name.trim()) {
      setError('Catalog name is required');
      return;
    }
    if (formState.sources.length === 0) {
      setError('Please select at least one product or collection for this catalog');
      return;
    }
    if (saving) return;

    try {
      setSaving(true);
      setError(null);

      const updates: Record<string, any> = {
        name: formState.name.trim(),
        priceMode: formState.priceMode,
        discountPercent: formState.priceMode === 'PERCENT_DISCOUNT' ? formState.discountPercent : 0,
        customPriceAmount:
          formState.priceMode === 'CUSTOM_PRICE' ? (parseFloat(formState.customPriceAmount) || null) : null,
        accentColor: formState.accentColor,
        showSku: formState.showSku,
        inventoryMode: formState.inventoryMode,
        inventoryCap: formState.inventoryMode === 'CAPPED' ? (parseInt(formState.inventoryCap, 10) || 50) : null,
        minQty: Math.max(1, formState.minQty),
        maxQty: formState.maxQty ? parseInt(formState.maxQty, 10) : null,
        qtyIncrement: Math.max(1, formState.qtyIncrement),
        buyerFormConfig: formState.buyerFormConfig,
        sources: formState.sources.map((s) => ({
          type: s.type,
          shopifyGid: s.id,
        })),
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
      <div className="cf-modal cf-modal-wide" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="cf-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h3 style={{ margin: 0 }}>Edit Catalog: {catalog.name}</h3>
            <span
              className={`cf-badge ${
                catalog.status === 'PUBLISHED' ? 'cf-badge-success' : 'cf-badge-outline'
              }`}
            >
              {catalog.status}
            </span>
          </div>
          <button type="button" className="cf-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Modal Body & Navigation Tabs */}
        <form onSubmit={handleSubmit}>
          <div className="cf-modal-body" style={{ minHeight: '380px' }}>
            {error && (
              <div
                style={{
                  background: '#fee2e2',
                  color: '#dc2626',
                  padding: '0.65rem 0.85rem',
                  borderRadius: '6px',
                  marginBottom: '1rem',
                  fontSize: '0.88rem',
                }}
              >
                ⚠️ {error}
              </div>
            )}

            {/* Navigation Tabs */}
            <div
              className="cf-tab-header"
              style={{
                display: 'flex',
                gap: '0.5rem',
                borderBottom: '1px solid #e2e8f0',
                marginBottom: '1.25rem',
                paddingBottom: '0.5rem',
              }}
            >
              <button
                type="button"
                className={`cf-tab-btn ${activeTab === 'sources' ? 'active' : ''}`}
                onClick={() => setActiveTab('sources')}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '0.45rem 0.85rem',
                  fontWeight: activeTab === 'sources' ? 700 : 500,
                  color: activeTab === 'sources' ? '#108043' : '#64748b',
                  borderBottom: activeTab === 'sources' ? '2px solid #108043' : '2px solid transparent',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                📦 Products & Sources ({formState.sources.length})
              </button>
              <button
                type="button"
                className={`cf-tab-btn ${activeTab === 'pricing' ? 'active' : ''}`}
                onClick={() => setActiveTab('pricing')}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '0.45rem 0.85rem',
                  fontWeight: activeTab === 'pricing' ? 700 : 500,
                  color: activeTab === 'pricing' ? '#108043' : '#64748b',
                  borderBottom: activeTab === 'pricing' ? '2px solid #108043' : '2px solid transparent',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                🏷️ Pricing & Inventory
              </button>
              <button
                type="button"
                className={`cf-tab-btn ${activeTab === 'rules' ? 'active' : ''}`}
                onClick={() => setActiveTab('rules')}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '0.45rem 0.85rem',
                  fontWeight: activeTab === 'rules' ? 700 : 500,
                  color: activeTab === 'rules' ? '#108043' : '#64748b',
                  borderBottom: activeTab === 'rules' ? '2px solid #108043' : '2px solid transparent',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                ⚙️ Quantity Rules & Branding
              </button>
              <button
                type="button"
                className={`cf-tab-btn ${activeTab === 'form' ? 'active' : ''}`}
                onClick={() => setActiveTab('form')}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '0.45rem 0.85rem',
                  fontWeight: activeTab === 'form' ? 700 : 500,
                  color: activeTab === 'form' ? '#108043' : '#64748b',
                  borderBottom: activeTab === 'form' ? '2px solid #108043' : '2px solid transparent',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                📋 Buyer Checkout Form
              </button>
            </div>

            {/* Render Shared Form */}
            <CatalogConfigurationForm
              formState={formState}
              onChange={handleFormChange}
              activeTab={activeTab}
            />
          </div>

          {/* Modal Footer */}
          <div className="cf-modal-footer">
            <button type="button" className="cf-btn cf-btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="cf-btn cf-btn-primary" disabled={saving}>
              {saving ? 'Saving Changes…' : 'Save Catalog Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
