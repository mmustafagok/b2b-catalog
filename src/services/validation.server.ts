import { prisma } from '../db.js';
import { BuyerValidateOrderSchema } from '../types/index.js';
import { calculateDisplayPrice, toDecimal, formatMoney } from './pricing.server.js';
import { CatalogStatus } from '../types/index.js';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

export type BuyerValidateOrderInput = z.infer<typeof BuyerValidateOrderSchema>;

export interface ValidationResult {
  status: 'VALID' | 'CHANGED' | 'INVALID';
  changedLines: Array<{
    variantId: string;
    productTitle: string;
    variantTitle: string;
    reason: 'PRICE_CHANGED' | 'OUT_OF_STOCK' | 'DELETED';
    oldPrice?: number;
    newPrice?: number;
    available?: boolean;
  }>;
  summary: {
    totalItems: number;
    totalLines: number;
    subtotal: number;
    formattedSubtotal: string;
    currency: string;
  };
}

import { resolveCatalogAllowedProductGids } from './sync.server.js';

/**
 * Validates buyer cart against current snapshot data before submission.
 */
export async function validateBuyerOrderLines(
  publicToken: string,
  input: BuyerValidateOrderInput
): Promise<ValidationResult> {
  const validated = BuyerValidateOrderSchema.parse(input);

  const catalog = await prisma.catalog.findUnique({
    where: { publicToken },
    include: { shop: true, sources: true },
  });

  if (!catalog || catalog.status !== CatalogStatus.PUBLISHED || catalog.shop.uninstalledAt !== null) {
    return {
      status: 'INVALID',
      changedLines: [
        {
          variantId: '',
          productTitle: 'Catalog',
          variantTitle: '',
          reason: 'DELETED',
        },
      ],
      summary: { totalItems: 0, totalLines: 0, subtotal: 0, formattedSubtotal: '$0.00', currency: 'USD' },
    };
  }

  const allowedProductGids = await resolveCatalogAllowedProductGids(catalog.shopId, catalog.sources);
  const currency = catalog.shop.currency || 'USD';
  const variantGids = validated.lines.map((l) => l.variantId);
  const variantSnapshots = await prisma.variantSnapshot.findMany({
    where: {
      shopId: catalog.shopId,
      shopifyVariantId: { in: variantGids },
    },
    include: {
      product: true,
    },
  });

  const snapshotMap = new Map(variantSnapshots.map((v) => [v.shopifyVariantId, v]));
  const changedLines: ValidationResult['changedLines'] = [];

  let totalItems = 0;
  let subtotalDecimal = new Prisma.Decimal('0.00');

  for (const line of validated.lines) {
    const snapshot = snapshotMap.get(line.variantId);

    if (!snapshot || !allowedProductGids.has(snapshot.shopifyProductId) || snapshot.product.status !== 'ACTIVE') {
      changedLines.push({
        variantId: line.variantId,
        productTitle: snapshot?.product.title || 'Item',
        variantTitle: snapshot?.title || line.variantId,
        reason: 'DELETED',
      });
      continue;
    }

    if (!snapshot.availableForSale) {
      changedLines.push({
        variantId: line.variantId,
        productTitle: snapshot.product.title,
        variantTitle: snapshot.title,
        reason: 'OUT_OF_STOCK',
        available: false,
      });
      continue;
    }

    const currentDisplayPrice = calculateDisplayPrice(
      snapshot.shopifyPrice,
      catalog.priceMode,
      catalog.discountPercent
    );

    totalItems += line.quantity;
    subtotalDecimal = subtotalDecimal.plus(currentDisplayPrice.times(line.quantity));
  }

  const subtotalNumber = parseFloat(subtotalDecimal.toFixed(2));

  let status: ValidationResult['status'] = 'VALID';
  if (catalog.dataVersion !== validated.dataVersion) {
    status = 'CHANGED';
  } else if (changedLines.length > 0) {
    status = 'INVALID';
  }

  return {
    status,
    changedLines,
    summary: {
      totalItems,
      totalLines: validated.lines.length - changedLines.length,
      subtotal: subtotalNumber,
      formattedSubtotal: formatMoney(subtotalDecimal, currency),
      currency,
    },
  };
}
