import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  parseBackupEncryptionKey,
  generateBackupEncryptionKey,
  encryptBackupBuffer,
  decryptBackupBuffer,
  encryptBackupFile,
  decryptBackupFile,
  BACKUP_MAGIC,
  BACKUP_VERSION,
  HEADER_LENGTH,
  KEY_LENGTH,
  IV_LENGTH,
  TAG_LENGTH,
} from '../scripts/backup-crypto.js';
import {
  runDatabaseBackup,
  sanitizeDatabaseUrlForLogging,
} from '../scripts/backup-database.js';
import {
  runDatabaseRestore,
  isProductionDatabaseUrl,
} from '../scripts/restore-database.js';

describe('Production-Safe Encrypted PostgreSQL Backup Architecture', () => {
  let testDir: string;
  let testKeyBase64: string;
  let testKeyBuffer: Buffer;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `catalogflow-backup-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(testDir, { recursive: true });
    testKeyBase64 = generateBackupEncryptionKey();
    testKeyBuffer = parseBackupEncryptionKey(testKeyBase64);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. KEY VALIDATION & PARSING
  // =========================================================================
  describe('1. Key Validation & Parsing', () => {
    it('throws error when BACKUP_ENCRYPTION_KEY is missing or empty', () => {
      expect(() => parseBackupEncryptionKey(undefined)).toThrow(
        /BACKUP_ENCRYPTION_KEY is required and cannot be empty/
      );
      expect(() => parseBackupEncryptionKey('')).toThrow(
        /BACKUP_ENCRYPTION_KEY is required and cannot be empty/
      );
      expect(() => parseBackupEncryptionKey('   ')).toThrow(
        /BACKUP_ENCRYPTION_KEY is required and cannot be empty/
      );
    });

    it('throws error when key is malformed Base64', () => {
      expect(() => parseBackupEncryptionKey('Not-Valid-Base64!!#$')).toThrow(
        /BACKUP_ENCRYPTION_KEY must be a valid Base64 string/
      );
    });

    it('throws error when key has wrong length (not 32 bytes)', () => {
      // 16 bytes (AES-128)
      const key16 = crypto.randomBytes(16).toString('base64');
      expect(() => parseBackupEncryptionKey(key16)).toThrow(
        /BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes/
      );

      // 64 bytes (512 bits)
      const key64 = crypto.randomBytes(64).toString('base64');
      expect(() => parseBackupEncryptionKey(key64)).toThrow(
        /BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes/
      );
    });

    it('successfully parses valid 32-byte Base64 key', () => {
      const parsed = parseBackupEncryptionKey(testKeyBase64);
      expect(parsed).toBeInstanceOf(Buffer);
      expect(parsed.length).toBe(32);
    });
  });

  // =========================================================================
  // 2. AES-256-GCM ENVELOPE ENCRYPTION & TAMPERING DETECTION
  // =========================================================================
  describe('2. AES-256-GCM Cryptographic Integrity', () => {
    it('encrypts and decrypts buffer payload with byte-for-byte fidelity', () => {
      const original = Buffer.from('CREATE TABLE test_data (id SERIAL PRIMARY KEY, value TEXT);', 'utf8');
      const encrypted = encryptBackupBuffer(original, testKeyBuffer);

      // Verify envelope structure
      expect(encrypted.length).toBeGreaterThan(HEADER_LENGTH);
      expect(encrypted.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)).toBe(true);
      expect(encrypted[BACKUP_MAGIC.length]).toBe(BACKUP_VERSION);

      const decrypted = decryptBackupBuffer(encrypted, testKeyBuffer);
      expect(decrypted.equals(original)).toBe(true);
    });

    it('generates unique cryptographically random IVs for each backup', () => {
      const payload = Buffer.from('SAMPLE_DUMP_PAYLOAD', 'utf8');
      const enc1 = encryptBackupBuffer(payload, testKeyBuffer);
      const enc2 = encryptBackupBuffer(payload, testKeyBuffer);

      const iv1 = enc1.subarray(BACKUP_MAGIC.length + 1, BACKUP_MAGIC.length + 1 + IV_LENGTH);
      const iv2 = enc2.subarray(BACKUP_MAGIC.length + 1, BACKUP_MAGIC.length + 1 + IV_LENGTH);

      expect(iv1.equals(iv2)).toBe(false);
    });

    it('detects and rejects ciphertext tampering', () => {
      const original = Buffer.from('CRITICAL_POSTGRESQL_BACKUP_SQL_DATA', 'utf8');
      const encrypted = encryptBackupBuffer(original, testKeyBuffer);

      // Mutate one byte in the ciphertext payload
      const tampered = Buffer.from(encrypted);
      tampered[HEADER_LENGTH + 5] ^= 0xff;

      expect(() => decryptBackupBuffer(tampered, testKeyBuffer)).toThrow(
        /Backup authentication failed: invalid tag, corrupted ciphertext, or incorrect key/
      );
    });

    it('detects and rejects authentication tag tampering', () => {
      const original = Buffer.from('CRITICAL_POSTGRESQL_BACKUP_SQL_DATA', 'utf8');
      const encrypted = encryptBackupBuffer(original, testKeyBuffer);

      // Mutate one byte in the 16-byte authentication tag
      const tagOffset = BACKUP_MAGIC.length + 1 + IV_LENGTH;
      const tampered = Buffer.from(encrypted);
      tampered[tagOffset + 2] ^= 0xaa;

      expect(() => decryptBackupBuffer(tampered, testKeyBuffer)).toThrow(
        /Backup authentication failed: invalid tag, corrupted ciphertext, or incorrect key/
      );
    });

    it('detects and rejects invalid envelope magic or version', () => {
      const original = Buffer.from('SAMPLE_DUMP_PAYLOAD', 'utf8');
      const encrypted = encryptBackupBuffer(original, testKeyBuffer);

      // 1. Corrupt magic header
      const badMagic = Buffer.from(encrypted);
      badMagic[0] = 0x58; // 'X' instead of 'C'
      expect(() => decryptBackupBuffer(badMagic, testKeyBuffer)).toThrow(
        /Invalid backup envelope: invalid magic header/
      );

      // 2. Corrupt version byte
      const badVersion = Buffer.from(encrypted);
      badVersion[BACKUP_MAGIC.length] = 99; // Version 99
      expect(() => decryptBackupBuffer(badVersion, testKeyBuffer)).toThrow(
        /Invalid backup envelope: unsupported version 99/
      );
    });

    it('encryptBackupFile and decryptBackupFile correctly write and read files on disk', async () => {
      const plaintextFile = path.join(testDir, 'raw.dump');
      const encryptedFile = path.join(testDir, 'raw.dump.enc');
      const restoredFile = path.join(testDir, 'restored.dump');

      const dumpContent = Buffer.from('POSTGRESQL_CUSTOM_DUMP_HEADER\x00\x01\x02\x03BINARY_PAYLOAD_HERE', 'binary');
      fs.writeFileSync(plaintextFile, dumpContent);

      await encryptBackupFile(plaintextFile, encryptedFile, testKeyBuffer);
      expect(fs.existsSync(encryptedFile)).toBe(true);

      await decryptBackupFile(encryptedFile, restoredFile, testKeyBuffer);
      expect(fs.existsSync(restoredFile)).toBe(true);

      const restoredContent = fs.readFileSync(restoredFile);
      expect(restoredContent.equals(dumpContent)).toBe(true);
    });
  });

  // =========================================================================
  // 3. BACKUP RUNNER REQUIREMENTS
  // =========================================================================
  describe('3. Backup Runner Requirements', () => {
    it('refuses to run and throws when DATABASE_BACKUP_URL is missing, never falling back to DATABASE_URL', async () => {
      const originalBackupUrl = process.env.DATABASE_BACKUP_URL;
      const originalDbUrl = process.env.DATABASE_URL;

      try {
        delete process.env.DATABASE_BACKUP_URL;
        process.env.DATABASE_URL = 'postgresql://user:pass@hostless-prod.db/catalogflow';

        await expect(
          runDatabaseBackup({
            databaseBackupUrl: undefined,
            backupEncryptionKey: testKeyBase64,
          })
        ).rejects.toThrow(
          'DATABASE_BACKUP_URL is required for database backups. Refusing to fall back to DATABASE_URL.'
        );
      } finally {
        process.env.DATABASE_BACKUP_URL = originalBackupUrl;
        process.env.DATABASE_URL = originalDbUrl;
      }
    });

    it('guarantees plaintext dump deletion in finally block after successful backup', async () => {
      const tempDir = path.join(testDir, 'temp');
      const outputDir = path.join(testDir, 'backups');

      let capturedPlaintextPath = '';

      const mockDumpExecutor = async (args: string[]) => {
        const fileArg = args.find((a) => a.startsWith('--file='));
        expect(fileArg).toBeDefined();
        capturedPlaintextPath = fileArg!.replace('--file=', '');
        fs.writeFileSync(capturedPlaintextPath, 'MOCK_PG_DUMP_PLAINTEXT_CONTENT');
        return { stdout: '', stderr: '' };
      };

      const result = await runDatabaseBackup({
        databaseBackupUrl: 'postgresql://backup_user:secret_pass@db.internal:5432/catalogflow',
        backupEncryptionKey: testKeyBase64,
        tempDir,
        outputDir,
        dumpExecutor: mockDumpExecutor,
      });

      expect(fs.existsSync(result.encryptedFilePath)).toBe(true);
      expect(result.encryptedFilePath.endsWith('.dump.enc')).toBe(true);

      // Verify plaintext dump has been DELETED
      expect(capturedPlaintextPath).not.toBe('');
      expect(fs.existsSync(capturedPlaintextPath)).toBe(false);
    });

    it('guarantees plaintext dump deletion in finally block even when encryption fails', async () => {
      const tempDir = path.join(testDir, 'temp');
      const outputDir = path.join(testDir, 'backups');

      let capturedPlaintextPath = '';

      const mockDumpExecutor = async (args: string[]) => {
        const fileArg = args.find((a) => a.startsWith('--file='));
        capturedPlaintextPath = fileArg!.replace('--file=', '');
        fs.writeFileSync(capturedPlaintextPath, 'MOCK_PG_DUMP_PLAINTEXT_CONTENT');
        return { stdout: '', stderr: '' };
      };

      // Pass an invalid encryption key that fails parsing/encryption
      await expect(
        runDatabaseBackup({
          databaseBackupUrl: 'postgresql://backup_user:secret_pass@db.internal:5432/catalogflow',
          backupEncryptionKey: 'invalid-non-32-byte-key',
          tempDir,
          outputDir,
          dumpExecutor: mockDumpExecutor,
        })
      ).rejects.toThrow();

      // Plaintext file MUST NOT exist on disk
      if (capturedPlaintextPath) {
        expect(fs.existsSync(capturedPlaintextPath)).toBe(false);
      }
    });

    it('handles pg_dump execution failure gracefully and cleans up any partial plaintext', async () => {
      const tempDir = path.join(testDir, 'temp');
      const outputDir = path.join(testDir, 'backups');

      let capturedPlaintextPath = '';

      const failingDumpExecutor = async (args: string[]) => {
        const fileArg = args.find((a) => a.startsWith('--file='));
        capturedPlaintextPath = fileArg!.replace('--file=', '');
        // Create partial file before failing
        fs.writeFileSync(capturedPlaintextPath, 'PARTIAL_CORRUPT_DUMP');
        throw new Error('pg_dump: connection to server failed: Connection refused');
      };

      await expect(
        runDatabaseBackup({
          databaseBackupUrl: 'postgresql://backup_user:secret_pass@db.internal:5432/catalogflow',
          backupEncryptionKey: testKeyBase64,
          tempDir,
          outputDir,
          dumpExecutor: failingDumpExecutor,
        })
      ).rejects.toThrow(/pg_dump: connection to server failed/);

      // Ensure partial plaintext dump was deleted
      expect(capturedPlaintextPath).not.toBe('');
      expect(fs.existsSync(capturedPlaintextPath)).toBe(false);
    });

    it('sanitizes credentials from database URLs in logs', () => {
      const rawUrl = 'postgresql://admin_user:super_secret_password_123@hostless-db.internal:5432/catalogflow_prod';
      const sanitized = sanitizeDatabaseUrlForLogging(rawUrl);

      expect(sanitized).not.toContain('super_secret_password_123');
      expect(sanitized).toContain('[REDACTED_PASSWORD]');
      expect(sanitized).toContain('hostless-db.internal:5432/catalogflow_prod');
    });
  });

  // =========================================================================
  // 4. RESTORE RUNNER & SAFETY GUARDS
  // =========================================================================
  describe('4. Restore Runner & Safety Guards', () => {
    it('refuses to run when RESTORE_DATABASE_URL is missing, never falling back to DATABASE_URL or DATABASE_BACKUP_URL', async () => {
      const originalRestoreUrl = process.env.RESTORE_DATABASE_URL;
      const originalDbUrl = process.env.DATABASE_URL;
      const originalBackupUrl = process.env.DATABASE_BACKUP_URL;

      try {
        delete process.env.RESTORE_DATABASE_URL;
        process.env.DATABASE_URL = 'postgresql://user:pass@hostless-prod.db/catalogflow';
        process.env.DATABASE_BACKUP_URL = 'postgresql://backup:pass@hostless-prod.db/catalogflow';

        await expect(
          runDatabaseRestore({
            restoreDatabaseUrl: undefined,
            backupEncryptionKey: testKeyBase64,
            backupFilePath: path.join(testDir, 'fake.dump.enc'),
          })
        ).rejects.toThrow(
          'RESTORE_DATABASE_URL is required for database restore. Refusing to fall back to DATABASE_URL or DATABASE_BACKUP_URL.'
        );
      } finally {
        process.env.RESTORE_DATABASE_URL = originalRestoreUrl;
        process.env.DATABASE_URL = originalDbUrl;
        process.env.DATABASE_BACKUP_URL = originalBackupUrl;
      }
    });

    it('production restore safety guard: refuses restore into production URL without explicit ALLOW_PRODUCTION_RESTORE=true', async () => {
      const prodUrl = 'postgresql://admin:pass@hostless.app:5432/catalogflow_production';
      expect(isProductionDatabaseUrl(prodUrl)).toBe(true);

      const encryptedPath = path.join(testDir, 'sample.dump.enc');
      fs.writeFileSync(encryptedPath, encryptBackupBuffer(Buffer.from('TEST'), testKeyBuffer));

      await expect(
        runDatabaseRestore({
          restoreDatabaseUrl: prodUrl,
          backupEncryptionKey: testKeyBase64,
          backupFilePath: encryptedPath,
          allowProductionRestore: false,
        })
      ).rejects.toThrow(
        /Safety guard: Target database appears to be a production database. Refusing restore unless ALLOW_PRODUCTION_RESTORE=true is explicitly set./
      );
    });

    it('production restore safety guard: allows restore into production URL when ALLOW_PRODUCTION_RESTORE=true is explicitly passed', async () => {
      const prodUrl = 'postgresql://admin:pass@hostless.app:5432/catalogflow_production';
      const encryptedPath = path.join(testDir, 'sample.dump.enc');
      fs.writeFileSync(encryptedPath, encryptBackupBuffer(Buffer.from('MOCK_DUMP_FOR_PROD'), testKeyBuffer));

      let restoreExecuted = false;
      const mockRestoreExecutor = async (args: string[]) => {
        restoreExecuted = true;
        return { stdout: '', stderr: '' };
      };

      const result = await runDatabaseRestore({
        restoreDatabaseUrl: prodUrl,
        backupEncryptionKey: testKeyBase64,
        backupFilePath: encryptedPath,
        allowProductionRestore: true,
        restoreExecutor: mockRestoreExecutor,
      });

      expect(result.success).toBe(true);
      expect(restoreExecuted).toBe(true);
    });

    it('fails restore if decryption fails with wrong encryption key before executing pg_restore', async () => {
      const wrongKeyBase64 = generateBackupEncryptionKey();
      const encryptedPath = path.join(testDir, 'valid.dump.enc');
      fs.writeFileSync(encryptedPath, encryptBackupBuffer(Buffer.from('VALID_DUMP'), testKeyBuffer));

      let restoreExecuted = false;
      const mockRestoreExecutor = async () => {
        restoreExecuted = true;
        return { stdout: '', stderr: '' };
      };

      await expect(
        runDatabaseRestore({
          restoreDatabaseUrl: 'postgresql://test_user:pass@localhost:5432/catalogflow_dev',
          backupEncryptionKey: wrongKeyBase64,
          backupFilePath: encryptedPath,
          restoreExecutor: mockRestoreExecutor,
        })
      ).rejects.toThrow(/Backup authentication failed/);

      // pg_restore MUST NOT be executed if decryption/authentication fails!
      expect(restoreExecuted).toBe(false);
    });

    it('guarantees decrypted plaintext deletion in finally block after successful restore', async () => {
      const encryptedPath = path.join(testDir, 'valid.dump.enc');
      fs.writeFileSync(encryptedPath, encryptBackupBuffer(Buffer.from('RESTORE_TEST_DATA'), testKeyBuffer));

      let capturedDecryptedPath = '';
      const mockRestoreExecutor = async (args: string[]) => {
        capturedDecryptedPath = args[args.length - 1];
        // Plaintext file must exist during pg_restore execution
        expect(fs.existsSync(capturedDecryptedPath)).toBe(true);
        return { stdout: '', stderr: '' };
      };

      const result = await runDatabaseRestore({
        restoreDatabaseUrl: 'postgresql://test_user:pass@localhost:5432/catalogflow_test',
        backupEncryptionKey: testKeyBase64,
        backupFilePath: encryptedPath,
        restoreExecutor: mockRestoreExecutor,
      });

      expect(result.success).toBe(true);

      // Plaintext decrypted file MUST be deleted in finally block
      expect(capturedDecryptedPath).not.toBe('');
      expect(fs.existsSync(capturedDecryptedPath)).toBe(false);
    });

    it('guarantees decrypted plaintext deletion in finally block after failed pg_restore', async () => {
      const encryptedPath = path.join(testDir, 'valid.dump.enc');
      fs.writeFileSync(encryptedPath, encryptBackupBuffer(Buffer.from('RESTORE_TEST_DATA'), testKeyBuffer));

      let capturedDecryptedPath = '';
      const failingRestoreExecutor = async (args: string[]) => {
        capturedDecryptedPath = args[args.length - 1];
        throw new Error('pg_restore: error: could not connect to server');
      };

      await expect(
        runDatabaseRestore({
          restoreDatabaseUrl: 'postgresql://test_user:pass@localhost:5432/catalogflow_test',
          backupEncryptionKey: testKeyBase64,
          backupFilePath: encryptedPath,
          restoreExecutor: failingRestoreExecutor,
        })
      ).rejects.toThrow(/pg_restore: error: could not connect to server/);

      // Plaintext decrypted file MUST be deleted in finally block even after failure
      expect(capturedDecryptedPath).not.toBe('');
      expect(fs.existsSync(capturedDecryptedPath)).toBe(false);
    });
  });
});
