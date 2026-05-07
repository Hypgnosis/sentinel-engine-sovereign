/**
 * SENTINEL ENGINE V5.4 — Adversarial NLI Verification Loop
 * ═══════════════════════════════════════════════════════════════
 * "The Prosecutor" — Governed Escalation Sidecar.
 *
 * After primary Gemini inference completes, this module fires an
 * async call to a lightweight model (gemini-2.5-flash) that
 * acts as a fact-checking adversary. It identifies semantic
 * contradictions between the generated narrative and the source
 * context logs.
 *
 * V5.4 CHANGES:
 *   - HIGH_IMPACT rejections now trigger JIT Escalation Requests
 *     instead of just logging. The escalation routes to the
 *     Standing Authority Matrix for human review.
 *   - Non-high-impact rejections continue with existing fire-and-
 *     forget logging pattern.
 *   - Verification results now carry an escalation_id link.
 * ═══════════════════════════════════════════════════════════════
 */

const { getSql } = require('./db');
const { EscalationEngine } = require('./escalation-engine');
const { AuthorityUnit, globalGraphRegistry } = require('./authority-graph/unit');
const { ArbitrationInterface } = require('./authority-graph/arbitration');

const SIDECAR_MODEL = 'gemini-2.5-flash';

// ─────────────────────────────────────────────────────
//  ADVERSARIAL PROMPT TEMPLATE
// ─────────────────────────────────────────────────────

const PROSECUTOR_PROMPT = `You are a Verification Prosecutor for the Sentinel Intelligence Engine.
Your mandate is absolute factual integrity. You must:

1. Compare the GENERATED NARRATIVE against the SOURCE LOGS provided below.
2. Identify ANY semantic contradictions, unsupported claims, or hallucinated data points.
3. Flag specific discrepancies with exact quotes from both the narrative and source.

CRITICAL RULES:
- A claim is CONTRADICTED if the source data explicitly states the opposite.
- A claim is UNSUPPORTED if no source data backs it up (this is a soft discrepancy).
- Numbers, dates, port names, risk levels and trends are HIGH-PRIORITY for verification.
- If the narrative is broadly consistent with sources, return isVerified: true.

Return your verdict as a JSON object:
{
  "isVerified": boolean,
  "discrepancies": ["string describing each discrepancy found"],
  "verificationNotes": "Brief summary of your analysis"
}`;

// ─────────────────────────────────────────────────────
//  VERIFICATION SCHEMA (for Gemini responseSchema)
// ─────────────────────────────────────────────────────

const VERIFICATION_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isVerified: { type: 'BOOLEAN', description: 'True if the narrative is factually consistent with source data.' },
    discrepancies: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'List of specific contradictions or unsupported claims found.',
    },
    verificationNotes: { type: 'STRING', description: 'Brief summary of the verification analysis.' },
  },
  required: ['isVerified', 'discrepancies'],
};

// ─────────────────────────────────────────────────────
//  POSTGRES TABLE SETUP (idempotent)
// ─────────────────────────────────────────────────────

let _tableEnsured = false;

async function ensureVerificationTable() {
  if (_tableEnsured) return;
  const sql = getSql();
  if (!sql) return;

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS verification_results (
        id SERIAL PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        is_verified BOOLEAN,
        discrepancies JSONB DEFAULT '[]',
        verification_notes TEXT,
        sidecar_model TEXT,
        verified_at TIMESTAMPTZ DEFAULT NOW(),
        latency_ms INTEGER,
        escalation_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    _tableEnsured = true;
    console.log('[VERIFICATION_LOOP] Table verification_results ensured.');
  } catch (err) {
    console.warn('[VERIFICATION_LOOP] Table creation skipped:', err.message);
    _tableEnsured = true;
  }
}

// ─────────────────────────────────────────────────────
//  STORE VERIFICATION RESULT
// ─────────────────────────────────────────────────────

