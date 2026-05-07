/**
 * SENTINEL ENGINE v4.1 — Instance Configuration Loader
 * ═══════════════════════════════════════════════════════
 * Reads the ACTIVE_INSTANCE environment variable and loads the
 * corresponding industry_config.json from /instances/<id>/.
 *
 * This is the bridge between the single-core inference engine
 * and the multi-industry expansion architecture.
 *
 * Usage in Cloud Function:
 *   const { loadInstanceConfig } = require('./instance-loader');
 *   const instanceConfig = loadInstanceConfig();
 *   // instanceConfig.cognition.systemPrompt  → industry-specific prompt
 *   // instanceConfig.database.datasetId      → industry-specific BQ dataset
 *   // instanceConfig.cognition.complexTriggers → industry-specific routing
 *
 * Deploy with:
 *   gcloud functions deploy sentinelInference \
 *     --set-env-vars="ACTIVE_INSTANCE=energy-cfe"
 *
 * Default: Falls back to 'logistics' (original Sentinel behavior).
 * ═══════════════════════════════════════════════════════
 */

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────
//  DEFAULT LOGISTICS CONFIG (Backward Compatibility)
// ─────────────────────────────────────────────────────
// If no instance is specified, the engine behaves exactly as v4.0 —
// logistics-only, English, sentinel_warehouse dataset.

const LOGISTICS_DEFAULT = {
  industry: 'Logistics & Supply Chain',
  client: 'Global',
  version: '4.1.0-logistics',
  instanceId: 'logistics',
  theme: {
    accentColor: '#00E5FF',
    themeMode: 'sentinel-dark',
    fontFamily: 'JetBrains Mono',
  },
  database: {
    projectId: 'ha-sentinel-core-v21',
    datasetId: 'sentinel_warehouse',
    tables: [
      { id: 'freight_indices',       label: 'Freight Indices',      displayColumns: ['source', 'route_origin', 'route_destination', 'rate_usd', 'trend', 'narrative_context', 'ingested_at'] },
      { id: 'port_congestion',       label: 'Port Congestion',      displayColumns: ['source', 'port_name', 'vessels_at_anchor', 'avg_wait_days', 'severity_level', 'narrative_context', 'ingested_at'] },
      { id: 'maritime_chokepoints',  label: 'Maritime Chokepoints', displayColumns: ['source', 'chokepoint_name', 'status', 'vessel_queue', 'transit_delay_hours', 'narrative_context', 'ingested_at'] },
      { id: 'risk_matrix',           label: 'Risk Matrix',          displayColumns: ['source', 'risk_factor', 'severity', 'probability', 'impact_window', 'narrative_context', 'ingested_at'] },
    ],
  },
  cognition: {
    systemPrompt: null, // Uses the hardcoded buildSystemPrompt in index.js
    language: 'en-US',
    ttsVoice: 'en-US-Journey-F',
    ttsLanguageCode: 'en-US',
    complexTriggers: [
      'deep analysis', 'compare', 'forecast', 'comprehensive report',
      'strategic', 'risk matrix', '5 year', 'profound', 'multi-modal',
      'long-term', 'scenario planning', 'regression', 'correlation',
      'year-over-year', 'supply chain redesign', 'total cost of ownership',
    ],
    modelFallback: 'gemini-1.5-flash',
  },
  retrievalStrategies: ['INTERNAL_VECTOR', 'LEGACY_FS', 'EXTERNAL_PLUGINS', 'EXTERNAL_API'],
  external_plugins: ['marinetraffic', 'xeneta', 'freightos'], // Example plugins for default logistics
  ui: {
    dashboardTitle: 'Sentinel Engine',
    dashboardSubtitle: 'Sovereign Intelligence Layer',
    heroScenarios: [],
  },
};

// ─────────────────────────────────────────────────────
//  INSTANCE LOADER
// ─────────────────────────────────────────────────────

let _cachedConfig = null;

/**
 * Loads and caches the active instance configuration.
 *
 * Resolution order:
 *   1. Environment variable ACTIVE_INSTANCE (e.g., "energy-cfe")
 *   2. File: ../instances/<ACTIVE_INSTANCE>/industry_config.json
 *   3. Fallback: built-in LOGISTICS_DEFAULT
 *
 * @returns {object} The resolved industry configuration
 */
function loadInstanceConfig() {
  if (_cachedConfig) return _cachedConfig;

  const activeInstance = process.env.ACTIVE_INSTANCE || 'logistics';

  if (activeInstance === 'logistics') {
    console.log(JSON.stringify({
      severity: 'INFO',
      event: 'INSTANCE_LOADER_DEFAULT',
      instance: 'logistics',
      message: 'No ACTIVE_INSTANCE set — using built-in logistics defaults.',
      timestamp: new Date().toISOString(),
    }));
    _cachedConfig = LOGISTICS_DEFAULT;
    return _cachedConfig;
  }

  // Try to load from the instances directory
  const configPath = path.resolve(__dirname, '..', 'instances', activeInstance, 'industry_config.json');

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);

    console.log(JSON.stringify({
      severity: 'INFO',
      event: 'INSTANCE_LOADER_SUCCESS',
      instance: activeInstance,
      industry: config.industry,
      datasetId: config.database?.datasetId,
      timestamp: new Date().toISOString(),
    }));

    _cachedConfig = config;
    return _cachedConfig;
  } catch (err) {
    console.error(JSON.stringify({
      severity: 'ERROR',
      event: 'INSTANCE_LOADER_FAILURE',
      instance: activeInstance,
      configPath,
      error: err.message,
      message: 'Failed to load instance config — falling back to logistics defaults.',
      timestamp: new Date().toISOString(),
    }));

    _cachedConfig = LOGISTICS_DEFAULT;
    return _cachedConfig;
  }
}

