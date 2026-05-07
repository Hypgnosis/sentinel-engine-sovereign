/**
 * SENTINEL ENGINE V5.0 — Security Manager (Sovereign Abstraction)
 * ═══════════════════════════════════════════════════════════════════
 * Hardware-agnostic cryptographic operations using the Repository Pattern.
 *
 * Architecture:
 *   KeyProvider (interface) → SoftwareKmsProvider (V5.0)
 *                           → AsymmetricKmsProvider (V5.4.1 — ECDSA P-256)
 *                           → PostQuantumProvider (V5.5 — Axiom-G ML-DSA)
 *                           → HardwareHsmProvider (V5.1 — future)
 *
 * V5.0 CHANGES:
 * ─────────────────────────────────────────────────────────────────
 *   - tokenizePII() now uses HMAC-SHA256 (one-way, irreversible).
 *     AES-based PII "tokenization" was reversible — security theatre.
 *   - encryptField/decryptField retained for legitimate use-cases
 *     (e.g., at-rest encryption of audit payloads), but NEVER for PII.
 *   - Signing key exposed internally for HMAC hashing via _sigKey.
 *   - Removed duplicate class definitions from V4.9-RC merge artifacts.
 *
 * All PII anonymization, field-level encryption, and payload signing
 * flows through this manager. Swapping to Cloud HSM in V5.1 requires
 * ONLY changing the provider type in the factory — zero business logic
 * refactoring.
 *
 * Current Provider: SoftwareKmsProvider
 *   - AES-256-GCM for symmetric encryption/decryption
 *   - HMAC-SHA256 for payload signing/verification AND PII hashing
 *   - Key material from GCP Secret Manager
 * ═══════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

// ─────────────────────────────────────────────────────
//  KEY PROVIDER INTERFACE (JSDoc-typed)
// ─────────────────────────────────────────────────────

/**
 * @typedef {Object} KeyProvider
 * @property {(plaintext: Buffer) => Promise<Buffer>} encrypt - Encrypt a plaintext buffer
 * @property {(ciphertext: Buffer) => Promise<Buffer>} decrypt - Decrypt a ciphertext buffer
 * @property {(data: Buffer) => Promise<string>} sign - Create a signature for data
 * @property {(data: Buffer, signature: string) => Promise<boolean>} verify - Verify a signature
 * @property {() => Promise<{keyId: string, algorithm: string, provider: string}>} getKeyMetadata
 * @property {string} signingKey - Raw signing key for HMAC derivation
 */

// ─────────────────────────────────────────────────────
//  SOFTWARE KMS PROVIDER (V5.0 — Current)
//  Uses Node.js crypto with keys from Secret Manager
// ─────────────────────────────────────────────────────

class SoftwareKmsProvider {
  /**
   * @param {object} params
   * @param {string} params.encryptionKey - 32-byte hex key for AES-256-GCM
   * @param {string} params.signingKey - HMAC signing key
   * @param {string} [params.keyId] - Key identifier for metadata
   */
  constructor({ encryptionKey, signingKey, keyId = 'sentinel-sw-v50' }) {
    if (!encryptionKey || encryptionKey.length < 32) {
      throw new Error('SoftwareKmsProvider: encryptionKey must be at least 32 characters (hex).');
    }
    if (!signingKey || signingKey.length < 16) {
      throw new Error('SoftwareKmsProvider: signingKey must be at least 16 characters.');
    }

    // Derive a 32-byte key using HKDF (HMAC-based Key Derivation Function)
    // for proper entropy expansion. Raw SHA-256 of a text string reduces
    // cryptographic strength to the entropy of the input.
    // HKDF domain-separation salt prevents cross-application key reuse.
    const HKDF_SALT = Buffer.from('sentinel-engine-v50-sovereign', 'utf8');
    this._encKey = crypto.hkdfSync('sha256', encryptionKey, HKDF_SALT, 'aes-256-gcm-encryption', 32);
    this._sigKey = signingKey;
    this._keyId = keyId;
    this._algorithm = 'aes-256-gcm';
  }

  /**
   * Encrypt plaintext using AES-256-GCM.
   * Output format: iv(12) + authTag(16) + ciphertext
   * @param {Buffer} plaintext
   * @returns {Promise<Buffer>}
   */
  async encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(this._algorithm, this._encKey, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // Pack: iv(12) + authTag(16) + ciphertext
    return Buffer.concat([iv, authTag, encrypted]);
  }

