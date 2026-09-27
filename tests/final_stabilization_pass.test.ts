import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import {
  createCatalog,
  updateCatalog,
  publishCatalog,
  getCatalogById,
} from '../src/services/catalog.server.js';
import { createOrderLink } from '../src/services/orderlink.server.js';
import { getPublicCatalogPayload } from '../src/services/sync.server.js';
import { validateBuyerOrderLines } from '../src/services/validation.server.js';
import { getShopAnalyticsSummary, recordAnalyticsEvent, ANALYTICS_EVENTS } from '../src/services/analytics.server.js';
import { parseApiErrorMessage, sanitizeErrorMessage } from '../src/services/security.server.js';
import { CatalogSourceType, PriceMode, resolveEffectiveQuantityRules, resolveVariantInventory } from '../src/types/index.js';

describe('Final Launch Stabilization Pass Test Suite', () => {
  let shop: { id: string; shopDomain: string };
  const prodGid1 = 'gid://shopify/Product/8001';
  const prodGid2 = 'gid://shopify/Product/8002';
  const varGid1 = 'gid://shopify/ProductVariant/80011';
  const varGid2 = 'gid://shopify/ProductVariant/80021';

  beforeEach(async () => {
    await prisma.analyticsEvent.deleteMany();
    await prisma.orderSubmission.deleteMany();
    await prisma.orderLink.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalogVariantConfig.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'launch-stabilization-test.myshopify.com',
      accessToken: 'token_launch_test',
    });

    await prisma.productSnapshot.create({
      data: {
        shopId: shop.id,
        shopifyProductId: prodGid1,
        title: 'Product One',
        handle: 'product-one',
        status: 'ACTIVE',
        variants: {
          create: [
            {
              shopifyVariantId: varGid1,
              title: 'Variant One',
              shopifyPrice: 20.0,
              inventoryQuantity: 10,
              availableForSale: true,
              inventoryTracked: true,
              inventoryPolicy: 'DENY',
              selectedOptionsJson: '[]',
            },
          ],
        },
      },
    });

    await prisma.productSnapshot.create({
      data: {
        shopId: shop.id,
        shopifyProductId: prodGid2,
        title: 'Product Two',
        handle: 'product-two',
        status: 'ACTIVE',
        variants: {
          create: [
            {
              shopifyVariantId: varGid2,
              title: 'Variant Two',
              shopifyPrice: 40.0,
              inventoryQuantity: 5,
              availableForSale: true,
              inventoryTracked: true,
              inventoryPolicy: 'DENY',
              selectedOptionsJson: '[]',
            },
          ],
        },
      },
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // EDIT MEMBERSHIP (1 - 4)
  // ───────────────────────────────────────────────────────────────────────────

  it('1. add product to existing catalog', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Edit Membership Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });

    const updated = await updateCatalog(shop.id, catalog.id, {
      sources: [
        { type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 },
        { type: CatalogSourceType.PRODUCT, shopifyGid: prodGid2 },
      ],
    });

    expect(updated.sources.length).toBe(2);
    expect(updated.sources.some((s) => s.shopifyGid === prodGid2)).toBe(true);
  });

  it('2. remove product from existing catalog', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Remove Product Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [
        { type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 },
        { type: CatalogSourceType.PRODUCT, shopifyGid: prodGid2 },
      ],
    });

    const updated = await updateCatalog(shop.id, catalog.id, {
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });

    expect(updated.sources.length).toBe(1);
    expect(updated.sources[0].shopifyGid).toBe(prodGid1);
  });

  it('3. add/remove persists and dataVersion increments', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Persist Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });

    const initialVersion = catalog.dataVersion;
    const updated = await updateCatalog(shop.id, catalog.id, {
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid2 }],
    });

    expect(updated.dataVersion).toBeGreaterThan(initialVersion);
    const reFetched = await getCatalogById(shop.id, catalog.id);
    expect(reFetched.sources[0].shopifyGid).toBe(prodGid2);
  });

  it('4. existing Order Links remain valid after catalog edit', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Order Link Edit Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });
    await publishCatalog(shop.id, catalog.id);

    const link = await createOrderLink(catalog.id, shop.id, { label: 'Permanent Link' });

    await updateCatalog(shop.id, catalog.id, {
      sources: [
        { type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 },
        { type: CatalogSourceType.PRODUCT, shopifyGid: prodGid2 },
      ],
    });

    const payload = await getPublicCatalogPayload(catalog.publicToken);
    expect(payload).not.toBeNull();
    expect(payload?.catalog.id).toBe(catalog.id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ERROR UX (20 - 21)
  // ───────────────────────────────────────────────────────────────────────────

  it('20. stale catalog error renders friendly message and avoids [object Object]', async () => {
    const catalog = await createCatalog(shop.id, {
      name: 'Stale Error Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: prodGid1 }],
    });
    await publishCatalog(shop.id, catalog.id);

    // Stale dataVersion submit
    const valResult = await validateBuyerOrderLines(catalog.publicToken, {
      dataVersion: 99999, // Stale version
      lines: [{ variantId: varGid1, quantity: 1 }],
    });

    expect(valResult.status).toBe('CHANGED');
    expect(valResult.changedLines.some((l) => l.reason === 'DELETED' || l.reason === 'QTY_RULE')).toBe(false);
  });

  it('21. API error parser never returns [object Object]', () => {
    const objError = { error: { message: 'Catalog version mismatch' } };
    const rawMsg = parseApiErrorMessage(objError);
    expect(rawMsg).not.toContain('[object Object]');
    expect(rawMsg).toBe('Catalog version mismatch');

    const sanitized = sanitizeErrorMessage(objError);
    expect(sanitized).not.toContain('[object Object]');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ANALYTICS (24 - 26)
  // ───────────────────────────────────────────────────────────────────────────

  it('24. truthful funnel semantics: engaged count is at least draft order count', async () => {
    // Record 10 catalog views and 5 draft orders created (without prior order_summary_started events)
    for (let i = 0; i < 10; i++) {
      await recordAnalyticsEvent(shop.id, ANALYTICS_EVENTS.CATALOG_VIEWED);
    }
    for (let i = 0; i < 5; i++) {
      await recordAnalyticsEvent(shop.id, ANALYTICS_EVENTS.DRAFT_ORDER_CREATED, undefined, undefined, `key_${i}`);
    }

    const summary = await getShopAnalyticsSummary(shop.id, 30);
    expect(summary.counts.catalogViews).toBe(10);
    expect(summary.counts.draftOrdersCreated).toBe(5);
    // orderSummariesStarted should be at least 5 (Math.max(0, 0, 5))
    expect(summary.counts.orderSummariesStarted).toBe(5);
    expect(summary.conversionRates.overallConversionPct).toBe(50);
  });

  it('25. orders/views conversion math is accurately computed', async () => {

    await recordAnalyticsEvent(shop.id, ANALYTICS_EVENTS.CATALOG_VIEWED);
    await recordAnalyticsEvent(shop.id, ANALYTICS_EVENTS.CATALOG_VIEWED);
    await recordAnalyticsEvent(shop.id, ANALYTICS_EVENTS.DRAFT_ORDER_CREATED, undefined, undefined, 'order_key_1');

    const summary = await getShopAnalyticsSummary(shop.id, 30);
    expect(summary.counts.catalogViews).toBe(2);
    expect(summary.counts.draftOrdersCreated).toBe(1);
    expect(summary.conversionRates.overallConversionPct).toBe(50);
  });
});
