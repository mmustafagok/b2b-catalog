import crypto from 'crypto';

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

function getEncryptionKey(secretOverride?: string): Buffer {
  const secret = secretOverride || process.env.ENCRYPTION_SECRET;
  if (!secret || secret.length < 16) {
    throw new CryptoError('ENCRYPTION_SECRET must be at least 16 characters long');
  }
  // Deterministically hash to 32 bytes for AES-256
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts an access token using authenticated AES-256-GCM.
 * Output format: enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 */
export function encryptToken(plainText: string, secretOverride?: string): string {
  if (!plainText) {
    return '';
  }

  // If already encrypted, do not re-encrypt
  if (plainText.startsWith('enc:v1:')) {
    return plainText;
  }

  const key = getEncryptionKey(secretOverride);
  const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `enc:v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a token encrypted with encryptToken().
 */
export function decryptToken(envelope: string, secretOverride?: string): string {
  if (!envelope) {
    return '';
  }

  // Handle unencrypted legacy tokens if any in dev/test
  if (!envelope.startsWith('enc:v1:')) {
    return envelope;
  }

  const parts = envelope.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new CryptoError('Invalid encryption envelope format');
  }

  const [, , ivHex, tagHex, cipherHex] = parts;
  const key = getEncryptionKey(secretOverride);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(cipherHex, 'hex');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err: any) {
    throw new CryptoError('Failed to decrypt token: authentication tag verification failed or wrong key');
  }
}
