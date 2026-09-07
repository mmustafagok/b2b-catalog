import { prisma } from '../db.js';
import {
  CreateCatalogInputSchema,
  UpdateCatalogInputSchema,
  CatalogStatus,
  PriceMode,
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

export async function createCatalog(shopId: string, input: CreateCatalogInput) {
  const validated = CreateCatalogInputSchema.parse(input);

  const publicToken = generateOpaqueToken();

  return prisma.$transaction(async (tx) => {
    const catalog = await tx.catalog.create({
      data: {
        shopId,
        name: validated.name,
        publicToken,
        status: CatalogStatus.DRAFT,
        priceMode: validated.priceMode || PriceMode.SHOPIFY_PRICE,
        discountPercent: validated.priceMode === PriceMode.PERCENT_DISCOUNT ? validated.discountPercent || 0 : 0,
        logoUrl: validated.logoUrl,
        accentColor: validated.accentColor || '#108043',
        showSku: validated.showSku ?? true,
        showInventory: validated.showInventory ?? false,
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
      },
    });

    return catalog;
  });
}

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
      await tx.catalogSource.deleteMany({
        where: { catalogId },
      });
      await tx.catalogSource.createMany({
        data: validated.sources.map((s) => ({
          catalogId,
          type: s.type,
          shopifyGid: s.shopifyGid,
        })),
      });
    }

    const updated = await tx.catalog.update({
      where: { id: catalogId },
      data: {
        name: validated.name,
        priceMode: validated.priceMode,
        discountPercent:
          validated.priceMode === PriceMode.PERCENT_DISCOUNT
            ? validated.discountPercent ?? existing.discountPercent
            : 0,
        logoUrl: validated.logoUrl,
        accentColor: validated.accentColor,
        showSku: validated.showSku,
        showInventory: validated.showInventory,
        dataVersion: { increment: 1 },
      },
      include: {
        sources: true,
      },
    });

    return updated;
  });
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
    throw new CatalogError(
      `Plan quota reached: You can have at most ${entitlement.limits.maxLiveCatalogs} live catalog(s) on the ${entitlement.limits.name} plan. Please upgrade to publish more.`,
      403,
      'QUOTA_EXCEEDED'
    );
  }

  // Check plan variant quota limits across all active products in this catalog
  const allowedProductGids = await resolveCatalogAllowedProductGids(catalog.shopId, catalog.sources);
  const variantCount = allowedProductGids.size > 0
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

  return prisma.catalog.update({
    where: { id: catalogId },
    data: {
      status: CatalogStatus.PUBLISHED,
      publishedAt: new Date(),
      dataVersion: { increment: 1 },
    },
    include: { sources: true },
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

export async function getCatalogsByShop(shopId: string) {
  const catalogs = await prisma.catalog.findMany({
    where: { shopId },
    include: {
      sources: true,
      _count: {
        select: {
          submissions: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return Promise.all(
    catalogs.map(async (cat) => {
      const allowedGids = await resolveCatalogAllowedProductGids(shopId, cat.sources);
      const productCount = allowedGids.size;
      const variantCount = productCount > 0
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
      };
    })
  );
}

export async function getCatalogById(shopId: string, catalogId: string) {
  const catalog = await prisma.catalog.findFirst({
    where: { id: catalogId, shopId },
    include: {
      sources: true,
      _count: {
        select: {
          submissions: true,
        },
      },
    },
  });

  if (!catalog) {
    throw new CatalogError('Catalog not found or unauthorized', 404, 'NOT_FOUND');
  }

  const allowedGids = await resolveCatalogAllowedProductGids(shopId, catalog.sources);
  const productCount = allowedGids.size;
  const variantCount = productCount > 0
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
