/**
 * SENTINEL ENGINE V5.4 — Standing Authority Matrix
 * ═══════════════════════════════════════════════════════════════════
 * Maps automated rejections to Named Human Approvers who own the
 * decision. Implements the NIST CSF 2.0 GOVERN function, moving
 * from "Assumed Execution" to "Conditional Execution."
 *
 * Blast Radius Tiers:
 *   LOCAL    → Single-tenant impact → SOC Tier 1
 *   REGIONAL → Multi-tenant / regional infra → SOC Tier 2
 *   GLOBAL   → Infrastructure-wide / data-plane → Chief Engineer / CISO
 *
 * Escalation Chain:
 *   SOC_TIER_1 (tier 1) → SOC_TIER_2 (tier 2) → CHIEF_ENGINEER (tier 3) → CISO (tier 4)
 *
 * V5.4 MANDATE:
 *   Every automated action MUST map to a Responsible_Authority_ID.
 *   Modifications to this matrix are WebAuthn-gated and logged in
 *   the Evidence Locker as AUTHORITY_MODIFIED events.
 * ═══════════════════════════════════════════════════════════════════
 */

const { getSql } = require('./db');

// ─────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────

const BLAST_RADIUS = Object.freeze({
  LOCAL: 'LOCAL',
  REGIONAL: 'REGIONAL',
  GLOBAL: 'GLOBAL',
});

const AUTHORITY_ROLES = Object.freeze({
  SOC_TIER_1: 'SOC_TIER_1',
  SOC_TIER_2: 'SOC_TIER_2',
  CHIEF_ENGINEER: 'CHIEF_ENGINEER',
  CISO: 'CISO',
});

/**
 * Default escalation mapping when the matrix table is empty or unavailable.
 * This is the hardcoded floor — the matrix table overrides these.
 */
const DEFAULT_ESCALATION_MAP = Object.freeze({
  LOCAL: { role: AUTHORITY_ROLES.SOC_TIER_1, tier: 1 },
  REGIONAL: { role: AUTHORITY_ROLES.SOC_TIER_2, tier: 2 },
  GLOBAL: { role: AUTHORITY_ROLES.CISO, tier: 4 },
});

// ─────────────────────────────────────────────────────
//  TABLE SETUP (idempotent)
// ─────────────────────────────────────────────────────

let _tableEnsured = false;

async function ensureAuthorityTable() {
  if (_tableEnsured) return;
  const sql = getSql();
  if (!sql) return;

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS standing_authority_matrix (
        authority_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        blast_radius TEXT NOT NULL,
        escalation_tier INTEGER NOT NULL,
        contact_channel TEXT,
        webhook_url TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        tenant_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    _tableEnsured = true;
    console.log('[AUTHORITY_MATRIX] Table standing_authority_matrix ensured.');
  } catch (err) {
    console.warn('[AUTHORITY_MATRIX] Table creation skipped:', err.message);
    _tableEnsured = true;
  }
}

// ─────────────────────────────────────────────────────
//  STANDING AUTHORITY MATRIX
// ─────────────────────────────────────────────────────

class StandingAuthorityMatrix {
  /**
   * Determine the blast radius based on impact level and query classification.
   *
   * @param {string} impactLevel - HIGH_IMPACT, STANDARD, LOW
   * @param {string} queryClassification - SENSITIVE, PROCEDURAL, GENERAL
   * @returns {string} Blast radius tier
   */
  static classifyBlastRadius(impactLevel, queryClassification) {
    if (impactLevel === 'HIGH_IMPACT' && queryClassification === 'SENSITIVE') {
      return BLAST_RADIUS.GLOBAL;
    }
    if (impactLevel === 'HIGH_IMPACT') {
      return BLAST_RADIUS.REGIONAL;
    }
    return BLAST_RADIUS.LOCAL;
  }

