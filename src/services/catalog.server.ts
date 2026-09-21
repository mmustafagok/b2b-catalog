import { prisma } from '../db.js';
import {
  CreateCatalogInputSchema,
  UpdateCatalogInputSchema,
  CatalogStatus,
  PriceMode,
  InventoryMode,
  type CatalogVariantConfigInput,
} from '../types/index.js';
import { generateOpaqueToken } from './auth.server.js';
import { resolveCatalogAllowedProductGids } from './sync.server.js';
import { defaultBillingProvider } from './billing.server.js';
import { z } from 'zod';

export type CreateCatalogInput = z.input<typeof CreateCatalogInputSchema>;
export type UpdateCatalogInput = z.input<typeof UpdateCatalogInputSchema>;

export class CatalogError extends Error {
  constructor(message: string, public statusCode: number = 400, public code: string = 'CATALOG_ERROR') {
    super(message);
    this.name = 'CatalogError';
  }
}

// ─── Helper: parse buyerFormConfig ────────────────────────────────────────────

function parseBuyerFormConfig(raw: unknown): string {
  if (!raw) return '{}';
  if (typeof raw === 'string') return raw;
  try { return JSON.stringify(raw); } catch { return '{}'; }
}

// ─── Create Catalog ───────────────────────────────────────────────────────────

export async function createCatalog(shopId: string, input: CreateCatalogInput) {
  const validated = CreateCatalogInputSchema.parse(input);

  const publicToken = generateOpaqueToken();
  const inventoryMode = validated.inventoryMode || InventoryMode.STATUS_ONLY;
  const inventoryCap = inventoryMode === InventoryMode.CAPPED ? (validated.inventoryCap ?? null) : null;
  const showInventory = inventoryMode === InventoryMode.EXACT || (validated.showInventory && inventoryMode !== InventoryMode.HIDDEN);

  return prisma.$transaction(async (tx) => {
    const catalog = await tx.catalog.create({
      data: {
        shopId,
        name: validated.name,
        publicToken,
        status: CatalogStatus.DRAFT,
        priceMode: validated.priceMode || PriceMode.SHOPIFY_PRICE,
        discountPercent:
          validated.priceMode === PriceMode.PERCENT_DISCOUNT ? validated.discountPercent || 0 : 0,
        customPriceAmount:
          validated.priceMode === PriceMode.CUSTOM_PRICE
            ? (validated.customPriceAmount ?? null)
            : null,
        logoUrl: validated.logoUrl ?? null,
        accentColor: validated.accentColor || '#108043',
        showSku: validated.showSku ?? true,
        showInventory,
        inventoryMode,
        inventoryCap,
        minQty: validated.minQty ?? 1,
        maxQty: validated.maxQty ?? null,
        qtyIncrement: validated.qtyIncrement ?? 1,
        buyerFormConfig: parseBuyerFormConfig(validated.buyerFormConfig),
        dataVersion: 1,
        sources: {
          create: validated.sources.map((s) => ({
            type: s.type,
            shopifyGid: s.shopifyGid,
          })),
        },
      },
      include: {
        sources: true,
        variantConfigs: true,
      },
    });

    // Upsert variant configs if provided
    if (validated.variantConfigs && validated.variantConfigs.length > 0) {
      await _upsertVariantConfigs(tx, catalog.id, validated.variantConfigs);
    }

    return catalog;
  });
}

// ─── Update Catalog ───────────────────────────────────────────────────────────

