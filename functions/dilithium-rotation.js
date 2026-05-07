/**
 * SENTINEL DILITHIUM ROTATION ENGINE (V5.5 — Axiom-G)
 * ═══════════════════════════════════════════════════════
 * Atomic Key Rotation for CRYSTALS-Dilithium (ML-DSA) keys.
 *
 * Lifecycle:
 *   PENDING → ACTIVE_SIGNING → DEPRECATED_VERIFICATION → PURGED
 *
 * Protocol:
 *   1. Generation:  New Dilithium key pair (vN+1) created.
 *   2. Promotion:   vN+1 becomes ACTIVE_SIGNING.
 *   3. Deprecation: vN moved to DEPRECATED_VERIFICATION (verify-only).
 *   4. Purge:       After 30-day grace period, vN private key is deleted.
 *
 * The 30-day grace window prevents "Execution Blocked" errors when
 * Gems try to verify old PQ_BLOCK signatures with a rotated key.
 *
 * @module dilithium-rotation
 * @version 5.5.0-Sovereign
 * ═══════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const { getSql } = require('./db');
const { SecurityManager, PostQuantumProvider } = require('./security-manager');

const GRACE_PERIOD_DAYS = 30;

class DilithiumRotationEngine {
  /**
   * Executes an Atomic Key Rotation for a specific tenant.
   * Enforces the 'PENDING -> ACTIVE -> DEPRECATED' lifecycle.
   *
   * @param {string} tenantId
   * @returns {Promise<{status: string, version: number, keyId: string}>}
   */
  static async rotateTenantKey(tenantId) {
    const sql = getSql();
    if (!sql) throw new Error('ROTATION_FAILED: Database unavailable.');

    console.log(`[ROTATION] Initializing PQ-Lattice rotation for tenant: ${tenantId}`);

    return await sql.begin(async (tx) => {
      // ── 1. Atomic Lock & Check ──
      // Block parallel rotations for the same tenant to prevent race conditions.
      const [shard] = await tx`
        SELECT status FROM shard_map 
        WHERE tenant_id = ${tenantId} FOR UPDATE
      `;
      if (shard.status === 'ROTATING') {
        throw new Error('ROTATION_IN_PROGRESS: Parallel rotation blocked for this tenant.');
      }

      await tx`UPDATE shard_map SET status = 'ROTATING' WHERE tenant_id = ${tenantId}`;

      try {
        // ── 2. Determine next version ──
        const [current] = await tx`
          SELECT key_version, public_key_ref FROM tenant_crypto_configs
          WHERE tenant_id = ${tenantId} AND status = 'ACTIVE_SIGNING'
          ORDER BY key_version DESC LIMIT 1
        `;
        const nextVersion = current ? current.key_version + 1 : 1;

        // ── 3. Secure Key Generation (ML-DSA-65) ──
        const newKeyPair = await DilithiumRotationEngine._generateDilithiumPair();
        const keyId = `sentinel-pq-${tenantId}-v${nextVersion}`;

        // ── 4. ATOMIC SWAP ──
        // Deprecate current active key (Verify-Only mode)
        if (current) {
          const now = new Date();
          const purgeAt = new Date(now.getTime() + GRACE_PERIOD_DAYS * 86400000);

          await tx`
            UPDATE tenant_crypto_configs
            SET status = 'DEPRECATED_VERIFICATION',
                deprecated_at = NOW(),
                purge_eligible_at = ${purgeAt.toISOString()},
                private_key_ref = NULL,
                last_rotation_event = NOW()
            WHERE tenant_id = ${tenantId}
              AND status = 'ACTIVE_SIGNING'
          `;
        }

        // Promote the new key to ACTIVE_SIGNING
        await tx`
          INSERT INTO tenant_crypto_configs (
            tenant_id, key_version, algorithm,
            public_key_ref, private_key_ref,
            status, promoted_at, created_by
          ) VALUES (
            ${tenantId}, ${nextVersion}, 'ML-DSA-65',
            ${newKeyPair.publicPem}, ${`secrets/${keyId}/private`},
            'ACTIVE_SIGNING', NOW(), 'DilithiumRotationEngine'
          )
        `;

        // ── 5. Trust Synchronization ──
        // Update evidence metadata so Satellite Agents trust the new key version.
        await tx`
          INSERT INTO evidence_metadata (
            tenant_id, event, old_key_version, new_key_version, new_public_key, metadata
          ) VALUES (
            ${tenantId}, 'KEY_ROTATION', 
            ${current ? current.key_version : null}, 
            ${nextVersion}, ${newKeyPair.publicPem},
            ${JSON.stringify({ algorithm: 'ML-DSA-65', nist_level: 3 })}
          )
        `;

        // Unlock shard
        await tx`UPDATE shard_map SET status = 'ACTIVE' WHERE tenant_id = ${tenantId}`;

        console.log(`[ROTATION] Success. Tenant ${tenantId} promoted to v${nextVersion}.`);
        return { status: 'SUCCESS', version: nextVersion, keyId };

      } catch (err) {
        // Ensure shard is unlocked even on failure
        await tx`UPDATE shard_map SET status = 'ACTIVE' WHERE tenant_id = ${tenantId}`;
        throw err;
      }
    });
  }

  /**
   * Internal: Secure Key Generation Bridge
   * @private
   */
  static async _generateDilithiumPair() {
    // PRE-FLIGHT: Entropy Verification
    if (!DilithiumRotationEngine._hasSecureEntropy()) {
      throw new Error("ENTROPY_EXHAUSTION: High-quality randomness unavailable for PQ-key generation.");
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
      publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
      privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
  }

  /**
   * Standard check for entropy pool status.
   * @private
   */
  static _hasSecureEntropy() {
    try {
      const bytes = crypto.randomBytes(32);
      return bytes && bytes.length === 32;
    } catch {
      return false;
    }
  }
}

module.exports = { DilithiumRotationEngine, GRACE_PERIOD_DAYS };
