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

function safeProtocol(url) {
  // Returns protocol label without exposing credentials
  if (!url) return 'none';
  const match = url.match(/^([a-z]+:\/\/)/);
  return match ? match[1] : url.slice(0, 12) + '...';
}

// ── Main ──────────────────────────────────────────────────────────────────────

const raw = process.env.DATABASE_URL;
const normalized = normalizeDbUrl(raw);

// Safe diagnostics — never print the full URL or credentials
console.log('[migrate-production] DATABASE_URL diagnostics:');
console.log(`  exists   : ${Boolean(raw)}`);
console.log(`  raw len  : ${raw ? raw.length : 0}`);
console.log(`  norm len : ${normalized ? normalized.length : 0}`);
console.log(`  protocol : ${safeProtocol(normalized)}`);

if (!normalized) {
  console.error('[migrate-production] FATAL: DATABASE_URL is not set. Exiting.');
  process.exit(1);
}

if (!normalized.startsWith('postgresql://') && !normalized.startsWith('postgres://')) {
  const safeHead = normalized.slice(0, 16).replace(/./g, (c, i) => (i < 12 ? c : '*'));
  console.error(`[migrate-production] FATAL: Normalized URL does not start with postgresql:// or postgres://. Head: "${safeHead}..."`);
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
