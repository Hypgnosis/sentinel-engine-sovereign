/**
 * SENTINEL ENGINE V4.9-RC — Recursive Schema Retry
 * ═══════════════════════════════════════════════════════════
 * If a Gemini generation fails Zod validation for specific
 * sub-modules, this engine re-prompts ONLY the failed module
 * at Temperature 0.1 for deterministic output.
 *
 * Max 2 retries per module. If exhausted, returns a structured
 * SENTINEL_GENERIC_ADVISORY fallback to prevent frontend crash.
 * ═══════════════════════════════════════════════════════════
 */

const { SUB_SCHEMA_MAP, validateInferenceResponse } = require('./schemas');

const MAX_RETRIES_PER_MODULE = 2;

// ─────────────────────────────────────────────────────
//  GEMINI SUB-SCHEMA PROMPTS
//  Each module has a focused extraction prompt.
// ─────────────────────────────────────────────────────

const MODULE_PROMPTS = {
  geography: `You are a geographic data extractor. Extract ONLY geographic/location data from the provided context.
Return a JSON object with this exact structure:
{
  "regions": [{"name": "string", "congestionLevel": "LOW|MODERATE|HIGH|CRITICAL", "portStatus": "string"}],
  "corridors": [{"origin": "string", "destination": "string", "transitDays": number, "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL"}]
}
Maximum 5 regions and 3 corridors.`,

  riskMatrix: `You are a risk assessment specialist. Extract ONLY risk factors from the provided context.
Return a JSON object with this exact structure:
{
  "factors": [{"name": "string", "severity": "LOW|MEDIUM|HIGH|CRITICAL", "probability": 0.0-1.0, "impactWindow": "string", "mitigationStrategy": "string"}],
  "overallRisk": "LOW|MEDIUM|HIGH|CRITICAL"
}
Maximum 5 risk factors.`,

  executiveAction: `You are an executive briefing writer. Generate ONLY the executive decision summary from the provided context.
Return a JSON object with this exact structure:
{
  "narrative": "Decision summary in under 150 words. No markdown headers or bullet symbols.",
  "recommendations": [{"action": "string", "priority": "LOW|MEDIUM|HIGH|URGENT", "confidence": 0.0-1.0}],
  "metrics": [{"label": "string", "value": "string", "trend": "up|down|stable"}]
}
Maximum 5 recommendations and 3 metrics.`,
};

// ─────────────────────────────────────────────────────
//  GEMINI SUB-SCHEMAS (for responseSchema config)
// ─────────────────────────────────────────────────────

const MODULE_RESPONSE_SCHEMAS = {
  geography: {
    type: 'OBJECT',
    properties: {
      regions: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, congestionLevel: { type: 'STRING' }, portStatus: { type: 'STRING' } }, required: ['name'] } },
      corridors: { type: 'ARRAY', items: { type: 'OBJECT', properties: { origin: { type: 'STRING' }, destination: { type: 'STRING' }, transitDays: { type: 'NUMBER' }, riskLevel: { type: 'STRING' } }, required: ['origin', 'destination'] } },
    },
  },
  riskMatrix: {
    type: 'OBJECT',
    properties: {
      factors: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, severity: { type: 'STRING' }, probability: { type: 'NUMBER', minimum: 0, maximum: 1 }, impactWindow: { type: 'STRING' }, mitigationStrategy: { type: 'STRING' } }, required: ['name', 'severity', 'probability'] } },
      overallRisk: { type: 'STRING' },
    },
  },
  executiveAction: {
    type: 'OBJECT',
    properties: {
      narrative: { type: 'STRING' },
      recommendations: { type: 'ARRAY', items: { type: 'OBJECT', properties: { action: { type: 'STRING' }, priority: { type: 'STRING' }, confidence: { type: 'NUMBER', minimum: 0, maximum: 1 } }, required: ['action'] } },
      metrics: { type: 'ARRAY', items: { type: 'OBJECT', properties: { label: { type: 'STRING' }, value: { type: 'STRING' }, trend: { type: 'STRING' } }, required: ['label', 'value'] } },
    },
    required: ['narrative'],
  },
};

// ─────────────────────────────────────────────────────
//  GENERIC ADVISORY FALLBACK
// ─────────────────────────────────────────────────────