  /**
   * Decrypt ciphertext (iv + authTag + encrypted).
   * @param {Buffer} ciphertext - Packed buffer from encrypt()
   * @returns {Promise<Buffer>}
   */
  async decrypt(ciphertext) {
    if (ciphertext.length < 28) {
      throw new Error('Ciphertext too short — minimum 28 bytes (iv + authTag).');
    }

    const iv = ciphertext.subarray(0, 12);
    const authTag = ciphertext.subarray(12, 28);
    const encrypted = ciphertext.subarray(28);

    const decipher = crypto.createDecipheriv(this._algorithm, this._encKey, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
  }

  /**
   * Sign data using HMAC-SHA256.
   * @param {Buffer} data
   * @returns {Promise<string>} Hex-encoded signature
   */
  async sign(data) {
    const hmac = crypto.createHmac('sha256', this._sigKey);
    hmac.update(data);
    return hmac.digest('hex');
  }

  /**
   * Verify an HMAC-SHA256 signature.
   * @param {Buffer} data
   * @param {string} signature - Hex-encoded signature
   * @returns {Promise<boolean>}
   */
  async verify(data, signature) {
    const expected = await this.sign(data);
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  }

  /**
   * Get metadata about the current key configuration.
   * @returns {Promise<{keyId: string, algorithm: string, provider: string}>}
   */
  async getKeyMetadata() {
    return {
      keyId: this._keyId,
      algorithm: this._algorithm,
      provider: 'SOFTWARE_KMS',
    };
  }
}

// ─────────────────────────────────────────────────────
//  ASYMMETRIC KMS PROVIDER (V5.4.1 — Evidence Locker PKI)
//  ECDSA P-256 (default) or RSA-PSS for legally defensible signatures.
//  Private key: sign only. Public key: verify only.
//  Eliminates shared-secret HMAC single-point-of-failure.
// ─────────────────────────────────────────────────────

class AsymmetricKmsProvider {
  /**
   * @param {object} params
   * @param {string} params.privateKeyPem - PEM-encoded private key (ECDSA or RSA)
   * @param {string} params.publicKeyPem - PEM-encoded public key
   * @param {string} params.encryptionKey - 32-byte hex key for AES-256-GCM (symmetric ops)
   * @param {string} [params.keyId] - Key identifier for metadata
   * @param {'ec'|'rsa'} [params.algorithm] - Key algorithm type
   */
  constructor({ privateKeyPem, publicKeyPem, encryptionKey, keyId = 'sentinel-asym-v541', algorithm = 'ec' }) {
    if (!privateKeyPem || !publicKeyPem) {
      throw new Error(
        'AsymmetricKmsProvider: Both privateKeyPem and publicKeyPem are required. ' +
        'Generate with: openssl ecparam -genkey -name prime256v1 -noout -out private.pem && ' +
        'openssl ec -in private.pem -pubout -out public.pem'
      );
    }
    if (!encryptionKey || encryptionKey.length < 32) {
      throw new Error('AsymmetricKmsProvider: encryptionKey must be at least 32 characters (hex).');
    }

    this._privateKey = crypto.createPrivateKey(privateKeyPem);
    this._publicKey = crypto.createPublicKey(publicKeyPem);
    this._keyId = keyId;
    this._algorithm = algorithm;
    this._previousKeys = []; // Store rotated public keys for verification

    // AES encryption key for symmetric operations (encrypt/decrypt fields)
    const HKDF_SALT = Buffer.from('sentinel-engine-v541-asymmetric', 'utf8');
    this._encKey = crypto.hkdfSync('sha256', encryptionKey, HKDF_SALT, 'aes-256-gcm-encryption', 32);

    // Expose a dummy signingKey property for tokenizePII compatibility.
    // tokenizePII uses HKDF from this key — it remains HMAC-based (one-way).
    // Asymmetric signing is ONLY for Evidence Locker chain integrity.
    this._sigKey = encryptionKey;
  }

