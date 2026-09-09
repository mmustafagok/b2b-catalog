import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

export function sanitizeDatabaseUrl(url?: string): string | undefined {
  if (!url) return url;
  let clean = url.trim().replace(/[\r\n]+/g, '').trim();
  // Strip one matching surrounding quote pair
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1).trim();
  }
  // Repair: platform stripped 'postgresql:' leaving '//...'
  if (clean.startsWith('//')) {
    clean = 'postgresql:' + clean;
  }
  // Repair single-slash variants
  if (clean.startsWith('postgresql:/') && !clean.startsWith('postgresql://')) {
    clean = 'postgresql://' + clean.slice('postgresql:/'.length);
  }
  if (clean.startsWith('postgres:/') && !clean.startsWith('postgres://')) {
    clean = 'postgres://' + clean.slice('postgres:/'.length);
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
