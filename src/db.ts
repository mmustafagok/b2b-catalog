import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

export function sanitizeDatabaseUrl(url?: string): string | undefined {
  if (!url) return url;
  return url.trim().replace(/^["']|["']$/g, '').trim();
}

const rawUrl = process.env.DATABASE_URL;
const sanitizedUrl = sanitizeDatabaseUrl(rawUrl);
if (sanitizedUrl) {
  process.env.DATABASE_URL = sanitizedUrl;
}

declare global {
  // eslint-disable-next-line no-var
  var __prismaClient: PrismaClient | undefined;
}

export const prisma =
  global.__prismaClient ||
  new PrismaClient({
    datasources: sanitizedUrl
      ? { db: { url: sanitizedUrl } }
      : undefined,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__prismaClient = prisma;
}

export default prisma;