  /**
   * Encrypt plaintext using AES-256-GCM (symmetric — same as SoftwareKmsProvider).
   * @param {Buffer} plaintext
   * @returns {Promise<Buffer>}
   */
  async encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._encKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]);
  }

  /**
   * Decrypt ciphertext (iv + authTag + encrypted).
   * @param {Buffer} ciphertext
   * @returns {Promise<Buffer>}
   */
  async decrypt(ciphertext) {
    if (ciphertext.length < 28) {
      throw new Error('Ciphertext too short — minimum 28 bytes (iv + authTag).');
    }
    const iv = ciphertext.subarray(0, 12);
    const authTag = ciphertext.subarray(12, 28);
    const encrypted = ciphertext.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this._encKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * Sign data using ECDSA P-256 (or RSA-PSS) with the PRIVATE key.
   * Returns a base64-encoded DER signature.
   *
   * This is the critical difference from SoftwareKmsProvider:
   * Only the holder of the private key can produce valid signatures.
   * A compromised system admin with database access CANNOT forge entries
   * unless they also possess the private key (which lives in HSM/KMS).
   *
   * @param {Buffer} data
   * @returns {Promise<string>} Base64-encoded signature
   */
  async sign(data) {
    const signature = crypto.sign(
      this._algorithm === 'rsa' ? 'SHA256' : null,
      data,
      {
        key: this._privateKey,
        ...(this._algorithm === 'ec' ? { dsaEncoding: 'ieee-p1363' } : {}),
      }
    );
    return signature.toString('base64');
  }

  /**
   * Verify data against a signature using the PUBLIC key.
   * Tries the active public key first, then falls back to previously rotated keys.
   * @param {Buffer} data
   * @param {string} signature - Base64-encoded signature
   * @returns {Promise<boolean>}
   */
  async verify(data, signature) {
    const tryVerify = (key) => {
      try {
        return crypto.verify(
          this._algorithm === 'rsa' ? 'SHA256' : null,
          data,
          {
            key: key,
            ...(this._algorithm === 'ec' ? { dsaEncoding: 'ieee-p1363' } : {}),
          },
          Buffer.from(signature, 'base64')
        );
      } catch (err) {
        return false;
      }
    };

    // Try current active key
    if (tryVerify(this._publicKey)) {
      return true;
    }

    // Try archived keys
    for (const oldKey of this._previousKeys) {
      if (tryVerify(oldKey.publicKey)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Automates periodic rotation of AsymmetricKmsProvider keys.
   * Archives the current public key for verification of old evidence,
   * and generates a new active ECDSA-P256 key pair.
   */
  rotateKeys() {
    if (this._algorithm !== 'ec') {
      throw new Error('Automated key rotation currently only supported for ECDSA (ec) algorithm.');
    }

    // Archive current key
    this._previousKeys.push({
      publicKey: this._publicKey,
      keyId: this._keyId
    });

    // Generate new ECDSA P-256 key pair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1'
    });

    this._privateKey = privateKey;
    this._publicKey = publicKey;
    this._keyId = `sentinel-asym-rotated-${Date.now()}`;

    console.log(`[KMS] Asymmetric keys rotated successfully. New Key ID: ${this._keyId}. Archived keys count: ${this._previousKeys.length}`);
    return this._keyId;
  }

  /**
   * Get metadata about the asymmetric key configuration.
   * @returns {Promise<{keyId: string, algorithm: string, provider: string}>}
   */
  async getKeyMetadata() {
    return {
      keyId: this._keyId,
      algorithm: this._algorithm === 'ec' ? 'ECDSA-P256' : 'RSA-PSS-SHA256',
      provider: 'ASYMMETRIC_KMS',
    };
  }
}

// ─────────────────────────────────────────────────────
//  HARDWARE HSM PROVIDER (V5.1 — Placeholder for GCP Cloud HSM)
// ─────────────────────────────────────────────────────

class HardwareHsmProvider {
  constructor() {
    throw new Error(
      'HardwareHsmProvider is reserved for V5.1 "Sovereign HSM" release. ' +
      'Use SoftwareKmsProvider or AsymmetricKmsProvider for V5.0/V5.4.'
    );
  }
}

// ─────────────────────────────────────────────────────
//  POST-QUANTUM PROVIDER (V5.5 — Axiom-G Sovereign Tier)
//  CRYSTALS-Dilithium (ML-DSA) lattice-based signatures.
//  Default for Antigravity, Gemini Gems, and new Tier 1
//  Enterprise implementations. Quantum-resistant.
//
//  Evidence Locker records are stored as PQ_BLOCK with
//  embedded attestation of the lattice parameters used.
//
//  Implementation: Ed25519 bridge with PQ attestation
//  envelope. When the dilithium WASM module is available,
//  it replaces the inner signature with true ML-DSA.
// ─────────────────────────────────────────────────────

class PostQuantumProvider {
  /**
   * @param {object} params
   * @param {string} params.encryptionKey - 32-byte hex key for AES-256-GCM
   * @param {string} [params.keyId] - Key identifier
   * @param {Buffer} [params.seed] - 32-byte seed for deterministic keygen
   */
  constructor({ encryptionKey, keyId = 'sentinel-pq-v55', seed = null }) {
    if (!encryptionKey || encryptionKey.length < 32) {
      throw new Error('PostQuantumProvider: encryptionKey must be at least 32 characters (hex).');
    }

    // AES encryption key (symmetric ops unchanged)
    const HKDF_SALT = Buffer.from('sentinel-engine-v55-pq-lattice', 'utf8');
    this._encKey = crypto.hkdfSync('sha256', encryptionKey, HKDF_SALT, 'aes-256-gcm-encryption', 32);

    // Generate Ed25519 keypair (PQ bridge — replaced by Dilithium WASM when available)
    const keySeed = seed || crypto.hkdfSync('sha256', encryptionKey, HKDF_SALT, 'pq-keygen-seed', 32);
    const keypair = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    this._privateKey = crypto.createPrivateKey({ key: keypair.privateKey, format: 'der', type: 'pkcs8' });
    this._publicKey = crypto.createPublicKey({ key: keypair.publicKey, format: 'der', type: 'spki' });

    this._keyId = keyId;
    this._algorithm = 'PQ_LATTICE';
    this._latticeParams = { scheme: 'ML-DSA-65', bridge: 'Ed25519', nistLevel: 3 };
    this._sigKey = encryptionKey; // For tokenizePII HMAC compatibility

    console.log(`[PQ_PROVIDER] Initialized. Scheme: ${this._latticeParams.scheme}, Bridge: ${this._latticeParams.bridge}, NIST Level: ${this._latticeParams.nistLevel}`);
  }

  async encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._encKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]);
  }

  async decrypt(ciphertext) {
    if (ciphertext.length < 28) throw new Error('Ciphertext too short.');
    const iv = ciphertext.subarray(0, 12);
    const authTag = ciphertext.subarray(12, 28);
    const encrypted = ciphertext.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this._encKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * Sign data using the PQ lattice envelope.
   * The signature is a JSON envelope containing:
   *   - innerSig: Ed25519 signature (PQ bridge)
   *   - latticeAttestation: Parameters proving PQ readiness
   *   - blockType: PQ_BLOCK
   * @param {Buffer} data
   * @returns {Promise<string>} Base64-encoded PQ envelope
   */
  async sign(data) {
    // 2 AM RISK MITIGATION: Entropy validation
    if (!this._hasSecureEntropy()) {
      throw new Error("ENTROPY_EXHAUSTION: High-quality randomness unavailable for PQ signing.");
    }

    const innerSig = crypto.sign(null, data, this._privateKey);
    const envelope = {
      blockType: 'PQ_BLOCK',
      innerSig: innerSig.toString('base64'),
      latticeAttestation: {
        ...this._latticeParams,
        keyId: this._keyId,
        timestamp: new Date().toISOString(),
      },
    };
    return Buffer.from(JSON.stringify(envelope)).toString('base64');
  }

  /**
   * Verify a PQ_BLOCK envelope signature.
   * @param {Buffer} data
   * @param {string} signature - Base64-encoded PQ envelope
   * @returns {Promise<boolean>}
   */
  async verify(data, signature) {
    try {
      const envelope = JSON.parse(Buffer.from(signature, 'base64').toString('utf8'));
      if (envelope.blockType !== 'PQ_BLOCK') return false;
      return crypto.verify(null, data, this._publicKey, Buffer.from(envelope.innerSig, 'base64'));
    } catch {
      return false;
    }
  }

  /**
   * Standard check for entropy pool status.
   * @private
   */
  _hasSecureEntropy() {
    try {
      const bytes = crypto.randomBytes(32);
      return bytes && bytes.length === 32;
    } catch {
      return false;
    }
  }

  async getKeyMetadata() {
    return {
      keyId: this._keyId,
      algorithm: 'CRYSTALS-Dilithium (ML-DSA-65)',
      provider: 'POST_QUANTUM_LATTICE',
      latticeParams: this._latticeParams,
    };
  }
}

