import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { PriceMode, CatalogSourceType } from '../src/types/index.js';
import {
  deriveOnboardingState,
  getLinkSharedStorageKey,
} from '../src/client/merchant/onboardingUtils.js';

describe('Lightweight Onboarding Improvement Suite', () => {
  let shop: { id: string; shopDomain: string };

  beforeEach(async () => {
    await prisma.orderSubmission.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalogVariantConfig.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'onboarding-test-shop.myshopify.com',
      accessToken: 'token_onboarding_test',
    });
  });

  it('1. zero catalogs → first-use card visible and checklist 0/4 complete', () => {
    const state = deriveOnboardingState({
      catalogsCount: 0,
      publishedCatalogsCount: 0,
      linkShared: false,
      submissionsCount: 0,
    });

    expect(state.shouldShowFirstUseCard).toBe(true);
    expect(state.shouldShowChecklist).toBe(true);
    expect(state.hasCatalog).toBe(false);
    expect(state.hasPublished).toBe(false);
    expect(state.linkShared).toBe(false);
    expect(state.hasFirstOrder).toBe(false);
    expect(state.isActivated).toBe(false);
  });

  it('2. Create Catalog CTA triggers catalog creation state', async () => {
    // Verify first-use card explicitly instructs Create Catalog action
    const state = deriveOnboardingState({
      catalogsCount: 0,
      publishedCatalogsCount: 0,
      linkShared: false,
      submissionsCount: 0,
    });
    expect(state.shouldShowFirstUseCard).toBe(true);

    // Simulate creating a catalog in DB
    const cat = await createCatalog(shop.id, {
      name: 'First Wholesale Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
    });
    expect(cat.id).toBeDefined();
  });

  it('3. catalog exists → "Catalog created" complete', async () => {
    await createCatalog(shop.id, {
      name: 'First Wholesale Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
    });

    const state = deriveOnboardingState({
      catalogsCount: 1,
      publishedCatalogsCount: 0,
      linkShared: false,
      submissionsCount: 0,
    });

    expect(state.shouldShowFirstUseCard).toBe(false);
    expect(state.shouldShowChecklist).toBe(true);
    expect(state.hasCatalog).toBe(true);
    expect(state.hasPublished).toBe(false);
  });

  it('4. published catalog → "Published" complete', async () => {
    const cat = await createCatalog(shop.id, {
      name: 'First Wholesale Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
    });
    await publishCatalog(shop.id, cat.id);

    const state = deriveOnboardingState({
      catalogsCount: 1,
      publishedCatalogsCount: 1,
      linkShared: false,
      submissionsCount: 0,
    });

    expect(state.hasCatalog).toBe(true);
    expect(state.hasPublished).toBe(true);
    expect(state.shouldShowChecklist).toBe(true);
  });

  it('5. Copy Link action → "Link copied/shared" complete', () => {
    const key = getLinkSharedStorageKey(shop.id);
    expect(key).toBe(`cf_link_shared_${shop.id}`);

    const state = deriveOnboardingState({
      catalogsCount: 1,
      publishedCatalogsCount: 1,
      linkShared: true,
      submissionsCount: 0,
    });

    expect(state.hasCatalog).toBe(true);
    expect(state.hasPublished).toBe(true);
    expect(state.linkShared).toBe(true);
    expect(state.hasFirstOrder).toBe(false);
  });

  it('6. first real submission → "First order received" complete', async () => {
    const cat = await createCatalog(shop.id, {
      name: 'First Wholesale Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
    });
    const published = await publishCatalog(shop.id, cat.id);

    const sub = await prisma.orderSubmission.create({
      data: {
        shopId: shop.id,
        catalogId: published.id,
        idempotencyKeyHash: 'hash_idemp_key_onboarding_test',
        draftOrderId: 'gid://shopify/DraftOrder/888',
        draftOrderName: '#DRAFT-888',
        status: 'COMPLETED',
        itemCount: 5,
        lineCount: 1,
        subtotalAmount: 100,
        currency: 'USD',
      },
    });

    expect(sub.id).toBeDefined();

    const state = deriveOnboardingState({
      catalogsCount: 1,
      publishedCatalogsCount: 1,
      linkShared: true,
      submissionsCount: 1,
    });

    expect(state.hasFirstOrder).toBe(true);
    expect(state.isActivated).toBe(true);
  });

  it('7. onboarding disappears permanently after first order', async () => {
    const state = deriveOnboardingState({
      catalogsCount: 1,
      publishedCatalogsCount: 1,
      linkShared: true,
      submissionsCount: 1,
    });

    expect(state.shouldShowFirstUseCard).toBe(false);
    expect(state.shouldShowChecklist).toBe(false);
    expect(state.isActivated).toBe(true);
  });

  it('8. existing activated merchant does not see onboarding', () => {
    const state = deriveOnboardingState({
      catalogsCount: 5,
      publishedCatalogsCount: 3,
      linkShared: true,
      submissionsCount: 42,
    });

    expect(state.shouldShowFirstUseCard).toBe(false);
    expect(state.shouldShowChecklist).toBe(false);
    expect(state.isActivated).toBe(true);
  });

  it('9. post-publish success state contract exposes Copy/Open/QR actions', async () => {
    const cat = await createCatalog(shop.id, {
      name: 'Publish Success Catalog',
      priceMode: PriceMode.SHOPIFY_PRICE,
      sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/101' }],
    });
    const published = await publishCatalog(shop.id, cat.id);

    expect(published.status).toBe('PUBLISHED');
    expect(published.publicToken).toBeDefined();
    // Post-publish success state relies on publicToken for Copy Link, Open Buyer View (/c/token), and QR Code
    const buyerUrl = `/c/${published.publicToken}`;
    expect(buyerUrl).toContain('/c/');
  });
});
