import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BACKUP_MAGIC = Buffer.from('CFBKP', 'utf8'); // 5 bytes: CatalogFlow Backup
export const BACKUP_VERSION = 1; // 1 byte
export const IV_LENGTH = 12; // 12 bytes for AES-256-GCM
export const TAG_LENGTH = 16; // 16 bytes auth tag
export const KEY_LENGTH = 32; // 32 bytes (256 bits)
export const HEADER_LENGTH = BACKUP_MAGIC.length + 1 + IV_LENGTH + TAG_LENGTH; // 5 + 1 + 12 + 16 = 34 bytes

/**
 * Validates and decodes the Base64 backup encryption key.
 * Enforces exactly 32 bytes (256-bit AES).
 */
export function parseBackupEncryptionKey(keyBase64: string | undefined): Buffer {
  if (!keyBase64 || typeof keyBase64 !== 'string' || keyBase64.trim() === '') {
    throw new Error('BACKUP_ENCRYPTION_KEY is required and cannot be empty.');
  }

  const trimmed = keyBase64.trim();
  // Validate Base64 encoding
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!base64Regex.test(trimmed)) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be a valid Base64 string.');
  }

  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length !== KEY_LENGTH) {
    throw new Error(
      `BACKUP_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (received ${decoded.length} bytes).`
    );
  }

  return decoded;
}

/**
 * Generates a cryptographically random 32-byte key formatted as Base64.
 */
export function generateBackupEncryptionKey(): string {
  return crypto.randomBytes(KEY_LENGTH).toString('base64');
}

/**
 * Encrypts a plaintext buffer with AES-256-GCM authenticated encryption.
 * Emits an authenticated envelope: [MAGIC (5B)][VERSION (1B)][IV (12B)][TAG (16B)][CIPHERTEXT].
 */
export function encryptBackupBuffer(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be exactly ${KEY_LENGTH} bytes.`);
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.concat([
    BACKUP_MAGIC,
    Buffer.from([BACKUP_VERSION]),
    iv,
    tag,
  ]);

  return Buffer.concat([header, ciphertext]);
}

/**
 * Decrypts an authenticated backup envelope buffer with AES-256-GCM.
 * Authenticates the header, IV, tag, and ciphertext before returning decrypted plaintext.
 */
export function decryptBackupBuffer(encrypted: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Decryption key must be exactly ${KEY_LENGTH} bytes.`);
  }

  if (encrypted.length < HEADER_LENGTH) {
    throw new Error(
      `Invalid backup envelope: payload is smaller than header size (${encrypted.length} < ${HEADER_LENGTH}).`
    );
  }

  const magic = encrypted.subarray(0, BACKUP_MAGIC.length);
  if (!magic.equals(BACKUP_MAGIC)) {
    throw new Error('Invalid backup envelope: invalid magic header.');
  }

  const version = encrypted[BACKUP_MAGIC.length];
  if (version !== BACKUP_VERSION) {
    throw new Error(`Invalid backup envelope: unsupported version ${version}.`);
  }

  const ivStart = BACKUP_MAGIC.length + 1;
  const iv = encrypted.subarray(ivStart, ivStart + IV_LENGTH);

  const tagStart = ivStart + IV_LENGTH;
  const tag = encrypted.subarray(tagStart, tagStart + TAG_LENGTH);

  const ciphertext = encrypted.subarray(HEADER_LENGTH);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err: any) {
    throw new Error(
      `Backup authentication failed: invalid tag, corrupted ciphertext, or incorrect key (${err?.message || 'decryption failed'}).`
    );
  }
}

/**
 * Encrypts a plaintext file and writes the encrypted envelope to disk.
 */
export async function encryptBackupFile(
  inputPlaintextPath: string,
  outputEncryptedPath: string,
  key: Buffer
): Promise<{ bytesWritten: number; iv: Buffer; tag: Buffer }> {
  const plaintext = await fs.promises.readFile(inputPlaintextPath);
  const encrypted = encryptBackupBuffer(plaintext, key);
  
  const outputDir = path.dirname(outputEncryptedPath);
  if (!fs.existsSync(outputDir)) {
    await fs.promises.mkdir(outputDir, { recursive: true });
  }

  await fs.promises.writeFile(outputEncryptedPath, encrypted);

  const iv = encrypted.subarray(BACKUP_MAGIC.length + 1, BACKUP_MAGIC.length + 1 + IV_LENGTH);
  const tag = encrypted.subarray(BACKUP_MAGIC.length + 1 + IV_LENGTH, HEADER_LENGTH);

  return {
    bytesWritten: encrypted.length,
    iv,
    tag,
  };
}

/**
 * Decrypts an encrypted backup file from disk and writes the verified plaintext file.
 */
export async function decryptBackupFile(
  inputEncryptedPath: string,
  outputPlaintextPath: string,
  key: Buffer
): Promise<{ bytesWritten: number }> {
  const encrypted = await fs.promises.readFile(inputEncryptedPath);
  const plaintext = decryptBackupBuffer(encrypted, key);

  const outputDir = path.dirname(outputPlaintextPath);
  if (!fs.existsSync(outputDir)) {
    await fs.promises.mkdir(outputDir, { recursive: true });
  }

  await fs.promises.writeFile(outputPlaintextPath, plaintext);
  return { bytesWritten: plaintext.length };
}