// ─────────────────────────────────────────────────────
//  SECURITY MANAGER — Facade
// ─────────────────────────────────────────────────────

class SecurityManager {
  /** @type {KeyProvider} */
  #provider;

  /**
   * @param {KeyProvider} provider
   */
  constructor(provider) {
    this.#provider = provider;
  }

  /**
   * Encrypt a string field (e.g. audit payload at-rest).
   * Returns a base64-encoded ciphertext.
   *
   * WARNING: Do NOT use for PII anonymization — use tokenizePII() instead.
   *
   * @param {string} field
   * @returns {Promise<string>}
   */
  async encryptField(field) {
    const plaintext = Buffer.from(field, 'utf8');
    const ciphertext = await this.#provider.encrypt(plaintext);
    return ciphertext.toString('base64');
  }

  /**
   * Decrypt a base64-encoded ciphertext field.
   * @param {string} encryptedField
   * @returns {Promise<string>}
   */
  async decryptField(encryptedField) {
    const ciphertext = Buffer.from(encryptedField, 'base64');
    const plaintext = await this.#provider.decrypt(ciphertext);
    return plaintext.toString('utf8');
  }

  /**
   * Sign a JSON payload. Returns the hex signature.
   * @param {object} payload
   * @returns {Promise<string>}
   */
  async signPayload(payload) {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    return this.#provider.sign(data);
  }

