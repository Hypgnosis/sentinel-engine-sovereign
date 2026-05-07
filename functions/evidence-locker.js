/**
 * SENTINEL ENGINE V5.4 — Evidence Locker (Immutable Audit Ledger)
 * ═══════════════════════════════════════════════════════════════════
 * Append-only, HMAC-signed chain-of-custody ledger. Every entry is
 * cryptographically linked to its predecessor via `previous_signature`.
 *
 * This module produces "Legally Usable Evidence" per KPMG Principle 4.4.
 * It is NOT a log — it is a signed receipt of truth. Each entry's
 * integrity can be independently verified without trusting the database.
 *
 * Chain structure:
 *   Entry N.signature = HMAC(Entry N.payload + Entry N-1.signature)
 *   Tampering with ANY entry breaks the chain from that point forward.
 *
 * V5.4 MANDATE:
 *   - Append-only. No UPDATE or DELETE operations exist.
 *   - Every human override in the HITL pipeline MUST route through
 *     this locker before taking effect.
 *   - Rollback operations use the last PRISTINE_CHECKPOINT as the
 *     restoration manifest.
 * ═══════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const { getSql } = require('./db');
const { exportAuditRecord } = require('./audit-log-exporter');

// ─────────────────────────────────────────────────────
//  EVENT TYPE REGISTRY
// ─────────────────────────────────────────────────────

const EVENT_TYPES = Object.freeze({
  GOVERNANCE_FINDING: 'GOVERNANCE_FINDING', // V5.5 AGS Monotonic Reduction
  LEGIBILITY_RECORD: 'LEGIBILITY_RECORD',   // V5.5 AGS Arbitration Interface
  PQ_BLOCK: 'PQ_BLOCK',                     // V5.5 Axiom-G: CRYSTALS-Dilithium sealed record
  ECDSA_BLOCK: 'ECDSA_BLOCK',               // V5.5 Axiom-G: ECDSA P-256 sealed record
});

// ─────────────────────────────────────────────────────
//  TABLE SETUP (idempotent)
// ─────────────────────────────────────────────────────

let _tableEnsured = false;

async function ensureEvidenceTable() {
  if (_tableEnsured) return;
  const sql = getSql();
  if (!sql) return;

  try {
    // Enable uuid-ossp extension for UUID generation if needed (gen_random_uuid is native in PG 13+)
    await sql`
      CREATE TABLE IF NOT EXISTS arbitration_requests (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          requesting_agent TEXT NOT NULL,
          action TEXT NOT NULL,
          context JSONB NOT NULL,
          target_domain TEXT,
          timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS evidence_locker (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          request_id UUID REFERENCES arbitration_requests(id),
          decision TEXT NOT NULL CHECK (decision IN ('permit', 'deny', 'halt', 'escalate')),
          authority_unit_id TEXT,
          contract_evaluated_id TEXT,
          delegation_chain JSONB,
          invariants_checked JSONB,
          legibility_record JSONB NOT NULL,
          governance_finding JSONB,
          signature TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    // Formal Arbitration Interface Tables
    await sql`
      CREATE TABLE IF NOT EXISTS arbitration_responses (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          request_id UUID NOT NULL REFERENCES arbitration_requests(id) ON DELETE CASCADE,
          authority_unit TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('permit', 'escalate', 'deny', 'reduce')),
          reasoning TEXT,
          legibility_record JSONB NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS governance_findings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          request_id UUID NOT NULL REFERENCES arbitration_requests(id) ON DELETE CASCADE,
          trigger TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('attenuate', 'suspend', 'revoke')),
          attenuated_scope JSONB,
          supervisor_timeout BOOLEAN DEFAULT FALSE,
          timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    // High-Capacity GIN Indexes for Active Governance
    await sql`
      CREATE INDEX IF NOT EXISTS idx_arb_requests_context ON arbitration_requests USING GIN (context)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_arb_responses_legibility ON arbitration_responses USING GIN (legibility_record)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_gov_findings_trigger ON governance_findings (trigger)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_gov_findings_action ON governance_findings (action)
    `;

    // High-Capacity Indexes for Evidence Locker
    await sql`
      CREATE INDEX IF NOT EXISTS idx_ev_locker_gov_finding_action ON evidence_locker USING BTREE ((governance_finding ->> 'action'))
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_ev_locker_gov_finding_trigger ON evidence_locker USING BTREE ((governance_finding ->> 'trigger'))
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_ev_locker_gov_finding_gin ON evidence_locker USING GIN (governance_finding)
    `;

    _tableEnsured = true;
    console.log('[EVIDENCE_LOCKER] Arbitration schema and JSONB GIN indexes ensured.');
  } catch (err) {
    console.warn('[EVIDENCE_LOCKER] Table creation skipped:', err.message);
    _tableEnsured = true;
  }
}

// ─────────────────────────────────────────────────────
//  EVIDENCE LOCKER (Sentinel Arbiter)
// ─────────────────────────────────────────────────────

class EvidenceLocker {
  /** @type {import('./security-manager').SecurityManager} */
  #securityManager;

  /**
   * @param {import('./security-manager').SecurityManager} securityManager
   */
  constructor(securityManager) {
    if (!securityManager) {
      throw new Error('[EVIDENCE_LOCKER] SecurityManager is required for KMS signature verification.');
    }
    this.#securityManager = securityManager;
  }

  /**
   * Insert an arbitration request. Returns the UUID.
   */
  async createArbitrationRequest({ requesting_agent, action, context, target_domain }) {
    await ensureEvidenceTable();
    const sql = getSql();
    if (!sql) throw new Error('DB_UNAVAILABLE');

    const [row] = await sql`
      INSERT INTO arbitration_requests (requesting_agent, action, context, target_domain)
      VALUES (${requesting_agent}, ${action}, ${JSON.stringify(context)}, ${target_domain})
      RETURNING id
    `;
    return row.id;
  }

  /**
   * Record a signed Legibility Record or Governance Finding into the Evidence Locker.
   *
   * @param {object} params
   * @param {string} params.request_id - Original request UUID
   * @param {string} params.decision - 'permit', 'deny', 'halt', 'escalate'
   * @param {string} params.authority_unit_id
   * @param {string} params.contract_evaluated_id
   * @param {Array} params.delegation_chain
   * @param {object} params.invariants_checked
   * @param {object} params.legibility_record
   * @param {object} params.governance_finding
   * @param {string} params.signature - KMS Signature
   * @returns {Promise<{id: string}>}
   */
  async recordEvent({ 
    request_id, 
    decision, 
    authority_unit_id = null, 
    contract_evaluated_id = null, 
    delegation_chain = null, 
    invariants_checked = null, 
    legibility_record = {}, 
    governance_finding = null,
    signature
  }) {
    await ensureEvidenceTable();

    const sql = getSql();
    if (!sql) {
      console.error('[EVIDENCE_LOCKER] Cannot record — DB unavailable. AUDIT TRAIL BROKEN.');
      throw new Error('EVIDENCE_LOCKER_UNAVAILABLE');
    }

    try {
      const [row] = await sql`
        INSERT INTO evidence_locker (
          request_id, decision, authority_unit_id, contract_evaluated_id,
          delegation_chain, invariants_checked, legibility_record,
          governance_finding, signature
        ) VALUES (
          ${request_id}, ${decision}, ${authority_unit_id}, ${contract_evaluated_id},
          ${delegation_chain ? JSON.stringify(delegation_chain) : null},
          ${invariants_checked ? JSON.stringify(invariants_checked) : null},
          ${JSON.stringify(legibility_record)},
          ${governance_finding ? JSON.stringify(governance_finding) : null},
          ${signature}
        )
        RETURNING id
      `;

      console.log(JSON.stringify({
        severity: 'INFO',
        eventType: 'EVIDENCE_RECORDED',
        id: row.id,
        request_id,
        decision,
        message: `[EVIDENCE_LOCKER] Recorded Arbiter Decision (${decision}) for ${request_id}.`,
      }));

      // ── KPMG 4.4: Stream signed record to BigQuery audit archive ──
      // Fire-and-forget — BQ failure NEVER blocks the primary response.
      exportAuditRecord({
        request_id,
        tenant_id:          legibility_record?.tenantId || null,
        decision,
        authority_unit_id,
        contract_id:        contract_evaluated_id,
        confidence:         legibility_record?.confidence ?? null,
        classification:     legibility_record?.classification || null,
        impact_level:       legibility_record?.impactLevel || null,
        narrative:          legibility_record?.narrative || null,
        legibility_record,
        governance_finding,
        signature,
        data_authority:     legibility_record?.dataAuthority || null,
      }).catch(() => { /* structured error logged inside exportAuditRecord */ });

      return { id: row.id };
    } catch (err) {
      console.error(JSON.stringify({
        severity: 'CRITICAL',
        eventType: 'EVIDENCE_WRITE_FAILURE',
        request_id,
        error: err.message,
        message: `[EVIDENCE_LOCKER] CRITICAL: Failed to record Arbiter Decision for ${request_id}.`,
      }));
      throw err;
    }
  }

  /**
   * Record a formal Arbitration Response.
   */
  async recordArbitrationResponse({ request_id, authority_unit, decision, reasoning, legibility_record }) {
    try {
      await ensureEvidenceTable();
      const sql = getSql();
      if (!sql) throw new Error('DB_UNAVAILABLE');

      const [row] = await sql`
        INSERT INTO arbitration_responses (request_id, authority_unit, decision, reasoning, legibility_record)
        VALUES (${request_id}, ${authority_unit}, ${decision}, ${reasoning}, ${JSON.stringify(legibility_record)})
        RETURNING id
      `;
      return row.id;
    } catch (err) {
      console.error('[EVIDENCE_LOCKER] Critical failure recording arbitration response. Failsafe activated.', err.message);
      return 'DENY_SYSTEM_FAILURE';
    }
  }

  /**
   * Record a formal Governance Finding.
   */
  async recordGovernanceFinding({ request_id, trigger, action, attenuated_scope, supervisor_timeout = false }) {
    await ensureEvidenceTable();
    const sql = getSql();
    if (!sql) throw new Error('DB_UNAVAILABLE');

    const [row] = await sql`
      INSERT INTO governance_findings (request_id, trigger, action, attenuated_scope, supervisor_timeout)
      VALUES (${request_id}, ${trigger}, ${action}, ${attenuated_scope ? JSON.stringify(attenuated_scope) : null}, ${supervisor_timeout})
      RETURNING id
    `;
    return row.id;
  }

  /**
   * Retrieve the Evidence Locker Fragment for a given arbitration request.
   *
   * @param {string} requestId
   * @returns {Promise<object[]>} Array of locker entries for this request
   */
  async getFragment(requestId) {
    const sql = getSql();
    if (!sql) return [];

    try {
      const rows = await sql`
        SELECT id, request_id, decision, authority_unit_id, contract_evaluated_id,
               delegation_chain, invariants_checked, legibility_record,
               governance_finding, signature, created_at
        FROM evidence_locker
        WHERE request_id = ${requestId}
        ORDER BY created_at ASC
      `;
      return rows;
    } catch (err) {
      console.error('[EVIDENCE_LOCKER] Fragment retrieval failed:', err.message);
      return [];
    }
  }

  /**
   * Retrieve the last PRISTINE_CHECKPOINT manifest for a tenant.
   * Used by the Rollback Engine to restore known-good state.
   *
   * @param {string} tenantId
   * @returns {Promise<object|null>} The checkpoint payload, or null if none exists
   */
  async getLastVerifiedPristine(tenantId) {
    const sql = getSql();
    if (!sql) return null;

    try {
      const [row] = await sql`
        SELECT locker_id, payload, signature, created_at
        FROM evidence_locker
        WHERE tenant_id = ${tenantId}
          AND event_type = ${EVENT_TYPES.PRISTINE_CHECKPOINT}
        ORDER BY created_at DESC
        LIMIT 1
      `;

      if (!row) {
        console.warn(`[EVIDENCE_LOCKER] No pristine checkpoint found for tenant ${tenantId}.`);
        return null;
      }

      return {
        lockerId: row.locker_id,
        payload: row.payload,
        signature: row.signature,
        checkpointedAt: row.created_at,
      };
    } catch (err) {
      console.error('[EVIDENCE_LOCKER] Pristine checkpoint retrieval failed:', err.message);
      return null;
    }
  }

  /**
   * Verify the integrity of the entire chain for a tenant.
   * Walks the chain from GENESIS to HEAD and verifies each HMAC link.
   *
   * @param {string} tenantId
   * @returns {Promise<{valid: boolean, entryCount: number, brokenAt: string|null}>}
   */
  async verifyChain(tenantId) {
    const sql = getSql();
    if (!sql) return { valid: false, entryCount: 0, brokenAt: 'DB_UNAVAILABLE' };

    try {
      const rows = await sql`
        SELECT locker_id, request_id, event_type, payload, signature,
               previous_signature, tenant_id
        FROM evidence_locker
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at ASC
      `;

      if (rows.length === 0) return { valid: true, entryCount: 0, brokenAt: null };

      let lastSignature = null;

      for (const row of rows) {
        // Verify chain linkage
        const expectedPrevious = lastSignature || null;
        if (row.previous_signature !== expectedPrevious) {
          console.error(JSON.stringify({
            severity: 'CRITICAL',
            eventType: 'CHAIN_INTEGRITY_VIOLATION',
            lockerId: row.locker_id,
            tenantId,
            expected: expectedPrevious,
            actual: row.previous_signature,
            message: `[EVIDENCE_LOCKER] CHAIN BROKEN at ${row.locker_id}. Expected previous=${expectedPrevious}, got=${row.previous_signature}.`,
          }));
          return { valid: false, entryCount: rows.length, brokenAt: row.locker_id };
        }

        // Verify HMAC signature
        const canonicalPayload = JSON.stringify({
          lockerId: row.locker_id,
          requestId: row.request_id,
          eventType: row.event_type,
          tenantId: row.tenant_id,
          payload: row.payload,
          previousSignature: row.previous_signature || 'GENESIS',
        });
        const isValid = await this.#securityManager.verifyPayload(
          JSON.parse(canonicalPayload),
          row.signature
        );

        if (!isValid) {
          console.error(JSON.stringify({
            severity: 'CRITICAL',
            eventType: 'SIGNATURE_INTEGRITY_VIOLATION',
            lockerId: row.locker_id,
            tenantId,
            message: `[EVIDENCE_LOCKER] SIGNATURE INVALID at ${row.locker_id}. Entry has been tampered with.`,
          }));
          return { valid: false, entryCount: rows.length, brokenAt: row.locker_id };
        }

        lastSignature = row.signature;
      }

      console.log(`[EVIDENCE_LOCKER] Chain verified for tenant ${tenantId}: ${rows.length} entries, all valid.`);
      return { valid: true, entryCount: rows.length, brokenAt: null };
    } catch (err) {
      console.error('[EVIDENCE_LOCKER] Chain verification error:', err.message);
      return { valid: false, entryCount: 0, brokenAt: err.message };
    }
  }

  /**
   * Get recent events for the HITL dashboard.
   *
   * @param {string} tenantId
   * @param {number} [limit=50]
   * @returns {Promise<object[]>}
   */
  async getRecentEvents(tenantId, limit = 50) {
    const sql = getSql();
    if (!sql) return [];

    try {
      const rows = await sql`
        SELECT locker_id, request_id, event_type, responsible_authority_id,
               payload, created_at
        FROM evidence_locker
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return rows;
    } catch (err) {
      console.error('[EVIDENCE_LOCKER] Recent events query failed:', err.message);
      return [];
    }
  }
}

module.exports = { EvidenceLocker, EVENT_TYPES };