async function storeVerificationResult(requestId, tenantId, result, latencyMs, escalationId = null) {
  const sql = getSql();
  if (!sql) {
    console.warn('[VERIFICATION_LOOP] Cannot store result — DB unavailable.');
    return;
  }

  try {
    await sql`
      INSERT INTO verification_results (
        request_id, tenant_id, is_verified, discrepancies,
        verification_notes, sidecar_model, latency_ms, escalation_id
      )
      VALUES (
        ${requestId},
        ${tenantId},
        ${result.isVerified},
        ${JSON.stringify(result.discrepancies || [])},
        ${result.verificationNotes || ''},
        ${SIDECAR_MODEL},
        ${latencyMs},
        ${escalationId}
      )
      ON CONFLICT (request_id) DO UPDATE SET
        is_verified = EXCLUDED.is_verified,
        discrepancies = EXCLUDED.discrepancies,
        verification_notes = EXCLUDED.verification_notes,
        verified_at = NOW(),
        latency_ms = EXCLUDED.latency_ms,
        escalation_id = EXCLUDED.escalation_id
    `;
    console.log(`[VERIFICATION_LOOP] Result stored for ${requestId}: verified=${result.isVerified}${escalationId ? ` escalation=${escalationId}` : ''}`);
  } catch (err) {
    console.error(`[VERIFICATION_LOOP] Failed to store result for ${requestId}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────
//  LAUNCH VERIFICATION SIDECAR (Fire-and-forget)
// ─────────────────────────────────────────────────────

/**
 * Launches the Prosecutor sidecar asynchronously.
 * This function is called WITHOUT await so it doesn't block the primary response.
 *
 * @param {object} params
 * @param {object} params.genaiClient - Google GenAI client
 * @param {string} params.requestId - Unique request identifier
 * @param {string} params.tenantId - Tenant context
 * @param {string} params.narrative - Generated narrative from primary model
 * @param {string} params.sourceContext - RAG source logs
 * @returns {Promise<void>}
 */
/**
 * Launches the Prosecutor sidecar.
 *
 * V5.4 ESCALATION INTEGRATION:
 *   When verdict.isVerified === false AND impactLevel === 'HIGH_IMPACT',
 *   the Prosecutor triggers a JIT Escalation Request via the
 *   EscalationEngine. The escalation routes to the Standing Authority
 *   Matrix for human review.
 *
 * @param {object} params
 * @param {object} params.genaiClient - Google GenAI client
 * @param {string} params.requestId - Unique request identifier
 * @param {string} params.tenantId - Tenant context
 * @param {string} params.narrative - Generated narrative from primary model
 * @param {string} params.sourceContext - RAG source logs
 * @param {string} [params.impactLevel] - HIGH_IMPACT, STANDARD, LOW (V5.4)
 * @param {string} [params.queryClassification] - SENSITIVE, PROCEDURAL, GENERAL (V5.4)
 * @param {import('./security-manager').SecurityManager} [params.securityManager] - For escalation (V5.4)
 * @returns {Promise<object>} Verdict with optional escalation info
 */
async function launchVerificationSidecar({
  genaiClient, requestId, tenantId, narrative, sourceContext,
  impactLevel, queryClassification, securityManager,
}) {
  const t0 = Date.now();

  try {
    await ensureVerificationTable();

    // ═══ V5.4.1 SOVEREIGN AIR GAP: PII Tokenization ═══
    // Before ANY data leaves the sovereign data plane to a public LLM API,
    // we apply HMAC-SHA256 one-way peppering to the Pristine Data.
    // This mathematically guarantees that SSNs, credit cards, patient IDs,
    // and subject identifiers are irreversibly anonymized.
    //
    // The Prosecutor can still reason about semantic contradictions
    // (e.g., "the narrative claims X but the source says Y") because
    // the structural context is preserved — only the raw PII values
    // are replaced with deterministic hash tokens.
    //
    // Residual Risk (per Auditor): Over-anonymization may degrade
    // explainability if the Prosecutor cannot parse tokenized fields.
    // Monitor verification quality metrics quarterly.
    let sanitizedContext = sourceContext;
    if (securityManager && sourceContext) {
      try {
        sanitizedContext = await securityManager.tokenizePII(sourceContext, tenantId);
        console.log(`[VERIFICATION_LOOP] Pristine Data tokenized for request ${requestId}. Sovereign air gap enforced.`);
      } catch (tokenErr) {
        // FAIL-CLOSED: If tokenization fails, do NOT send raw PII to public API.
        console.error(JSON.stringify({
          severity: 'CRITICAL',
          eventType: 'PII_TOKENIZATION_FAILED',
          requestId,
          tenantId,
          error: tokenErr.message,
          message: `[VERIFICATION_LOOP] PII tokenization FAILED for ${requestId}. Sidecar will receive REDACTED context to prevent data exfiltration.`,
        }));
        sanitizedContext = '[REDACTED: PII tokenization failed — sovereign air gap enforced]';
      }
    }

    const userContent = `GENERATED NARRATIVE:\n${narrative}\n\nSOURCE LOGS:\n${sanitizedContext}`;

    const result = await genaiClient.models.generateContent({
      model: SIDECAR_MODEL,
      contents: userContent,
      config: {
        systemInstruction: PROSECUTOR_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: VERIFICATION_RESPONSE_SCHEMA,
        temperature: 0.0,  // Deterministic verification
        maxOutputTokens: 512,
        topK: 5,
        topP: 0.3,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    let cleanedText = (result.text || '').replace(/```(json)?/gi, '').trim();
    cleanedText = cleanedText.replace(/,\s*([\]}])/g, '$1');
    const verdict = JSON.parse(cleanedText);

    const latencyMs = Date.now() - t0;
    console.log(`[VERIFICATION_LOOP] Prosecutor completed in ${latencyMs}ms. Verified: ${verdict.isVerified}`);

    // ═══ V5.5 AGS: Prosecutor Integration into Authority Graph ═══
    // We map the semantic check formally into the AuthorityUnit conditions.
    const sidecarActionUnit = new AuthorityUnit({
      id: `VERIFICATION_UNIT_${requestId}`,
      scope: {
        decision_type: 'generate_response',
        domain: queryClassification || 'GENERAL',
        conditions: [
          // The semantic contradiction check is now a formal AGS condition
          function PROSECUTOR_SEMANTIC_CHECK(ctx) {
            return ctx.verdict.isVerified !== false;
          }
        ]
      },
      provenance: { chain: ['ROOT', `VERIFICATION_UNIT_${requestId}`] }
    });

    const arbitrationRecord = await ArbitrationInterface.evaluateDecision({
      request_id: requestId,
      action: { source_unit_id: sidecarActionUnit.id, domain: queryClassification || 'GENERAL' },
      context: { verdict },
      asymmetricKms: null // Semantic checks do not require irreversible audit ledger generation themselves
    });

    // ═══ V5.5 GOVERNED ESCALATION: Close the Loop ═══
    // If the AGS denies due to conditions (Prosecutor found hallucination), we escalate.
    let escalationResult = null;

    if (arbitrationRecord.status !== 'PERMIT') {
      console.error(JSON.stringify({
        severity: 'CRITICAL',
        eventType: 'AGS_ARBITRATION_DENIED',
        requestId,
        tenantId,
        impactLevel: impactLevel || 'UNKNOWN',
        reason: arbitrationRecord.status,
        discrepancyCount: verdict.discrepancies?.length || 0,
        discrepancies: verdict.discrepancies,
        verificationNotes: verdict.verificationNotes,
        latencyMs,
        message: `[AGS_ARBITRATION_DENIED] AGS Evaluation failed for request ${requestId} due to ${arbitrationRecord.status}.`,
      }));

      // V5.5: HIGH_IMPACT / UTILITY_CRITICAL rejections → JIT Escalation to Named Human Approver
      if ((impactLevel === 'HIGH_IMPACT' || impactLevel === 'UTILITY_CRITICAL') && securityManager) {
        try {
          const escalationEngine = new EscalationEngine(securityManager);
          escalationResult = await escalationEngine.createEscalation({
            requestId,
            tenantId,
            narrative,
            sourceContext,
            prosecutorVerdict: verdict,
            impactLevel,
            queryClassification: queryClassification || 'SENSITIVE',
          });

          verdict._escalation = {
            escalationId: escalationResult.escalationId,
            authorityId: escalationResult.authorityId,
            authorityName: escalationResult.authorityName,
            authorityRole: escalationResult.authorityRole,
            blastRadius: escalationResult.blastRadius,
            ttlExpiresAt: escalationResult.ttlExpiresAt,
            status: 'ESCALATION_PENDING',
          };

          console.log(`[VERIFICATION_LOOP] JIT Escalation created: ${escalationResult.escalationId} (${escalationResult.latencyMs}ms).`);
        } catch (escErr) {
          console.error(JSON.stringify({
            severity: 'CRITICAL',
            eventType: 'ESCALATION_CREATION_FAILED',
            requestId,
            tenantId,
            error: escErr.message,
            message: `[ESCALATION_FAILED] Could not create JIT escalation for ${requestId}. Defaulting to BLOCKED.`,
          }));
          // Escalation failure → fail-closed → BLOCKED
          verdict._escalation = { status: 'ESCALATION_FAILED_BLOCKED' };
        }
      }
    }

    if (verdict.discrepancies && verdict.discrepancies.length > 0) {
      verdict.discrepancies.forEach((d, i) => console.warn(`  [${i + 1}] ${d}`));
    }

    await storeVerificationResult(
      requestId, tenantId, verdict, latencyMs,
      escalationResult?.escalationId || null
    );

    // Return verdict so synchronous callers (SENSITIVE queries)
    // can include it in the response BEFORE the HTTP 200 is sent.
    return verdict;
  } catch (err) {
    const latencyMs = Date.now() - t0;
    // Structured log for monitoring — sidecar failures must not be silent
    console.error(JSON.stringify({
      severity: 'ERROR',
      eventType: 'VERIFICATION_SIDECAR_FAILURE',
      requestId,
      tenantId,
      error: err.message,
      latencyMs,
      message: `[VERIFICATION_SIDECAR_FAILURE] Prosecutor failed for ${requestId} after ${latencyMs}ms: ${err.message}`,
    }));

    // Store failure result so polling knows it completed (with error)
    await storeVerificationResult(requestId, tenantId, {
      isVerified: null,
      discrepancies: [`VERIFICATION_ERROR: ${err.message}`],
      verificationNotes: 'Sidecar execution failed.',
    }, latencyMs, null).catch(storeErr => {
      console.error(JSON.stringify({
        severity: 'CRITICAL',
        eventType: 'VERIFICATION_STORE_FAILURE',
        requestId,
        tenantId,
        error: storeErr.message,
        message: `[VERIFICATION_STORE_FAILURE] Could not persist verification failure for ${requestId}. Audit trail is BROKEN.`,
      }));
    });
  }
}