export async function updateCatalog(shopId: string, catalogId: string, input: UpdateCatalogInput) {
  const validated = UpdateCatalogInputSchema.parse(input);

  const existing = await prisma.catalog.findFirst({
    where: { id: catalogId, shopId },
  });

  if (!existing) {
    throw new CatalogError('Catalog not found or unauthorized', 404, 'NOT_FOUND');
  }

  return prisma.$transaction(async (tx) => {
    if (validated.sources) {
      // Replace sources
      await tx.catalogSource.deleteMany({ where: { catalogId } });
      await tx.catalogSource.createMany({
        data: validated.sources.map((s) => ({
          catalogId,
          type: s.type,
          shopifyGid: s.shopifyGid,
        })),
      });
    }

    // Build pricing fields
    const effectivePriceMode = validated.priceMode ?? (existing.priceMode as PriceMode);
    const discountPercent =
      effectivePriceMode === PriceMode.PERCENT_DISCOUNT
        ? (validated.discountPercent ?? Number(existing.discountPercent))
        : 0;
    const customPriceAmount =
      effectivePriceMode === PriceMode.CUSTOM_PRICE
        ? (validated.customPriceAmount ?? (existing.customPriceAmount ? Number(existing.customPriceAmount) : null))
        : null;

    // Handle inventoryMode & inventoryCap consistency
    const effectiveInventoryMode = validated.inventoryMode ?? (existing.inventoryMode as InventoryMode) ?? InventoryMode.STATUS_ONLY;
    let effectiveInventoryCap: number | null = null;
    if (effectiveInventoryMode === InventoryMode.CAPPED) {
      effectiveInventoryCap = validated.inventoryCap !== undefined ? validated.inventoryCap : (existing.inventoryCap ?? 50);
    }
    const effectiveShowInventory = effectiveInventoryMode === InventoryMode.EXACT || (validated.showInventory ?? existing.showInventory);

    const updated = await tx.catalog.update({
      where: { id: catalogId },
      data: {
        ...(validated.name !== undefined && { name: validated.name }),
        priceMode: effectivePriceMode,
        discountPercent,
        customPriceAmount,
        ...(validated.logoUrl !== undefined && { logoUrl: validated.logoUrl }),
        ...(validated.accentColor !== undefined && { accentColor: validated.accentColor }),
        ...(validated.showSku !== undefined && { showSku: validated.showSku }),
        showInventory: effectiveShowInventory,
        inventoryMode: effectiveInventoryMode,
        inventoryCap: effectiveInventoryCap,
        ...(validated.minQty !== undefined && { minQty: validated.minQty }),
        ...(validated.maxQty !== undefined && { maxQty: validated.maxQty }),
        ...(validated.qtyIncrement !== undefined && { qtyIncrement: validated.qtyIncrement }),
        ...(validated.buyerFormConfig !== undefined && {
          buyerFormConfig: parseBuyerFormConfig(validated.buyerFormConfig),
        }),
        dataVersion: { increment: 1 },
      },
      include: {
        sources: true,
        variantConfigs: true,
      },
    });

    if (validated.variantConfigs && validated.variantConfigs.length > 0) {
      await _upsertVariantConfigs(tx, catalogId, validated.variantConfigs);
    }

    return updated;
  });
}

// ─── Variant Configs ──────────────────────────────────────────────────────────

/**
 * Internal helper: bulk-upserts variant configs within a transaction.
 */
async function _upsertVariantConfigs(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  catalogId: string,
  configs: CatalogVariantConfigInput[]
) {
  for (const vc of configs) {
    await tx.catalogVariantConfig.upsert({
      where: {
        catalogId_shopifyVariantId: {
          catalogId,
          shopifyVariantId: vc.shopifyVariantId,
        },
      },
      update: {
        enabled: vc.enabled ?? true,
        customPrice: vc.customPrice ?? null,
        minQty: vc.minQty ?? null,
        maxQty: vc.maxQty ?? null,
        qtyIncrement: vc.qtyIncrement ?? null,
        position: vc.position ?? 0,
      },
      create: {
        catalogId,
        shopifyVariantId: vc.shopifyVariantId,
        enabled: vc.enabled ?? true,
        customPrice: vc.customPrice ?? null,
        minQty: vc.minQty ?? null,
        maxQty: vc.maxQty ?? null,
        qtyIncrement: vc.qtyIncrement ?? null,
        position: vc.position ?? 0,
      },
    });
  }
}

