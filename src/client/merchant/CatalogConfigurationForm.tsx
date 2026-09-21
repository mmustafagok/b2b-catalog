import React, { useState, useEffect, useCallback } from 'react';
import { BuyerFormConfig } from '../../types/index.js';
import { authenticatedFetch } from './appBridgeAuth.js';

export interface CatalogFormState {
  name: string;
  priceMode: 'SHOPIFY_PRICE' | 'PERCENT_DISCOUNT' | 'CUSTOM_PRICE';
  discountPercent: number;
  customPriceAmount: string;
  accentColor: string;
  showSku: boolean;
  inventoryMode: 'STATUS_ONLY' | 'CAPPED' | 'EXACT' | 'HIDDEN';
  inventoryCap: string;
  minQty: number;
  maxQty: string;
  qtyIncrement: number;
  buyerFormConfig: BuyerFormConfig;
  sources: Array<{ type: 'COLLECTION' | 'PRODUCT'; id: string; title: string; imageUrl?: string | null }>;
}

export interface ResourceItem {
  id: string;
  title: string;
  imageUrl?: string | null;
  detail?: string | null;
}

interface CatalogConfigurationFormProps {
  formState: CatalogFormState;
  onChange: (updates: Partial<CatalogFormState>) => void;
  activeTab?: 'sources' | 'pricing' | 'rules' | 'form';
}