/**
 * Returns the BigQuery table configurations for the active instance.
 * These are used by vectorSearchRetrieval to know which tables to query.
 *
 * @param {object} config - The loaded instance configuration
 * @returns {Array<{table: string, displayColumns: string[], label: string}>}
 */
function getTableConfigs(config) {
  if (!config?.database?.tables) {
    // Fallback to hardcoded logistics tables
    return null;
  }

  return config.database.tables.map(t => ({
    table: t.id,
    displayColumns: t.displayColumns || [],
    label: t.label,
  }));
}

/**
 * Builds the industry-specific system prompt.
 * If the instance provides a custom systemPrompt in cognition,
 * it wraps it with the standard Sentinel framing.
 * Otherwise returns null to signal "use the hardcoded logistics prompt."
 *
 * @param {object} config - The loaded instance configuration
 * @param {string} contextPayload - The RAG context block
 * @param {string} dataAuthority - The data source label
 * @returns {string|null}
 */
function buildInstanceSystemPrompt(config, contextPayload, dataAuthority) {
  if (!config?.cognition?.systemPrompt) {
    return null; // Use the original hardcoded logistics prompt
  }

  return `SYSTEM: Sentinel Engine — Sovereign Intelligence Layer.
STATUS: GCP-Native Infrastructure ${config.version} (Data Moat Architecture).
ARCHITECT: High ArchyTech Solutions.
INDUSTRY: ${config.industry}
CLIENT: ${config.client}
DATA AUTHORITY: ${dataAuthority}

OPERATIONAL CONTEXT (STRUCTURED DATA — VECTORIZED RETRIEVAL):
${contextPayload}

INSTRUCTION:
${config.cognition.systemPrompt}

RESPONSE FORMAT DIRECTIVES:
1. The "narrative" field must use markdown with bullet points, highlighted metrics, and actionable recommendations.
2. The "metrics" field must extract the most relevant KPIs from your analysis.
3. The "confidence" field is your certainty (0.85–1.0) based on data coverage.
4. The "sources" field lists the data sources used.
5. The "dataAuthority" field MUST be exactly: "${dataAuthority}".

DATA INTEGRITY MANDATE:
If the operational context above is empty or insufficient to answer the query,
you MUST explicitly state that data coverage is limited. Set the confidence
field to reflect actual data coverage (0.0–1.0). Never fabricate data points,
metrics, or trends that are not grounded in the provided context.

OUTPUT FORMAT: Strict JSON following the provided schema.
`;
}

/**
 * Returns the industry-specific complex triggers for the cognitive router.
 *
 * @param {object} config - The loaded instance configuration
 * @returns {string[]}
 */
function getComplexTriggers(config) {
  return config?.cognition?.complexTriggers || LOGISTICS_DEFAULT.cognition.complexTriggers;
}

/**
 * Returns the TTS voice configuration for the active instance.
 *
 * @param {object} config - The loaded instance configuration
 * @returns {{ languageCode: string, voiceName: string }}
 */
function getTTSConfig(config) {
  return {
    languageCode: config?.cognition?.ttsLanguageCode || 'en-US',
    voiceName: config?.cognition?.ttsVoice || 'en-US-Journey-F',
  };
}

/**
 * Returns the configured retrieval strategies.
 *
 * @param {object} config - The loaded instance configuration
 * @returns {string[]} e.g., ['INTERNAL_VECTOR', 'EXTERNAL_API']
 */
function getRetrievalStrategies(config) {
  return config?.retrievalStrategies || LOGISTICS_DEFAULT.retrievalStrategies;
}

/**
 * Returns the configured external plugins.
 *
 * @param {object} config - The loaded instance configuration
 * @returns {string[]} e.g., ['marinetraffic', 'xeneta']
 */
function getExternalPlugins(config) {
  return config?.external_plugins || LOGISTICS_DEFAULT.external_plugins;
}

/**
 * Invalidates the cached config for testing or hot-reload.
 */
function invalidateCache() {
  _cachedConfig = null;
}

module.exports = {
  loadInstanceConfig,
  getTableConfigs,
  buildInstanceSystemPrompt,
  getComplexTriggers,
  getTTSConfig,
  getRetrievalStrategies,
  getExternalPlugins,
  invalidateCache,
  LOGISTICS_DEFAULT,
};
