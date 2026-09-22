import { prisma } from '../db.js';
import { BuyerValidateOrderSchema, resolveEffectiveQuantityRules } from '../types/index.js';
import { calculateDisplayPrice, toDecimal, formatMoney } from './pricing.server.js';
import { CatalogStatus, PriceMode } from '../types/index.js';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { resolveCatalogAllowedProductGids } from './sync.server.js';
import type { CatalogVariantConfig } from '@prisma/client';

export type BuyerValidateOrderInput = z.infer<typeof BuyerValidateOrderSchema>;

export interface ValidationResult {
  status: 'VALID' | 'CHANGED' | 'INVALID';
  changedLines: Array<{
    variantId: string;
    productTitle: string;
    variantTitle: string;
    reason: 'PRICE_CHANGED' | 'OUT_OF_STOCK' | 'DELETED' | 'DISABLED' | 'QTY_RULE';
    oldPrice?: number;
    newPrice?: number;
    available?: boolean;
    detail?: string;
  }>;
  summary: {
    totalItems: number;
    totalLines: number;
    subtotal: number;
    formattedSubtotal: string;
    currency: string;
  };
}

/**
 * Validates buyer cart against current snapshot data before submission.
 * Also validates variant-level enable/disable status and quantity rules.
 * Respects inventory mode privacy — never leaks exact qty in STATUS_ONLY or HIDDEN modes.
 */
export async function validateBuyerOrderLines(
  publicToken: string,
  input: BuyerValidateOrderInput
): Promise<ValidationResult> {
  const validated = BuyerValidateOrderSchema.parse(input);

  const catalog = await prisma.catalog.findUnique({
    where: { publicToken },
    include: { shop: true, sources: true, variantConfigs: true },
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

  // Build variant config map
  const variantConfigMap = new Map<string, CatalogVariantConfig>(
    (catalog.variantConfigs as CatalogVariantConfig[]).map((vc) => [vc.shopifyVariantId, vc])
  );

  const inventoryMode: string = (catalog as any).inventoryMode || 'STATUS_ONLY';
  const catalogMinQty: number = (catalog as any).minQty ?? 1;
  const catalogMaxQty: number | null = (catalog as any).maxQty ?? null;
  const catalogQtyIncrement: number = (catalog as any).qtyIncrement ?? 1;
  const customPriceAmount = (catalog as any).customPriceAmount ?? null;

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
    const vcfg = variantConfigMap.get(line.variantId);

    if (!snapshot || !allowedProductGids.has(snapshot.shopifyProductId) || snapshot.product.status !== 'ACTIVE') {
      changedLines.push({
        variantId: line.variantId,
        productTitle: snapshot?.product.title || 'Item',
        variantTitle: snapshot?.title || line.variantId,
        reason: 'DELETED',
      });
      continue;
    }

    // Variant-level enabled check
    if (vcfg && !vcfg.enabled) {
      changedLines.push({
        variantId: line.variantId,
        productTitle: snapshot.product.title,
        variantTitle: snapshot.title,
        reason: 'DISABLED',
        detail: 'This item is no longer available in this catalog',
      });
      continue;
    }

    // Quantity rule validation
    const { min: effectiveMin, max: effectiveMax, step: effectiveIncrement } = resolveEffectiveQuantityRules(catalog as any, vcfg);

    if (line.quantity < effectiveMin) {
      changedLines.push({
        variantId: line.variantId,
        productTitle: snapshot.product.title,
        variantTitle: snapshot.title,
        reason: 'QTY_RULE',
        detail: `Minimum quantity is ${effectiveMin}`,
      });
      continue;
    }
    if (effectiveMax !== null && line.quantity > effectiveMax) {
      changedLines.push({
        variantId: line.variantId,
        productTitle: snapshot.product.title,
        variantTitle: snapshot.title,
        reason: 'QTY_RULE',
        detail: `Maximum quantity is ${effectiveMax}`,
      });
      continue;
    }
    if (effectiveIncrement > 1 && (line.quantity - effectiveMin) % effectiveIncrement !== 0) {
      changedLines.push({
        variantId: line.variantId,
        productTitle: snapshot.product.title,
        variantTitle: snapshot.title,
        reason: 'QTY_RULE',
        detail: `Quantity must be in increments of ${effectiveIncrement} starting from ${effectiveMin}`,
      });
      continue;
    }

    // Stock check
    if (!snapshot.availableForSale || (snapshot.inventoryTracked && snapshot.inventoryPolicy !== 'CONTINUE' && snapshot.inventoryQuantity <= 0)) {
      changedLines.push({
        variantId: line.variantId,
        productTitle: snapshot.product.title,
        variantTitle: snapshot.title,
        reason: 'OUT_OF_STOCK',
        available: false,
        detail: 'This item is currently unavailable',
      });
      continue;
    }

    // Calculate display price
    let currentDisplayPrice: Prisma.Decimal;
    if (vcfg?.customPrice) {
      currentDisplayPrice = toDecimal(vcfg.customPrice);
    } else if (catalog.priceMode === PriceMode.CUSTOM_PRICE && customPriceAmount) {
      currentDisplayPrice = toDecimal(customPriceAmount);
    } else {
      currentDisplayPrice = calculateDisplayPrice(
        snapshot.shopifyPrice,
        catalog.priceMode,
        catalog.discountPercent
      );
    }

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