export async function getCatalogVariantConfigs(catalogId: string, shopId: string) {
  const catalog = await prisma.catalog.findFirst({
    where: { id: catalogId, shopId },
    include: { sources: true },
  });
  if (!catalog) {
    throw new CatalogError('Catalog not found or unauthorized', 404, 'NOT_FOUND');
  }

  // 1. Resolve allowed products for this catalog
  const allowedProductGids = await resolveCatalogAllowedProductGids(shopId, catalog.sources);
  const allowedProductGidArray = Array.from(allowedProductGids);

  // 2. Fetch all variant snapshots for allowed products
  const variants = allowedProductGidArray.length > 0
    ? await prisma.variantSnapshot.findMany({
        where: {
          shopId,
          shopifyProductId: { in: allowedProductGidArray },
        },
        include: {
          product: {
            select: { title: true, imageUrl: true },
          },
        },
        orderBy: [
          { product: { title: 'asc' } },
          { title: 'asc' },
        ],
      })
    : [];

  // 3. Fetch existing overrides
  const existingConfigs = await prisma.catalogVariantConfig.findMany({
    where: { catalogId },
  });
  const configMap = new Map(existingConfigs.map((c) => [c.shopifyVariantId, c]));

  // 4. Overlay: every variant is returned with defaults + overrides
  return variants.map((v, index) => {
    const override = configMap.get(v.shopifyVariantId);
    return {
      shopifyVariantId: v.shopifyVariantId,
      shopifyProductId: v.shopifyProductId,
      productTitle: v.product.title,
      variantTitle: v.title,
      sku: v.sku,
      basePrice: Number(v.shopifyPrice),
      imageUrl: v.imageUrl || v.product.imageUrl || null,
      enabled: override ? override.enabled : true,
      customPrice: override?.customPrice ? Number(override.customPrice) : null,
      minQty: override?.minQty ?? catalog.minQty ?? null,
      maxQty: override?.maxQty ?? catalog.maxQty ?? null,
      qtyIncrement: override?.qtyIncrement ?? catalog.qtyIncrement ?? null,
      position: override?.position ?? index,
    };
  });
}

