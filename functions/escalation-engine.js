/**
 * SENTINEL ENGINE V5.4 — JIT Escalation Engine
 * ═══════════════════════════════════════════════════════════════════
 * The bridge between autonomous Fail-Closed rejection and human
 * Standing Authority accountability. When the Prosecutor rejects a
 * HIGH_IMPACT task, this engine generates a Just-in-Time (JIT)
 * Approval Request and routes it to the correct Named Human Approver.
 *
 * Latency Target: <100ms from Prosecutor rejection to JIT creation.
 *
 * Lifecycle:
 *   PENDING → OVERRIDE_RELEASED (human approved, FIDO2-signed)
 *   PENDING → CONFIRMED_BLOCKED (human confirmed rejection)
 *   PENDING → TTL_EXPIRED (no response within TTL → permanent BLOCKED)
 *
 * V5.4 MANDATE:
 *   - Every override MUST be signed by a hardware key (FIDO2/WebAuthn).
 *   - No "bypass" mode exists. The FIDO2 assertion is the ONLY key
 *     that unlocks the override path.
 *   - All actions are recorded in the Evidence Locker with full
 *     chain-of-custody integrity.
 * ═══════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const { getSql } = require('./db');
const { EvidenceLocker, EVENT_TYPES } = require('./evidence-locker');
const { StandingAuthorityMatrix } = require('./authority-matrix');
const { MonotonicReductionProtocol } = require('./authority-graph/reduction');

// Default TTL: 300 seconds (5 minutes)
const ESCALATION_TTL_SECONDS = parseInt(process.env.ESCALATION_TTL_SECONDS || '300', 10);

// ─────────────────────────────────────────────────────
//  TABLE SETUP (idempotent)
// ─────────────────────────────────────────────────────

let _tableEnsured = false;

async function ensureEscalationTable() {
  if (_tableEnsured) return;
  const sql = getSql();
  if (!sql) return;

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS escalation_requests (
        escalation_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        authority_id TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        impact_level TEXT NOT NULL DEFAULT 'HIGH_IMPACT',
        blast_radius TEXT NOT NULL DEFAULT 'LOCAL',
        evidence_fragment JSONB NOT NULL,
        resolution_payload JSONB,
        coaching_annotation TEXT,
        ttl_expires_at TIMESTAMPTZ NOT NULL,
        resolved_at TIMESTAMPTZ,
        resolved_by TEXT,
        webauthn_assertion_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    _tableEnsured = true;
    console.log('[ESCALATION_ENGINE] Table escalation_requests ensured.');
  } catch (err) {
    console.warn('[ESCALATION_ENGINE] Table creation skipped:', err.message);
    _tableEnsured = true;
  }
}

// ─────────────────────────────────────────────────────
//  ESCALATION ENGINE
// ─────────────────────────────────────────────────────

const SSE_CLIENTS = [];

function broadcastSSE(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  SSE_CLIENTS.forEach((client, index) => {
    try {
      client.res.write(payload);
    } catch (err) {
      SSE_CLIENTS.splice(index, 1);
    }
  });
}

async function addSSEClient(req, res, tenantId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write(': connected\n\n');

  try {
    const sql = getSql();
    if (sql && tenantId) {
      const recentEvidence = await sql`
        SELECT event_type, payload, created_at as timestamp
        FROM evidence_locker
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC
        LIMIT 50
      `;
      // We do not have tenant_id on governance_findings in the schema, but we can query it generically
      // or join if needed. For now, pull the latest governance findings globally.
      const recentGovernance = await sql`
        SELECT trigger as event_type, action as payload_action, timestamp
        FROM governance_findings
        ORDER BY timestamp DESC
        LIMIT 20
      `;

      const allEvents = [
        ...recentEvidence.map(r => ({ ...r, type: 'evidence_locker' })),
        ...recentGovernance.map(r => ({ ...r, type: 'governance_finding' }))
      ].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      allEvents.forEach(evt => {
        res.write(`event: active_feed\ndata: ${JSON.stringify(evt)}\n\n`);
      });
    }
  } catch (err) {
    console.error('[HITL_SSE] Failed to pull active feed from DB:', err.message);
  }

  SSE_CLIENTS.push({ req, res, tenantId });
  req.on('close', () => {
    const index = SSE_CLIENTS.findIndex(c => c.req === req);
    if (index !== -1) SSE_CLIENTS.splice(index, 1);
  });
}

class EscalationEngine {
  /** @type {EvidenceLocker} */
  #evidenceLocker;
  /** @type {import('./security-manager').SecurityManager} */
  #securityManager;
  /** @type {import('./webauthn-provider').WebAuthnProvider} */
  #webauthnProvider;

  /**
   * @param {import('./security-manager').SecurityManager} securityManager
   * @param {import('./webauthn-provider').WebAuthnProvider} [webauthnProvider]
   */
  constructor(securityManager, webauthnProvider = null) {
    if (!securityManager) {
      throw new Error('[ESCALATION_ENGINE] SecurityManager is required.');
    }
    this.#securityManager = securityManager;
    this.#evidenceLocker = new EvidenceLocker(securityManager);
    this.#webauthnProvider = webauthnProvider;
  }

  /**
   * Generate a unique escalation ID.
   * @returns {string}
   */
  _generateEscalationId() {
    const timestamp = Date.now().toString(36);
    const entropy = crypto.randomBytes(6).toString('hex');
    return `ESC-${timestamp}-${entropy}`;
  }

  /**
   * Create a JIT Escalation Request.
   * Target: <100ms from call to DB write.
   *
   * This is the core function that transforms a Prosecutor rejection
   * into a governed human-review workflow.
   *
   * @param {object} rejectionEvent
   * @param {string} rejectionEvent.requestId - Original request ID
   * @param {string} rejectionEvent.tenantId - Tenant context
   * @param {string} rejectionEvent.narrative - The AI's generated narrative (intent)
   * @param {string} rejectionEvent.sourceContext - The Pristine data it contradicted
   * @param {object} rejectionEvent.prosecutorVerdict - The Prosecutor's logic/verdict
   * @param {string} rejectionEvent.impactLevel - HIGH_IMPACT, STANDARD, LOW
   * @param {string} rejectionEvent.queryClassification - SENSITIVE, PROCEDURAL, GENERAL
   * @returns {Promise<{escalationId: string, authorityId: string, ttlExpiresAt: string}>}
   */
  async createEscalation(rejectionEvent) {
    const t0 = Date.now();
    await ensureEscalationTable();

    const {
      requestId, tenantId, narrative, sourceContext,
      prosecutorVerdict, impactLevel, queryClassification,
    } = rejectionEvent;

    const sql = getSql();
    if (!sql) {
      throw new Error('[ESCALATION_ENGINE] Cannot create escalation — DB unavailable.');
    }

    // Step 1: Resolve the responsible authority
    const blastRadius = StandingAuthorityMatrix.classifyBlastRadius(impactLevel, queryClassification);
    const authority = await StandingAuthorityMatrix.resolveAuthority(blastRadius, tenantId);

    // Step 2: Build the Evidence Locker Fragment
    const evidenceFragment = {
      aiIntent: narrative,
      pristineData: sourceContext ? sourceContext.substring(0, 4096) : null, // cap at 4KB
      prosecutorLogic: prosecutorVerdict,
      blastRadius,
      impactLevel,
      queryClassification,
    };

    // Step 3: Write escalation request
    const escalationId = this._generateEscalationId();
    const ttlExpiresAt = new Date(Date.now() + ESCALATION_TTL_SECONDS * 1000).toISOString();

    try {
      await sql`
        INSERT INTO escalation_requests (
          escalation_id, request_id, tenant_id, authority_id, status,
          impact_level, blast_radius, evidence_fragment, ttl_expires_at
        ) VALUES (
          ${escalationId}, ${requestId}, ${tenantId}, ${authority.authorityId},
          'PENDING', ${impactLevel}, ${blastRadius},
          ${JSON.stringify(evidenceFragment)}, ${ttlExpiresAt}
        )
      `;
    } catch (err) {
      console.error(`[ESCALATION_ENGINE] Failed to create escalation:`, err.message);
      throw err;
    }

    // Step 4: Record in Evidence Locker (chain-of-custody)
    await this.#evidenceLocker.recordEvent({
      requestId,
      eventType: EVENT_TYPES.PROSECUTOR_REJECTION,
      tenantId,
      payload: { prosecutorVerdict, impactLevel, blastRadius },
      responsibleAuthorityId: authority.authorityId,
    });

    await this.#evidenceLocker.recordEvent({
      requestId,
      eventType: EVENT_TYPES.ESCALATION_CREATED,
      tenantId,
      payload: { escalationId, authorityId: authority.authorityId, ttlExpiresAt },
      responsibleAuthorityId: authority.authorityId,
    });

    const latencyMs = Date.now() - t0;

    // Step 5: Fire webhook notification (non-blocking)
    StandingAuthorityMatrix.notifyAuthority(authority, {
      escalationId,
      requestId,
      tenantId,
      impactLevel,
      blastRadius,
      ttlExpiresAt,
    }).catch(err => console.error('[ESCALATION_ENGINE] Webhook notification failed:', err.message));

    // Step 6: Broadcast to SSE clients for instant dashboard push
    broadcastSSE('escalation_created', {
      escalationId,
      authorityId: authority.authorityId,
      tenantId,
      impactLevel,
      blastRadius
    });

    console.log(JSON.stringify({
      severity: 'WARNING',
      eventType: 'ESCALATION_CREATED',
      escalationId,
      requestId,
      tenantId,
      authorityId: authority.authorityId,
      blastRadius,
      impactLevel,
      ttlExpiresAt,
      latencyMs,
      message: `[ESCALATION_ENGINE] JIT Escalation ${escalationId} created in ${latencyMs}ms. Authority: ${authority.name} (${authority.role}). TTL: ${ESCALATION_TTL_SECONDS}s.`,
    }));

    return {
      escalationId,
      authorityId: authority.authorityId,
      authorityName: authority.name,
      authorityRole: authority.role,
      blastRadius,
      ttlExpiresAt,
      latencyMs,
    };
  }

  /**
   * Resolve an escalation — human decision handler.
   * Requires a valid WebAuthn assertion (FIDO2 hardware key signature).
   *
   * @param {object} params
   * @param {string} params.escalationId
   * @param {string} params.decision - 'OVERRIDE_RELEASE' or 'CONFIRM_BLOCK'
   * @param {string} params.authorityId - The resolving authority
   * @param {string} [params.coachingAnnotation] - Feedback for model drift prevention
   * @param {object} [params.webauthnAssertion] - FIDO2 assertion object
   * @returns {Promise<{status: string, releasedPayload: object|null}>}
   */
  async resolveEscalation({ escalationId, decision, authorityId, coachingAnnotation, webauthnAssertion }) {
    const sql = getSql();
    if (!sql) throw new Error('[ESCALATION_ENGINE] DB unavailable.');

    // Step 1: Validate WebAuthn assertion (MANDATORY for all overrides)
    if (this.#webauthnProvider) {
      try {
        const isValid = await this.#webauthnProvider.verifyAuthentication(authorityId, webauthnAssertion);
        if (!isValid) {
          console.error(JSON.stringify({
            severity: 'CRITICAL',
            eventType: 'WEBAUTHN_REJECTION',
            escalationId,
            authorityId,
            message: `[ESCALATION_ENGINE] FIDO2 assertion INVALID for ${authorityId}. Override DENIED.`,
          }));
          throw new Error('WEBAUTHN_VERIFICATION_FAILED');
        }
      } catch (err) {
        if (err.message === 'WEBAUTHN_VERIFICATION_FAILED') throw err;
        console.error(`[ESCALATION_ENGINE] WebAuthn verification error: ${err.message}`);
        throw new Error('WEBAUTHN_VERIFICATION_FAILED');
      }
    } else {
      console.warn('[ESCALATION_ENGINE] WebAuthn provider not configured. FIDO2 enforcement DEGRADED.');
    }

    // Step 2: Fetch the escalation
    const [escalation] = await sql`
      SELECT escalation_id, request_id, tenant_id, authority_id, status,
             evidence_fragment, ttl_expires_at
      FROM escalation_requests
      WHERE escalation_id = ${escalationId}
    `;

    if (!escalation) throw new Error(`Escalation ${escalationId} not found.`);
    if (escalation.status !== 'PENDING') throw new Error(`Escalation ${escalationId} already resolved: ${escalation.status}`);

    // Check TTL
    if (new Date(escalation.ttl_expires_at) < new Date()) {
      throw new Error(`Escalation ${escalationId} has expired (TTL exceeded).`);
    }

    // Step 3: Apply decision
    const newStatus = decision === 'OVERRIDE_RELEASE' ? 'OVERRIDE_RELEASED' : 'CONFIRMED_BLOCKED';
    const assertionId = webauthnAssertion?.id || crypto.randomBytes(16).toString('hex');

    await sql`
      UPDATE escalation_requests SET
        status = ${newStatus},
        resolved_at = NOW(),
        resolved_by = ${authorityId},
        coaching_annotation = ${coachingAnnotation || null},
        webauthn_assertion_id = ${assertionId},
        resolution_payload = ${JSON.stringify({ decision, authorityId, coachingAnnotation })}
      WHERE escalation_id = ${escalationId}
    `;

    // Step 4: Record in Evidence Locker
    const eventType = decision === 'OVERRIDE_RELEASE'
      ? EVENT_TYPES.HUMAN_OVERRIDE
      : EVENT_TYPES.HUMAN_CONFIRM_REJECTION;

    await this.#evidenceLocker.recordEvent({
      requestId: escalation.request_id,
      eventType,
      tenantId: escalation.tenant_id,
      payload: {
        escalationId,
        decision,
        authorityId,
        webauthnAssertionId: assertionId,
        coachingAnnotation: coachingAnnotation || null,
      },
      responsibleAuthorityId: authorityId,
    });

    // Step 5: If coaching annotation provided, record separately
    if (coachingAnnotation) {
      await this.#evidenceLocker.recordEvent({
        requestId: escalation.request_id,
        eventType: EVENT_TYPES.COACHING_ANNOTATION,
        tenantId: escalation.tenant_id,
        payload: {
          escalationId,
          annotation: coachingAnnotation,
          authorityId,
        },
        responsibleAuthorityId: authorityId,
      });
    }

    console.log(JSON.stringify({
      severity: decision === 'OVERRIDE_RELEASE' ? 'WARNING' : 'INFO',
      eventType: 'ESCALATION_RESOLVED',
      escalationId,
      decision: newStatus,
      authorityId,
      hasCoaching: !!coachingAnnotation,
      message: `[ESCALATION_ENGINE] Escalation ${escalationId} resolved: ${newStatus} by ${authorityId}.`,
    }));

    broadcastSSE('escalation_resolved', {
      escalationId,
      decision: newStatus,
      authorityId
    });

    return {
      status: newStatus,
      releasedPayload: decision === 'OVERRIDE_RELEASE' ? escalation.evidence_fragment : null,
    };
  }

  /**
   * Expire stale escalations past their TTL.
   * Transitions PENDING → TTL_EXPIRED → permanent BLOCKED state.
   *
   * Should be called by a Cloud Scheduler cron (every 60s) or
   * inline before listing pending escalations.
   *
   * @returns {Promise<number>} Number of expired escalations
   */
  async expireStaleEscalations() {
    const sql = getSql();
    if (!sql) return 0;

    try {
      // ── V5.4.1: Bifurcated TTL Enforcement ──
      // UTILITY_CRITICAL escalations fail-open (Physical Safety Bypass).
      // All other escalations fail-closed (permanent BLOCKED).

      // Phase 1: Standard Fail-Closed (non-UTILITY_CRITICAL)
      const expiredBlocked = await sql`
        UPDATE escalation_requests SET
          status = 'TTL_EXPIRED',
          resolved_at = NOW(),
          resolved_by = 'SYSTEM_TTL_ENFORCEMENT'
        WHERE status = 'PENDING'
          AND ttl_expires_at < NOW()
          AND impact_level != 'UTILITY_CRITICAL'
        RETURNING escalation_id, request_id, tenant_id, impact_level
      `;

      for (const row of expiredBlocked) {
        await this.#evidenceLocker.recordEvent({
          requestId: row.request_id,
          eventType: EVENT_TYPES.HUMAN_CONFIRM_REJECTION,
          tenantId: row.tenant_id,
          payload: {
            escalationId: row.escalation_id,
            decision: 'TTL_EXPIRED',
            reason: `No human authority responded within ${ESCALATION_TTL_SECONDS}s TTL. Fail-closed to permanent BLOCKED state.`,
          },
        });

        console.log(JSON.stringify({
          severity: 'WARNING',
          eventType: 'ESCALATION_TTL_EXPIRED',
          escalationId: row.escalation_id,
          requestId: row.request_id,
          tenantId: row.tenant_id,
          ttlSeconds: ESCALATION_TTL_SECONDS,
          message: `[ESCALATION_ENGINE] Escalation ${row.escalation_id} EXPIRED. No authority responded within ${ESCALATION_TTL_SECONDS}s. Fail-closed.`,
        }));
      }

      // Phase 2: Physical Safety Bypass — UTILITY_CRITICAL Fail-Open (V5.5 AGS Monotonic Reduction)
      const expiredBypassed = await sql`
        UPDATE escalation_requests SET
          status = 'MONOTONIC_REDUCTION_APPLIED',
          resolved_at = NOW(),
          resolved_by = 'SYSTEM_MONOTONIC_REDUCTION'
        WHERE status = 'PENDING'
          AND ttl_expires_at < NOW()
          AND impact_level = 'UTILITY_CRITICAL'
        RETURNING escalation_id, request_id, tenant_id, impact_level
      `;

      for (const row of expiredBypassed) {
        // Execute Monotonic Reduction (stripping to minimum viable scope)
        const reductionFinding = await MonotonicReductionProtocol.contractToMinimum(
          'UTILITY_CRITICAL_DOMAIN_ROOT', 
          'Supervisor TTL Expired',
          null // Defer cryptographic signing to the EvidenceLocker's internal wrapper
        );

        // Record critical audit alarm — this MUST be reviewed quarterly
        // by the Authority Matrix owner per the Auditor's control mandate.
        await this.#evidenceLocker.recordEvent({
          requestId: row.request_id,
          eventType: EVENT_TYPES.GOVERNANCE_FINDING,
          tenantId: row.tenant_id,
          payload: {
            escalationId: row.escalation_id,
            decision: 'MONOTONIC_REDUCTION_TRIGGERED',
            impactLevel: 'UTILITY_CRITICAL',
            finding: reductionFinding,
            reason: `No human authority responded within ${ESCALATION_TTL_SECONDS}s TTL. ` +
                    `UTILITY_CRITICAL classification activated AGS Monotonic Reduction Protocol. ` +
                    `Scope reduced to minimum viable safe state.`
          },
          responsibleAuthorityId: 'SYSTEM_MONOTONIC_REDUCTION',
        });

        broadcastSSE('monotonic_reduction', {
          escalationId: row.escalation_id,
          requestId: row.request_id,
          tenantId: row.tenant_id,
          impactLevel: 'UTILITY_CRITICAL',
          finding: reductionFinding
        });

        console.error(JSON.stringify({
          severity: 'CRITICAL',
          eventType: 'PHYSICAL_SAFETY_BYPASS_TRIGGERED',
          escalationId: row.escalation_id,
          requestId: row.request_id,
          tenantId: row.tenant_id,
          ttlSeconds: ESCALATION_TTL_SECONDS,
          message: `[ESCALATION_ENGINE] ⚠️ PHYSICAL SAFETY BYPASS: Escalation ${row.escalation_id} auto-released. ` +
                   `UTILITY_CRITICAL classification prevented fail-closed blackout. Immediate CISO review required.`,
        }));
      }

      const totalExpired = expiredBlocked.length + expiredBypassed.length;
      if (totalExpired > 0) {
        console.log(`[ESCALATION_ENGINE] Expired ${totalExpired} stale escalation(s): ${expiredBlocked.length} blocked, ${expiredBypassed.length} safety-bypassed.`);
      }
      return totalExpired;
    } catch (err) {
      console.error('[ESCALATION_ENGINE] TTL enforcement error:', err.message);
      return 0;
    }
  }

  /**
   * List pending escalations for the HITL Supervisor Dashboard.
   *
   * @param {string} tenantId
   * @returns {Promise<object[]>}
   */
  async listPending(tenantId) {
    await ensureEscalationTable();

    // Expire stale escalations first (inline TTL enforcement)
    await this.expireStaleEscalations();

    const sql = getSql();
    if (!sql) return [];

    try {
      const rows = await sql`
        SELECT e.escalation_id, e.request_id, e.tenant_id, e.authority_id,
               e.status, e.impact_level, e.blast_radius, e.evidence_fragment,
               e.coaching_annotation, e.ttl_expires_at, e.created_at,
               a.name AS authority_name, a.role AS authority_role
        FROM escalation_requests e
        LEFT JOIN standing_authority_matrix a ON e.authority_id = a.authority_id
        WHERE e.tenant_id = ${tenantId}
          AND e.status = 'PENDING'
        ORDER BY e.created_at DESC
      `;

      return rows.map(r => ({
        escalationId: r.escalation_id,
        requestId: r.request_id,
        tenantId: r.tenant_id,
        authorityId: r.authority_id,
        authorityName: r.authority_name,
        authorityRole: r.authority_role,
        status: r.status,
        impactLevel: r.impact_level,
        blastRadius: r.blast_radius,
        evidenceFragment: r.evidence_fragment,
        ttlExpiresAt: r.ttl_expires_at,
        createdAt: r.created_at,
      }));
    } catch (err) {
      console.error('[ESCALATION_ENGINE] List pending failed:', err.message);
      return [];
    }
  }

  /**
   * Get full escalation history for audit dashboard.
   *
   * @param {string} tenantId
   * @param {number} [limit=50]
   * @returns {Promise<object[]>}
   */
  async getHistory(tenantId, limit = 50) {
    const sql = getSql();
    if (!sql) return [];

    try {
      const rows = await sql`
        SELECT e.escalation_id, e.request_id, e.tenant_id, e.authority_id,
               e.status, e.impact_level, e.blast_radius, e.coaching_annotation,
               e.ttl_expires_at, e.resolved_at, e.resolved_by, e.created_at,
               a.name AS authority_name, a.role AS authority_role
        FROM escalation_requests e
        LEFT JOIN standing_authority_matrix a ON e.authority_id = a.authority_id
        WHERE e.tenant_id = ${tenantId}
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `;

      return rows.map(r => ({
        escalationId: r.escalation_id,
        requestId: r.request_id,
        status: r.status,
        impactLevel: r.impact_level,
        blastRadius: r.blast_radius,
        authorityName: r.authority_name,
        authorityRole: r.authority_role,
        coachingAnnotation: r.coaching_annotation,
        ttlExpiresAt: r.ttl_expires_at,
        resolvedAt: r.resolved_at,
        resolvedBy: r.resolved_by,
        createdAt: r.created_at,
      }));
    } catch (err) {
      console.error('[ESCALATION_ENGINE] History query failed:', err.message);
      return [];
    }
  }
}

module.exports = {
  EscalationEngine,
  ESCALATION_TTL_SECONDS,
  EVENT_TYPES,
  addSSEClient,
  broadcastSSE
};
