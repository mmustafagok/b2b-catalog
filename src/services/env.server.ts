/**
 * Environment Validation Service (M9.16)
 * Fails fast at startup in production mode if required configuration or secrets are missing.
 * Tolerates development/test placeholders safely.
 */

export interface ValidatedEnvironment {
  nodeEnv: string;
  databaseUrl: string;
  encryptionSecret: string;
  shopifyApiKey?: string;
  shopifyApiSecret?: string;
  shopifyAppUrl?: string;
  port: number;
}

export function validateEnvironment(): ValidatedEnvironment {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const databaseUrl = process.env.DATABASE_URL || '';
  const encryptionSecret = process.env.ENCRYPTION_SECRET || '';
  const shopifyApiKey = process.env.SHOPIFY_API_KEY;
  const shopifyApiSecret = process.env.SHOPIFY_API_SECRET;
  const shopifyAppUrl = process.env.HOST || process.env.SHOPIFY_APP_URL;
  const port = parseInt(process.env.PORT || '8080', 10);

  const missingProdVars: string[] = [];

  // 1. In all environments, DATABASE_URL must exist and start with postgresql:// or postgres://
  const cleanDbUrl = databaseUrl.trim().replace(/^["']|["']$/g, '').trim();
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
    if (!shopifyAppUrl) {
      missingProdVars.push('HOST / SHOPIFY_APP_URL');
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
    port,
  };
}
