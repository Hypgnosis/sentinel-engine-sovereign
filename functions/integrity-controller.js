/**
 * SENTINEL ENGINE V5.0 — Integrity Controller
 * ═══════════════════════════════════════════════════════════
 * Consolidated truth-enforcement layer. This is the SINGLE point
 * through which all inference output passes before client delivery.
 *
 * V5.0 DESIGN RULE:
 *   If Zod validation fails after recursive retry, the data is
 *   STRUCTURALLY UNVERIFIABLE. The controller MUST NOT serve it.
 *   Returning a typed 422 is the correct failure mode — not a
 *   generic 500, and not "graceful degradation" that shifts
 *   validation burden to the frontend.
 *
 * Pipeline: DLL Rules → Zod Validation → PII Tokenization
 * ═══════════════════════════════════════════════════════════
 */

const { dllInterceptor } = require('./dll');
const { validateInferenceResponse } = require('./schemas');

/**
 * Typed error for truth audit failures.
 * Caught by the handler to return HTTP 422 Unprocessable Entity.
 *
 * CRITICAL DISTINCTION FOR MONITORING:
 *   - SCHEMA_VALIDATION_FAILED: The LLM produced structurally broken output.
 *     This is a SYSTEM ERROR. Alert the on-call engineer.
 *   - INTEGRITY_GATE_REJECTION: The engine deliberately rejected a response
 *     that was structurally valid but substantively empty or misleading.
 *     This is the system WORKING CORRECTLY. Log as a protective intervention.
 */
class TruthAuditError extends Error {
  /**
   * @param {string[]} failedModules - Schema modules that failed validation
   * @param {object} errors - Raw Zod error details
   * @param {string} [auditCode='SCHEMA_VALIDATION_FAILED'] - Monitoring classification
   */
  constructor(failedModules, errors, auditCode = 'SCHEMA_VALIDATION_FAILED') {
    super(`Schema validation failed for modules: ${failedModules.join(', ')}`);
    this.name = 'TruthAuditError';
    this.failedModules = failedModules;
    this.errors = errors;
    this.httpStatus = 422;
    this.auditCode = auditCode;
  }
}

class IntegrityController {
  /** @type {import('./security-manager').SecurityManager} */
  #securityManager;

  /**
   * @param {import('./security-manager').SecurityManager} securityManager
   *   The SecurityManager instance initialized at global scope in index.js.
   *   Must be fully constructed (keys resolved) before use.
   */
  constructor(securityManager) {
    if (!securityManager) {
      throw new Error(
        '[INTEGRITY_CONTROLLER] SecurityManager instance is required. ' +
        'Ensure it is initialized at boot and injected via constructor.'
      );
    }
    this.#securityManager = securityManager;
  }

  /**
   * PHASE 1: Pre-Inference Procedural Rules.
   * Evaluates DLL deterministic intercepts (Vessel Risk, Margin Gate).
   * If a rule triggers, returns the override response — the AI is bypassed entirely.
   *
   * @param {string} query - User query
   * @param {string} contextPayload - RAG context string
   * @returns {object|null} Override result, or null to continue with AI inference
   */
  checkProceduralRules(query, contextPayload) {
    return dllInterceptor(query, contextPayload);
  }

