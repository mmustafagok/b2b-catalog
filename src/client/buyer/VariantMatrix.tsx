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
}

export const VariantMatrix: React.FC<VariantMatrixProps> = ({
  product,
  quantities,
  onQuantityChange,
  showSku,
  showInventory,
}) => {
  const handleInputChange = (variantId: string, val: string) => {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed) || parsed < 0) {
      onQuantityChange(variantId, 0);
    } else {
      onQuantityChange(variantId, parsed);
    }
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
            {showInventory && <th scope="col">Stock</th>}
            <th scope="col">Wholesale Price</th>
            <th scope="col" style={{ width: '150px', textAlign: 'right' }}>Quantity</th>
          </tr>
        </thead>
        <tbody>
          {product.variants.map((variant) => {
            const currentQty = quantities[variant.shopifyVariantId] || 0;
            const hasDiscount = variant.displayPrice < variant.basePrice;

            return (
              <tr key={variant.shopifyVariantId} role="row">
                <td>
                  <span style={{ fontWeight: 500 }}>{variant.title}</span>
                </td>
                {showSku && (
                  <td>
                    <span className="variant-sku">{variant.sku || '—'}</span>
                  </td>
                )}
                {showInventory && (
                  <td>
                    {variant.availableForSale ? (
                      <span className="stock-tag in-stock">
                        {variant.inventoryQuantity !== undefined
                          ? `${variant.inventoryQuantity} in stock`
                          : 'In Stock'}
                      </span>
                    ) : (
                      <span className="stock-tag out-of-stock">Out of stock</span>
                    )}
                  </td>
                )}
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
                      disabled={currentQty <= 0}
                      onClick={() => onQuantityChange(variant.shopifyVariantId, Math.max(0, currentQty - 1))}
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min="0"
                      aria-label={`Quantity for ${variant.title}`}
                      className="qty-input"
                      value={currentQty === 0 ? '' : currentQty}
                      placeholder="0"
                      onChange={(e) => handleInputChange(variant.shopifyVariantId, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          onQuantityChange(variant.shopifyVariantId, currentQty + 1);
                        } else if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          onQuantityChange(variant.shopifyVariantId, Math.max(0, currentQty - 1));
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="qty-btn"
                      aria-label={`Increase quantity for ${variant.title}`}
                      onClick={() => onQuantityChange(variant.shopifyVariantId, currentQty + 1)}
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