  /**
   * Resolve the responsible human authority for a given blast radius.
   * Queries the standing_authority_matrix table, falling back to
   * hardcoded defaults if the table is empty or unavailable.
   *
   * @param {string} blastRadius - LOCAL, REGIONAL, GLOBAL
   * @param {string} [tenantId] - Optional tenant filter
   * @returns {Promise<{authorityId: string, name: string, role: string, escalationTier: number, contactChannel: string|null, webhookUrl: string|null}>}
   */
  static async resolveAuthority(blastRadius, tenantId = null) {
    await ensureAuthorityTable();
    const sql = getSql();

    if (sql) {
      try {
        // Find the lowest-tier active authority for this blast radius
        // Tenant-specific authorities take priority over global ones
        const [row] = await sql`
          SELECT authority_id, name, role, escalation_tier, contact_channel, webhook_url
          FROM standing_authority_matrix
          WHERE blast_radius = ${blastRadius}
            AND is_active = TRUE
            AND (tenant_id = ${tenantId} OR tenant_id IS NULL)
          ORDER BY
            CASE WHEN tenant_id IS NOT NULL THEN 0 ELSE 1 END,
            escalation_tier ASC
          LIMIT 1
        `;

        if (row) {
          return {
            authorityId: row.authority_id,
            name: row.name,
            role: row.role,
            escalationTier: row.escalation_tier,
            contactChannel: row.contact_channel,
            webhookUrl: row.webhook_url,
          };
        }
      } catch (err) {
        console.error('[AUTHORITY_MATRIX] DB query failed:', err.message);
      }
    }

    // Fallback: hardcoded default
    const fallback = DEFAULT_ESCALATION_MAP[blastRadius] || DEFAULT_ESCALATION_MAP.GLOBAL;
    console.warn(`[AUTHORITY_MATRIX] Using hardcoded fallback for ${blastRadius}: ${fallback.role}`);
    return {
      authorityId: `SYSTEM_DEFAULT_${fallback.role}`,
      name: `Default ${fallback.role} Authority`,
      role: fallback.role,
      escalationTier: fallback.tier,
      contactChannel: null,
      webhookUrl: null,
    };
  }

  /**
   * Get the full escalation chain for a given classification.
   * Returns authorities ordered by escalation tier (lowest first).
   *
   * @param {string} blastRadius
   * @param {string} [tenantId]
   * @returns {Promise<object[]>} Ordered chain of authorities
   */
  static async getAuthorityChain(blastRadius, tenantId = null) {
    await ensureAuthorityTable();
    const sql = getSql();
    if (!sql) {
      const fallback = DEFAULT_ESCALATION_MAP[blastRadius] || DEFAULT_ESCALATION_MAP.GLOBAL;
      return [{
        authorityId: `SYSTEM_DEFAULT_${fallback.role}`,
        name: `Default ${fallback.role} Authority`,
        role: fallback.role,
        escalationTier: fallback.tier,
      }];
    }

    try {
      const rows = await sql`
        SELECT authority_id, name, role, escalation_tier, contact_channel, webhook_url
        FROM standing_authority_matrix
        WHERE is_active = TRUE
          AND (tenant_id = ${tenantId} OR tenant_id IS NULL)
          AND escalation_tier >= (
            SELECT MIN(escalation_tier) FROM standing_authority_matrix
            WHERE blast_radius = ${blastRadius} AND is_active = TRUE
          )
        ORDER BY escalation_tier ASC
      `;

      if (rows.length === 0) {
        const fallback = DEFAULT_ESCALATION_MAP[blastRadius] || DEFAULT_ESCALATION_MAP.GLOBAL;
        return [{
          authorityId: `SYSTEM_DEFAULT_${fallback.role}`,
          name: `Default ${fallback.role} Authority`,
          role: fallback.role,
          escalationTier: fallback.tier,
        }];
      }

      return rows.map(r => ({
        authorityId: r.authority_id,
        name: r.name,
        role: r.role,
        escalationTier: r.escalation_tier,
        contactChannel: r.contact_channel,
        webhookUrl: r.webhook_url,
      }));
    } catch (err) {
      console.error('[AUTHORITY_MATRIX] Chain query failed:', err.message);
      return [];
    }
  }

  /**
   * Register a new authority in the matrix.
   * This operation is WebAuthn-gated — the caller MUST have already
   * verified the FIDO2 assertion before calling this method.
   *
   * @param {object} authority
   * @param {string} authority.authorityId
   * @param {string} authority.name
   * @param {string} authority.role
   * @param {string} authority.blastRadius
   * @param {number} authority.escalationTier
   * @param {string} [authority.contactChannel]
   * @param {string} [authority.webhookUrl]
   * @param {string} [authority.tenantId]
   * @returns {Promise<boolean>} True if registered successfully
   */
  static async registerAuthority(authority) {
    await ensureAuthorityTable();
    const sql = getSql();
    if (!sql) {
      throw new Error('[AUTHORITY_MATRIX] Cannot register — DB unavailable.');
    }

    // Validate role
    if (!Object.values(AUTHORITY_ROLES).includes(authority.role)) {
      throw new Error(`[AUTHORITY_MATRIX] Invalid role: ${authority.role}`);
    }

    // Validate blast radius
    if (!Object.values(BLAST_RADIUS).includes(authority.blastRadius)) {
      throw new Error(`[AUTHORITY_MATRIX] Invalid blast radius: ${authority.blastRadius}`);
    }

    try {
      await sql`
        INSERT INTO standing_authority_matrix (
          authority_id, name, role, blast_radius, escalation_tier,
          contact_channel, webhook_url, tenant_id
        ) VALUES (
          ${authority.authorityId},
          ${authority.name},
          ${authority.role},
          ${authority.blastRadius},
          ${authority.escalationTier},
          ${authority.contactChannel || null},
          ${authority.webhookUrl || null},
          ${authority.tenantId || null}
        )
        ON CONFLICT (authority_id) DO UPDATE SET
          name = EXCLUDED.name,
          role = EXCLUDED.role,
          blast_radius = EXCLUDED.blast_radius,
          escalation_tier = EXCLUDED.escalation_tier,
          contact_channel = EXCLUDED.contact_channel,
          webhook_url = EXCLUDED.webhook_url,
          tenant_id = EXCLUDED.tenant_id,
          updated_at = NOW()
      `;

      console.log(`[AUTHORITY_MATRIX] Authority registered: ${authority.authorityId} (${authority.role}, ${authority.blastRadius})`);
      return true;
    } catch (err) {
      console.error('[AUTHORITY_MATRIX] Registration failed:', err.message);
      throw err;
    }
  }

