import { PriceMode } from '../types/index.js';
import { Prisma } from '@prisma/client';

export type DecimalLike = number | string | Prisma.Decimal;

/**
 * Converts a DecimalLike value to a Prisma Decimal with 2 decimal places.
 */
export function toDecimal(val: DecimalLike): Prisma.Decimal {
  if (val instanceof Prisma.Decimal) {
    return val;
  }
  return new Prisma.Decimal(String(val));
}

/**
 * Rounds a monetary decimal to 2 decimal places deterministically.
 */
export function roundDecimal(amount: DecimalLike): Prisma.Decimal {
  const dec = toDecimal(amount);
  return dec.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Deterministically computes the buyer display price using Decimal arithmetic.
 */
export function calculateDisplayPrice(
  basePrice: DecimalLike,
  priceMode: string = PriceMode.SHOPIFY_PRICE,
  discountPercent: DecimalLike | null = 0
): Prisma.Decimal {
  const baseDec = toDecimal(basePrice);

  if (baseDec.lte(0)) {
    return new Prisma.Decimal('0.00');
  }

  if (priceMode === PriceMode.PERCENT_DISCOUNT && discountPercent) {
    const discountDec = toDecimal(discountPercent);
    if (discountDec.gt(0)) {
      const validDiscount = Prisma.Decimal.min(Prisma.Decimal.max(discountDec, new Prisma.Decimal(0)), new Prisma.Decimal(90));
      // multiplier = 1 - (discount / 100)
      const multiplier = new Prisma.Decimal(1).minus(validDiscount.dividedBy(100));
      return roundDecimal(baseDec.times(multiplier));
    }
  }

  return roundDecimal(baseDec);
}

/**
 * Formats a monetary amount into a localized currency string.
 * e.g. formatMoney(120.50, 'EUR') => "€120.50"
 * e.g. formatMoney(120.50, 'USD') => "$120.50"
 * e.g. formatMoney(120.50, 'TRY') => "TRY 120.50" or "₺120.50"
 */
export function formatMoney(amount: DecimalLike, currency: string = 'USD'): string {
  const num = typeof amount === 'number' ? amount : parseFloat(toDecimal(amount).toFixed(2));
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  } catch {
    // Fallback if currency code is unusual
    return `${currency.toUpperCase()} ${num.toFixed(2)}`;
  }
}

/**
 * Validates whether two amounts match within standard cent tolerance.
 */
export function verifyLinePrice(
  actualCalculatedPrice: DecimalLike,
  expectedPrice: DecimalLike,
  tolerance: DecimalLike = 0.01
): boolean {
  const diff = toDecimal(actualCalculatedPrice).minus(toDecimal(expectedPrice)).abs();
  return diff.lte(toDecimal(tolerance));
}