  /**
   * PHASE 2: Final Truth Audit — Unified pipeline for post-inference validation.
   *
   * Executes in strict order:
   *   1. Procedural DLL post-processing (reserved for future rules)
   *   2. Zod schema validation (final enforcement gate)
   *   3. SecurityManager.tokenizePII() sweep on all narrative fields
   *
   * This is the LAST gate before data leaves the engine.
   * If Zod fails here, the data is REJECTED — never served.
   *
   * @param {object} dataObject - Parsed inference response from Gemini
   * @param {string} [tenantId] - Tenant ID for per-tenant PII salt
   * @param {object} [context] - Optional request context for future DLL post-rules, can include industryDomain
   * @param {import('./security-manager').SecurityManager} [securityManagerOverride] - Optional SM override for testing
   * @returns {Promise<object>} Audited, PII-scrubbed response
   * @throws {TruthAuditError} If Zod validation fails — NEVER serves unverified data
   */
  async finalTruthAudit(dataObject, tenantId = null, context = null, securityManagerOverride = null) {
    const sm = securityManagerOverride || this.#securityManager;

    const domain = context?.industryDomain || 'LOGISTICS';

    // ── Step 1: Procedural DLL post-processing (future expansion point) ──
    // Currently no post-inference DLL rules. The pre-inference rules
    // (checkProceduralRules) handle all deterministic overrides.

    // ── Step 2: Zod Schema Validation (Final Safety Gate) ──
    // If this fails, the AI produced structurally unverifiable output.
    // NEVER serve it. Throw a typed error → handler returns 422.
    
    let isPartial = false;
    if (context?.contextPayload && context.contextPayload.includes('[WARNING: External Data Authority')) {
      console.warn('[INTEGRITY_CONTROLLER] Flagging inference as PARTIAL due to missing external authority.');
      isPartial = true;
    }

    const validation = validateInferenceResponse(dataObject, domain, isPartial);
    if (!validation.valid) {
      console.error(
        `[TRUTH_AUDIT_REJECTED] Zod schema failed post-retry. ` +
        `Modules: ${validation.failedModules.join(', ')}. ` +
        `Errors: ${JSON.stringify(validation.errors)}`
      );
      throw new TruthAuditError(validation.failedModules, validation.errors);
    }

    let audited = validation.result;

    if (isPartial) {
      audited._verificationPartial = true;

      // ── Confidence Decay: Hard-cap to 0.50 on partial data ──
      // The LLM must NOT self-report high confidence when external
      // data authority is missing. A 0.95 confidence on 25% of the
      // intended data is a Decision Failure, not a Success.
      const PARTIAL_CONFIDENCE_CAP = 0.50;
      if (typeof audited.confidence === 'number' && audited.confidence > PARTIAL_CONFIDENCE_CAP) {
        console.warn(
          `[INTEGRITY_CONTROLLER] Confidence decay: ${audited.confidence} → ${PARTIAL_CONFIDENCE_CAP} (partial data authority)`
        );
        audited.confidence = PARTIAL_CONFIDENCE_CAP;
      }

      // ── Narrative Substance Gate ──
      // Catch the "Fail-Silent" trap: if the LLM generated a
      // non-committal placeholder narrative under partial context,
      // reject it. A narrative under 50 chars with no actionable
      // content is not intelligence — it's an empty plate.
      const narrative = audited.executiveAction?.narrative || '';
      if (narrative.length < 50) {
        console.error(
          `[INTEGRITY_CONTROLLER] Narrative substance gate FAILED. ` +
          `Length=${narrative.length}. Partial context produced empty intelligence.`
        );
        throw new TruthAuditError(
          ['executiveAction'],
          { executiveAction: ['Narrative too short under partial data state. Minimum 50 chars required.'] },
          'INTEGRITY_GATE_REJECTION'
        );
      }
    }

    // ── Step 3: PII Tokenization (HMAC-SHA256, irreversible) ──
    // Sweep all narrative fields for SSN, CC, and Subject ID patterns.
    // Uses per-tenant salt to prevent cross-tenant rainbow table attacks.
    if (audited.narrative) {
      audited.narrative = await sm.tokenizePII(audited.narrative, tenantId);
    }

    if (audited.executiveAction && audited.executiveAction.narrative) {
      audited.executiveAction.narrative = await sm.tokenizePII(
        audited.executiveAction.narrative, tenantId
      );
    }

    // Sweep recommendation text for PII leakage
    if (audited.executiveAction && Array.isArray(audited.executiveAction.recommendations)) {
      for (let i = 0; i < audited.executiveAction.recommendations.length; i++) {
        const rec = audited.executiveAction.recommendations[i];
        if (rec.action) {
          audited.executiveAction.recommendations[i].action = await sm.tokenizePII(rec.action, tenantId);
        }
      }
    }

    return audited;
  }
}

module.exports = { IntegrityController, TruthAuditError };

