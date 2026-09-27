import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseBackupEncryptionKey, decryptBackupFile } from './backup-crypto.js';
import { sanitizeDatabaseUrlForLogging, parsePostgresUrlToEnv } from './backup-database.js';

const execFileAsync = promisify(execFile);

export interface RestoreOptions {
  restoreDatabaseUrl?: string;
  backupEncryptionKey?: string;
  backupFilePath?: string;
  tempDir?: string;
  allowProductionRestore?: boolean;
  restoreExecutor?: (args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
}

export interface RestoreResult {
  success: boolean;
  targetDatabase: string;
  backupSource: string;
}

/**
 * Checks whether a database URL matches a known or suspected production database.
 */
export function isProductionDatabaseUrl(targetUrl: string): boolean {
  if (!targetUrl) return false;

  // 1. Direct match with current runtime production database URLs
  if (process.env.DATABASE_URL && targetUrl.trim() === process.env.DATABASE_URL.trim()) {
    return true;
  }
  if (process.env.DATABASE_BACKUP_URL && targetUrl.trim() === process.env.DATABASE_BACKUP_URL.trim()) {
    return true;
  }

  // 2. Hostname/connection string heuristic inspection
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    // Check hostless production patterns
    if (host.includes('hostless.app') || host.includes('prod') || host.includes('production')) {
      return true;
    }

    // Database name patterns
    if (pathname.includes('catalogflow_prod') || pathname.includes('b2b_catalog_prod')) {
      return true;
    }
  } catch {
    // If not a valid URL, search string tokens
    const lower = targetUrl.toLowerCase();
    if (lower.includes('hostless.app') || lower.includes('prod')) {
      return true;
    }
  }

  return false;
}

/**
 * Executes a production-safe encrypted database restore.
 * 
 * Strict Guarantees:
 * 1. Requires RESTORE_DATABASE_URL (strictly never falls back to DATABASE_URL or DATABASE_BACKUP_URL).
 * 2. Authenticates and decrypts the backup envelope BEFORE invoking pg_restore.
 * 3. Enforces production safety guard (refuses restore to production unless ALLOW_PRODUCTION_RESTORE=true).
 * 4. Guaranteed plaintext dump deletion in finally block under all circumstances.
 */
export async function runDatabaseRestore(options: RestoreOptions = {}): Promise<RestoreResult> {
  const restoreUrl = options.restoreDatabaseUrl ?? process.env.RESTORE_DATABASE_URL;
  if (!restoreUrl || restoreUrl.trim() === '') {
    throw new Error(
      'RESTORE_DATABASE_URL is required for database restore. Refusing to fall back to DATABASE_URL or DATABASE_BACKUP_URL.'
    );
  }

  // Enforce Production-Target Safety Guard
  const isTargetProduction = isProductionDatabaseUrl(restoreUrl);
  const allowProd =
    options.allowProductionRestore === true ||
    process.env.ALLOW_PRODUCTION_RESTORE === 'true' ||
    process.env.ALLOW_PRODUCTION_RESTORE === '1';

  if (isTargetProduction && !allowProd) {
    throw new Error(
      'Safety guard: Target database appears to be a production database. Refusing restore unless ALLOW_PRODUCTION_RESTORE=true is explicitly set.'
    );
  }

  const keyBase64 = options.backupEncryptionKey ?? process.env.BACKUP_ENCRYPTION_KEY;
  const key = parseBackupEncryptionKey(keyBase64);

  const backupFilePath = options.backupFilePath ?? process.env.BACKUP_FILE_PATH ?? process.argv[2];
  if (!backupFilePath || !fs.existsSync(backupFilePath)) {
    throw new Error(`Encrypted backup file not found: ${backupFilePath || '(none specified)'}`);
  }

  const runnerTemp = options.tempDir ?? process.env.RUNNER_TEMP ?? os.tmpdir();
  if (!fs.existsSync(runnerTemp)) {
    fs.mkdirSync(runnerTemp, { recursive: true });
  }

  const timestamp = Date.now();
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const tempPlaintextDumpPath = path.join(
    runnerTemp,
    `catalogflow-restore-temp-${timestamp}-${randomSuffix}.dump`
  );

  console.info(
    `[Restore] Initiating restore from ${backupFilePath} into ${sanitizeDatabaseUrlForLogging(restoreUrl)}`
  );

  try {
    // 1. Authenticate and decrypt the backup BEFORE invoking pg_restore
    console.info('[Restore] Authenticating and decrypting backup envelope...');
    await decryptBackupFile(backupFilePath, tempPlaintextDumpPath, key);
    console.info('[Restore] Envelope authenticated and decrypted successfully.');

    // 2. Execute pg_restore
    console.info('[Restore] Invoking pg_restore on target database...');
    const restoreArgs = [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      tempPlaintextDumpPath,
    ];

    const libpqEnv = parsePostgresUrlToEnv(restoreUrl);
    const restoreEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...libpqEnv,
    };

    if (options.restoreExecutor) {
      await options.restoreExecutor(restoreArgs, restoreEnv);
    } else {
      await execFileAsync('pg_restore', restoreArgs, {
        env: restoreEnv,
        maxBuffer: 100 * 1024 * 1024,
      });
    }

    console.info('[Restore] pg_restore completed successfully.');
    return {
      success: true,
      targetDatabase: sanitizeDatabaseUrlForLogging(restoreUrl),
      backupSource: path.basename(backupFilePath),
    };
  } finally {
    // 3. GUARANTEED PLAINTEXT CLEANUP:
    // Decrypted temporary dump must NEVER remain on disk after restore, whether successful or failed.
    if (fs.existsSync(tempPlaintextDumpPath)) {
      try {
        await fs.promises.unlink(tempPlaintextDumpPath);
        console.info('[Restore] Plaintext decrypted dump securely removed.');
      } catch (cleanupErr: any) {
        console.error('[Restore] Warning: Failed to delete temporary decrypted dump:', cleanupErr?.message);
      }
    }
  }
}

// Direct CLI invocation
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain || process.argv[1]?.endsWith('restore-database.ts')) {
  runDatabaseRestore()
    .then((result) => {
      console.info(`[Restore] Successfully restored backup to: ${result.targetDatabase}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Restore] Failed to restore database:', err?.message || err);
      process.exit(1);
    });
}
