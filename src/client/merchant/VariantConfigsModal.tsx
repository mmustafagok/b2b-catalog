import React, { useState, useEffect } from 'react';
import { authenticatedFetch } from './appBridgeAuth.js';
import { CatalogSummary } from './EditCatalogModal.js';

interface VariantConfigItem {
  shopifyVariantId: string;
  enabled: boolean;
  customPrice: number | null;
  overrideQuantityRules: boolean;
  minQty: number | null;
  maxQty: number | null;
  qtyIncrement: number | null;
  productTitle?: string;
  variantTitle?: string;
  sku?: string | null;
  basePrice?: number;
}

interface VariantConfigsModalProps {
  catalog: CatalogSummary;
  onClose: () => void;
  onToast: (msg: string) => void;
}

export const VariantConfigsModal: React.FC<VariantConfigsModalProps> = ({
  catalog,
  onClose,
  onToast,
}) => {
  const [configs, setConfigs] = useState<VariantConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const fetchConfigs = async () => {
      try {
        setLoading(true);
        // Fetch saved configs
        const res = await authenticatedFetch(`/api/admin/catalogs/${catalog.id}/variant-configs`);
        if (res.ok) {
          const data = await res.json();
          setConfigs(
            (data.configs || []).map((c: any) => ({
              ...c,
              overrideQuantityRules: Boolean(c.overrideQuantityRules),
            }))
          );
        }
      } catch (err: any) {
        onToast(`Error loading variant configs: ${err.message}`);
      } finally {
        setLoading(false);
      }
    };

    fetchConfigs();
  }, [catalog.id]);

  const handleToggle = (variantId: string) => {
    setConfigs((prev) =>
      prev.map((c) =>
        c.shopifyVariantId === variantId ? { ...c, enabled: !c.enabled } : c
      )
    );
  };

  const handleFieldChange = (variantId: string, field: keyof VariantConfigItem, val: any) => {
    setConfigs((prev) =>
      prev.map((c) => {
        if (c.shopifyVariantId !== variantId) return c;
        if (field === 'overrideQuantityRules' && !val) {
          return {
            ...c,
            overrideQuantityRules: false,
            minQty: null,
            maxQty: null,
            qtyIncrement: null,
          };
        }
        return { ...c, [field]: val };
      })
    );
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const payload = configs.map((c) => {
        const isOverride = Boolean(c.overrideQuantityRules);
        return {
          shopifyVariantId: c.shopifyVariantId,
          enabled: c.enabled,
          customPrice: c.customPrice !== null && c.customPrice !== undefined && c.customPrice !== ('' as any)
            ? Number(c.customPrice)
            : null,
          overrideQuantityRules: isOverride,
          minQty: isOverride && c.minQty ? Number(c.minQty) : null,
          maxQty: isOverride && c.maxQty ? Number(c.maxQty) : null,
          qtyIncrement: isOverride && c.qtyIncrement ? Number(c.qtyIncrement) : null,
        };
      });

      const res = await authenticatedFetch(`/api/admin/catalogs/${catalog.id}/variant-configs`, {
        method: 'PUT',
        body: JSON.stringify({ configs: payload }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save variant configurations');
      }

      onToast('Variant configurations saved successfully!');
      onClose();
    } catch (err: any) {
      onToast(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const filteredConfigs = configs.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (c.productTitle && c.productTitle.toLowerCase().includes(q)) ||
      (c.variantTitle && c.variantTitle.toLowerCase().includes(q)) ||
      (c.sku && c.sku.toLowerCase().includes(q)) ||
      c.shopifyVariantId.toLowerCase().includes(q)
    );
  });

  const catMin = catalog.minQty || 1;
  const catMax = catalog.maxQty || null;
  const catStep = catalog.qtyIncrement || 1;

  return (
    <div className="cf-modal-backdrop" onClick={onClose}>
      <div className="cf-modal cf-modal-xl" style={{ maxWidth: '960px' }} onClick={(e) => e.stopPropagation()}>
        <div className="cf-modal-header">
          <div>
            <h3>Configure Variants: {catalog.name}</h3>
            <p style={{ fontSize: '0.825rem', color: '#64748b' }}>
              Selectively enable variants or override quantity rules per variant. Unchecked variants inherit catalog defaults automatically.
            </p>
          </div>
          <button type="button" className="cf-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="cf-modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <div style={{ marginBottom: '1rem', display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Filter by product, variant, SKU..."
              className="cf-input"
              style={{ width: '100%', maxWidth: '360px' }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span style={{ fontSize: '0.85rem', color: '#64748b' }}>
              Catalog Defaults: Min <strong>{catMin}</strong> · Step <strong>{catStep}</strong> {catMax ? `· Max ${catMax}` : ''}
            </span>
          </div>

          {loading ? (
            <p style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>Loading variant configurations...</p>
          ) : configs.length === 0 ? (
            <p style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>No variants found for this catalog.</p>
          ) : (
            <div className="cf-table-container">
              <table className="cf-table" style={{ fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th style={{ width: '50px' }}>Active</th>
                    <th>Product / Variant / SKU</th>
                    <th style={{ width: '110px' }}>Custom Price</th>
                    <th style={{ width: '130px' }}>Qty Rules Override</th>
                    <th style={{ width: '80px' }}>Min Qty</th>
                    <th style={{ width: '80px' }}>Max Qty</th>
                    <th style={{ width: '80px' }}>Step</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredConfigs.map((c) => (
                    <tr key={c.shopifyVariantId} style={{ opacity: c.enabled ? 1 : 0.5 }}>
                      <td>
                        <input
                          type="checkbox"
                          checked={c.enabled}
                          onChange={() => handleToggle(c.shopifyVariantId)}
                        />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{c.productTitle || 'Product'}</div>
                        <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                          {c.variantTitle || c.shopifyVariantId} {c.sku ? `• SKU: ${c.sku}` : ''}
                        </div>
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="Retail"
                          className="cf-input cf-input-sm"
                          value={c.customPrice ?? ''}
                          disabled={!c.enabled}
                          onChange={(e) => handleFieldChange(c.shopifyVariantId, 'customPrice', e.target.value ? parseFloat(e.target.value) : null)}
                        />
                      </td>
                      <td>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={c.overrideQuantityRules}
                            disabled={!c.enabled}
                            onChange={(e) => handleFieldChange(c.shopifyVariantId, 'overrideQuantityRules', e.target.checked)}
                          />
                          <span>Override</span>
                        </label>
                      </td>
                      <td>
                        <input
                          type="number"
                          min="1"
                          placeholder={String(catMin)}
                          className="cf-input cf-input-sm"
                          value={c.overrideQuantityRules ? (c.minQty ?? '') : ''}
                          disabled={!c.enabled || !c.overrideQuantityRules}
                          onChange={(e) => handleFieldChange(c.shopifyVariantId, 'minQty', e.target.value ? parseInt(e.target.value, 10) : null)}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min="1"
                          placeholder={catMax ? String(catMax) : '∞'}
                          className="cf-input cf-input-sm"
                          value={c.overrideQuantityRules ? (c.maxQty ?? '') : ''}
                          disabled={!c.enabled || !c.overrideQuantityRules}
                          onChange={(e) => handleFieldChange(c.shopifyVariantId, 'maxQty', e.target.value ? parseInt(e.target.value, 10) : null)}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min="1"
                          placeholder={String(catStep)}
                          className="cf-input cf-input-sm"
                          value={c.overrideQuantityRules ? (c.qtyIncrement ?? '') : ''}
                          disabled={!c.enabled || !c.overrideQuantityRules}
                          onChange={(e) => handleFieldChange(c.shopifyVariantId, 'qtyIncrement', e.target.value ? parseInt(e.target.value, 10) : null)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="cf-modal-footer">
          <button type="button" className="cf-btn cf-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cf-btn cf-btn-primary"
            disabled={saving || loading}
            onClick={handleSave}
          >
            {saving ? 'Saving...' : 'Save Configurations'}
          </button>
        </div>
      </div>
    </div>
  );
};
