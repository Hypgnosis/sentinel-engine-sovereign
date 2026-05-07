/**
 * SENTINEL ENGINE V5.5 — Security Utilities (Lightweight Crypto)
 * ═══════════════════════════════════════════════════════════════
 * Minimal AES-256-GCM decryption for the Sovereign Proxy hot path.
 *
 * This module exists to enforce the Principle of Least Privilege:
 *   - The Sovereign Proxy needs ONLY DSN decryption authority.
 *   - It does NOT need the full SecurityManager (Dilithium WASM,
 *     key rotation, signing, entropy gates, etc.).
 *
 * By isolating AES-GCM here, we:
 *   1. Avoid importing the heavy SecurityManager into the hot path.
 *   2. Prevent the Proxy from gaining signing/rotation authority.
 *   3. Keep cold-start overhead minimal (~2ms vs ~200ms for WASM).
 *
 * Required ENV:
 *   SENTINEL_DSN_MASTER_KEY — 32-byte hex-encoded AES-256 key.
 *   This MUST match the key used by SecurityManager.encryptField()
 *   to encrypt shard_dsn values in the shard_map table.
 *
 * @module security-utils
 * @version 5.5.0-Sovereign
 * ═══════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;      // 96-bit IV (NIST recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag

/**
 * Cached master key buffer. Loaded once from env on first call.
 * @type {Buffer|null}
 */
let _masterKey = null;

/**
 * Load and validate the DSN Master Key from environment.
 * Fails fast with a clear error if missing or malformed.
 *
 * @returns {Buffer} 32-byte AES-256 key
 * @throws {Error} CRYPTO_FAULT if key is missing or invalid
 */
function _getMasterKey() {
  if (_masterKey) return _masterKey;

  const keyHex = process.env.SENTINEL_DSN_MASTER_KEY
    || process.env.SENTINEL_ENCRYPTION_KEY;

  if (!keyHex) {
    throw new Error(
      'CRYPTO_FAULT: SENTINEL_DSN_MASTER_KEY is missing from environment. ' +
      'The Sovereign Proxy cannot decrypt shard DSNs without this key. ' +
      'Provision it via: gcloud secrets versions access latest --secret=SENTINEL_DSN_MASTER_KEY'
    );
  }

  const keyBuffer = Buffer.from(keyHex, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error(
      `CRYPTO_FAULT: SENTINEL_DSN_MASTER_KEY must be exactly 32 bytes (256 bits). ` +
      `Got ${keyBuffer.length} bytes. Regenerate with: openssl rand -hex 32`
    );
  }

  _masterKey = keyBuffer;
  return _masterKey;
}

/**
 * Decrypt an AES-256-GCM ciphertext string.
 *
 * Expected format (produced by SecurityManager.encryptField):
 *   iv_hex:authTag_hex:ciphertext_hex
 *
 * This is a synchronous, CPU-only operation — no KMS round-trip.
 * Typical latency: <0.1ms (measured on Cloud Functions 2nd gen).
 *
 * @param {string} encryptedString - "iv:tag:ciphertext" hex format
 * @returns {string} Decrypted plaintext
 * @throws {Error} If decryption fails (bad key, tampered data, format error)
 */
function decryptWithMasterKey(encryptedString) {
  if (!encryptedString || typeof encryptedString !== 'string') {
    throw new Error('DECRYPT_FAILED: Input must be a non-empty string.');
  }

  const parts = encryptedString.split(':');
  if (parts.length !== 3) {
    throw new Error(
      'DECRYPT_FAILED: Ciphertext format invalid. Expected "iv:authTag:ciphertext". ' +
      'Was this value encrypted with SecurityManager.encryptField()?'
    );
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;

  try {
    const key = _getMasterKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');

    if (iv.length !== IV_LENGTH) {
      throw new Error(`IV must be ${IV_LENGTH} bytes, got ${iv.length}`);
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(`Auth tag must be ${AUTH_TAG_LENGTH} bytes, got ${authTag.length}`);
    }

    const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    // Wrap crypto errors with actionable context
    if (err.message.startsWith('DECRYPT_FAILED') || err.message.startsWith('CRYPTO_FAULT')) {
      throw err;
    }
    throw new Error(
      `DECRYPT_FAILED: AES-256-GCM decryption failed. ${err.message}. ` +
      'Possible causes: wrong master key, corrupted ciphertext, or key rotation in progress.'
    );
  }
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Used by provisioning scripts to populate shard_map.shard_dsn.
 *
 * @param {string} plaintext - Value to encrypt (e.g., a DATABASE_URL)
 * @returns {string} "iv:authTag:ciphertext" hex format
 */
function encryptWithMasterKey(plaintext) {
  const key = _getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

module.exports = {
  decryptWithMasterKey,
  encryptWithMasterKey,
};
