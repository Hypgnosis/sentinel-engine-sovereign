/**
 * SENTINEL ENGINE V5.0 — Deterministic Logic Layer (DLL)
 * ═══════════════════════════════════════════════════════════
 * Hard-coded safety intercepts that override AI behavior.
 *
 * V5.0 CHANGES:
 * ─────────────────────────────────────────────────────────
 *   - Removed all PII regex patterns (redactPII). PII masking
 *     is now exclusively handled by SecurityManager.tokenizePII()
 *     using HMAC-SHA256 one-way hashing. The DLL is NOT the
 *     source of truth for data sovereignty — the SecurityManager is.
 *   - Retained procedural intercept rules (Vessel Risk, Margin).
 *     These are consumed via IntegrityController.checkProceduralRules().
 */

/**
 * Intercepts the query and context to enforce deterministic rules.
 *
 * @param {string} query - User query
 * @param {string} context - RAG context
 * @returns {object|null} Override result or null to continue with AI
 */
function dllInterceptor(query, context) {
  const normalizedQuery = query.toLowerCase();
  const normalizedContext = context.toLowerCase();

  // Rule 1: High vessel risk fallback
  // Logic: If query mentions 'sea' and context contains 'vessel_risk: high'
  if (normalizedQuery.includes('sea') && normalizedContext.includes('"vessel_risk":"high"')) {
    return {
      narrative: "### DETERMINISTIC OVERRIDE: HIGH VESSEL RISK\n\nOperational intelligence indicates **vessel_risk: HIGH** for requested sea lanes. Sentinel DLL Directive 21.a is now active.\n\n**Mandatory Decision:** Switch transport mode to **Rail/Land Gateway** immediately. Sea transit is suspended for this lane until risk levels normalize.\n\n**Details:** Potential threat detected in AIS patterns. Security protocol escalation level 4.",
      metrics: [
        { label: "Vessel Risk", value: "HIGH", trend: "stable", confidence: 1.0 },
        { label: "Override Directive", value: "DLL-21a", trend: "stable", confidence: 1.0 }
      ],
      confidence: 1.0,
      sources: ["Sentinel DLL Safety Interceptor"],
      dataAuthority: "SENTINEL_DLL_OVERRIDE"
    };
  }

  // Rule 2: Margin Level Risk
  if (normalizedContext.includes('"margin"') && extractMinMargin(context) < 0.05) {
    return {
      narrative: "### DETERMINISTIC OVERRIDE: CRITICAL MARGIN ALERT\n\nSentinel DLL has detected margin levels below the 5% safety threshold. Lane-level risk escalation is mandatory.\n\n**Mandatory Decision:** Escalate to human review immediately. Automated approval is suspended for this lane.",
      metrics: [
        { label: "Margin Level", value: `${(extractMinMargin(context) * 100).toFixed(1)}%`, trend: "down", confidence: 1.0 },
        { label: "Override Directive", value: "DLL-MARGIN-GATE", trend: "stable", confidence: 1.0 }
      ],
      confidence: 1.0,
      sources: ["Sentinel DLL Safety Interceptor"],
      dataAuthority: "SENTINEL_DLL_OVERRIDE"
    };
  }

  return null; // No override
}

/**
 * Utility to extract minimum margin from context JSON strings.
 * @param {string} context - RAG context string
 * @returns {number} Minimum margin value found, or 1.0 if none
 */
function extractMinMargin(context) {
  const matches = context.match(/"margin":\s*(\d*\.?\d+)/g);
  if (!matches) return 1.0;
  const margins = matches.map(m => parseFloat(m.split(':')[1]));
  return Math.min(...margins);
}

module.exports = {
  dllInterceptor,
  extractMinMargin,
};
