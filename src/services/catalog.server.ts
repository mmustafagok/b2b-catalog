import { prisma } from '../db.js';
import {
  CreateCatalogInputSchema,
  UpdateCatalogInputSchema,
  CatalogStatus,
  PriceMode,
  PLAN_LIMITS,
  PlanTier,
} from '../types/index.js';
import { generateOpaqueToken } from './auth.server.js';
import { z } from 'zod';

export type CreateCatalogInput = z.infer<typeof CreateCatalogInputSchema>;
export type UpdateCatalogInput = z.infer<typeof UpdateCatalogInputSchema>;

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

  // Check plan quota limits
  const planLimits = PLAN_LIMITS[shop.plan as PlanTier] || PLAN_LIMITS[PlanTier.STARTER];
  const activePublishedCount = await prisma.catalog.count({
    where: {
      shopId,
      status: CatalogStatus.PUBLISHED,
      id: { not: catalogId }, // Exclude self if already published
    },
  });

  if (activePublishedCount >= planLimits.maxLiveCatalogs) {
    throw new CatalogError(
      `Plan quota reached: You can have at most ${planLimits.maxLiveCatalogs} live catalog(s) on the ${planLimits.name} plan. Please upgrade to publish more.`,
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
  return prisma.catalog.findMany({
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

  return catalog;
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
