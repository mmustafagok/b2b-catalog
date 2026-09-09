/**
 * Production migration launcher.
 * Normalizes DATABASE_URL BEFORE invoking prisma migrate deploy,
 * so the Prisma CLI always receives a valid postgresql:// connection string
 * even when the hosting platform strips the protocol prefix.
 */

import { spawnSync } from 'child_process';

function normalizeDbUrl(raw) {
  if (!raw) return raw;
  // Remove surrounding whitespace and CR/LF
  let url = raw.trim().replace(/[\r\n]+/g, '');
  // Remove one matching surrounding quote pair
  if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
    url = url.slice(1, -1).trim();
  }
  // Repair: platform stripped "postgresql:" and left "//..."
  if (url.startsWith('//')) {
    url = 'postgresql:' + url;
  }
  return url;
}

const raw = process.env.DATABASE_URL;
const normalized = normalizeDbUrl(raw);

if (!normalized) {
  console.error('[migrate-production] ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

if (!normalized.startsWith('postgresql://') && !normalized.startsWith('postgres://')) {
  // Log prefix only — never log full URL or credentials
  const safePrefix = normalized.slice(0, 12);
  console.error(`[migrate-production] ERROR: DATABASE_URL does not start with postgresql:// or postgres://. Prefix: "${safePrefix}..."`);
  process.exit(1);
}

// Assign normalized value so Prisma CLI inherits it
process.env.DATABASE_URL = normalized;

console.log('[migrate-production] DATABASE_URL normalized. Running prisma migrate deploy...');

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  env: process.env,
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);
