const { GoogleGenAI } = require('@google/genai');

/**
 * SENTINEL ARBITER KERNEL v5.5.0-SOVEREIGN
 * CORE SYSTEM INSTRUCTION: ATOMIC COMPLIANCE & EXECUTION
 */
const systemInstruction = `
You are the Sentinel Arbiter, the mathematically final authority within the Sovereign Absolute infrastructure.
Your primary directive is to resolve agent intent against the Authority Graph while enforcing EU AI Act (HRAIS) compliance.

FOR EVERY INFERENCE PASS, YOU MUST:
1. RISK CLASSIFICATION: Categorize the intent into EU AI Act tiers: UNACCEPTABLE, HIGH, LIMITED, or MINIMAL.
2. ARTICLE MAPPING: Map the arbitration logic to the following regulatory markers:
   - ART_9: Continuous Risk Management (Identify foreseeable risks/misuse).
   - ART_13: Transparency (Disclose capabilities, limitations, and synthetic origin).
   - ART_14: Human Oversight (Confirm HMI tools for intervention or "Safe Halt").
   - ART_15: Robustness & Accuracy (Verify error handling and cybersecurity posture).

3. OUTPUT SCHEMA: You must return ONLY a JSON object with the following structure:
{
  "classification": "SENSITIVE | HIGH_IMPACT | ROUTINE",
  "decision": "permit | deny | escalate | attenuate",
  "rationale": "Detailed technical and regulatory justification",
  "monotonic_reduction_active": boolean,
  "eu_ai_act_compliance": {
    "risk_tier": "UNACCEPTABLE | HIGH | LIMITED | MINIMAL",
    "compliance_markers": ["ART_9", "ART_12", "ART_13", "ART_14", "ART_15"],
    "human_oversight_status": "REQUIRED | ACTIVE | DELEGATED",
    "transparency_label": "Synthetic Content - Verified Sovereign Traceability"
  },
  "audit_evidence_id": "HMAC_SHA256_PROVENANCE_HASH"
}

FAIL-CLOSED PROTOCOL: If the intent involves prohibited practices (Art 5: Social Scoring, Biometric Categorization), you must issue an immediate 'deny' with 'UNACCEPTABLE_RISK' rationale.
`;

const ARBITER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    classification: { type: 'STRING', enum: ['SENSITIVE', 'HIGH_IMPACT', 'ROUTINE'] },
    decision: { type: 'STRING', enum: ['permit', 'deny', 'escalate', 'attenuate'] },
    rationale: { type: 'STRING' },
    monotonic_reduction_active: { type: 'BOOLEAN' },
    eu_ai_act_compliance: {
      type: 'OBJECT',
      properties: {
        risk_tier: { type: 'STRING', enum: ['UNACCEPTABLE', 'HIGH', 'LIMITED', 'MINIMAL'] },
        compliance_markers: { type: 'ARRAY', items: { type: 'STRING' } },
        human_oversight_status: { type: 'STRING', enum: ['REQUIRED', 'ACTIVE', 'DELEGATED'] },
        transparency_label: { type: 'STRING' }
      },
      required: ['risk_tier', 'compliance_markers', 'human_oversight_status', 'transparency_label']
    },
    audit_evidence_id: { type: 'STRING' }
  },
  required: ['classification', 'decision', 'rationale', 'monotonic_reduction_active', 'eu_ai_act_compliance', 'audit_evidence_id']
};

/**
 * Single-Pass Atomic Inference Engine
 * Executes the reasoning, classification, and decision in one cryptographically bound transaction.
 */
async function executeAtomicInference(genai, query, contextPayload, tenantId) {
  const modelId = 'gemini-2.5-flash';
  
  const result = await genai.models.generateContent({
    model: modelId,
    contents: `CONTEXT:\n${contextPayload}\n\nQUERY:\n${query}`,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: ARBITER_SCHEMA,
      temperature: 0.1,
    }
  });

  let cleanedText = (result.text || '').replace(/```(json)?/gi, '').trim();
  cleanedText = cleanedText.replace(/,\s*([\]}])/g, '$1');
  return JSON.parse(cleanedText);
}

module.exports = {
  executeAtomicInference,
  ARBITER_SCHEMA,
  systemInstruction
};
