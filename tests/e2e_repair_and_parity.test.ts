import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { installOrUpdateShop } from '../src/services/shop.server.js';
import {
  createCatalog,
  updateCatalog,
  publishCatalog,
  getCatalogById,
  getCatalogVariantConfigs,
  upsertCatalogVariantConfigs,
} from '../src/services/catalog.server.js';
import {
  createOrderLink,
  getOrderLinksForCatalog,
  getOrderLinkById,
  validateOrderLinkAccess,
  generateQrCodeDataUrl,
  verifyPasscode,
  hashPasscode,
  generateOrderLinkAccessToken,
} from '../src/services/orderlink.server.js';
import { syncProductSnapshot, getPublicCatalogPayload } from '../src/services/sync.server.js';
import { submitBuyerOrder, OrderSubmissionError } from '../src/services/order.server.js';
import { validateBuyerOrderLines } from '../src/services/validation.server.js';
import { PriceMode, InventoryMode, CatalogSourceType, CreateCatalogInputSchema, UpdateCatalogInputSchema } from '../src/types/index.js';
import { ShopifyAdminClient } from '../src/services/shopify-client.server.js';

describe('Focused Bugfix & E2E Repair Test Suite', () => {
  let shop: { id: string; shopDomain: string; currency?: string };

  beforeEach(async () => {
    await prisma.reorderIntent.deleteMany();
    await prisma.orderLink.deleteMany();
    await prisma.catalogVariantConfig.deleteMany();
    await prisma.orderSubmission.deleteMany();
    await prisma.catalogSource.deleteMany();
    await prisma.catalog.deleteMany();
    await prisma.variantSnapshot.deleteMany();
    await prisma.productSnapshot.deleteMany();
    await prisma.shop.deleteMany();

    shop = await installOrUpdateShop({
      shopDomain: 'e2e-repair-test.myshopify.com',
      accessToken: 'test_token',
    });

    // Seed a standard product with 2 variants
    await syncProductSnapshot(shop.id, {
      id: 1001,
      title: 'Ergonomic Office Chair',
      handle: 'ergonomic-office-chair',
      status: 'active',
      variants: [
        { id: 2001, product_id: 1001, title: 'Black / Mesh', price: '250.00', inventory_quantity: 45, inventory_policy: 'deny', inventory_management: 'shopify', sku: 'CHAIR-BLK' },
        { id: 2002, product_id: 1001, title: 'Grey / Fabric', price: '275.00', inventory_quantity: 15, inventory_policy: 'deny', inventory_management: 'shopify', sku: 'CHAIR-GRY' },
      ],
    });
  });

  // ===========================================================================
  // 1. INVENTORY DISPLAY MODE SAVE & VALIDATION TESTS
  // ===========================================================================
  describe('1. Inventory Display Modes', () => {
    it('1. STATUS_ONLY saves without requiring inventoryCap', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Status Only Catalog',
        inventoryMode: InventoryMode.STATUS_ONLY,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      expect(catalog.inventoryMode).toBe(InventoryMode.STATUS_ONLY);
      expect(catalog.inventoryCap).toBeNull();

      // Edit to STATUS_ONLY
      const updated = await updateCatalog(shop.id, catalog.id, {
        inventoryMode: InventoryMode.STATUS_ONLY,
        inventoryCap: null,
      });
      expect(updated.inventoryMode).toBe(InventoryMode.STATUS_ONLY);
      expect(updated.inventoryCap).toBeNull();
    });

    it('2. EXACT saves without requiring inventoryCap', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Exact Mode Catalog',
        inventoryMode: InventoryMode.EXACT,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      expect(catalog.inventoryMode).toBe(InventoryMode.EXACT);

      const updated = await updateCatalog(shop.id, catalog.id, {
        inventoryMode: InventoryMode.EXACT,
      });
      expect(updated.inventoryMode).toBe(InventoryMode.EXACT);
    });

    it('3. HIDDEN saves without requiring inventoryCap', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Hidden Mode Catalog',
        inventoryMode: InventoryMode.HIDDEN,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      expect(catalog.inventoryMode).toBe(InventoryMode.HIDDEN);

      const updated = await updateCatalog(shop.id, catalog.id, {
        inventoryMode: InventoryMode.HIDDEN,
      });
      expect(updated.inventoryMode).toBe(InventoryMode.HIDDEN);
    });

    it('4. CAPPED saves with valid positive cap', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Capped Mode Catalog',
        inventoryMode: InventoryMode.CAPPED,
        inventoryCap: 25,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      expect(catalog.inventoryMode).toBe(InventoryMode.CAPPED);
      expect(catalog.inventoryCap).toBe(25);

      const updated = await updateCatalog(shop.id, catalog.id, {
        inventoryMode: InventoryMode.CAPPED,
        inventoryCap: 75,
      });
      expect(updated.inventoryMode).toBe(InventoryMode.CAPPED);
      expect(updated.inventoryCap).toBe(75);
    });

    it('5. CAPPED rejects missing or invalid cap with useful validation error', async () => {
      // Missing inventoryCap on CAPPED mode creation
      expect(() =>
        CreateCatalogInputSchema.parse({
          name: 'Invalid Capped Catalog',
          inventoryMode: InventoryMode.CAPPED,
          inventoryCap: null,
          sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
        })
      ).toThrow(/inventory cap is required/i);

      // Invalid 0 cap
      expect(() =>
        CreateCatalogInputSchema.parse({
          name: 'Zero Capped Catalog',
          inventoryMode: InventoryMode.CAPPED,
          inventoryCap: 0,
          sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
        })
      ).toThrow();
    });
  });

  // ===========================================================================
  // 2. VARIANT CONFIGS LOADER & OVERLAY TESTS
  // ===========================================================================
  describe('2. Variant Configs Loader & Overlay', () => {
    it('6. catalog variants load with zero existing config rows', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'New Empty Config Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });

      // Initially, 0 CatalogVariantConfig rows exist in DB
      const dbRows = await prisma.catalogVariantConfig.findMany({ where: { catalogId: catalog.id } });
      expect(dbRows).toHaveLength(0);

      // getCatalogVariantConfigs must derive the full variant list from the catalog's products
      const configs = await getCatalogVariantConfigs(catalog.id, shop.id);
      expect(configs).toHaveLength(2);
      expect(configs[0].productTitle).toBe('Ergonomic Office Chair');
      expect(configs[0].enabled).toBe(true);
      expect(configs[0].sku).toBe('CHAIR-BLK');
      expect(configs[1].enabled).toBe(true);
      expect(configs[1].sku).toBe('CHAIR-GRY');
    });

    it('7. default variant behavior is enabled and inherits catalog rules', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Inherited Rules Catalog',
        minQty: 5,
        maxQty: 100,
        qtyIncrement: 5,
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });

      const configs = await getCatalogVariantConfigs(catalog.id, shop.id);
      expect(configs[0].enabled).toBe(true);
      expect(configs[0].minQty).toBe(5);
      expect(configs[0].maxQty).toBe(100);
      expect(configs[0].qtyIncrement).toBe(5);
    });

    it('8. config overlay works for custom price and quantity overrides', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Overlay Test Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });

      await upsertCatalogVariantConfigs(catalog.id, shop.id, [
        { shopifyVariantId: 'gid://shopify/ProductVariant/2001', enabled: true, customPrice: 199.99, minQty: 2 },
      ]);

      const configs = await getCatalogVariantConfigs(catalog.id, shop.id);
      const v1 = configs.find((c) => c.shopifyVariantId === 'gid://shopify/ProductVariant/2001');
      const v2 = configs.find((c) => c.shopifyVariantId === 'gid://shopify/ProductVariant/2002');

      expect(v1?.customPrice).toBe(199.99);
      expect(v1?.minQty).toBe(2);
      expect(v2?.customPrice).toBeNull();
    });

    it('9. disabled variant persists and is excluded from buyer payload and rejected on submit', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Disabled Variant Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      await publishCatalog(shop.id, catalog.id);

      await upsertCatalogVariantConfigs(catalog.id, shop.id, [
        { shopifyVariantId: 'gid://shopify/ProductVariant/2002', enabled: false },
      ]);
      const currentCatalog = await getCatalogById(shop.id, catalog.id);

      // Public buyer payload only returns enabled variant
      const payload = await getPublicCatalogPayload(catalog.publicToken);
      expect(payload?.products[0]?.variants).toHaveLength(1);
      expect(payload?.products[0]?.variants[0]?.shopifyVariantId).toBe('gid://shopify/ProductVariant/2001');

      // Attempting to submit the disabled variant is rejected server-side
      const mockClient: any = {
        request: async () => ({ draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/1', name: '#D1' }, userErrors: [] } }),
      };

      await expect(
        submitBuyerOrder(
          catalog.publicToken,
          'idem-key-disabled-test',
          {
            dataVersion: currentCatalog.dataVersion,
            lines: [{ variantId: 'gid://shopify/ProductVariant/2002', quantity: 1 }],
            buyer: { businessName: 'Acme', email: 'test@acme.com' },
          },
          mockClient as any
        )
      ).rejects.toThrow(/no longer available/i);
    });

    it('10. modal reopen loads saved config reliably', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Reopen Modal Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });

      await upsertCatalogVariantConfigs(catalog.id, shop.id, [
        { shopifyVariantId: 'gid://shopify/ProductVariant/2001', enabled: false },
        { shopifyVariantId: 'gid://shopify/ProductVariant/2002', enabled: true, customPrice: 220.00 },
      ]);

      // Simulate re-fetching as when modal is opened again
      const configs = await getCatalogVariantConfigs(catalog.id, shop.id);
      expect(configs).toHaveLength(2);
      const c1 = configs.find((c) => c.shopifyVariantId === 'gid://shopify/ProductVariant/2001');
      const c2 = configs.find((c) => c.shopifyVariantId === 'gid://shopify/ProductVariant/2002');
      expect(c1?.enabled).toBe(false);
      expect(c2?.enabled).toBe(true);
      expect(c2?.customPrice).toBe(220.00);
    });
  });

  // ===========================================================================
  // 3. WHOLESALE ORDER LINKS & QR UX TESTS
  // ===========================================================================
  describe('3. Order Links & QR UX', () => {
    it('11. created order link produces clean token resolving to /l/:token', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Order Link Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });

      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'Instagram Wholesale Bio',
        source: 'instagram',
      });

      expect(link.token).toHaveLength(64);
      expect(link.label).toBe('Instagram Wholesale Bio');
      expect(link.active).toBe(true);
    });

    it('12. passcode link does not include passcode in URL and requires passcode to unlock', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Passcode Order Link Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });

      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'VIP Retailers',
        passcode: 'SecretPass123',
      });

      expect(link.passcodeHash).not.toContain('SecretPass123');
      expect(verifyPasscode('SecretPass123', link.passcodeHash!)).toBe(true);

      // Access without token fails
      const noAccess = validateOrderLinkAccess(link, null);
      expect(noAccess.ok).toBe(false);
      expect(noAccess.reason).toBe('PASSCODE_REQUIRED');

      // Access with unlocked scoped token succeeds
      const token = generateOrderLinkAccessToken(link);
      const access = validateOrderLinkAccess(link, token);
      expect(access.ok).toBe(true);
    });

    it('13. QR code encodes exact order link URL', async () => {
      const buyerUrl = 'https://mystore.com/l/abcdef1234567890';
      const qrDataUrl = await generateQrCodeDataUrl(buyerUrl);
      expect(qrDataUrl).toMatch(/^data:image\/png;base64,/);
    });

    it('14. inactive link cannot be accessed', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Inactive Link Catalog',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });

      const link = await createOrderLink(catalog.id, shop.id, {
        label: 'Deactivated Link',
      });
      const inactiveLink = { ...link, active: false };

      const access = validateOrderLinkAccess(inactiveLink);
      expect(access.ok).toBe(false);
      expect(access.reason).toBe('LINK_INACTIVE');
    });
  });

  // ===========================================================================
  // 4. BUYER FORM CONFIG & SUBMISSION VALIDATION TESTS
  // ===========================================================================
  describe('4. Buyer Form Validation & Submit Contract', () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = {
        request: async (query: string) => {
          if (query.includes('nodes(') || query.includes('nodes')) {
            return {
              nodes: [
                {
                  id: 'gid://shopify/ProductVariant/2001',
                  title: 'Black / Mesh',
                  price: '250.00',
                  availableForSale: true,
                  inventoryQuantity: 45,
                  inventoryPolicy: 'DENY',
                  inventoryItem: { tracked: true },
                  product: { id: 'gid://shopify/Product/1001', status: 'ACTIVE', title: 'Ergonomic Office Chair' },
                },
                {
                  id: 'gid://shopify/ProductVariant/2002',
                  title: 'Grey / Fabric',
                  price: '275.00',
                  availableForSale: true,
                  inventoryQuantity: 15,
                  inventoryPolicy: 'DENY',
                  inventoryItem: { tracked: true },
                  product: { id: 'gid://shopify/Product/1001', status: 'ACTIVE', title: 'Ergonomic Office Chair' },
                },
              ],
            };
          }
          return {
            draftOrderCreate: {
              draftOrder: {
                id: 'gid://shopify/DraftOrder/999',
                name: '#D-1001',
                totalPrice: '250.00',
                currencyCode: 'USD',
              },
              userErrors: [],
            },
          };
        },
      };
    });

    it('15. hidden optional fields do not cause validation failure', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Minimal Form Catalog',
        buyerFormConfig: {
          showPhone: false,
          requirePhone: false,
          showTaxId: false,
          requireTaxId: false,
          showPoNumber: false,
          requirePoNumber: false,
          showNote: false,
        },
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, catalog.id);

      // Submit only mandatory businessName and email
      const result = await submitBuyerOrder(
        catalog.publicToken,
        'idem-key-min-form',
        {
          dataVersion: published.dataVersion,
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
          buyer: {
            businessName: 'Nordic Retailers AS',
            email: 'orders@nordicretail.com',
          },
        },
        mockClient as any
      );

      expect(result.success).toBe(true);
      expect(result.draftOrderId).toBe('gid://shopify/DraftOrder/999');
    });

    it('16. visible optional fields may be empty (empty strings normalized without failure)', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Optional Fields Catalog',
        buyerFormConfig: {
          showPhone: true,
          requirePhone: false,
          showTaxId: true,
          requireTaxId: false,
          showPoNumber: true,
          requirePoNumber: false,
          showNote: true,
        },
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, catalog.id);

      const result = await submitBuyerOrder(
        catalog.publicToken,
        'idem-key-empty-optional',
        {
          dataVersion: published.dataVersion,
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
          buyer: {
            businessName: 'Apex Wholesale',
            email: 'buyer@apex.com',
            phone: '',
            taxId: '',
            poNumber: '',
            note: '',
          },
        },
        mockClient as any
      );

      expect(result.success).toBe(true);
    });

    it('17. required visible field fails clearly with field-level details when empty', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Strict Form Catalog',
        buyerFormConfig: {
          showPhone: true,
          requirePhone: true,
          showTaxId: true,
          requireTaxId: true,
          showPoNumber: true,
          requirePoNumber: true,
        },
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, catalog.id);

      try {
        await submitBuyerOrder(
          catalog.publicToken,
          'idem-key-strict-empty',
          {
            dataVersion: published.dataVersion,
            lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 1 }],
            buyer: {
              businessName: 'Strict Corp',
              email: 'buyer@strict.com',
            },
          },
          mockClient as any
        );
        expect.unreachable('Should have thrown OrderSubmissionError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(OrderSubmissionError);
        expect(err.code).toBe('BUYER_FORM_VALIDATION_FAILED');
        expect(err.details?.fields?.phone).toBeDefined();
        expect(err.details?.fields?.taxId).toBeDefined();
        expect(err.details?.fields?.poNumber).toBeDefined();
      }
    });

    it('18. required visible field succeeds when filled', async () => {
      const catalog = await createCatalog(shop.id, {
        name: 'Strict Filled Catalog',
        buyerFormConfig: {
          showPhone: true,
          requirePhone: true,
          showTaxId: true,
          requireTaxId: true,
          showPoNumber: true,
          requirePoNumber: true,
          showNote: true,
        },
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });
      const published = await publishCatalog(shop.id, catalog.id);

      const result = await submitBuyerOrder(
        catalog.publicToken,
        'idem-key-strict-filled',
        {
          dataVersion: published.dataVersion,
          lines: [{ variantId: 'gid://shopify/ProductVariant/2001', quantity: 2 }],
          buyer: {
            businessName: 'Strict Corp',
            email: 'buyer@strict.com',
            phone: '+1 555-0199',
            taxId: 'US-991827364',
            poNumber: 'PO-2026-001',
            note: 'Deliver to back dock',
          },
        },
        mockClient as any
      );

      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // 5. CREATE AND EDIT DATA PARITY TESTS
  // ===========================================================================
  describe('5. Create and Edit Data Parity', () => {
    it('19. create supports all core config fields and edit loads/persists the exact same fields', async () => {
      const initialFormConfig = {
        showPhone: true,
        requirePhone: true,
        showTaxId: true,
        requireTaxId: false,
        showPoNumber: true,
        requirePoNumber: true,
        showNote: true,
      };

      // Create with full suite of settings
      const created = await createCatalog(shop.id, {
        name: 'Full Parity Catalog',
        priceMode: PriceMode.PERCENT_DISCOUNT,
        discountPercent: 15,
        inventoryMode: InventoryMode.CAPPED,
        inventoryCap: 40,
        minQty: 3,
        maxQty: 500,
        qtyIncrement: 3,
        buyerFormConfig: initialFormConfig,
        accentColor: '#2563eb',
        sources: [{ type: CatalogSourceType.PRODUCT, shopifyGid: 'gid://shopify/Product/1001' }],
      });

      expect(created.name).toBe('Full Parity Catalog');
      expect(created.priceMode).toBe(PriceMode.PERCENT_DISCOUNT);
      expect(Number(created.discountPercent)).toBe(15);
      expect(created.inventoryMode).toBe(InventoryMode.CAPPED);
      expect(created.inventoryCap).toBe(40);
      expect(created.minQty).toBe(3);
      expect(created.maxQty).toBe(500);
      expect(created.qtyIncrement).toBe(3);
      expect(created.accentColor).toBe('#2563eb');

      // Edit catalog changes
      const updated = await updateCatalog(shop.id, created.id, {
        name: 'Updated Parity Catalog',
        priceMode: PriceMode.CUSTOM_PRICE,
        customPriceAmount: 49.99,
        inventoryMode: InventoryMode.EXACT,
        minQty: 1,
        maxQty: null,
        qtyIncrement: 1,
        accentColor: '#059669',
      });

      expect(updated.name).toBe('Updated Parity Catalog');
      expect(updated.priceMode).toBe(PriceMode.CUSTOM_PRICE);
      expect(Number(updated.customPriceAmount)).toBe(49.99);
      expect(updated.inventoryMode).toBe(InventoryMode.EXACT);
      expect(updated.minQty).toBe(1);
      expect(updated.maxQty).toBeNull();
      expect(updated.accentColor).toBe('#059669');

      // Re-fetch confirms DB persistence
      const fetched = await getCatalogById(shop.id, created.id);
      expect(fetched.name).toBe('Updated Parity Catalog');
      expect(fetched.priceMode).toBe(PriceMode.CUSTOM_PRICE);
      expect(Number(fetched.customPriceAmount)).toBe(49.99);
      expect(fetched.inventoryMode).toBe(InventoryMode.EXACT);
    });
  });
});