  /**
   * Deactivate an authority (soft delete).
   *
   * @param {string} authorityId
   * @returns {Promise<boolean>}
   */
  static async deactivateAuthority(authorityId) {
    const sql = getSql();
    if (!sql) return false;

    try {
      await sql`
        UPDATE standing_authority_matrix
        SET is_active = FALSE, updated_at = NOW()
        WHERE authority_id = ${authorityId}
      `;
      console.log(`[AUTHORITY_MATRIX] Authority deactivated: ${authorityId}`);
      return true;
    } catch (err) {
      console.error('[AUTHORITY_MATRIX] Deactivation failed:', err.message);
      return false;
    }
  }

  /**
   * List all active authorities (for HITL dashboard).
   *
   * @param {string} [tenantId]
   * @returns {Promise<object[]>}
   */
  static async listActive(tenantId = null) {
    await ensureAuthorityTable();
    const sql = getSql();
    if (!sql) return [];

    try {
      const rows = await sql`
        SELECT authority_id, name, role, blast_radius, escalation_tier,
               contact_channel, webhook_url, tenant_id, created_at
        FROM standing_authority_matrix
        WHERE is_active = TRUE
          AND (tenant_id = ${tenantId} OR tenant_id IS NULL)
        ORDER BY escalation_tier ASC
      `;
      return rows.map(r => ({
        authorityId: r.authority_id,
        name: r.name,
        role: r.role,
        blastRadius: r.blast_radius,
        escalationTier: r.escalation_tier,
        contactChannel: r.contact_channel,
        webhookUrl: r.webhook_url,
        tenantId: r.tenant_id,
        createdAt: r.created_at,
      }));
    } catch (err) {
      console.error('[AUTHORITY_MATRIX] List query failed:', err.message);
      return [];
    }
  }

  /**
   * Fire a webhook notification to the resolved authority.
   * Non-blocking — failures are logged but do not break the escalation flow.
   *
   * @param {object} authority - Resolved authority object
   * @param {object} escalationPayload - The JIT approval request payload
   */
  static async notifyAuthority(authority, escalationPayload) {
    if (!authority.webhookUrl) {
      console.log(`[AUTHORITY_MATRIX] No webhook configured for ${authority.authorityId}. Dashboard-only notification.`);
      return;
    }

    try {
      const response = await fetch(authority.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🚨 *Sentinel V5.4 Escalation* — ${escalationPayload.escalationId}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  `*Impact Level:* ${escalationPayload.impactLevel}`,
                  `*Blast Radius:* ${escalationPayload.blastRadius}`,
                  `*Request:* \`${escalationPayload.requestId}\``,
                  `*Tenant:* ${escalationPayload.tenantId}`,
                  `*TTL Expires:* ${escalationPayload.ttlExpiresAt}`,
                  ``,
                  `Open the Sentinel Supervisor Dashboard to review and resolve.`,
                ].join('\n'),
              },
            },
          ],
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        console.log(`[AUTHORITY_MATRIX] Webhook delivered to ${authority.authorityId} at ${authority.webhookUrl}`);
      } else {
        console.warn(`[AUTHORITY_MATRIX] Webhook failed (${response.status}) for ${authority.authorityId}`);
      }
    } catch (err) {
      // Non-blocking — failure is logged, escalation continues
      console.error(`[AUTHORITY_MATRIX] Webhook error for ${authority.authorityId}: ${err.message}`);
    }
  }
}

module.exports = {
  StandingAuthorityMatrix,
  BLAST_RADIUS,
  AUTHORITY_ROLES,
};
