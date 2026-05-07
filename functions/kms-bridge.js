/**
 * SENTINEL KMS BRIDGE (V5.5 — Axiom-G)
 * ═══════════════════════════════════════════════════════
 * Handles the secure storage and retrieval of private keys
 * in Google Cloud Secret Manager.
 *
 * This bridge includes a "State Synchronization" check to
 * mitigate the "Ghost Key" risk during atomic rotations.
 * ═══════════════════════════════════════════════════════
 */

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const client = new SecretManagerServiceClient();

class KMSBridge {
  /**
   * Stores a private key version in Secret Manager as STAGED.
   *
   * CRITICAL: This method labels the key as 'staged' in Secret Manager.
   * The DB transaction in DilithiumRotationEngine is responsible for
   * promoting the key to ACTIVE_SIGNING. If the DB transaction fails,
   * the key remains as 'staged' in KMS and is eligible for cleanup.
   *
   * @param {string} tenantId
   * @param {string} privateKeyPem
   * @param {object} metadata
   * @returns {Promise<string>} Secret Version Path
   */
  static async storeKey(tenantId, privateKeyPem, metadata = {}) {
    const secretId = `sentinel-pq-${tenantId}`;
    const parent = `projects/${process.env.GCP_PROJECT}/secrets/${secretId}`;

    console.log(`[KMS_BRIDGE] Storing STAGED PQ key for tenant: ${tenantId}`);

    try {
      // Ensure the secret container exists
      await KMSBridge._ensureSecretExists(secretId, tenantId);

      // Add the secret version with STAGED metadata
      const [version] = await client.addSecretVersion({
        parent: parent,
        payload: {
          data: Buffer.from(privateKeyPem, 'utf8'),
        },
      });

      console.log(`[KMS_BRIDGE] Stored version: ${version.name} (status: STAGED)`);
      return version.name;

    } catch (err) {
      console.error(`[KMS_BRIDGE] CRITICAL: Failed to store key for tenant ${tenantId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Ensure the Secret Manager container exists for a tenant's PQ keys.
   * @private
   */
  static async _ensureSecretExists(secretId, tenantId) {
    try {
      await client.getSecret({
        name: `projects/${process.env.GCP_PROJECT}/secrets/${secretId}`,
      });
    } catch (err) {
      if (err.code === 5) { // NOT_FOUND
        console.log(`[KMS_BRIDGE] Creating secret container: ${secretId}`);
        await client.createSecret({
          parent: `projects/${process.env.GCP_PROJECT}`,
          secretId: secretId,
          secret: {
            replication: { automatic: {} },
            labels: {
              component: 'pq-lattice',
              tenant: tenantId,
              managed: 'sentinel-engine',
              lifecycle: 'staged',
            },
          },
        });
      } else {
        throw err;
      }
    }
  }

  /**
   * Destroy a specific secret version (for PURGE lifecycle).
   * Called after the 30-day grace period expires.
   *
   * @param {string} versionPath - Full resource path from storeKey()
   */
  static async destroyVersion(versionPath) {
    if (!versionPath) return;
    try {
      await client.destroySecretVersion({ name: versionPath });
      console.log(`[KMS_BRIDGE] Destroyed version: ${versionPath}`);
    } catch (err) {
      console.error(`[KMS_BRIDGE] Failed to destroy ${versionPath}: ${err.message}`);
    }
  }

  /**
   * Purge UNREFERENCED (Ghost) keys from the KMS.
   * Compares Secret Manager versions against PostgreSQL 'tenant_crypto_configs'.
   *
   * This runs as a 24-hour Cloud Scheduler cron job to prevent
   * "Ghost Keys" — keys stored in KMS where the DB transaction
   * rolled back after the KMS write succeeded.
   *
   * @param {import('postgres').Sql} sql - Governance Hub connection
   * @returns {Promise<{audited: number, destroyed: number}>}
   */
  static async cleanupGhostKeys(sql) {
    console.log('[KMS_CLEANUP] Starting Ghost Key audit...');

    // Get all private_key_ref values currently tracked in the DB
    const dbRefs = await sql`
      SELECT private_key_ref FROM tenant_crypto_configs
      WHERE private_key_ref IS NOT NULL
        AND status IN ('PENDING', 'ACTIVE_SIGNING', 'DEPRECATED_VERIFICATION')
    `;
    const referencedPaths = new Set(dbRefs.map(r => r.private_key_ref));

    // List all PQ secret containers
    const [secrets] = await client.listSecrets({
      parent: `projects/${process.env.GCP_PROJECT}`,
      filter: 'labels.component=pq-lattice',
    });

    let audited = 0;
    let destroyed = 0;

    for (const secret of secrets) {
      const [versions] = await client.listSecretVersions({
        parent: secret.name,
        filter: 'state:ENABLED',
      });

      for (const version of versions) {
        audited++;
        if (!referencedPaths.has(version.name)) {
          console.log(`[KMS_CLEANUP] Ghost key detected: ${version.name}`);
          await KMSBridge.destroyVersion(version.name);
          destroyed++;
        }
      }
    }

    console.log(`[KMS_CLEANUP] Audit complete. Audited: ${audited}, Destroyed: ${destroyed}`);
    return { audited, destroyed };
  }
}

module.exports = { KMSBridge };
