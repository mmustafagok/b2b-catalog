/**
 * validate-shopify-production-config.mjs
 *
 * Validates shopify.app.catalogflow-b2b-order-catalog.toml (production deploy config)
 * against required production values.
 *
 * Exits non-zero on any violation.
 * Does NOT use brittle TOML regex parsing — reads the file as text for specific known-format keys,
 * and validates targeted lines.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '../shopify.app.catalogflow-b2b-order-catalog.toml');
const PRODUCTION_URL = 'https://b2b-catalog.hostless.app';
const EXPECTED_CLIENT_ID = '6c4ea87dbc56b998f87864fd64fa8a07';
const EXPECTED_API_VERSION = '2026-07';
const REQUIRED_SCOPES = ['read_products', 'read_inventory', 'write_draft_orders', 'read_draft_orders'];

const FORBIDDEN_STRINGS = [
  'trycloudflare.com',
  'localhost',
  '127.0.0.1',
  'shopify.dev/apps/default-app-home',
];

let failed = false;

function fail(msg) {
  console.error(`  ✗ FAIL: ${msg}`);
  failed = true;
}

function pass(msg) {
  console.log(`  ✓ PASS: ${msg}`);
}

console.log(`\n[validate-shopify-production-config] Validating: ${CONFIG_PATH}\n`);

let content;
try {
  content = readFileSync(CONFIG_PATH, 'utf-8');
} catch (e) {
  console.error(`FATAL: Cannot read production config: ${e.message}`);
  process.exit(1);
}

// 1. Forbidden strings must not appear anywhere in the file
for (const forbidden of FORBIDDEN_STRINGS) {
  if (content.includes(forbidden)) {
    fail(`Production config contains forbidden string: "${forbidden}"`);
  } else {
    pass(`Does not contain "${forbidden}"`);
  }
}

// 2. application_url must be exactly the production URL
const appUrlMatch = content.match(/^application_url\s*=\s*"([^"]+)"/m);
if (!appUrlMatch) {
  fail('application_url not found in config');
} else {
  const url = appUrlMatch[1].replace(/\/$/, ''); // strip optional trailing slash
  if (url !== PRODUCTION_URL) {
    fail(`application_url is "${url}", expected "${PRODUCTION_URL}"`);
  } else {
    pass(`application_url = "${url}"`);
  }
}

// 3. embedded must be true
if (/^embedded\s*=\s*true/m.test(content)) {
  pass('embedded = true');
} else {
  fail('embedded must be true in production config');
}

// 4. client_id must match
const clientIdMatch = content.match(/^client_id\s*=\s*"([^"]+)"/m);
if (!clientIdMatch) {
  fail('client_id not found in config');
} else if (clientIdMatch[1] !== EXPECTED_CLIENT_ID) {
  fail(`client_id is "${clientIdMatch[1]}", expected "${EXPECTED_CLIENT_ID}"`);
} else {
  pass(`client_id = "${clientIdMatch[1]}"`);
}

// 5. api_version must be correct
if (content.includes(`api_version = "${EXPECTED_API_VERSION}"`)) {
  pass(`api_version = "${EXPECTED_API_VERSION}"`);
} else {
  fail(`api_version "${EXPECTED_API_VERSION}" not found`);
}

// 6. All required scopes present
const scopesMatch = content.match(/^scopes\s*=\s*"([^"]+)"/m);
if (!scopesMatch) {
  fail('scopes not found in config');
} else {
  const scopes = scopesMatch[1].split(',').map(s => s.trim());
  for (const required of REQUIRED_SCOPES) {
    if (scopes.includes(required)) {
      pass(`scope: ${required}`);
    } else {
      fail(`Missing required scope: "${required}"`);
    }
  }
}

// 7. include_config_on_deploy must be true (so deploy actually uses this file)
if (/^include_config_on_deploy\s*=\s*true/m.test(content)) {
  pass('include_config_on_deploy = true');
} else {
  fail('include_config_on_deploy must be true in production deploy config');
}

// 8. automatically_update_urls_on_dev must be false (production safety)
if (/^automatically_update_urls_on_dev\s*=\s*false/m.test(content)) {
  pass('automatically_update_urls_on_dev = false (production safe)');
} else {
  fail('automatically_update_urls_on_dev must be false in production config to prevent tunnel URL pollution');
}

// 9. redirect_urls: if any are specified, all must be Hostless
const redirectSection = content.match(/redirect_urls\s*=\s*\[([^\]]*)\]/s);
if (redirectSection) {
  const urls = redirectSection[1].match(/"([^"]+)"/g) || [];
  if (urls.length === 0) {
    pass('redirect_urls = [] (correct for managed installation)');
  } else {
    for (const u of urls) {
      const url = u.replace(/"/g, '');
      if (!url.startsWith(PRODUCTION_URL)) {
        fail(`redirect_url "${url}" does not use production domain`);
      } else {
        pass(`redirect_url: ${url}`);
      }
    }
  }
}

console.log('');

if (failed) {
  console.error('[validate-shopify-production-config] ✗ VALIDATION FAILED — fix issues above before deploying\n');
  process.exit(1);
} else {
  console.log('[validate-shopify-production-config] ✓ All production config checks passed\n');
  process.exit(0);
}
