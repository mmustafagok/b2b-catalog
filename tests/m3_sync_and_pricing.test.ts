import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import { createCatalog, publishCatalog } from '../src/services/catalog.server.js';
import { calculateDisplayPrice, roundDecimal, toDecimal } from '../src/services/pricing.server.js';
import {
  syncProductSnapshot,
  deleteProductSnapshot,
  getPublicCatalogPayload,
  normalizeShopifyGid,
} from '../src/services/sync.server.js';
import { CatalogSourceType, PriceMode } from '../src/types/index.js';

describe('Milestone 3: Product Sync, Snapshot Cache & Pricing Logic', () => {
  let shop: { id: string; shopDomain: string };

  beforeEach(async () => {
    await prisma.orderSubmission.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'sync-test.myshopify.com',
      accessToken: 'token_sync_test',
    });
  });

  describe('Pricing Calculations', () => {
    it('should correctly round decimal money to two decimal places', () => {
      expect(roundDecimal('19.994').toString()).toBe('19.99');
      expect(roundDecimal('19.995').toString()).toBe('20');
      expect(roundDecimal(toDecimal('0.1').plus('0.2')).toString()).toBe('0.3');
    });

    it('should calculate wholesale display prices with various discount percentages', () => {
      // 1. Shopify Price mode (0% discount)
      expect(calculateDisplayPrice(100, PriceMode.SHOPIFY_PRICE, 0).toNumber()).toBe(100.0);

      // 2. 10% discount on $100 -> $90
      expect(calculateDisplayPrice(100, PriceMode.PERCENT_DISCOUNT, 10).toNumber()).toBe(90.0);

      // 3. 25% discount on $39.99 -> $29.99
      expect(calculateDisplayPrice(39.99, PriceMode.PERCENT_DISCOUNT, 25).toNumber()).toBe(29.99);

      // 4. 33.3% discount on $45.50 -> $30.35
      expect(calculateDisplayPrice(45.5, PriceMode.PERCENT_DISCOUNT, 33.3).toNumber()).toBe(30.35);

      // 5. 90% discount on $200 -> $20
      expect(calculateDisplayPrice(200, PriceMode.PERCENT_DISCOUNT, 90).toNumber()).toBe(20.0);

      // 6. Zero or negative price handling
      expect(calculateDisplayPrice(0, PriceMode.PERCENT_DISCOUNT, 20).toNumber()).toBe(0);
      expect(calculateDisplayPrice(-10, PriceMode.PERCENT_DISCOUNT, 20).toNumber()).toBe(0);
    });
  });

  describe('Product & Variant Snapshots Sync', () => {
    it('should normalize numeric IDs to standard Shopify GIDs', () => {
      expect(normalizeShopifyGid('Product', 12345)).toBe('gid://shopify/Product/12345');
      expect(normalizeShopifyGid('Product', 'gid://shopify/Product/12345')).toBe('gid://shopify/Product/12345');
      expect(normalizeShopifyGid('ProductVariant', 67890)).toBe('gid://shopify/ProductVariant/67890');
    });

    it('should ingest product and multiple variants with options', async () => {
      const mockWebhookProduct = {
        id: 5001,
        title: 'Wholesale Heavy Hoodie',
        vendor: 'Apparel Co',
        handle: 'heavy-hoodie',
        status: 'active',
        image: { src: 'https://example.com/hoodie.jpg' },
        options: [
          { name: 'Color', position: 1 },
          { name: 'Size', position: 2 },
        ],
        variants: [
          {
            id: 6001,
            product_id: 5001,
            title: 'Black / S',
            price: '50.00',
            sku: 'HOOD-BLK-S',
            barcode: '12345678',
            inventory_quantity: 45,
            available: true,
            option1: 'Black',
            option2: 'S',
          },
          {
            id: 6002,
            product_id: 5001,
            title: 'Black / M',
            price: '50.00',
            sku: 'HOOD-BLK-M',
            barcode: '12345679',
            inventory_quantity: 80,
            available: true,
            option1: 'Black',
            option2: 'M',
          },
        ],
      };

      await syncProductSnapshot(shop.id, mockWebhookProduct);

      const product = await prisma.productSnapshot.findUnique({
        where: {
          shopId_shopifyProductId: {
            shopId: shop.id,
            shopifyProductId: 'gid://shopify/Product/5001',
          },
        },
        include: { variants: true },
      });

      expect(product).toBeDefined();
      expect(product?.title).toBe('Wholesale Heavy Hoodie');
      expect(product?.variants).toHaveLength(2);
      expect(product?.variants[0].sku).toBe('HOOD-BLK-S');
      expect(Number(product?.variants[0].shopifyPrice)).toBe(50.0);
    });

    it('should prune deleted variants upon product update', async () => {
      // 1. Ingest with 2 variants
      await syncProductSnapshot(shop.id, {
        id: 5002,
        title: 'T-Shirt',
        handle: 't-shirt',
        status: 'active',
        variants: [
          { id: 7001, product_id: 5002, title: 'Small', price: '20.00', sku: 'TS-S' },
          { id: 7002, product_id: 5002, title: 'Medium', price: '20.00', sku: 'TS-M' },
        ],
      });

      let variants = await prisma.variantSnapshot.findMany({
        where: { shopId: shop.id, shopifyProductId: 'gid://shopify/Product/5002' },
      });
      expect(variants).toHaveLength(2);

      // 2. Update with only 1 variant (Small deleted on Shopify)
      await syncProductSnapshot(shop.id, {
        id: 5002,
        title: 'T-Shirt',
        handle: 't-shirt',
        status: 'active',
        variants: [
          { id: 7002, product_id: 5002, title: 'Medium', price: '20.00', sku: 'TS-M' },
        ],
      });

      variants = await prisma.variantSnapshot.findMany({
        where: { shopId: shop.id, shopifyProductId: 'gid://shopify/Product/5002' },
      });
      expect(variants).toHaveLength(1);
      expect(variants[0].sku).toBe('TS-M');
    });

    it('should delete product snapshot and cascade variants on deleteProductSnapshot', async () => {
      await syncProductSnapshot(shop.id, {
        id: 5003,
        title: 'Delete Me Product',
        handle: 'delete-me',
        status: 'active',
        variants: [{ id: 8001, product_id: 5003, title: 'Default', price: '10.00', sku: 'DEL-1' }],
      });

      await deleteProductSnapshot(shop.id, 5003);

      const product = await prisma.productSnapshot.findUnique({
        where: {
          shopId_shopifyProductId: {
            shopId: shop.id,
            shopifyProductId: 'gid://shopify/Product/5003',
          },
        },
      });
      expect(product).toBeNull();

      const variants = await prisma.variantSnapshot.findMany({
        where: { shopId: shop.id, shopifyProductId: 'gid://shopify/Product/5003' },
      });
      expect(variants).toHaveLength(0);
    });
  });

  describe('Public Catalog Payload Generation', () => {
    it('should assemble public catalog payload with computed wholesale prices and settings', async () => {
      // 1. Ingest product
      await syncProductSnapshot(shop.id, {
        id: 9001,
        title: 'Premium Denim',
        vendor: 'Jeans Inc',
        handle: 'premium-denim',
        status: 'active',
        image: { src: 'https://example.com/jeans.jpg' },
        variants: [
          {
            id: 9101,
            product_id: 9001,
            title: '30W / 32L',
            price: '80.00',
            sku: 'JEANS-30-32',
            inventory_quantity: 25,
            available: true,
          },
        ],
      });

      // 2. Create catalog with 20% discount and showInventory enabled
      const catalog = await createCatalog(shop.id, {
        name: 'Denim Line Sheet',
        priceMode: PriceMode.PERCENT_DISCOUNT,
        discountPercent: 20,
        showInventory: true,
        showSku: true,
        sources: [
          {
            type: CatalogSourceType.PRODUCT,
            shopifyGid: 'gid://shopify/Product/9001',
          },
        ],
      });

      await publishCatalog(shop.id, catalog.id);

      // 3. Request public payload
      const payload = await getPublicCatalogPayload(catalog.publicToken);

      expect(payload).toBeDefined();
      expect(payload?.catalog.name).toBe('Denim Line Sheet');
      expect(payload?.catalog.discountPercent).toBe(20);
      expect(payload?.products).toHaveLength(1);

      const prod = payload?.products[0];
      expect(prod?.title).toBe('Premium Denim');
      expect(prod?.variants).toHaveLength(1);

      const variant = prod?.variants[0];
      expect(variant?.sku).toBe('JEANS-30-32');
      expect(variant?.basePrice).toBe(80.0);
      expect(variant?.displayPrice).toBe(64.0); // 80 * 0.80 = 64
      expect(variant?.inventoryQuantity).toBe(25);
    });
  });
});
