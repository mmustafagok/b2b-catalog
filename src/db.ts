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

export class DatabaseEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseEnvironmentError';
  }
}

/**
 * Validates that automated test executions can never accidentally connect to or
 * execute tests against a designated production database.
 */
export function validateDatabaseEnvironmentForContext(options: {
  nodeEnv?: string;
  isVitest?: boolean;
  databaseUrl?: string;
  productionDatabaseUrl?: string;
  productionDbHost?: string;
}): { ok: boolean; selectedUrl?: string } {
  const isTest = options.nodeEnv === 'test' || Boolean(options.isVitest);
  const targetUrl = options.databaseUrl;

  if (isTest && targetUrl) {
    // 1. Refuse if targetUrl matches an explicitly defined production database URL
    if (options.productionDatabaseUrl && targetUrl === options.productionDatabaseUrl) {
      throw new DatabaseEnvironmentError(
        'Refusing to run tests against designated production database (matches PRODUCTION_DATABASE_URL)'
      );
    }

    // 2. Refuse if targetUrl matches an explicitly configured production DB host
    if (options.productionDbHost && targetUrl.includes(options.productionDbHost)) {
      throw new DatabaseEnvironmentError(
        `Refusing to run tests against designated production database host (${options.productionDbHost})`
      );
    }

    // 3. Refuse if URL hostname or database name clearly indicates live production while in test mode
    try {
      const parsed = new URL(targetUrl);
      if (
        (parsed.hostname.includes('prod') || parsed.pathname.includes('prod')) &&
        !parsed.hostname.includes('test') &&
        !parsed.pathname.includes('test')
      ) {
        throw new DatabaseEnvironmentError(
          `Refusing to run automated tests against production-named database: ${parsed.hostname}${parsed.pathname}`
        );
      }
    } catch (err: any) {
      if (err instanceof DatabaseEnvironmentError) throw err;
      // Ignore URL parsing errors for non-standard connection strings
    }
  }

  return { ok: true, selectedUrl: targetUrl };
}

// In test environments, prioritize TEST_DATABASE_URL if defined
const isTestContext = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
const chosenRawUrl = (isTestContext && process.env.TEST_DATABASE_URL)
  ? process.env.TEST_DATABASE_URL
  : process.env.DATABASE_URL;

const sanitizedUrl = sanitizeDatabaseUrl(chosenRawUrl);

validateDatabaseEnvironmentForContext({
  nodeEnv: process.env.NODE_ENV,
  isVitest: Boolean(process.env.VITEST),
  databaseUrl: sanitizedUrl,
  productionDatabaseUrl: process.env.PRODUCTION_DATABASE_URL,
  productionDbHost: process.env.PRODUCTION_DB_HOST,
});

if (sanitizedUrl && !process.env.TEST_DATABASE_URL) {
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
