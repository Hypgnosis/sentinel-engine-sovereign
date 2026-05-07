/**
 * SENTINEL ENGINE V4.9-RC — Schema Decomposition (Zod)
 * ═══════════════════════════════════════════════════════════
 * Three composable sub-schemas that form the InferenceResponse.
 * Each can be independently validated and retried if generation
 * fails Zod validation.
 *
 * Sub-Schemas:
 *   1. GeographySchema     — Regions, corridors, geospatial data
 *   2. RiskMatrixSchema    — Threats, probabilities, mitigations
 *   3. ExecutiveActionSchema — Narrative, recommendations, metrics
 *
 * Also exports Gemini-compatible JSON Schema objects for use
 * with the `responseSchema` config in generateContent().
 * ═══════════════════════════════════════════════════════════
 */

const { z } = require('zod');

// ─────────────────────────────────────────────────────
//  SUB-SCHEMA 1: Geography
// ─────────────────────────────────────────────────────

const RegionSchema = z.object({
  name: z.string().describe('Region or port name'),
  coordinates: z.string().optional().describe('Lat/Lon if available'),
  congestionLevel: z.enum(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']).optional(),
  portStatus: z.string().optional().describe('Operational status'),
});

const CorridorSchema = z.object({
  origin: z.string().describe('Origin port or region'),
  destination: z.string().describe('Destination port or region'),
  transitDays: z.number().optional().describe('Average transit time in days'),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
});

const GeographySchema = z.object({
  regions: z.array(RegionSchema).max(5).default([]).describe('Affected regions/ports'),
  corridors: z.array(CorridorSchema).max(3).default([]).describe('Active trade corridors'),
});

// ─────────────────────────────────────────────────────
//  SUB-SCHEMA 2: Risk Matrix
// ─────────────────────────────────────────────────────

const RiskFactorSchema = z.object({
  name: z.string().describe('Risk factor identifier'),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  probability: z.number().min(0).max(1).describe('Probability as float 0-1'),
  impactWindow: z.string().optional().describe('Time horizon for impact'),
  mitigationStrategy: z.string().optional().describe('Recommended mitigation'),
});

const RiskMatrixSchema = z.object({
  factors: z.array(RiskFactorSchema).max(5).default([]).describe('Identified risk factors'),
  overallRisk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
});

// ─────────────────────────────────────────────────────
//  SUB-SCHEMA 3: Executive Action
// ─────────────────────────────────────────────────────

const RecommendationSchema = z.object({
  action: z.string().describe('Recommended action'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  deadline: z.string().optional().describe('Action deadline or urgency'),
  confidence: z.number().min(0).max(1).optional(),
});

const MetricSchema = z.object({
  label: z.string(),
  value: z.string(),
  trend: z.enum(['up', 'down', 'stable']).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ExecutiveActionSchema = z.object({
  classification: z.enum(['SENSITIVE', 'HIGH_IMPACT', 'ROUTINE']).describe('Query classification'),
  decision: z.enum(['permit', 'deny', 'escalate', 'attenuate']).describe('AGS decision mapping'),
  rationale: z.string().describe('Reasoning behind the decision'),
  monotonic_reduction_active: z.boolean().describe('Whether monotonic reduction is active'),
  eu_ai_act_compliance: z.object({
    risk_tier: z.enum(['UNACCEPTABLE', 'HIGH', 'LIMITED', 'MINIMAL']),
    compliance_markers: z.array(z.string()),
    human_oversight_status: z.enum(['REQUIRED', 'ACTIVE', 'DELEGATED']),
    transparency_label: z.string()
  }).describe('EU AI Act compliance markers'),
  audit_evidence_id: z.string().describe('Cryptographic audit trail ID'),
  narrative: z.string().optional().describe('Decision summary. No markdown headers.'),
  recommendations: z.array(RecommendationSchema).max(5).default([]),
  metrics: z.array(MetricSchema).max(3).default([]),
});

// ─────────────────────────────────────────────────────
//  COMPOSITE: Full InferenceResponse
// ─────────────────────────────────────────────────────

const InferenceResponseSchema = z.object({
  geography: GeographySchema.optional().default({ regions: [], corridors: [] }),
  riskMatrix: RiskMatrixSchema.optional().default({ factors: [], overallRisk: 'MEDIUM' }),
  executiveAction: ExecutiveActionSchema,
  confidence: z.number().min(0).max(1).describe('Overall confidence 0.0-1.0'),
  sources: z.array(z.string()).max(3).describe('Data provenance'),
  dataAuthority: z.string().optional(),
});

// ─────────────────────────────────────────────────────
//  GEMINI-COMPATIBLE JSON SCHEMAS
//  Used with responseSchema in generateContent()
// ─────────────────────────────────────────────────────

const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    geography: {
      type: 'OBJECT',
      description: 'Geographic context for the decision.',
      properties: {
        regions: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
              coordinates: { type: 'STRING' },
              congestionLevel: { type: 'STRING' },
              portStatus: { type: 'STRING' },
            },
            required: ['name'],
          },
        },
        corridors: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              origin: { type: 'STRING' },
              destination: { type: 'STRING' },
              transitDays: { type: 'NUMBER' },
              riskLevel: { type: 'STRING' },
            },
            required: ['origin', 'destination'],
          },
        },
      },
    },
    riskMatrix: {
      type: 'OBJECT',
      description: 'Risk assessment matrix.',
      properties: {
        factors: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
              severity: { type: 'STRING' },
              probability: { type: 'NUMBER', minimum: 0, maximum: 1 },
              impactWindow: { type: 'STRING' },
              mitigationStrategy: { type: 'STRING' },
            },
            required: ['name', 'severity', 'probability'],
          },
        },
        overallRisk: { type: 'STRING' },
      },
    },
    executiveAction: {
      type: 'OBJECT',
      description: 'Executive decision summary.',
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
        audit_evidence_id: { type: 'STRING' },
        narrative: { type: 'STRING' },
        recommendations: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              action: { type: 'STRING' },
              priority: { type: 'STRING', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
              deadline: { type: 'STRING' },
              confidence: { type: 'NUMBER' },
            },
            required: ['action', 'priority'],
          },
        },
        metrics: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              label: { type: 'STRING' },
              value: { type: 'STRING' },
              trend: { type: 'STRING', enum: ['up', 'down', 'stable'] },
              confidence: { type: 'NUMBER' },
            },
            required: ['label', 'value'],
          },
        },
      },
      required: ['classification', 'decision', 'rationale', 'monotonic_reduction_active', 'eu_ai_act_compliance', 'audit_evidence_id'],
    },
    confidence: { type: 'NUMBER', minimum: 0, maximum: 1, description: 'Overall confidence as float 0.0-1.0.' },
    sources: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Maximum 3 data sources.' },
    dataAuthority: { type: 'STRING' },
  },
  required: ['executiveAction', 'confidence', 'sources'],
};

