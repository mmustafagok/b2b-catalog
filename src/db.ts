import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

export function sanitizeDatabaseUrl(url?: string): string | undefined {
  if (!url) return url;
  let clean = url.trim().replace(/^["']|["']$/g, '').trim();
  if (clean.startsWith('//')) {
    clean = 'postgresql:' + clean;
  } else if (!clean.startsWith('postgresql://') && !clean.startsWith('postgres://') && clean.includes('@')) {
    clean = 'postgresql://' + clean;
  }
  return clean;
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
