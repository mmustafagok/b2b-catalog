import { prisma } from '../db.js';
import {
  CreateCatalogInputSchema,
  UpdateCatalogInputSchema,
  CatalogStatus,
  PriceMode,
  InventoryMode,
  PlanTier,
  CatalogVariantConfigInputSchema,
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
  const inventoryMode = validated.inventoryMode ?? (validated.showInventory ? InventoryMode.EXACT : InventoryMode.STATUS_ONLY);
  // Normalise legacy CAPPED to STATUS_ONLY (CAPPED is removed from new UI)
  const effectiveInventoryMode = inventoryMode === InventoryMode.CAPPED ? InventoryMode.STATUS_ONLY : inventoryMode;
  const showInventory = effectiveInventoryMode !== InventoryMode.HIDDEN;

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
        inventoryMode: effectiveInventoryMode,
        inventoryCap: null,
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

    // Ensure default OrderLink exists for this catalog
    await tx.orderLink.create({
      data: {
        catalogId: catalog.id,
        shopId,
        token: catalog.publicToken,
        label: 'Default Link',
        active: true,
      },
    });

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
        ? (validated.customPriceAmount ?? (existing.customPriceAmount != null ? Number(existing.customPriceAmount) : null))
        : null;

    // Handle inventoryMode consistency — normalize legacy CAPPED to STATUS_ONLY
    const rawInventoryMode =
      validated.inventoryMode ??
      (validated.showInventory !== undefined
        ? (validated.showInventory ? InventoryMode.EXACT : InventoryMode.STATUS_ONLY)
        : ((existing.inventoryMode as InventoryMode) ?? InventoryMode.STATUS_ONLY));
    // Normalize CAPPED to STATUS_ONLY (legacy compat)
    const effectiveInventoryMode = rawInventoryMode === InventoryMode.CAPPED ? InventoryMode.STATUS_ONLY : rawInventoryMode;
    const effectiveShowInventory = effectiveInventoryMode !== InventoryMode.HIDDEN;

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
        inventoryCap: null,
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
  configs: Array<z.infer<typeof CatalogVariantConfigInputSchema>>
) {
  for (const vc of configs) {
    const isOverride = vc.overrideQuantityRules !== undefined
      ? Boolean(vc.overrideQuantityRules)
      : Boolean(vc.minQty != null || vc.maxQty != null || vc.qtyIncrement != null);

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
        overrideQuantityRules: isOverride,
        minQty: isOverride ? (vc.minQty ?? null) : null,
        maxQty: isOverride ? (vc.maxQty ?? null) : null,
        qtyIncrement: isOverride ? (vc.qtyIncrement ?? null) : null,
        position: vc.position ?? 0,
      },
      create: {
        catalogId,
        shopifyVariantId: vc.shopifyVariantId,
        enabled: vc.enabled ?? true,
        customPrice: vc.customPrice ?? null,
        overrideQuantityRules: isOverride,
        minQty: isOverride ? (vc.minQty ?? null) : null,
        maxQty: isOverride ? (vc.maxQty ?? null) : null,
        qtyIncrement: isOverride ? (vc.qtyIncrement ?? null) : null,
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
    const hasOverride = Boolean(override?.overrideQuantityRules);
    return {
      shopifyVariantId: v.shopifyVariantId,
      shopifyProductId: v.shopifyProductId,
      productTitle: v.product.title,
      variantTitle: v.title,
      sku: v.sku,
      basePrice: Number(v.shopifyPrice),
      imageUrl: v.imageUrl || v.product.imageUrl || null,
      enabled: override ? override.enabled : true,
      customPrice: override?.customPrice != null ? Number(override.customPrice) : null,
      overrideQuantityRules: hasOverride,
      minQty: hasOverride ? (override?.minQty ?? null) : (catalog.minQty ?? null),
      maxQty: hasOverride ? (override?.maxQty ?? null) : (catalog.maxQty ?? null),
      qtyIncrement: hasOverride ? (override?.qtyIncrement ?? null) : (catalog.qtyIncrement ?? null),
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

  const validatedConfigs = configs.map((config) => CatalogVariantConfigInputSchema.parse(config));

  return prisma.$transaction(async (tx) => {
    await _upsertVariantConfigs(tx, catalogId, validatedConfigs);
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

/**
 * Canonical function for effective active variant counting in a catalog.
 * Defines the ONE authoritative source of truth for:
 * - catalog variant quota enforcement during publish
 * - catalog summaries (getCatalogsByShop, getCatalogById)
 * - billing & quotas metrics (maxVariantsInPublishedCatalogs)
 * - plan downgrade eligibility checks
 *
 * Rules:
 * - Variant must belong to resolved active product/collection sources.
 * - Product must have status === 'ACTIVE'.
 * - Variant must NOT be explicitly disabled via CatalogVariantConfig (enabled === false).
 * - Each Shopify variant is counted at most ONCE per catalog (deduplicated across overlapping sources).
 */
export async function countActiveVariantsForCatalog(
  shopId: string,
  catalogId: string,
  sources?: Array<{ type: string; shopifyGid: string }>
): Promise<number> {
  let catalogSources = sources;
  if (!catalogSources) {
    const cat = await prisma.catalog.findFirst({
      where: { id: catalogId, shopId },
      include: { sources: true },
    });
    if (!cat) return 0;
    catalogSources = cat.sources;
  }

  const allowedProductGids = await resolveCatalogAllowedProductGids(shopId, catalogSources);
  if (allowedProductGids.size === 0) return 0;

  // 1. Fetch all variants belonging to active products within allowed sources
  const variants = await prisma.variantSnapshot.findMany({
    where: {
      shopId,
      shopifyProductId: { in: Array.from(allowedProductGids) },
      product: { status: 'ACTIVE' },
    },
    select: { shopifyVariantId: true },
  });

  if (variants.length === 0) return 0;

  // 2. Deduplicate Shopify variant IDs across sources (product sources + collection sources)
  const uniqueVariantIds = Array.from(new Set(variants.map((v) => v.shopifyVariantId)));

  // 3. Fetch explicitly disabled variant configs for this catalog
  const disabledConfigs = await prisma.catalogVariantConfig.findMany({
    where: {
      catalogId,
      enabled: false,
    },
    select: { shopifyVariantId: true },
  });

  const disabledSet = new Set(disabledConfigs.map((c) => c.shopifyVariantId));

  // 4. Count unique variants that are not explicitly disabled
  const activeCount = uniqueVariantIds.filter((vId) => !disabledSet.has(vId)).length;
  return activeCount;
}

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
    const planName = entitlement.planTier === PlanTier.FREE ? 'Free' : entitlement.limits.name;
    const msg =
      entitlement.planTier === PlanTier.FREE
        ? "You've reached the Free plan limit of 1 live catalog."
        : `You've reached the ${planName} plan limit of ${entitlement.limits.maxLiveCatalogs} live catalog(s).`;
    throw new CatalogError(msg, 403, 'QUOTA_EXCEEDED');
  }

  // Check plan variant quota limits across active, enabled variants in this catalog
  const variantCount = await countActiveVariantsForCatalog(shopId, catalog.id, catalog.sources);

  if (variantCount > entitlement.limits.maxVariants) {
    const planName = entitlement.planTier === PlanTier.FREE ? 'Free' : entitlement.limits.name;
    const msg =
      entitlement.planTier === PlanTier.FREE
        ? 'This catalog exceeds the Free plan limit of 50 active variants.'
        : `This catalog exceeds the ${planName} plan limit of ${entitlement.limits.maxVariants} active variants.`;
    throw new CatalogError(msg, 403, 'QUOTA_EXCEEDED');
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

  return prisma.$transaction(async (tx) => {
    // Invalidate / deactivate all order links for this catalog
    await tx.orderLink.updateMany({
      where: { catalogId },
      data: { active: false },
    });

    return tx.catalog.update({
      where: { id: catalogId },
      data: {
        status: CatalogStatus.ARCHIVED,
        dataVersion: { increment: 1 },
      },
      include: { sources: true },
    });
  });
}

export async function deleteCatalog(shopId: string, catalogId: string) {
  const existing = await prisma.catalog.findFirst({
    where: { id: catalogId, shopId },
    include: {
      _count: {
        select: {
          submissions: true,
        },
      },
    },
  });

  if (!existing) {
    throw new CatalogError('Catalog not found or unauthorized', 404, 'NOT_FOUND');
  }

  if (existing._count.submissions > 0) {
    throw new CatalogError(
      'Cannot delete catalog with order submission history. Please archive this catalog instead.',
      409,
      'CATALOG_HAS_HISTORY'
    );
  }

  return prisma.$transaction(async (tx) => {
    // Clean up all order links, variant configs, overrides, sources, and intents
    await tx.orderLink.deleteMany({ where: { catalogId } });
    await tx.catalogVariantConfig.deleteMany({ where: { catalogId } });
    await tx.catalogItemOverride.deleteMany({ where: { catalogId } });
    await tx.catalogSource.deleteMany({ where: { catalogId } });
    await tx.reorderIntent.deleteMany({ where: { catalogId } });
    await tx.analyticsEvent.deleteMany({ where: { catalogId } });

    return tx.catalog.delete({
      where: { id: catalogId },
    });
  });
}

// ─── Queries ──────────────────────────────────────────────────────────────────

async function _enrichSources(
  shopId: string,
  sources: Array<{ id: string; catalogId: string; type: string; shopifyGid: string }>
) {
  if (!sources || sources.length === 0) return [];

  const productGids = sources.filter((s) => s.type === 'PRODUCT').map((s) => s.shopifyGid);
  const collectionGids = sources.filter((s) => s.type === 'COLLECTION').map((s) => s.shopifyGid);

  const [products, collections] = await Promise.all([
    productGids.length > 0
      ? prisma.productSnapshot.findMany({
          where: { shopId, shopifyProductId: { in: productGids } },
          select: { shopifyProductId: true, title: true, imageUrl: true },
        })
      : [],
    collectionGids.length > 0
      ? prisma.collectionSnapshot.findMany({
          where: { shopId, shopifyCollectionId: { in: collectionGids } },
          select: { shopifyCollectionId: true, title: true },
        })
      : [],
  ]);

  const productMap = new Map(products.map((p) => [p.shopifyProductId, p]));
  const collectionMap = new Map(collections.map((c) => [c.shopifyCollectionId, c]));

  return sources.map((s) => {
    if (s.type === 'PRODUCT') {
      const p = productMap.get(s.shopifyGid);
      return {
        ...s,
        title: p?.title || s.shopifyGid,
        imageUrl: p?.imageUrl || null,
      };
    } else {
      const c = collectionMap.get(s.shopifyGid);
      return {
        ...s,
        title: c?.title || s.shopifyGid,
        imageUrl: null,
      };
    }
  });
}

export async function getCatalogsByShop(shopId: string, includeArchived: boolean = false) {
  const catalogs = await prisma.catalog.findMany({
    where: {
      shopId,
      ...(includeArchived ? {} : { status: { not: CatalogStatus.ARCHIVED } }),
    },
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

  const defaultOrderLinks = await prisma.orderLink.findMany({
    where: { shopId, token: { in: catalogs.map((c) => c.publicToken) } },
    select: { token: true, active: true },
  });
  const defaultLinkActiveMap = new Map(defaultOrderLinks.map((l) => [l.token, l.active]));

  return Promise.all(
    catalogs.map(async (cat) => {
      const [allowedGids, enrichedSources, variantCount] = await Promise.all([
        resolveCatalogAllowedProductGids(shopId, cat.sources),
        _enrichSources(shopId, cat.sources),
        countActiveVariantsForCatalog(shopId, cat.id, cat.sources),
      ]);
      const productCount = allowedGids.size;

      return {
        ...cat,
        sources: enrichedSources,
        productCount,
        variantCount,
        linkCount: cat._count.orderLinks,
        submissionsCount: cat._count.submissions,
        defaultLinkActive: defaultLinkActiveMap.get(cat.publicToken) ?? true,
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

  const [allowedGids, enrichedSources, variantCount] = await Promise.all([
    resolveCatalogAllowedProductGids(shopId, catalog.sources),
    _enrichSources(shopId, catalog.sources),
    countActiveVariantsForCatalog(shopId, catalog.id, catalog.sources),
  ]);
  const productCount = allowedGids.size;

  return {
    ...catalog,
    sources: enrichedSources,
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