export async function upsertCatalogVariantConfigs(
  catalogId: string,
  shopId: string,
  configs: CatalogVariantConfigInput[]
) {
  const catalog = await prisma.catalog.findFirst({ where: { id: catalogId, shopId } });
  if (!catalog) {
    throw new CatalogError('Catalog not found or unauthorized', 404, 'NOT_FOUND');
  }

  return prisma.$transaction(async (tx) => {
    await _upsertVariantConfigs(tx, catalogId, configs);
    // Bump dataVersion so active buyers re-fetch updated catalog
    await tx.catalog.update({
      where: { id: catalogId },
      data: { dataVersion: { increment: 1 } },
    });
    return tx.catalogVariantConfig.findMany({
      where: { catalogId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  });
}

// ─── Publish / Unpublish / Archive / Delete ───────────────────────────────────

export async function publishCatalog(shopId: string, catalogId: string) {
  const shop = await prisma.shop.findFirst({
    where: { id: shopId, uninstalledAt: null },
  });

  if (!shop) {
    throw new CatalogError('Shop not found or inactive', 404, 'SHOP_INACTIVE');
  }

  const catalog = await prisma.catalog.findFirst({
    where: { id: catalogId, shopId },
    include: { sources: true },
  });

  if (!catalog) {
    throw new CatalogError('Catalog not found or unauthorized', 404, 'NOT_FOUND');
  }

  if (catalog.sources.length === 0) {
    throw new CatalogError('Cannot publish a catalog without product or collection sources', 422, 'NO_SOURCES');
  }

  // Resolve commercial quota limits strictly via centralized BillingProvider entitlement
  const entitlement = await defaultBillingProvider.getEntitlement(shop);
  const activePublishedCount = await prisma.catalog.count({
    where: {
      shopId,
      status: CatalogStatus.PUBLISHED,
      id: { not: catalogId }, // Exclude self if already published
    },
  });

  if (activePublishedCount >= entitlement.limits.maxLiveCatalogs) {
    throw new CatalogError(
      `Plan quota reached: You can have at most ${entitlement.limits.maxLiveCatalogs} live catalog(s) on the ${entitlement.limits.name} plan. Please upgrade to publish more.`,
      403,
      'QUOTA_EXCEEDED'
    );
  }

  // Check plan variant quota limits across all active products in this catalog
  const allowedProductGids = await resolveCatalogAllowedProductGids(catalog.shopId, catalog.sources);
  const variantCount =
    allowedProductGids.size > 0
      ? await prisma.variantSnapshot.count({
          where: {
            shopId,
            shopifyProductId: { in: Array.from(allowedProductGids) },
            product: { status: 'ACTIVE' },
          },
        })
      : 0;

  if (variantCount > entitlement.limits.maxVariants) {
    throw new CatalogError(
      `Plan variant quota reached: This catalog has ${variantCount} variants, but your ${entitlement.limits.name} plan limit is ${entitlement.limits.maxVariants} variants. Please upgrade to publish this catalog.`,
      403,
      'QUOTA_EXCEEDED'
    );
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.catalog.update({
      where: { id: catalogId },
      data: {
        status: CatalogStatus.PUBLISHED,
        publishedAt: new Date(),
        dataVersion: { increment: 1 },
      },
      include: { sources: true },
    });

    // Ensure a default OrderLink exists for this catalog (idempotent)
    const existingDefaultLink = await tx.orderLink.findUnique({
      where: { token: catalog.publicToken },
    });

    if (!existingDefaultLink) {
      await tx.orderLink.create({
        data: {
          catalogId,
          shopId,
          token: catalog.publicToken,
          label: 'Default Link',
          active: true,
        },
      });
    }

    return updated;
  });
}

export async function unpublishCatalog(shopId: string, catalogId: string) {
  const existing = await prisma.catalog.findFirst({
    where: { id: catalogId, shopId },
  });

  if (!existing) {
    throw new CatalogError('Catalog not found or unauthorized', 404, 'NOT_FOUND');
  }

  return prisma.catalog.update({
    where: { id: catalogId },
    data: {
      status: CatalogStatus.DRAFT,
      dataVersion: { increment: 1 },
    },
    include: { sources: true },
  });
}

export async function archiveCatalog(shopId: string, catalogId: string) {
  const existing = await prisma.catalog.findFirst({
    where: { id: catalogId, shopId },
  });

  if (!existing) {
    throw new CatalogError('Catalog not found or unauthorized', 404, 'NOT_FOUND');
  }

  return prisma.catalog.update({
    where: { id: catalogId },
    data: {
      status: CatalogStatus.ARCHIVED,
      dataVersion: { increment: 1 },
    },
  });
}

export async function deleteCatalog(shopId: string, catalogId: string) {
  const existing = await prisma.catalog.findFirst({
    where: { id: catalogId, shopId },
  });

  if (!existing) {
    throw new CatalogError('Catalog not found or unauthorized', 404, 'NOT_FOUND');
  }

  return prisma.catalog.delete({
    where: { id: catalogId },
  });
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function getCatalogsByShop(shopId: string) {
  const catalogs = await prisma.catalog.findMany({
    where: { shopId },
    include: {
      sources: true,
      _count: {
        select: {
          submissions: true,
          orderLinks: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return Promise.all(
    catalogs.map(async (cat) => {
      const allowedGids = await resolveCatalogAllowedProductGids(shopId, cat.sources);
      const productCount = allowedGids.size;
      const variantCount =
        productCount > 0
          ? await prisma.variantSnapshot.count({
              where: {
                shopId,
                shopifyProductId: { in: Array.from(allowedGids) },
                product: { status: 'ACTIVE' },
              },
            })
          : 0;

      return {
        ...cat,
        productCount,
        variantCount,
        linkCount: cat._count.orderLinks,
      };
    })
  );
}

export async function getCatalogById(shopId: string, catalogId: string) {
  const catalog = await prisma.catalog.findFirst({
    where: { id: catalogId, shopId },
    include: {
      sources: true,
      variantConfigs: true,
      _count: {
        select: {
          submissions: true,
          orderLinks: true,
        },
      },
    },
  });

  if (!catalog) {
    throw new CatalogError('Catalog not found or unauthorized', 404, 'NOT_FOUND');
  }

  const allowedGids = await resolveCatalogAllowedProductGids(shopId, catalog.sources);
  const productCount = allowedGids.size;
  const variantCount =
    productCount > 0
      ? await prisma.variantSnapshot.count({
          where: {
            shopId,
            shopifyProductId: { in: Array.from(allowedGids) },
            product: { status: 'ACTIVE' },
          },
        })
      : 0;

  return {
    ...catalog,
    productCount,
    variantCount,
    linkCount: catalog._count.orderLinks,
  };
}

export async function getPublishedCatalogByToken(publicToken: string) {
  const catalog = await prisma.catalog.findUnique({
    where: { publicToken },
    include: {
      shop: true,
      sources: true,
    },
  });

  // Security check: Must be published AND owning shop must be active
  if (!catalog || catalog.status !== CatalogStatus.PUBLISHED || catalog.shop.uninstalledAt !== null) {
    return null;
  }

  return catalog;
}