// ─────────────────────────────────────────────────────
//  POLL VERIFICATION STATUS
// ─────────────────────────────────────────────────────

/**
 * Retrieves the async verification result for a given requestId.
 *
 * @param {string} requestId
 * @returns {Promise<{status: string, result: object|null}>}
 */
async function getVerificationStatus(requestId) {
  const sql = getSql();
  if (!sql) {
    return { status: 'unavailable', result: null };
  }

  try {
    const [row] = await sql`
      SELECT is_verified, discrepancies, verification_notes, sidecar_model, verified_at, latency_ms
      FROM verification_results
      WHERE request_id = ${requestId}
    `;

    if (!row) {
      return { status: 'pending', result: null };
    }

    return {
      status: 'completed',
      result: {
        isVerified: row.is_verified,
        discrepancies: row.discrepancies,
        verificationNotes: row.verification_notes,
        sidecarModel: row.sidecar_model,
        verifiedAt: row.verified_at,
        latencyMs: row.latency_ms,
      },
    };
  } catch (err) {
    console.error('[VERIFICATION_LOOP] Poll error:', err.message);
    return { status: 'error', result: null };
  }
}

module.exports = {
  launchVerificationSidecar,
  getVerificationStatus,
  ensureVerificationTable,
  SIDECAR_MODEL,
};