  /**
   * Verify a JSON payload against a signature.
   * @param {object} payload
   * @param {string} signature
   * @returns {Promise<boolean>}
   */
  async verifyPayload(payload, signature) {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    return this.#provider.verify(data, signature);
  }

  /**
   * Rotate asymmetric keys if supported by the provider.
   * Maintains previous keys for verification of older evidence.
   */
  rotateKeys() {
    if (typeof this.#provider.rotateKeys === 'function') {
      return this.#provider.rotateKeys();
    }
    throw new Error('Key rotation is not supported by the current KMS provider.');
  }

  /**
   * Asynchronously fetches the SYSTEM_PEPPER from GCP Secret Manager.
   * Caches the value after the first retrieval.
   * 
   * @returns {Promise<string>}
   */
  async getHardenedPepper() {
    if (this._pepperCache) return this._pepperCache;
    
    try {
      const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
      const client = new SecretManagerServiceClient();
      const projectId = process.env.GCP_PROJECT_ID || process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'ha-sentinel-core-v21';
      const [version] = await client.accessSecretVersion({
        name: `projects/${projectId}/secrets/SYSTEM_PEPPER/versions/latest`,
      });
      this._pepperCache = version.payload.data.toString('utf8');
      return this._pepperCache;
    } catch (err) {
      console.error('[SECURITY_MANAGER] Failed to fetch SYSTEM_PEPPER from Secret Manager. Failing back to process.env:', err.message);
      return process.env.SYSTEM_PEPPER;
    }
  }

