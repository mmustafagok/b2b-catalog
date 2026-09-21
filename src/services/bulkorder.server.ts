/**
 * CSV Bulk Order Service
 *
 * Parses a buyer-supplied CSV (SKU,qty) bulk order, resolves SKUs to
 * variant GIDs, validates catalog membership and quantity rules, and
 * returns valid lines + per-row errors.
 *
 * Expected CSV format:
 *   SKU,Qty
 *   BLUE-WIDGET-LG,6
 *   RED-WIDGET-SM,12
 *
 * Header row is optional and auto-detected. Blank rows are skipped.
 */

import { prisma } from '../db.js';
import type { CatalogVariantConfig } from '@prisma/client';
import { resolveCatalogAllowedProductGids } from './sync.server.js';

export interface CsvBulkOrderRow {
  row: number;
  sku: string;
  qty: number;
}

export interface CsvBulkOrderError {
  row: number;
  sku: string;
  qty: number | null;
  error: string;
  errorCode: 'UNKNOWN_SKU' | 'NOT_IN_CATALOG' | 'OUT_OF_STOCK' | 'BELOW_MIN' | 'ABOVE_MAX' | 'BAD_INCREMENT' | 'INVALID_QTY' | 'DUPLICATE_SKU' | 'PARSE_ERROR';
}

export interface CsvBulkOrderLine {
  variantId: string;
  quantity: number;
  sku: string;
  productTitle: string;
  variantTitle: string;
}

export interface CsvBulkOrderResult {
  validLines: CsvBulkOrderLine[];
  errors: CsvBulkOrderError[];
  totalParsedRows: number;
}

const HEADER_PATTERNS = [/^sku/i, /^item/i, /^product/i, /^code/i, /^barcode/i];

function looksLikeHeader(firstCell: string): boolean {
  return HEADER_PATTERNS.some((p) => p.test(firstCell.trim()));
}

/**
 * Parses raw CSV text into (sku, qty) tuples.
 * Handles: header detection, blank rows, extra whitespace, quoted fields.
 */
function parseCsvRows(csvText: string): Array<{ row: number; sku: string; rawQty: string } | { row: number; parseError: string }> {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const results: Array<{ row: number; sku: string; rawQty: string } | { row: number; parseError: string }> = [];
  let rowNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV columns (simple split, handles basic quoting)
    const cols = line.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
    rowNum++;

    if (rowNum === 1 && looksLikeHeader(cols[0])) {
      rowNum = 0; // reset so next real row is row 1
      continue;
    }

    const sku = cols[0] || '';
    const rawQty = cols[1] || '';

    if (!sku) {
      results.push({ row: rowNum, parseError: 'SKU column is empty' });
      continue;
    }

    results.push({ row: rowNum, sku, rawQty });
  }

  return results;
}

/**
 * Main entry point.
 * Validates all SKUs against catalog membership, inventory, and quantity rules.
 */
