import React, { useMemo, useState } from 'react';
import { ProductItem, renderStockBadge } from './VariantMatrix.js';

interface QuickOrderViewProps {
  products: ProductItem[];
  quantities: Record<string, number>;
  onQuantityChange: (variantId: string, qty: number) => void;
  showSku: boolean;
  showInventory: boolean;
  inventoryMode?: string;
  inventoryCap?: number | null;
  currency?: string;
}

export const QuickOrderView: React.FC<QuickOrderViewProps> = ({
  products,
  quantities,
  onQuantityChange,
  showSku,
  showInventory,
  inventoryMode = 'STATUS_ONLY',
  inventoryCap,
  currency = 'USD',
}) => {
  const [filterQuery, setFilterQuery] = useState('');

  // Flatten products into variant rows
  const allRows = useMemo(() => {
    const rows: Array<{
      variantId: string;
      productId: string;
      productTitle: string;
      variantTitle: string;
      sku: string | null;
      imageUrl: string | null;
      basePrice: number;
      displayPrice: number;
      formattedPrice?: string;
      availableForSale: boolean;
      effectiveAvailable?: number | null;
      inventoryQuantity?: number;
      isCappedOverThreshold?: boolean;
      minQty?: number | null;
      maxQty?: number | null;
      qtyIncrement?: number | null;
    }> = [];

    for (const product of products) {
      for (const variant of product.variants) {
        rows.push({
          variantId: variant.shopifyVariantId,
          productId: product.shopifyProductId,
          productTitle: product.title,
          variantTitle: variant.title,
          sku: variant.sku,
          imageUrl: variant.imageUrl || product.imageUrl,
          basePrice: variant.basePrice,
          displayPrice: variant.displayPrice,
          formattedPrice: variant.formattedPrice,
          availableForSale: variant.availableForSale,
          effectiveAvailable: variant.effectiveAvailable,
          inventoryQuantity: variant.inventoryQuantity,
          isCappedOverThreshold: variant.isCappedOverThreshold,
          minQty: (variant as any).minQty,
          maxQty: (variant as any).maxQty,
          qtyIncrement: (variant as any).qtyIncrement,
        });
      }
    }
    return rows;
  }, [products]);

  const filteredRows = useMemo(() => {
    if (!filterQuery.trim()) return allRows;
    const q = filterQuery.toLowerCase().trim();
    return allRows.filter((r) => {
      const matchProduct = r.productTitle.toLowerCase().includes(q);
      const matchVariant = r.variantTitle.toLowerCase().includes(q);
      const matchSku = r.sku?.toLowerCase().includes(q);
      return matchProduct || matchVariant || matchSku;
    });
  }, [allRows, filterQuery]);

  const handleStep = (
    variantId: string,
    currentQty: number,
    delta: number,
    minQty = 1,
    maxQty: number | null = null,
    increment = 1
  ) => {
    let nextQty = currentQty + delta * increment;
    if (nextQty <= 0) {
      onQuantityChange(variantId, 0);
      return;
    }
    if (nextQty < minQty) {
      nextQty = delta > 0 ? minQty : 0;
    }
    if (maxQty !== null && nextQty > maxQty) {
      nextQty = maxQty;
    }
    onQuantityChange(variantId, nextQty);
  };

  const handleDirectInput = (
    variantId: string,
    val: string,
    maxQty: number | null = null
  ) => {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed) || parsed <= 0) {
      onQuantityChange(variantId, 0);
    } else {
      const clamped = maxQty !== null ? Math.min(parsed, maxQty) : parsed;
      onQuantityChange(variantId, clamped);
    }
  };

  return (
    <div className="quick-order-view">
      <div className="quick-order-toolbar">
        <div className="quick-order-search-wrap">
          <input
            type="text"
            className="search-input"
            placeholder="Search by SKU, product name, or variant..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
          {filterQuery && (
            <button
              type="button"
              className="clear-search-btn"
              onClick={() => setFilterQuery('')}
            >
              ×
            </button>
          )}
        </div>
        <div className="quick-order-count">
          Showing <strong>{filteredRows.length}</strong> of {allRows.length} variants
        </div>
      </div>

      <div className="table-responsive">
        <table className="quick-order-table" role="table">
          <thead>
            <tr>
              <th style={{ width: '48px' }}></th>
              <th>Product / Variant</th>
              {showSku && <th>SKU</th>}
              {inventoryMode !== 'HIDDEN' && <th>Availability</th>}
              <th>Unit Price</th>
              <th style={{ width: '180px', textAlign: 'right' }}>Quantity</th>
              <th style={{ width: '120px', textAlign: 'right' }}>Line Total</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={showSku ? (inventoryMode !== 'HIDDEN' ? 7 : 6) : (inventoryMode !== 'HIDDEN' ? 6 : 5)} className="empty-table-msg">
                  No variants match "{filterQuery}"
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => {
                const currentQty = quantities[row.variantId] || 0;
                const isOutOfStock = !row.availableForSale || row.effectiveAvailable === 0;
                const min = row.minQty || 1;
                const max = row.maxQty || (row.effectiveAvailable !== null && row.effectiveAvailable !== undefined ? row.effectiveAvailable : null);
                const step = row.qtyIncrement || 1;
                const lineTotal = currentQty * row.displayPrice;

                return (
                  <tr key={row.variantId} className={currentQty > 0 ? 'row-selected' : ''}>
                    <td data-label="Image">
                      {row.imageUrl ? (
                        <img src={row.imageUrl} alt={row.productTitle} className="quick-order-thumb" />
                      ) : (
                        <div className="quick-order-thumb-placeholder">📦</div>
                      )}
                    </td>
                    <td data-label="Product">
                      <div className="quick-order-product-title">{row.productTitle}</div>
                      <div className="quick-order-variant-title">{row.variantTitle}</div>
                      {(row.minQty || row.maxQty || row.qtyIncrement) && (
                        <div className="qty-rules-hint">
                          {row.minQty && <span>Min: {row.minQty} </span>}
                          {row.maxQty && <span>Max: {row.maxQty} </span>}
                          {row.qtyIncrement && row.qtyIncrement > 1 && <span>Step: {row.qtyIncrement}</span>}
                        </div>
                      )}
                    </td>
                    {showSku && (
                      <td data-label="SKU">
                        <span className="variant-sku">{row.sku || '—'}</span>
                      </td>
                    )}
                    {inventoryMode !== 'HIDDEN' && (
                      <td data-label="Availability">
                        {renderStockBadge(row, inventoryMode, inventoryCap)}
                      </td>
                    )}
                    <td data-label="Price">
                      <div className="price-box">
                        <span className="display-price">
                          {row.formattedPrice || `$${row.displayPrice.toFixed(2)}`}
                        </span>
                        {row.displayPrice < row.basePrice && (
                          <span className="base-price-struck">${row.basePrice.toFixed(2)}</span>
                        )}
                      </div>
                    </td>
                    <td data-label="Quantity" style={{ textAlign: 'right' }}>
                      <div className="qty-control">
                        <button
                          type="button"
                          className="qty-btn"
                          disabled={isOutOfStock || currentQty <= 0}
                          onClick={() => handleStep(row.variantId, currentQty, -1, min, max, step)}
                        >
                          −
                        </button>
                        <input
                          type="number"
                          min="0"
                          step={step}
                          disabled={isOutOfStock}
                          className="qty-input"
                          value={isOutOfStock ? '' : (currentQty === 0 ? '' : currentQty)}
                          placeholder="0"
                          onChange={(e) => handleDirectInput(row.variantId, e.target.value, max)}
                        />
                        <button
                          type="button"
                          className="qty-btn"
                          disabled={isOutOfStock || (max !== null && currentQty >= max)}
                          onClick={() => handleStep(row.variantId, currentQty, 1, min, max, step)}
                        >
                          +
                        </button>
                      </div>
                    </td>
                    <td data-label="Line Total" style={{ textAlign: 'right', fontWeight: 600 }}>
                      {currentQty > 0 ? `$${lineTotal.toFixed(2)}` : '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