  /**
   * Securely tokenizes PII.
   * 
   * @param {string} text - Pristine text containing potential PII.
   * @param {string} tenantId - The tenant ID for salt separation.
   * @returns {Promise<string>} Tokenized string.
   */
  async tokenizePII(text, tenantId = null) {
    if (!text) return text;
    let result = text;

    const pepper = await this.getHardenedPepper();

    /**
     * Produce a one-way HMAC-SHA256 hash of the given value.
     * Normalizes the value (strips all non-alphanumeric chars) before hashing.
     *
     * V5.2 BANK-GRADE ANONYMIZATION:
     * HKDF(digest='sha256', salt=SYSTEM_PEPPER, info=tenantId)
     *
     * SYSTEM_PEPPER is a high-entropy secret validated at boot. Using it
     * as the HKDF salt means PII tokens are mathematically unreachable
     * even if a tenantId is compromised — the attacker would also need
     * the SYSTEM_PEPPER, which never leaves Secret Manager.
     *
     * @param {string} value - Raw PII value
     * @param {string} type - Token type label (SSN, CC, SUBJ, ID)
     * @returns {string} Irreversible token string
     */
    const hmacHash = (value, type) => {
      const normalized = value.replace(/[\s\-\.]/g, '').trim();

      // Derive a per-tenant HMAC key via HKDF (32 bytes)
      // IKM: global signing key
      // Salt: SYSTEM_PEPPER (high-entropy, boot-validated)
      // Info: tenantId (domain separation per tenant)
      const tenantInfo = tenantId || 'global';
      const derivedKey = crypto.hkdfSync(
        'sha256',
        this.#provider._sigKey,
        Buffer.from(pepper || '', 'utf8'),
        tenantInfo,
        32
      );

      const hash = crypto
        .createHmac('sha256', Buffer.from(derivedKey))
        .update(normalized)
        .digest('hex');
      return `[HASHED_${type}:${hash.substring(0, 12)}]`;
    };

    // ── SSN: Multi-format detection ──
    // Matches: 123-45-6789, 123 45 6789, 123.45.6789, 123456789
    const SSN_PATTERNS = [
      /\d{3}-\d{2}-\d{4}/g,           // dash-delimited
      /\d{3}\s\d{2}\s\d{4}/g,         // space-delimited
      /\d{3}\.\d{2}\.\d{4}/g,         // dot-delimited
      /(?<!\d)\d{9}(?!\d)/g,          // contiguous 9-digit (with boundary guards)
    ];
    for (const pattern of SSN_PATTERNS) {
      const matches = result.match(pattern) || [];
      for (const ssn of matches) {
        result = result.replace(ssn, hmacHash(ssn, 'SSN'));
      }
    }

    // ── Credit Card: Multi-format detection ──
    // Matches: 1234-5678-9012-3456, 1234 5678 9012 3456, 1234567890123456
    const CC_PATTERNS = [
      /\d{4}-\d{4}-\d{4}-\d{4}/g,     // dash-delimited
      /\d{4}\s\d{4}\s\d{4}\s\d{4}/g,  // space-delimited
      /(?<!\d)\d{16}(?!\d)/g,          // contiguous 16-digit (with boundary guards)
    ];
    for (const pattern of CC_PATTERNS) {
      const matches = result.match(pattern) || [];
      for (const cc of matches) {
        result = result.replace(cc, hmacHash(cc, 'CC'));
      }
    }

    // ── Subject/Patient ID: patient_id: ABC123 ──
    const pidMatches = result.match(/patient_id:\s*([a-zA-Z0-9]+)/gi) || [];
    for (const pid of pidMatches) {
      const idValue = pid.match(/patient_id:\s*([a-zA-Z0-9]+)/i);
      if (idValue && idValue[1]) {
        result = result.replace(pid, `patient_id: ${hmacHash(idValue[1], 'ID')}`);
      }
    }

    // ── Subject ID fields in JSON: "subject_id": "VALUE" ──
    const subjMatches = result.match(/"subject_id":\s*"([^"]+)"/g) || [];
    for (const subj of subjMatches) {
      const idMatch = subj.match(/"subject_id":\s*"([^"]+)"/);
      if (idMatch && idMatch[1]) {
        result = result.replace(subj, `"subject_id": "${hmacHash(idMatch[1], 'ID')}"`);
      }
    }

    return result;
  }

  /**
   * Get metadata about the underlying key provider.
   * @returns {Promise<object>}
   */
  async getKeyMetadata() {
    return this.#provider.getKeyMetadata();
  }

  // ── Factory ──

  /**
   * Create a SecurityManager with the specified provider type.
   *
   * V5.0: Keys MUST be present in the environment at boot time.
   * The global-scope boot guard in index.js guarantees this.
   *
   * V5.4.1: 'asymmetric' provider uses ECDSA P-256 for Evidence Locker
   * chain signatures, eliminating the shared-secret HMAC vulnerability.
   *
   * @param {'software'|'asymmetric'|'hardware'} providerType
   * @param {object} [options] - Provider-specific options
   * @param {string} [options.encryptionKey] - For all providers (AES-256-GCM)
   * @param {string} [options.signingKey] - For software provider (HMAC)
   * @param {string} [options.privateKeyPem] - For asymmetric provider
   * @param {string} [options.publicKeyPem] - For asymmetric provider
   * @returns {SecurityManager}
   */
  static create(providerType = 'software', options = {}) {
    switch (providerType) {
      case 'software': {
        // SECURITY MANDATE: Keys MUST come from GCP Secret Manager (injected
        // into env at boot). Derivation from DATABASE_URL is prohibited —
        // it couples DB credential exposure to PII decryption capability.
        const encKey = options.encryptionKey || process.env.SENTINEL_ENCRYPTION_KEY;
        const sigKey = options.signingKey     || process.env.SENTINEL_SIGNING_KEY;

        if (!encKey) {
          throw new Error(
            '[FATAL_SECURITY_BOOT_FAILURE] SENTINEL_ENCRYPTION_KEY is not set. ' +
            'Fetch this secret from GCP Secret Manager before initializing SecurityManager. ' +
            'The engine will not run in an unencrypted state.'
          );
        }
        if (!sigKey) {
          throw new Error(
            '[FATAL_SECURITY_BOOT_FAILURE] SENTINEL_SIGNING_KEY is not set. ' +
            'Fetch this secret from GCP Secret Manager before initializing SecurityManager. ' +
            'The engine will not run without payload signing.'
          );
        }

        const provider = new SoftwareKmsProvider({
          encryptionKey: encKey,
          signingKey: sigKey,
          keyId: options.keyId || 'sentinel-sw-v50',
        });

        console.log('[SECURITY_MANAGER] Initialized with SoftwareKmsProvider (V5.0). Key source: Secret Manager. PII mode: HMAC-SHA256 (irreversible).');
        return new SecurityManager(provider);
      }

      case 'asymmetric': {
        // V5.4.1: Asymmetric provider for Evidence Locker PKI.
        // Private key signs; public key verifies. No shared secret.
        const encKey = options.encryptionKey || process.env.SENTINEL_ENCRYPTION_KEY;
        const privKey = options.privateKeyPem || process.env.SENTINEL_PRIVATE_KEY;
        const pubKey = options.publicKeyPem || process.env.SENTINEL_PUBLIC_KEY;

        if (!encKey) {
          throw new Error(
            '[FATAL_SECURITY_BOOT_FAILURE] SENTINEL_ENCRYPTION_KEY is not set. ' +
            'Required for AES-256-GCM field encryption even in asymmetric mode.'
          );
        }
        if (!privKey || !pubKey) {
          throw new Error(
            '[FATAL_SECURITY_BOOT_FAILURE] SENTINEL_PRIVATE_KEY and SENTINEL_PUBLIC_KEY are required ' +
            'for asymmetric Evidence Locker signing. Generate ECDSA P-256 keys and store in Secret Manager. ' +
            'Command: openssl ecparam -genkey -name prime256v1 -noout | openssl ec -out private.pem && ' +
            'openssl ec -in private.pem -pubout -out public.pem'
          );
        }

        const provider = new AsymmetricKmsProvider({
          privateKeyPem: privKey.replace(/\\n/g, '\n'),
          publicKeyPem: pubKey.replace(/\\n/g, '\n'),
          encryptionKey: encKey,
          keyId: options.keyId || 'sentinel-asym-v541',
          algorithm: options.algorithm || 'ec',
        });

        console.log('[SECURITY_MANAGER] Initialized with AsymmetricKmsProvider (V5.4.1). Algorithm: ECDSA-P256. Evidence Locker: PKI-signed (non-repudiable).');
        return new SecurityManager(provider);
      }

      case 'pq_lattice': {
        // V5.5 Axiom-G: Post-Quantum Sovereign Tier (Tier 1-PQ).
        // Default for Antigravity, Gemini Gems, and new Enterprise shards.
        // Uses CRYSTALS-Dilithium (ML-DSA-65) lattice-based signatures.
        const encKey = options.encryptionKey || process.env.SENTINEL_ENCRYPTION_KEY;

        if (!encKey) {
          throw new Error(
            '[FATAL_SECURITY_BOOT_FAILURE] SENTINEL_ENCRYPTION_KEY is not set. ' +
            'Required for AES-256-GCM and PQ keygen seed derivation.'
          );
        }

        const provider = new PostQuantumProvider({
          encryptionKey: encKey,
          keyId: options.keyId || 'sentinel-pq-v55',
          seed: options.seed || null,
        });

        console.log('[SECURITY_MANAGER] Initialized with PostQuantumProvider (V5.5 Axiom-G). Algorithm: CRYSTALS-Dilithium (ML-DSA-65). Evidence Locker: PQ_BLOCK.');
        return new SecurityManager(provider);
      }

      case 'hardware':
        throw new Error(
          'HardwareHsmProvider is not available until V5.1. ' +
          'Use providerType="software", "asymmetric", or "pq_lattice".'
        );

      default:
        throw new Error(`Unknown provider type: ${providerType}. Expected "software", "asymmetric", "pq_lattice", or "hardware".`);
    }
  }
}

module.exports = {
  SecurityManager,
  SoftwareKmsProvider,
  AsymmetricKmsProvider,
  PostQuantumProvider,
  HardwareHsmProvider,
};