export async function parseCsvBulkOrder(
  shopId: string,
  catalogId: string,
  csvText: string
): Promise<CsvBulkOrderResult> {
  // 1. Load catalog + variant configs
  const catalog = await prisma.catalog.findFirst({
    where: { id: catalogId, shopId, status: 'PUBLISHED' },
    include: { sources: true, variantConfigs: true },
  });

  if (!catalog) {
    throw Object.assign(new Error('Catalog not found or not published'), { statusCode: 404 });
  }

  // 2. Resolve allowed product GIDs
  const allowedProductGids = await resolveCatalogAllowedProductGids(shopId, catalog.sources);

  // 3. Build variant config map (shopifyVariantId → config)
  const variantConfigMap = new Map<string, CatalogVariantConfig>(
    catalog.variantConfigs.map((vc) => [vc.shopifyVariantId, vc])
  );

  // 4. Load all variant snapshots with SKUs for this shop (only SKUs that exist)
  const allVariants = await prisma.variantSnapshot.findMany({
    where: {
      shopId,
      shopifyProductId: { in: Array.from(allowedProductGids) },
    },
    include: { product: true },
    orderBy: { sku: 'asc' },
  });

  // Build SKU → variant map (take first match if duplicate across products)
  const skuToVariant = new Map<string, (typeof allVariants)[0]>();
  for (const v of allVariants) {
    if (v.sku && !skuToVariant.has(v.sku.trim().toUpperCase())) {
      skuToVariant.set(v.sku.trim().toUpperCase(), v);
    }
  }

  // 5. Parse CSV rows
  const parsedRows = parseCsvRows(csvText);

  const validLines: CsvBulkOrderLine[] = [];
  const errors: CsvBulkOrderError[] = [];
  const seenSkus = new Map<string, number>(); // SKU → row number (for duplicate detection)

  for (const parsed of parsedRows) {
    if ('parseError' in parsed) {
      errors.push({ row: parsed.row, sku: '', qty: null, error: parsed.parseError, errorCode: 'PARSE_ERROR' });
      continue;
    }

    const { row, sku, rawQty } = parsed;
    const skuUpper = sku.trim().toUpperCase();

    // Qty validation
    const qty = parseInt(rawQty, 10);
    if (!rawQty || isNaN(qty) || qty < 1) {
      errors.push({ row, sku, qty: null, error: `Invalid quantity "${rawQty}" — must be a positive integer`, errorCode: 'INVALID_QTY' });
      continue;
    }

    // Duplicate SKU check
    if (seenSkus.has(skuUpper)) {
      errors.push({ row, sku, qty, error: `Duplicate SKU "${sku}" (first seen on row ${seenSkus.get(skuUpper)})`, errorCode: 'DUPLICATE_SKU' });
      continue;
    }
    seenSkus.set(skuUpper, row);

    // SKU lookup
    const variant = skuToVariant.get(skuUpper);
    if (!variant) {
      errors.push({ row, sku, qty, error: `SKU "${sku}" not found in this catalog`, errorCode: 'UNKNOWN_SKU' });
      continue;
    }

    // Catalog membership check
    if (!allowedProductGids.has(variant.shopifyProductId)) {
      errors.push({ row, sku, qty, error: `SKU "${sku}" is not in this catalog`, errorCode: 'NOT_IN_CATALOG' });
      continue;
    }

    // Variant enabled check
    const vcfg = variantConfigMap.get(variant.shopifyVariantId);
    if (vcfg && !vcfg.enabled) {
      errors.push({ row, sku, qty, error: `SKU "${sku}" is not available in this catalog`, errorCode: 'NOT_IN_CATALOG' });
      continue;
    }

    // Availability check (skip if inventoryPolicy = CONTINUE)
    if (variant.inventoryTracked && variant.inventoryPolicy !== 'CONTINUE' && !variant.availableForSale) {
      errors.push({ row, sku, qty, error: `SKU "${sku}" is out of stock`, errorCode: 'OUT_OF_STOCK' });
      continue;
    }

    // Quantity rules (variant overrides → catalog defaults)
    const effectiveMin = vcfg?.minQty ?? catalog.minQty ?? 1;
    const effectiveMax = vcfg?.maxQty ?? catalog.maxQty ?? null;
    const effectiveIncrement = vcfg?.qtyIncrement ?? catalog.qtyIncrement ?? 1;

    if (qty < effectiveMin) {
      errors.push({ row, sku, qty, error: `Quantity ${qty} is below minimum ${effectiveMin} for SKU "${sku}"`, errorCode: 'BELOW_MIN' });
      continue;
    }
    if (effectiveMax !== null && qty > effectiveMax) {
      errors.push({ row, sku, qty, error: `Quantity ${qty} exceeds maximum ${effectiveMax} for SKU "${sku}"`, errorCode: 'ABOVE_MAX' });
      continue;
    }
    if (effectiveIncrement > 1 && qty % effectiveIncrement !== 0) {
      errors.push({ row, sku, qty, error: `Quantity ${qty} must be a multiple of ${effectiveIncrement} for SKU "${sku}"`, errorCode: 'BAD_INCREMENT' });
      continue;
    }

    validLines.push({
      variantId: variant.shopifyVariantId,
      quantity: qty,
      sku: variant.sku || sku,
      productTitle: variant.product.title,
      variantTitle: variant.title,
    });
  }

  return {
    validLines,
    errors,
    totalParsedRows: parsedRows.length,
  };
}
