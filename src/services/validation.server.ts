import { prisma } from '../db.js';
import { BuyerValidateOrderSchema } from '../types/index.js';
import { calculateDisplayPrice } from './pricing.server.js';
import { CatalogStatus } from '../types/index.js';
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
    currency: string;
  };
}

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
    include: { shop: true },
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
      summary: { totalItems: 0, totalLines: 0, subtotal: 0, currency: 'USD' },
    };
  }

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
  let subtotal = 0;

  for (const line of validated.lines) {
    const snapshot = snapshotMap.get(line.variantId);

    if (!snapshot) {
      changedLines.push({
        variantId: line.variantId,
        productTitle: 'Item',
        variantTitle: line.variantId,
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
    subtotal += currentDisplayPrice * line.quantity;
  }

  subtotal = Math.round(subtotal * 100) / 100;

  const status: ValidationResult['status'] =
    changedLines.length > 0 ? (catalog.dataVersion !== validated.dataVersion ? 'CHANGED' : 'INVALID') : 'VALID';

  return {
    status,
    changedLines,
    summary: {
      totalItems,
      totalLines: validated.lines.length - changedLines.length,
      subtotal,
      currency: 'USD',
    },
  };
}
