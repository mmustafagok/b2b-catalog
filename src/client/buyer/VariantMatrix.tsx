import React from 'react';

export interface VariantItem {
  id: string;
  shopifyVariantId: string;
  title: string;
  sku: string | null;
  basePrice: number;
  displayPrice: number;
  formattedPrice?: string;
  availableForSale: boolean;
  inventoryQuantity?: number;
  effectiveAvailable?: number | null;
  inventoryPolicy?: string;
  inventoryTracked?: boolean;
  minQty?: number | null;
  maxQty?: number | null;
  qtyIncrement?: number | null;
  selectedOptions: Array<{ name: string; value: string }>;
  imageUrl: string | null;
}

export interface ProductItem {
  id: string;
  shopifyProductId: string;
  title: string;
  vendor: string | null;
  handle: string;
  imageUrl: string | null;
  variants: VariantItem[];
}

interface VariantMatrixProps {
  product: ProductItem;
  quantities: Record<string, number>;
  onQuantityChange: (variantId: string, qty: number) => void;
  showSku: boolean;
  showInventory: boolean;
  inventoryMode?: string;
  inventoryCap?: number | null;
}

export const VariantMatrix: React.FC<VariantMatrixProps> = ({
  product,
  quantities,
  onQuantityChange,
  showSku,
  showInventory,
  inventoryMode = 'STATUS_ONLY',
  inventoryCap,
}) => {
  const handleInputChange = (
    variantId: string,
    val: string,
    maxLimit: number | null
  ) => {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed) || parsed < 0) {
      onQuantityChange(variantId, 0);
    } else {
      const clamped = maxLimit !== null ? Math.min(parsed, maxLimit) : parsed;
      onQuantityChange(variantId, clamped);
    }
  };

  const handleStep = (
    variantId: string,
    currentQty: number,
    delta: number,
    minQty = 1,
    maxLimit: number | null = null,
    increment = 1
  ) => {
    let next = currentQty + delta * increment;
    if (next <= 0) {
      onQuantityChange(variantId, 0);
      return;
    }
    if (next < minQty) {
      next = delta > 0 ? minQty : 0;
    }
    if (maxLimit !== null && next > maxLimit) {
      next = maxLimit;
    }
    onQuantityChange(variantId, next);
  };

  const renderStockBadge = (variant: VariantItem) => {
    if (inventoryMode === 'HIDDEN') {
      return null;
    }

    const isOutOfStock = !variant.availableForSale || variant.effectiveAvailable === 0;
    if (isOutOfStock) {
      return (
        <span className="stock-tag out-of-stock" style={{ color: '#dc2626', fontWeight: 600 }}>
          Out of stock
        </span>
      );
    }

    if (inventoryMode === 'EXACT' && variant.effectiveAvailable !== null && variant.effectiveAvailable !== undefined) {
      return (
        <span className="stock-tag in-stock" style={{ color: '#16a34a', fontWeight: 600 }}>
          {variant.effectiveAvailable} in stock
        </span>
      );
    }

    if (inventoryMode === 'CAPPED' && inventoryCap) {
      if (variant.effectiveAvailable !== null && variant.effectiveAvailable !== undefined && variant.effectiveAvailable > inventoryCap) {
        return (
          <span className="stock-tag in-stock" style={{ color: '#16a34a', fontWeight: 600 }}>
            {inventoryCap}+ available
          </span>
        );
      } else if (variant.effectiveAvailable !== null && variant.effectiveAvailable !== undefined) {
        return (
          <span className="stock-tag in-stock" style={{ color: '#16a34a', fontWeight: 600 }}>
            {variant.effectiveAvailable} available
          </span>
        );
      }
    }

    // Default STATUS_ONLY
    return (
      <span className="stock-tag in-stock" style={{ color: '#16a34a', fontWeight: 600 }}>
        {showInventory && variant.effectiveAvailable !== null && variant.effectiveAvailable !== undefined
          ? `${variant.effectiveAvailable} available`
          : 'In stock'}
      </span>
    );
  };

  return (
    <div className="product-card" id={`product-${product.id}`}>
      <div className="product-card-header">
        {product.imageUrl && (
          <img src={product.imageUrl} alt={product.title} className="product-img" />
        )}
        <div>
          <h3 className="product-title">{product.title}</h3>
          {product.vendor && <p className="product-vendor">{product.vendor}</p>}
        </div>
      </div>

      <table className="variant-table" role="table" aria-label={`Variants for ${product.title}`}>
        <thead>
          <tr role="row">
            <th scope="col">Variant / Options</th>
            {showSku && <th scope="col">SKU</th>}
            {inventoryMode !== 'HIDDEN' && <th scope="col">Availability</th>}
            <th scope="col">Wholesale Price</th>
            <th scope="col" style={{ width: '150px', textAlign: 'right' }}>Quantity</th>
          </tr>
        </thead>
        <tbody>
          {product.variants.map((variant) => {
            const currentQty = quantities[variant.shopifyVariantId] || 0;
            const hasDiscount = variant.displayPrice < variant.basePrice;
            const isOutOfStock = !variant.availableForSale || variant.effectiveAvailable === 0;
            const min = variant.minQty || 1;
            const step = variant.qtyIncrement || 1;
            const maxLimit = variant.maxQty || (variant.effectiveAvailable !== null && variant.effectiveAvailable !== undefined ? variant.effectiveAvailable : null);

            return (
              <tr key={variant.shopifyVariantId} role="row">
                <td>
                  <span style={{ fontWeight: 500 }}>{variant.title}</span>
                  {(variant.minQty || variant.maxQty || variant.qtyIncrement) && (
                    <div className="qty-rules-hint" style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      {variant.minQty && <span>Min: {variant.minQty} </span>}
                      {variant.maxQty && <span>Max: {variant.maxQty} </span>}
                      {variant.qtyIncrement && variant.qtyIncrement > 1 && <span>Step: {variant.qtyIncrement}</span>}
                    </div>
                  )}
                </td>
                {showSku && (
                  <td>
                    <span className="variant-sku">{variant.sku || '—'}</span>
                  </td>
                )}
                {inventoryMode !== 'HIDDEN' && <td>{renderStockBadge(variant)}</td>}
                <td>
                  <div className="price-box">
                    <span className="display-price">
                      {variant.formattedPrice || `$${variant.displayPrice.toFixed(2)}`}
                    </span>
                    {hasDiscount && (
                      <span className="base-price-struck">${variant.basePrice.toFixed(2)}</span>
                    )}
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div className="qty-control">
                    <button
                      type="button"
                      className="qty-btn"
                      aria-label={`Decrease quantity for ${variant.title}`}
                      disabled={isOutOfStock || currentQty <= 0}
                      onClick={() => handleStep(variant.shopifyVariantId, currentQty, -1, min, maxLimit, step)}
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min="0"
                      step={step}
                      max={maxLimit !== null ? maxLimit : undefined}
                      disabled={isOutOfStock}
                      aria-label={`Quantity for ${variant.title}`}
                      className="qty-input"
                      value={isOutOfStock ? '' : (currentQty === 0 ? '' : currentQty)}
                      placeholder={isOutOfStock ? '0' : '0'}
                      onChange={(e) => handleInputChange(variant.shopifyVariantId, e.target.value, maxLimit)}
                      onKeyDown={(e) => {
                        if (isOutOfStock) return;
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          handleStep(variant.shopifyVariantId, currentQty, 1, min, maxLimit, step);
                        } else if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          handleStep(variant.shopifyVariantId, currentQty, -1, min, maxLimit, step);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="qty-btn"
                      aria-label={`Increase quantity for ${variant.title}`}
                      disabled={isOutOfStock || (maxLimit !== null && currentQty >= maxLimit)}
                      onClick={() => handleStep(variant.shopifyVariantId, currentQty, 1, min, maxLimit, step)}
                    >
                      +
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
