/**
 * Environment Validation Service (M9.16)
 * Fails fast at startup in production mode if required configuration or secrets are missing.
 * Tolerates development/test placeholders safely.
 *
 * Key invariants:
 *  - HOST / PORT are the server bind address — NOT the public application URL.
 *  - SHOPIFY_APP_URL is the canonical public HTTPS application URL known to Shopify.
 *    It must NEVER be derived from HOST; they serve different purposes.
 */

export interface ValidatedEnvironment {
  nodeEnv: string;
  databaseUrl: string;
  encryptionSecret: string;
  shopifyApiKey?: string;
  shopifyApiSecret?: string;
  /** Public application URL as known to Shopify (must be HTTPS in production). */
  shopifyAppUrl?: string;
  /** Server bind host (e.g. '0.0.0.0'). Never used as the public app URL. */
  serverBindHost: string;
  port: number;
}

/**
 * Validates that SHOPIFY_APP_URL is safe for production:
 * - Must be present
 * - Must be HTTPS
 * - Must not be localhost / 127.x / 0.0.0.0 / trycloudflare / shopify.dev default
 */
export function validateShopifyAppUrl(url: string | undefined): string | null {
  if (!url) return 'SHOPIFY_APP_URL is missing';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return `SHOPIFY_APP_URL must use HTTPS (got: ${parsed.protocol})`;
    }
    const host = parsed.hostname.toLowerCase();
    const unsafeHosts = [
      'localhost', '127.0.0.1', '0.0.0.0',
      'trycloudflare.com', 'shopify.dev',
    ];
    for (const bad of unsafeHosts) {
      if (host === bad || host.endsWith(`.${bad}`)) {
        return `SHOPIFY_APP_URL must not be a development/tunnel URL (got host: ${host})`;
      }
    }
    // Shopify's own default-app-home redirect URL is not a valid production app URL
    if (url.includes('shopify.dev/apps/default-app-home')) {
      return 'SHOPIFY_APP_URL must not be the Shopify default-app-home redirect URL';
    }
    return null; // valid
  } catch {
    return `SHOPIFY_APP_URL is not a valid URL: ${url}`;
  }
}

export function validateEnvironment(): ValidatedEnvironment {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const databaseUrl = process.env.DATABASE_URL || '';
  const encryptionSecret = process.env.ENCRYPTION_SECRET || '';
  const shopifyApiKey = process.env.SHOPIFY_API_KEY;
  const shopifyApiSecret = process.env.SHOPIFY_API_SECRET;

  // SHOPIFY_APP_URL is the canonical public application URL — independent of HOST.
  // HOST is strictly the network bind address (e.g. 0.0.0.0, 127.0.0.1).
  // Mixing them caused 0.0.0.0 to be treated as the app URL, breaking Shopify embeds.
  const shopifyAppUrl = process.env.SHOPIFY_APP_URL;
  const serverBindHost = process.env.HOST || '0.0.0.0';
  const port = parseInt(process.env.PORT || '8080', 10);

  const missingProdVars: string[] = [];

  // 1. In all environments, DATABASE_URL must exist and start with postgresql:// or postgres://
  let cleanDbUrl = databaseUrl.trim().replace(/[\r\n]+/g, '').trim();
  // Strip one matching surrounding quote pair
  if ((cleanDbUrl.startsWith('"') && cleanDbUrl.endsWith('"')) || (cleanDbUrl.startsWith("'") && cleanDbUrl.endsWith("'"))) {
    cleanDbUrl = cleanDbUrl.slice(1, -1).trim();
  }
  // Repair: platform stripped 'postgresql:' leaving '//'
  if (cleanDbUrl.startsWith('//')) {
    cleanDbUrl = 'postgresql:' + cleanDbUrl;
    process.env.DATABASE_URL = cleanDbUrl;
  }
  // Repair single-slash variants
  if (cleanDbUrl.startsWith('postgresql:/') && !cleanDbUrl.startsWith('postgresql://')) {
    cleanDbUrl = 'postgresql://' + cleanDbUrl.slice('postgresql:/'.length);
    process.env.DATABASE_URL = cleanDbUrl;
  }
  if (cleanDbUrl.startsWith('postgres:/') && !cleanDbUrl.startsWith('postgres://')) {
    cleanDbUrl = 'postgres://' + cleanDbUrl.slice('postgres:/'.length);
    process.env.DATABASE_URL = cleanDbUrl;
  }

  if (!cleanDbUrl) {
    missingProdVars.push('DATABASE_URL');
  } else if (!cleanDbUrl.startsWith('postgresql://') && !cleanDbUrl.startsWith('postgres://')) {
    const safeSnippet = cleanDbUrl.slice(0, 15);
    missingProdVars.push(`DATABASE_URL must start with "postgresql://" or "postgres://". Currently starts with: "${safeSnippet}..." (length: ${cleanDbUrl.length})`);
  }

  // 2. In all environments, ENCRYPTION_SECRET must be at least 32 characters
  if (!encryptionSecret || encryptionSecret.length < 32) {
    if (nodeEnv === 'production') {
      missingProdVars.push('ENCRYPTION_SECRET (must be at least 32 characters)');
    } else if (!encryptionSecret) {
      // In dev/test, warn if empty
      console.warn('[Env] WARNING: ENCRYPTION_SECRET is missing or short. Using test fallback.');
    }
  }

  // 3. Strict production environment requirements
  if (nodeEnv === 'production') {
    if (!shopifyApiKey || shopifyApiKey.startsWith('your_') || shopifyApiKey === 'test_key') {
      missingProdVars.push('SHOPIFY_API_KEY');
    }
    if (!shopifyApiSecret || shopifyApiSecret.startsWith('your_') || shopifyApiSecret === 'test_secret') {
      missingProdVars.push('SHOPIFY_API_SECRET');
    }

    // Validate SHOPIFY_APP_URL as the canonical public URL (NOT HOST)
    const appUrlError = validateShopifyAppUrl(shopifyAppUrl);
    if (appUrlError) {
      missingProdVars.push(`SHOPIFY_APP_URL: ${appUrlError}`);
    }

    if (missingProdVars.length > 0) {
      console.error('================================================================');
      console.error('FATAL CONFIGURATION ERROR: Missing required production env vars:');
      for (const v of missingProdVars) {
        console.error(`  - ${v}`);
      }
      console.error('Application cannot start safely in production mode.');
      console.error('================================================================');
      process.exit(1);
    }
  }

  return {
    nodeEnv,
    databaseUrl,
    encryptionSecret: encryptionSecret || 'development_32_byte_secret_key_mock_12345',
    shopifyApiKey,
    shopifyApiSecret,
    shopifyAppUrl,
    serverBindHost,
    port,
  };
}