function buildGenericAdvisory(failedModules, originalErrors) {
  return {
    executiveAction: {
      narrative: 'Advisory: The intelligence engine encountered a schema validation anomaly during response synthesis. The data pipeline is operational, but the structured output could not be fully validated. Please retry your query or contact your system administrator if this persists.',
      recommendations: [
        { action: 'Retry your query with more specific parameters', priority: 'HIGH', confidence: 1.0 },
        { action: 'Check data pipeline health in the Sovereign Audit Log', priority: 'MEDIUM', confidence: 1.0 },
      ],
      metrics: [],
    },
    geography: { regions: [], corridors: [] },
    riskMatrix: { factors: [], overallRisk: 'MEDIUM' },
    confidence: 0,
    sources: ['SENTINEL_GENERIC_ADVISORY'],
    dataAuthority: 'FALLBACK_ADVISORY',
    _error: {
      code: 'SCHEMA_DECOMPOSITION_FAILURE',
      failedModules,
      errors: originalErrors,
      timestamp: new Date().toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────
//  RECURSIVE RETRY ENGINE
// ─────────────────────────────────────────────────────

/**
 * Attempts to generate a sub-module from Gemini.
 *
 * @param {object} genaiClient - Google GenAI client
 * @param {string} modelId - Model to use (e.g. 'gemini-1.5-flash')
 * @param {string} moduleName - Key in SUB_SCHEMA_MAP
 * @param {string} context - RAG context payload
 * @param {string} query - Original user query
 * @returns {Promise<object|null>} Parsed and validated module data, or null
 */
async function generateSubModule(genaiClient, modelId, moduleName, context, query) {
  const modulePrompt = MODULE_PROMPTS[moduleName];
  const moduleSchema = MODULE_RESPONSE_SCHEMAS[moduleName];

  if (!modulePrompt || !moduleSchema) {
    console.error(`[RECURSIVE_RETRY] Unknown module: ${moduleName}`);
    return null;
  }

  const systemPrompt = `${modulePrompt}\n\nCONTEXT DATA:\n${context}`;

  try {
    const result = await genaiClient.models.generateContent({
      model: modelId,
      contents: query,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: moduleSchema,
        temperature: 0.1,
        maxOutputTokens: 1024,
        topK: 10,
        topP: 0.5,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    let cleanedText = (result.text || '').replace(/```(json)?/gi, '').trim();
    cleanedText = cleanedText.replace(/,\s*([\]}])/g, '$1');
    const parsed = JSON.parse(cleanedText);

    // Validate against Zod
    const zodSchema = SUB_SCHEMA_MAP[moduleName];
    const validation = zodSchema.safeParse(parsed);

    if (validation.success) {
      console.log(`[RECURSIVE_RETRY] Module '${moduleName}' validated successfully.`);
      return validation.data;
    } else {
      console.warn(`[RECURSIVE_RETRY] Module '${moduleName}' Zod validation failed:`,
        validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      );
      return null;
    }
  } catch (err) {
    console.error(`[RECURSIVE_RETRY] Module '${moduleName}' generation error:`, err.message);
    return null;
  }
}

/**
 * Main recursive retry orchestrator.
 * Takes a partially-valid response and retries only the failed modules.
 *
 * @param {object} params
 * @param {object} params.genaiClient - Google GenAI client
 * @param {string} params.modelId - Primary model
 * @param {string} params.systemPrompt - Full system instruction
 * @param {string} params.query - User query
 * @param {string} params.context - RAG context payload
 * @param {object} params.partialResponse - The initial (possibly invalid) response
 * @param {string[]} params.failedModules - List of module names that failed
 * @returns {Promise<object>} Validated response or generic advisory
 */
async function recursiveSchemaRetry({
  genaiClient,
  modelId,
  systemPrompt,
  query,
  context,
  partialResponse,
  failedModules,
}) {
  const mergedResponse = { ...partialResponse };
  const unrecoverableModules = [];
  const allErrors = {};

  for (const moduleName of failedModules) {
    // Skip non-sub-schema failures (confidence, sources are top-level)
    if (!SUB_SCHEMA_MAP[moduleName]) {
      // Handle top-level field defaults
      if (moduleName === 'confidence') mergedResponse.confidence = 0.5;
      if (moduleName === 'sources') mergedResponse.sources = ['SENTINEL_INFERRED'];
      continue;
    }

    let recovered = false;

    for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODULE; attempt++) {
      console.log(`[RECURSIVE_RETRY] Retrying module '${moduleName}' — attempt ${attempt}/${MAX_RETRIES_PER_MODULE}`);

      const moduleData = await generateSubModule(genaiClient, modelId, moduleName, context, query);

      if (moduleData) {
        mergedResponse[moduleName] = moduleData;
        recovered = true;
        break;
      }
    }

    if (!recovered) {
      console.error(`[RECURSIVE_RETRY] Module '${moduleName}' EXHAUSTED after ${MAX_RETRIES_PER_MODULE} retries.`);
      unrecoverableModules.push(moduleName);
      allErrors[moduleName] = `Exhausted ${MAX_RETRIES_PER_MODULE} retries`;
    }
  }

  // If critical module (executiveAction) is unrecoverable, return fallback
  if (unrecoverableModules.includes('executiveAction')) {
    console.error(`[RECURSIVE_RETRY] Critical module 'executiveAction' unrecoverable. Returning generic advisory.`);
    return buildGenericAdvisory(unrecoverableModules, allErrors);
  }

  // Re-validate the merged response
  const finalValidation = validateInferenceResponse(mergedResponse);
  if (finalValidation.valid) {
    return finalValidation.result;
  }

  // If still invalid but we recovered partial data, fill defaults
  // This is the last-resort merge before giving up
  if (!mergedResponse.geography) mergedResponse.geography = { regions: [], corridors: [] };
  if (!mergedResponse.riskMatrix) mergedResponse.riskMatrix = { factors: [], overallRisk: 'MEDIUM' };

  const lastChance = validateInferenceResponse(mergedResponse);
  if (lastChance.valid) {
    return lastChance.result;
  }

  return buildGenericAdvisory(unrecoverableModules, allErrors);
}

module.exports = {
  recursiveSchemaRetry,
  generateSubModule,
  buildGenericAdvisory,
  MAX_RETRIES_PER_MODULE,
};
