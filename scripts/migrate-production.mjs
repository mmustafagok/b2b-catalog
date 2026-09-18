/**
 * Production migration launcher.
 * Normalizes DATABASE_URL BEFORE invoking `prisma migrate deploy`,
 * passing the normalized value explicitly in the child process environment.
 * This ensures the Prisma CLI always receives a valid postgresql:// URL
 * even when the hosting platform strips or truncates the protocol prefix.
 */

import { spawnSync } from 'child_process';

function normalizeDbUrl(raw) {
  if (!raw) return null;

  // 1. Trim whitespace and remove CR/LF
  let url = raw.trim().replace(/[\r\n]+/g, '');

  // 2. Strip one matching pair of surrounding quotes (single or double)
  if (
    (url.startsWith('"') && url.endsWith('"')) ||
    (url.startsWith("'") && url.endsWith("'"))
  ) {
    url = url.slice(1, -1).trim();
  }

  // 3. Repair: platform stripped "postgresql:" leaving "//..."
  if (url.startsWith('//')) {
    url = 'postgresql:' + url;
  }

  // 4. Repair single-slash variants: "postgresql:/" → "postgresql://"
  if (url.startsWith('postgresql:/') && !url.startsWith('postgresql://')) {
    url = 'postgresql://' + url.slice('postgresql:/'.length);
  }
  if (url.startsWith('postgres:/') && !url.startsWith('postgres://')) {
    url = 'postgres://' + url.slice('postgres:/'.length);
  }

  return url;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const raw = process.env.DATABASE_URL;
const normalized = normalizeDbUrl(raw);

// Safe diagnostics — never print credentials, raw URL, or sensitive data
let parsedHostname = null;
if (normalized) {
  try {
    parsedHostname = new URL(normalized).hostname || null;
  } catch {
    parsedHostname = 'invalid_url';
  }
}

console.log('[migrate-production] DATABASE_URL diagnostics:');
console.log(`  raw length: ${raw ? raw.length : 0}`);
console.log(`  raw starts with "postgresql://": ${Boolean(raw && raw.startsWith('postgresql://'))}`);
console.log(`  raw starts with "postgres://": ${Boolean(raw && raw.startsWith('postgres://'))}`);
console.log(`  raw starts with "//": ${Boolean(raw && raw.startsWith('//'))}`);
console.log(`  raw contains "@": ${Boolean(raw && raw.includes('@'))}`);
console.log(`  raw contains "?sslmode=require": ${Boolean(raw && raw.includes('?sslmode=require'))}`);
console.log(`  parsed hostname only AFTER normalization: ${parsedHostname}`);
console.log(`  normalized length: ${normalized ? normalized.length : 0}`);

if (!normalized) {
  console.error('[migrate-production] FATAL: DATABASE_URL is not set. Exiting.');
  process.exit(1);
}

if (!normalized.startsWith('postgresql://') && !normalized.startsWith('postgres://')) {
  console.error('[migrate-production] FATAL: Normalized URL does not start with postgresql:// or postgres://.');
  process.exit(1);
}

// Build explicit child env — do NOT rely solely on process.env mutation
const childEnv = { ...process.env, DATABASE_URL: normalized };

console.log('[migrate-production] Running: npx prisma migrate deploy');

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  env: childEnv,
  stdio: 'inherit',
  shell: true,
});

if (result.error) {
  console.error('[migrate-production] Failed to spawn prisma:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
