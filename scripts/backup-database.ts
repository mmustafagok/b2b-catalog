import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseBackupEncryptionKey, encryptBackupFile } from './backup-crypto.js';

const execFileAsync = promisify(execFile);

export interface BackupOptions {
  databaseBackupUrl?: string;
  backupEncryptionKey?: string;
  tempDir?: string;
  outputDir?: string;
  dumpExecutor?: (args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
}

export interface BackupResult {
  encryptedFilePath: string;
  fileName: string;
  sizeBytes: number;
  timestamp: string;
}

export interface LibpqEnvConfig {
  PGHOST: string;
  PGPORT: string;
  PGUSER?: string;
  PGPASSWORD?: string;
  PGDATABASE: string;
  PGSSLMODE: string;
}

/**
 * Parses a PostgreSQL connection string into standard libpq environment variables.
 * Decodes percent-encoded components and ensures the remote host, port, credentials,
 * and database are set explicitly so pg_dump/pg_restore never falls back to local sockets.
 */
export function parsePostgresUrlToEnv(rawUrl: string): LibpqEnvConfig {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new Error('Database URL is required and cannot be empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (err: any) {
    throw new Error(`Invalid database URL: failed to parse connection string (${err?.message || 'malformed URL'}).`);
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new Error(`Invalid database URL protocol '${parsed.protocol}': expected 'postgresql:' or 'postgres:'.`);
  }

  if (!parsed.hostname) {
    throw new Error('Invalid database URL: missing hostname.');
  }

  const rawPath = parsed.pathname.replace(/^\//, '').split('?')[0].trim();
  if (!rawPath) {
    throw new Error('Invalid database URL: missing database name.');
  }
  const databaseName = decodeURIComponent(rawPath);

  const sslmodeParam = parsed.searchParams.get('sslmode');
  const pgsslmode = sslmodeParam || 'require';

  const envConfig: LibpqEnvConfig = {
    PGHOST: decodeURIComponent(parsed.hostname),
    PGPORT: parsed.port || '5432',
    PGDATABASE: databaseName,
    PGSSLMODE: pgsslmode,
  };

  if (parsed.username) {
    envConfig.PGUSER = decodeURIComponent(parsed.username);
  }
  if (parsed.password) {
    envConfig.PGPASSWORD = decodeURIComponent(parsed.password);
  }

  return envConfig;
}

/**
 * Sanitizes connection strings for safe logging (removes password/credentials).
 */
export function sanitizeDatabaseUrlForLogging(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const user = parsed.username ? '[REDACTED_USER]' : '';
    const pass = parsed.password ? ':[REDACTED_PASSWORD]' : '';
    const auth = user || pass ? `${user}${pass}@` : '';
    return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`;
  } catch {
    return '[REDACTED_DATABASE_URL]';
  }
}

/**
 * Executes a production-safe encrypted database backup.
 * 
 * Strict Guarantees:
 * 1. Uses DATABASE_BACKUP_URL exclusively (strictly never falls back to DATABASE_URL).
 * 2. Uses AES-256-GCM authenticated encryption with a validated 32-byte key.
 * 3. Plaintext pg_dump file is deleted in a finally block under all circumstances (success or error).
 * 4. Outputs only authenticated .dump.enc files.
 * 5. Passes connection parameters via parsed libpq environment variables (PGHOST, PGPORT, etc.)
 *    so credentials never appear in process command arguments and connection never falls back to localhost.
 */
export async function runDatabaseBackup(options: BackupOptions = {}): Promise<BackupResult> {
  const backupUrl = options.databaseBackupUrl ?? process.env.DATABASE_BACKUP_URL;
  if (!backupUrl || backupUrl.trim() === '') {
    throw new Error(
      'DATABASE_BACKUP_URL is required for database backups. Refusing to fall back to DATABASE_URL.'
    );
  }

  // Parse connection URL to validate protocol, hostname, and extract libpq variables
  const libpqEnv = parsePostgresUrlToEnv(backupUrl);

  const keyBase64 = options.backupEncryptionKey ?? process.env.BACKUP_ENCRYPTION_KEY;
  const key = parseBackupEncryptionKey(keyBase64);

  const runnerTemp = options.tempDir ?? process.env.RUNNER_TEMP ?? os.tmpdir();
  if (!fs.existsSync(runnerTemp)) {
    fs.mkdirSync(runnerTemp, { recursive: true });
  }

  const outputDirectory = options.outputDir ?? process.env.BACKUP_OUTPUT_DIR ?? path.resolve(process.cwd(), 'backups');
  if (!fs.existsSync(outputDirectory)) {
    fs.mkdirSync(outputDirectory, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const tempPlaintextDumpPath = path.join(
    runnerTemp,
    `catalogflow-temp-dump-${timestamp}-${randomSuffix}.dump`
  );

  const encryptedFileName = `catalogflow-backup-${timestamp}-${randomSuffix}.dump.enc`;
  const encryptedFilePath = path.join(outputDirectory, encryptedFileName);

  console.info(`[Backup] Initiating database backup for target: ${sanitizeDatabaseUrlForLogging(backupUrl)}`);

  try {
    // 1. Run pg_dump to produce temporary plaintext custom-format dump
    console.info('[Backup] Executing pg_dump to temporary storage...');
    const dumpArgs = [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--file=${tempPlaintextDumpPath}`,
    ];

    // Pass connection parameters via libpq environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE)
    // Overrides any local socket defaults, and DATABASE_BACKUP_URL is NOT passed as PGDATABASE.
    const dumpEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...libpqEnv,
    };

    if (options.dumpExecutor) {
      await options.dumpExecutor(dumpArgs, dumpEnv);
    } else {
      await execFileAsync('pg_dump', dumpArgs, {
        env: dumpEnv,
        maxBuffer: 100 * 1024 * 1024,
      });
    }

    if (!fs.existsSync(tempPlaintextDumpPath)) {
      throw new Error('pg_dump finished but temporary dump file was not created.');
    }

    const plaintextStats = await fs.promises.stat(tempPlaintextDumpPath);
    console.info(`[Backup] Plaintext dump created (${plaintextStats.size} bytes). Encrypting with AES-256-GCM...`);

    // 2. Encrypt plaintext dump using AES-256-GCM authenticated envelope
    const encryptionResult = await encryptBackupFile(tempPlaintextDumpPath, encryptedFilePath, key);
    console.info(
      `[Backup] Encryption complete: ${encryptedFileName} (${encryptionResult.bytesWritten} bytes written).`
    );

    return {
      encryptedFilePath,
      fileName: encryptedFileName,
      sizeBytes: encryptionResult.bytesWritten,
      timestamp,
    };
  } finally {
    // 3. GUARANTEED PLAINTEXT CLEANUP:
    // The plaintext dump must NEVER remain on disk after backup, whether successful or failed.
    if (fs.existsSync(tempPlaintextDumpPath)) {
      try {
        await fs.promises.unlink(tempPlaintextDumpPath);
        console.info('[Backup] Plaintext temporary dump securely removed.');
      } catch (cleanupErr: any) {
        console.error('[Backup] Warning: Failed to delete temporary plaintext dump:', cleanupErr?.message);
      }
    }
  }
}

// Direct CLI invocation
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain || process.argv[1]?.endsWith('backup-database.ts')) {
  runDatabaseBackup()
    .then((result) => {
      console.info(`[Backup] Successfully completed: ${result.encryptedFilePath}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Backup] Failed to complete database backup:', err?.message || err);
      process.exit(1);
    });
}