// ─────────────────────────────────────────────────────
//  MODULE NAME MAPPING — For recursive retry targeting
// ─────────────────────────────────────────────────────

const SUB_SCHEMA_MAP = {
  geography: GeographySchema,
  riskMatrix: RiskMatrixSchema,
  executiveAction: ExecutiveActionSchema,
};

const ENERGY_SCHEMA = z.object({
  gridStatus: z.object({
    activeAlerts: z.array(z.string()).default([]),
    loadMegawatts: z.number().optional(),
    capacityMargin: z.number().optional()
  }).optional(),
  riskMatrix: RiskMatrixSchema.optional().default({ factors: [], overallRisk: 'MEDIUM' }),
  executiveAction: ExecutiveActionSchema,
  confidence: z.number().min(0).max(1).describe('Overall confidence 0.0-1.0'),
  sources: z.array(z.string()).max(3).describe('Data provenance'),
  dataAuthority: z.string().optional(),
});

const GEMINI_ENERGY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    gridStatus: {
      type: 'OBJECT',
      properties: {
        activeAlerts: { type: 'ARRAY', items: { type: 'STRING' } },
        loadMegawatts: { type: 'NUMBER' },
        capacityMargin: { type: 'NUMBER' }
      }
    },
    riskMatrix: GEMINI_RESPONSE_SCHEMA.properties.riskMatrix,
    executiveAction: GEMINI_RESPONSE_SCHEMA.properties.executiveAction,
    confidence: GEMINI_RESPONSE_SCHEMA.properties.confidence,
    sources: GEMINI_RESPONSE_SCHEMA.properties.sources,
    dataAuthority: GEMINI_RESPONSE_SCHEMA.properties.dataAuthority
  },
  required: ['executiveAction', 'confidence', 'sources']
};

// ─────────────────────────────────────────────────────
//  DEGRADED EXTENSION SCHEMAS
//  Used ONLY when _verificationPartial is detected.
//  These define exactly which fields become nullable
//  when an external adapter fails — NOT deepPartial().
//  Structural identifiers inside sub-objects remain mandatory
//  if the sub-object itself is present.
// ─────────────────────────────────────────────────────

// LOGISTICS degraded: geography and riskMatrix objects become fully optional,
// but if a region IS present, name is still required.
const DegradedLogisticsExtSchema = z.object({
  geography: GeographySchema.optional(),
  riskMatrix: RiskMatrixSchema.optional(),
});