export const CatalogConfigurationForm: React.FC<CatalogConfigurationFormProps> = ({
  formState,
  onChange,
  activeTab = 'sources',
}) => {
  const [searchTab, setSearchTab] = useState<'COLLECTION' | 'PRODUCT'>('COLLECTION');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ResourceItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const runSearch = useCallback(
    async (tab: 'COLLECTION' | 'PRODUCT', q: string) => {
      setSearchLoading(true);
      setSearchResults([]);
      setSearchError(null);
      try {
        const endpoint =
          tab === 'COLLECTION'
            ? `/api/admin/collections/search?q=${encodeURIComponent(q)}&limit=20`
            : `/api/admin/products/search?q=${encodeURIComponent(q)}&limit=20`;
        const res = await authenticatedFetch(endpoint);
        if (!res.ok) {
          setSearchError(`Search failed (${res.status}). Please try again.`);
          return;
        }
        const data = await res.json();
        if (tab === 'COLLECTION') {
          setSearchResults(
            (data.collections || []).map((c: any) => ({
              id: c.id,
              title: c.title,
              imageUrl: c.imageUrl,
              detail: c.productsCount != null ? `${c.productsCount} products` : null,
            }))
          );
        } else {
          setSearchResults(
            (data.products || []).map((p: any) => {
              const variants = p.variants || [];
              let stockDetail = p.price ? `From $${p.price}` : '';
              if (variants.length > 0) {
                const variantSummaries = variants
                  .slice(0, 4)
                  .map((v: any) => `${v.title}: ${v.inventoryQuantity ?? 0}`)
                  .join(', ');
                const more = variants.length > 4 ? ` +${variants.length - 4} more` : '';
                stockDetail = stockDetail ? `${stockDetail} • ${variantSummaries}${more}` : `${variantSummaries}${more}`;
              }
              return {
                id: p.id,
                title: p.title,
                imageUrl: p.imageUrl,
                detail: stockDetail || null,
              };
            })
          );
        }
      } catch (err: any) {
        setSearchError(err.message || 'Network error during search.');
      } finally {
        setSearchLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (activeTab !== 'sources') return;
    const t = setTimeout(() => runSearch(searchTab, searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery, searchTab, activeTab, runSearch]);

  const toggleSource = (item: ResourceItem) => {
    const exists = formState.sources.some((s) => s.id === item.id);
    let updatedSources;
    if (exists) {
      updatedSources = formState.sources.filter((s) => s.id !== item.id);
    } else {
      updatedSources = [
        ...formState.sources,
        { type: searchTab, id: item.id, title: item.title, imageUrl: item.imageUrl },
      ];
    }
    onChange({ sources: updatedSources });
  };

  const removeSource = (id: string) => {
    onChange({ sources: formState.sources.filter((s) => s.id !== id) });
  };

  const updateBuyerForm = (key: keyof BuyerFormConfig, val: boolean) => {
    onChange({
      buyerFormConfig: {
        ...formState.buyerFormConfig,
        [key]: val,
      },
    });
  };

  return (
    <div className="cf-config-form">
      <div className="cf-form-group" style={{ marginBottom: '1.25rem' }}>
        <label className="cf-label" htmlFor="cf-catalog-name-input">
          Catalog Name <span style={{ color: '#dc2626' }}>*</span>
        </label>
        <input
          id="cf-catalog-name-input"
          type="text"
          className="cf-input"
          placeholder="e.g. Wholesale Summer Line Sheet 2026"
          value={formState.name}
          onChange={(e) => onChange({ name: e.target.value })}
          required
        />
      </div>

      {activeTab === 'sources' && (
        <div className="cf-tab-pane">
          <p className="cf-section-desc" style={{ marginBottom: '0.85rem' }}>
            Choose Shopify products or collections to include in this catalog. Adding or removing products keeps your public catalog token and Order Links intact.
          </p>

          <div
            style={{
              marginBottom: '1.25rem',
              background: '#f8fafc',
              padding: '1rem',
              borderRadius: '8px',
              border: '1px solid #e2e8f0',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '0.5rem',
              }}
            >
              <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                Catalog Product Sources ({formState.sources.length} selected)
              </span>
            </div>

            {formState.sources.length === 0 ? (
              <p style={{ color: '#dc2626', fontSize: '0.85rem', margin: 0 }}>
                ⚠️ No products or collections selected. Please search and select at least one source below.
              </p>
            ) : (
              <div className="cf-source-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {formState.sources.map((s) => (
                  <span
                    key={s.id}
                    className="cf-source-chip"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      background: '#ffffff',
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      padding: '0.35rem 0.65rem',
                      fontSize: '0.85rem',
                    }}
                  >
                    <span>{s.type === 'COLLECTION' ? '📂' : '📦'}</span>
                    <strong>{s.title}</strong>
                    <button
                      type="button"
                      onClick={() => removeSource(s.id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#94a3b8',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '1rem',
                        marginLeft: '0.2rem',
                      }}
                      title="Remove from catalog"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem', fontWeight: 600 }}>
            Search & Add Shopify Products / Collections
          </h4>
          <div className="cf-seg-tabs" style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <button
              type="button"
              className={`cf-seg-tab cf-btn cf-btn-sm ${
                searchTab === 'COLLECTION' ? 'cf-btn-primary' : 'cf-btn-secondary'
              }`}
              onClick={() => {
                setSearchTab('COLLECTION');
                setSearchQuery('');
                setSearchResults([]);
              }}
            >
              📂 Collections
            </button>
            <button
              type="button"
              className={`cf-seg-tab cf-btn cf-btn-sm ${
                searchTab === 'PRODUCT' ? 'cf-btn-primary' : 'cf-btn-secondary'
              }`}
              onClick={() => {
                setSearchTab('PRODUCT');
                setSearchQuery('');
                setSearchResults([]);
              }}
            >
              📦 Products
            </button>
          </div>

          <div className="cf-search-bar" style={{ marginBottom: '0.75rem' }}>
            <input
              type="search"
              className="cf-input"
              placeholder={
                searchTab === 'COLLECTION'
                  ? 'Search Shopify collections by title…'
                  : 'Search Shopify products by title or SKU…'
              }
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div
            className="cf-resource-list"
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: '8px',
              maxHeight: '220px',
              overflowY: 'auto',
              background: '#ffffff',
            }}
          >
            {searchLoading && (
              <div style={{ padding: '1rem', textAlign: 'center', color: '#64748b', fontSize: '0.88rem' }}>
                🔍 Searching Shopify catalog…
              </div>
            )}
            {searchError && (
              <div style={{ padding: '1rem', textAlign: 'center', color: '#dc2626', fontSize: '0.88rem' }}>
                ⚠️ {searchError}
              </div>
            )}
            {!searchLoading && !searchError && searchResults.length === 0 && searchQuery.length > 0 && (
              <div style={{ padding: '1rem', textAlign: 'center', color: '#64748b', fontSize: '0.88rem' }}>
                No {searchTab === 'COLLECTION' ? 'collections' : 'products'} found for "{searchQuery}".
              </div>
            )}
            {!searchLoading && !searchError && searchResults.length === 0 && searchQuery.length === 0 && (
              <div style={{ padding: '1rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.88rem' }}>
                Type in the search bar above to find and add Shopify {searchTab === 'COLLECTION' ? 'collections' : 'products'}.
              </div>
            )}
            {searchResults.map((item) => {
              const selected = formState.sources.some((s) => s.id === item.id);
              return (
                <div
                  key={item.id}
                  onClick={() => toggleSource(item)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.65rem 0.85rem',
                    borderBottom: '1px solid #f1f5f9',
                    cursor: 'pointer',
                    background: selected ? '#f0fdf4' : '#ffffff',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt={item.title}
                        style={{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover' }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 4,
                          background: '#e2e8f0',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.9rem',
                        }}
                      >
                        {searchTab === 'COLLECTION' ? '📂' : '📦'}
                      </div>
                    )}
                    <div>
                      <strong style={{ fontSize: '0.88rem', display: 'block' }}>{item.title}</strong>
                      {item.detail && (
                        <span style={{ fontSize: '0.78rem', color: '#64748b' }}>{item.detail}</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`cf-btn cf-btn-sm ${selected ? 'cf-btn-primary' : 'cf-btn-secondary'}`}
                  >
                    {selected ? '✓ Added' : '+ Add'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'pricing' && (
        <div className="cf-tab-pane">
          <div className="cf-form-group" style={{ marginBottom: '1.25rem' }}>
            <label className="cf-label">Pricing Rule</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.35rem' }}>
              <label className="cf-radio-card" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <input
                  type="radio"
                  name="priceMode"
                  value="SHOPIFY_PRICE"
                  checked={formState.priceMode === 'SHOPIFY_PRICE'}
                  onChange={() => onChange({ priceMode: 'SHOPIFY_PRICE' })}
                />
                <div>
                  <strong>Shopify Retail Price</strong>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    Use live Shopify product prices directly.
                  </div>
                </div>
              </label>

              <label className="cf-radio-card" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <input
                  type="radio"
                  name="priceMode"
                  value="PERCENT_DISCOUNT"
                  checked={formState.priceMode === 'PERCENT_DISCOUNT'}
                  onChange={() => onChange({ priceMode: 'PERCENT_DISCOUNT' })}
                />
                <div>
                  <strong>Percentage Discount</strong>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    Apply a wholesale discount off standard Shopify prices.
                  </div>
                </div>
              </label>

              {formState.priceMode === 'PERCENT_DISCOUNT' && (
                <div style={{ marginLeft: '1.8rem', marginTop: '0.25rem' }}>
                  <label style={{ fontSize: '0.84rem', fontWeight: 600 }}>Discount Percentage (%)</label>
                  <input
                    type="number"
                    min="0"
                    max="90"
                    className="cf-input"
                    style={{ width: '120px', marginTop: '0.2rem' }}
                    value={formState.discountPercent}
                    onChange={(e) => onChange({ discountPercent: Math.max(0, Math.min(90, parseFloat(e.target.value) || 0)) })}
                  />
                </div>
              )}

              <label className="cf-radio-card" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <input
                  type="radio"
                  name="priceMode"
                  value="CUSTOM_PRICE"
                  checked={formState.priceMode === 'CUSTOM_PRICE'}
                  onChange={() => onChange({ priceMode: 'CUSTOM_PRICE' })}
                />
                <div>
                  <strong>Fixed Wholesale Price Override</strong>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    Set a single fixed wholesale price across all variants in this catalog.
                  </div>
                </div>
              </label>

              {formState.priceMode === 'CUSTOM_PRICE' && (
                <div style={{ marginLeft: '1.8rem', marginTop: '0.25rem' }}>
                  <label style={{ fontSize: '0.84rem', fontWeight: 600 }}>Fixed Price Amount ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="cf-input"
                    style={{ width: '140px', marginTop: '0.2rem' }}
                    placeholder="0.00"
                    value={formState.customPriceAmount}
                    onChange={(e) => onChange({ customPriceAmount: e.target.value })}
                  />
                </div>
              )}
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '1.25rem 0' }} />

          <div className="cf-form-group">
            <label className="cf-label">Inventory Display Mode</label>
            <p className="cf-section-desc" style={{ marginBottom: '0.5rem' }}>
              Control how stock availability is presented to buyers in the public portal.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label className="cf-radio-card" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}>
                <input
                  type="radio"
                  name="inventoryMode"
                  value="STATUS_ONLY"
                  checked={formState.inventoryMode === 'STATUS_ONLY'}
                  onChange={() => onChange({ inventoryMode: 'STATUS_ONLY' })}
                  style={{ marginTop: '0.25rem' }}
                />
                <div>
                  <strong>Status Only ("In stock" / "Out of stock")</strong>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    Displays stock status badge without leaking exact numerical inventory counts.
                  </div>
                </div>
              </label>

              <label className="cf-radio-card" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}>
                <input
                  type="radio"
                  name="inventoryMode"
                  value="CAPPED"
                  checked={formState.inventoryMode === 'CAPPED'}
                  onChange={() => onChange({ inventoryMode: 'CAPPED' })}
                  style={{ marginTop: '0.25rem' }}
                />
                <div>
                  <strong>Capped Threshold ("50+ available")</strong>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    Shows exact quantity when stock is under cap; displays "{formState.inventoryCap || '50'}+ available" for high inventory.
                  </div>
                </div>
              </label>

              {formState.inventoryMode === 'CAPPED' && (
                <div style={{ marginLeft: '1.8rem', marginTop: '0.25rem' }}>
                  <label style={{ fontSize: '0.84rem', fontWeight: 600 }}>Maximum Inventory Cap Count</label>
                  <input
                    type="number"
                    min="1"
                    className="cf-input"
                    style={{ width: '120px', marginTop: '0.2rem' }}
                    value={formState.inventoryCap}
                    onChange={(e) => onChange({ inventoryCap: e.target.value })}
                  />
                </div>
              )}

              <label className="cf-radio-card" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}>
                <input
                  type="radio"
                  name="inventoryMode"
                  value="EXACT"
                  checked={formState.inventoryMode === 'EXACT'}
                  onChange={() => onChange({ inventoryMode: 'EXACT' })}
                  style={{ marginTop: '0.25rem' }}
                />
                <div>
                  <strong>Exact Stock Count ("23 in stock")</strong>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    Always displays exact live available inventory count.
                  </div>
                </div>
              </label>

              <label className="cf-radio-card" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}>
                <input
                  type="radio"
                  name="inventoryMode"
                  value="HIDDEN"
                  checked={formState.inventoryMode === 'HIDDEN'}
                  onChange={() => onChange({ inventoryMode: 'HIDDEN' })}
                  style={{ marginTop: '0.25rem' }}
                />
                <div>
                  <strong>Hidden (No Inventory Badges)</strong>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                    Hides availability column and badges completely from the buyer portal.
                  </div>
                </div>
              </label>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'rules' && (
        <div className="cf-tab-pane">
          <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem', fontWeight: 600 }}>Catalog Quantity Rules</h4>
          <p className="cf-section-desc" style={{ marginBottom: '1rem' }}>
            Set order unit constraints across all variants in this catalog.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem' }}>
            <div>
              <label style={{ fontSize: '0.84rem', fontWeight: 600 }}>Min Quantity</label>
              <input
                type="number"
                min="1"
                className="cf-input"
                value={formState.minQty}
                onChange={(e) => onChange({ minQty: Math.max(1, parseInt(e.target.value, 10) || 1) })}
              />
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Minimum units required</span>
            </div>

            <div>
              <label style={{ fontSize: '0.84rem', fontWeight: 600 }}>Max Quantity</label>
              <input
                type="number"
                min="1"
                className="cf-input"
                placeholder="Optional"
                value={formState.maxQty}
                onChange={(e) => onChange({ maxQty: e.target.value })}
              />
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Optional ceiling per line</span>
            </div>

            <div>
              <label style={{ fontSize: '0.84rem', fontWeight: 600 }}>Step / Increment</label>
              <input
                type="number"
                min="1"
                className="cf-input"
                value={formState.qtyIncrement}
                onChange={(e) => onChange({ qtyIncrement: Math.max(1, parseInt(e.target.value, 10) || 1) })}
              />
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Pack size / multiplier</span>
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '1.25rem 0' }} />

          <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem', fontWeight: 600 }}>Display & Accent Customization</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={formState.showSku}
                onChange={(e) => onChange({ showSku: e.target.checked })}
              />
              <span style={{ fontSize: '0.88rem', fontWeight: 500 }}>Show Variant SKUs in Buyer Portal</span>
            </label>

            <div>
              <label style={{ fontSize: '0.84rem', fontWeight: 600, display: 'block', marginBottom: '0.35rem' }}>
                Buyer Portal Accent Color
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <input
                  type="color"
                  value={formState.accentColor}
                  onChange={(e) => onChange({ accentColor: e.target.value })}
                  style={{ width: 44, height: 38, border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer', padding: 2 }}
                />
                <input
                  type="text"
                  className="cf-input"
                  style={{ width: '120px' }}
                  value={formState.accentColor}
                  onChange={(e) => onChange({ accentColor: e.target.value })}
                />
                <span style={{ fontSize: '0.8rem', color: '#64748b' }}>Sets theme branding & button color</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'form' && (
        <div className="cf-tab-pane">
          <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem', fontWeight: 600 }}>Buyer Checkout Form Fields</h4>
          <p className="cf-section-desc" style={{ marginBottom: '1rem' }}>
            Configure fields requested from wholesale buyers during checkout.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ padding: '0.75rem', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.35rem' }}>📞 Phone Number</div>
              <div style={{ display: 'flex', gap: '1.25rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                  <input
                    type="checkbox"
                    checked={formState.buyerFormConfig.showPhone !== false}
                    onChange={(e) => updateBuyerForm('showPhone', e.target.checked)}
                  />
                  Show Field
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                  <input
                    type="checkbox"
                    checked={!!formState.buyerFormConfig.requirePhone}
                    onChange={(e) => updateBuyerForm('requirePhone', e.target.checked)}
                  />
                  Require Field
                </label>
              </div>
            </div>

            <div style={{ padding: '0.75rem', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.35rem' }}>📑 Tax ID / VAT ID</div>
              <div style={{ display: 'flex', gap: '1.25rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                  <input
                    type="checkbox"
                    checked={formState.buyerFormConfig.showTaxId !== false}
                    onChange={(e) => updateBuyerForm('showTaxId', e.target.checked)}
                  />
                  Show Field
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                  <input
                    type="checkbox"
                    checked={!!formState.buyerFormConfig.requireTaxId}
                    onChange={(e) => updateBuyerForm('requireTaxId', e.target.checked)}
                  />
                  Require Field
                </label>
              </div>
            </div>

            <div style={{ padding: '0.75rem', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.35rem' }}>🔢 Purchase Order Number (PO)</div>
              <div style={{ display: 'flex', gap: '1.25rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                  <input
                    type="checkbox"
                    checked={formState.buyerFormConfig.showPoNumber !== false}
                    onChange={(e) => updateBuyerForm('showPoNumber', e.target.checked)}
                  />
                  Show Field
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                  <input
                    type="checkbox"
                    checked={!!formState.buyerFormConfig.requirePoNumber}
                    onChange={(e) => updateBuyerForm('requirePoNumber', e.target.checked)}
                  />
                  Require Field
                </label>
              </div>
            </div>

            <div style={{ padding: '0.75rem', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.35rem' }}>📝 Order Notes & Special Instructions</div>
              <div style={{ display: 'flex', gap: '1.25rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                  <input
                    type="checkbox"
                    checked={formState.buyerFormConfig.showNote !== false}
                    onChange={(e) => updateBuyerForm('showNote', e.target.checked)}
                  />
                  Show Field
                </label>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
