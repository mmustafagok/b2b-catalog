import { PriceMode } from '../types/index.js';

/**
 * Rounds money to 2 decimal places using standard financial rounding.
 */
export function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * Deterministically computes the buyer display price.
 * @param basePrice Shopify regular variant price
 * @param priceMode SHOPIFY_PRICE or PERCENT_DISCOUNT
 * @param discountPercent 0 - 90 percentage discount
 */
export function calculateDisplayPrice(
  basePrice: number,
  priceMode: string = PriceMode.SHOPIFY_PRICE,
  discountPercent: number | null = 0
): number {
  if (basePrice <= 0) {
    return 0;
  }

  if (priceMode === PriceMode.PERCENT_DISCOUNT && discountPercent && discountPercent > 0) {
    const validDiscount = Math.min(Math.max(discountPercent, 0), 90);
    const discounted = basePrice * (1 - validDiscount / 100);
    return roundMoney(discounted);
  }

  return roundMoney(basePrice);
}

/**
 * Validates whether a line price matches the expected wholesale calculation.
 */
export function verifyLinePrice(
  actualCalculatedPrice: number,
  expectedPrice: number,
  tolerance: number = 0.01
): boolean {
  return Math.abs(actualCalculatedPrice - expectedPrice) <= tolerance;
}