// ENERGY degraded: gridStatus and riskMatrix objects become fully optional.
const DegradedEnergyExtSchema = z.object({
  gridStatus: z.object({
    activeAlerts: z.array(z.string()).default([]),
    loadMegawatts: z.number().optional(),
    capacityMargin: z.number().optional()
  }).optional(),
  riskMatrix: RiskMatrixSchema.optional(),
});

/**
 * The Mandatory Core: fields that MUST be present in every response,
 * regardless of partial state. An empty narrative is a system failure.
 */
const CoreSchema = z.object({
  executiveAction: ExecutiveActionSchema,
  confidence: z.number().min(0).max(1).describe('Overall confidence 0.0-1.0'),
  sources: z.array(z.string()).max(3).describe('Data provenance'),
  dataAuthority: z.string().optional(),
});

/**
 * Schema Registry resolving method.
 * Uses Tiered Enforcement: CoreSchema is ALWAYS strict.
 * Extensions use DegradedExtensionSchemas when isPartial=true,
 * preserving structural identifiers within sub-objects.
 * 
 * @param {string} domain 
 * @param {boolean} isPartial - If true, uses Degraded Extension schemas
 * @returns {object} Zod Schema
 */
function getSchemaForDomain(domain, isPartial = false) {
  if (domain === 'ENERGY') {
    const extensions = isPartial
      ? DegradedEnergyExtSchema
      : ENERGY_SCHEMA.pick({ gridStatus: true, riskMatrix: true });
    return CoreSchema.merge(extensions);
  }

  // Default: LOGISTICS or UNKNOWN
  const extensions = isPartial
    ? DegradedLogisticsExtSchema
    : InferenceResponseSchema.pick({ geography: true, riskMatrix: true });
  return CoreSchema.merge(extensions);
}

/**
 * Validates a full inference response against all sub-schemas.
 * Returns the list of modules that failed validation.
 *
 * @param {object} data - Raw parsed JSON from Gemini
 * @param {string} domain - Industry domain (LOGISTICS, ENERGY)
 * @param {boolean} isPartial - Allow missing fields for partial states
 * @returns {{ valid: boolean, result: object|null, failedModules: string[], errors: object }}
 */
function validateInferenceResponse(data, domain = 'LOGISTICS', isPartial = false) {
  const SchemaToUse = getSchemaForDomain(domain, isPartial);

  const parseResult = SchemaToUse.safeParse(data);
  if (parseResult.success) {
    return { valid: true, result: parseResult.data, failedModules: [], errors: {} };
  }

  // Identify which sub-modules failed
  const failedModules = [];
  const errors = {};

  const schemaMap = domain === 'ENERGY' ? {
      gridStatus: ENERGY_SCHEMA.shape.gridStatus,
      riskMatrix: RiskMatrixSchema,
      executiveAction: ExecutiveActionSchema,
    } : SUB_SCHEMA_MAP;

  for (const [moduleName, schema] of Object.entries(schemaMap)) {
    const moduleData = data[moduleName];
    if (moduleData) {
        // executiveAction is ALWAYS strict — it is Mandatory Core.
        // Extension modules use their original schema even in partial mode,
        // because the top-level Degraded schema already handles optionality.
        const moduleResult = schema.safeParse(moduleData);
        if (!moduleResult.success) {
          failedModules.push(moduleName);
          errors[moduleName] = moduleResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
        }
    }
  }

  // Mandatory Core checks apply regardless of isPartial status!
  if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 1) {
    failedModules.push('confidence');
    errors.confidence = ['Must be a number between 0 and 1'];
  }
  if (!Array.isArray(data.sources)) {
    failedModules.push('sources');
    errors.sources = ['Must be an array of strings'];
  }

  return { valid: false, result: null, failedModules, errors };
}

module.exports = {
  // Zod schemas
  GeographySchema,
  RiskMatrixSchema,
  ExecutiveActionSchema,
  InferenceResponseSchema,
  MetricSchema,

  // Industry Schemas
  LOGISTICS_SCHEMA: InferenceResponseSchema,
  ENERGY_SCHEMA,
  CORE_SCHEMA: CoreSchema,

  // Degraded Extension Schemas (Tiered Enforcement)
  DegradedLogisticsExtSchema,
  DegradedEnergyExtSchema,

  // Gemini schema
  GEMINI_RESPONSE_SCHEMA,
  GEMINI_ENERGY_SCHEMA,
  // Mapping
  SUB_SCHEMA_MAP,
  // Validator
  validateInferenceResponse,
  getSchemaForDomain,
};
