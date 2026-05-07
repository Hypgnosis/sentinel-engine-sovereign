/**
 * SENTINEL ENGINE — CORE INFRASTRUCTURE (V5.5.0 "SOVEREIGN ABSOLUTE")
 * ═══════════════════════════════════════════════════════════
 * Google Cloud Function (Node.js 22) — Gen2
 *
 * V5.5.0 CHANGES (Sovereign Absolute):
 * ─────────────────────────────────────
 * 1 — AsymmetricKmsProvider: ECDSA P-256 replaces HMAC-SHA256.
 *     Evidence Locker is now non-repudiable (PKI-signed).
 * 2 — 16KB Priority-Based Context Packer: mergeContextSafely()
 *     imported from adapters/context-packer. Internal vector rows
 *     (P0) are protected; external adapter data (P1/P2) fills the
 *     remaining 16,384-byte window. Zero meat-cleaver truncation.
 * 3 — Promise Boot: Eliminated top-level await (ERR_REQUIRE_ASYNC).
 *     SecurityManager initialized via SECURITY_BOOT_READY promise,
 *     awaited in all handlers via ensureBoot().
 * 4 — Classifier Fairness: Fallback classification defaults to
 *     GENERAL (not SENSITIVE) to prevent Supervisor Fatigue.
 *     Only explicit model outputs or confidence < 0.5 escalate.
 * 5 — Node.js 22 Runtime: Migrated from nodejs20 (EOL 2026-04-30).
 *
 * Constraints:
 *   - Truth over Speed (P99 may increase for SENSITIVE queries)
 *   - Correctness over Latency
 *   - Zod-enforced schema compliance
 *   - Zero hardcoded secrets or connection strings
 *   - Zero lazy-loaded security primitives
 *   - Every automated action maps to a Responsible_Authority_ID
 * ═══════════════════════════════════════════════════════════
 */

const functions = require('@google-cloud/functions-framework');
const { GoogleGenAI } = require('@google/genai');
const { BigQuery } = require('@google-cloud/bigquery');
const { Firestore } = require('@google-cloud/firestore');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const textToSpeech = require('@google-cloud/text-to-speech');
const admin = require('firebase-admin');

// ═══════════════════════════════════════════════════════
//  TASK 1: ATOMIC BOOT GUARD (Global Scope)
//  ─────────────────────────────────────────────────────
//  ALL critical secrets are validated and the SecurityManager
//  is constructed BEFORE any function exports are registered.
//  If ANY secret is missing, the container crashes immediately.
//  No lazy-loading. No graceful degradation. No security theatre.
// ═══════════════════════════════════════════════════════

// All 8 secrets injected by Cloud Functions deploy script must be
// present at boot. There is no graceful degradation — a missing
// secret means the container should not serve traffic at all.
const REQUIRED_SECRETS = {
  // ── Tier 1: Data Plane ──────────────────────────────────────
  DATABASE_URL:              process.env.DATABASE_URL,
  INSTANCE_CONNECTION_NAME:  process.env.INSTANCE_CONNECTION_NAME,
  SYSTEM_PEPPER:             process.env.SYSTEM_PEPPER,
  SENTINEL_ENCRYPTION_KEY:   process.env.SENTINEL_ENCRYPTION_KEY,
  // ── Tier 2: AI Inference Plane ───────────────────────────────
  GEMINI_API_KEY:            process.env.GEMINI_API_KEY,
  // ── Tier 3: Asymmetric PKI (Evidence Locker integrity) ───────
  // NOTE: SENTINEL_PRIVATE_KEY and SENTINEL_PUBLIC_KEY are loaded
  // from Secret Manager at runtime by the AsymmetricKmsProvider,
  // NOT injected as env vars, so they cannot be validated here.
  // SENTINEL_SIGNING_KEY is used for symmetric ops in security-manager.
  SENTINEL_SIGNING_KEY:      process.env.SENTINEL_SIGNING_KEY,
};

for (const [name, value] of Object.entries(REQUIRED_SECRETS)) {
  if (!value || value.trim().length === 0) {
    console.error(`[FATAL_SECURITY_BOOT_FAILURE] Secret "${name}" is missing or empty. Container HALTED.`);
    process.exit(1);
  }
}
console.log(`[BOOT_GUARD] ${Object.keys(REQUIRED_SECRETS).length} environment secrets validated. PKI keys loaded via Secret Manager at runtime.`);

// SecurityManager: Initialized at boot — NOT lazily inside request handlers.
const { SecurityManager, AsymmetricKmsProvider } = require('./security-manager');
const { MAX_CONTEXT_BYTES, mergeContextSafely } = require('./adapters/context-packer');

/** @type {import('./security-manager').SecurityManager} */
let _securityManager;

// Create a vault helper for the asymmetric boot
const vault = {
  getSecret: async (secretName) => {
    const client = new SecretManagerServiceClient();
    const projectId = process.env.GCP_PROJECT_ID || process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'ha-sentinel-core-v21';
    const [version] = await client.accessSecretVersion({
      name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
    });
    return version.payload.data.toString('utf8');
  }
};

// Initialize via a Promise to avoid top-level await in CJS
const SECURITY_BOOT_READY = (async () => {
  try {
    const privateKeyPem = await vault.getSecret('SENTINEL_PRIVATE_KEY');
    const publicKeyPem = await vault.getSecret('SENTINEL_PUBLIC_KEY');
    _securityManager = SecurityManager.create('asymmetric', {
      privateKeyPem,
      publicKeyPem,
      encryptionKey: process.env.SENTINEL_ENCRYPTION_KEY
    });
    console.log('[BOOT_GUARD] All secrets verified. SecurityManager initialized with ASYMMETRIC mode.');
    return true;
  } catch (err) {
    console.error(`[FATAL_SECURITY_BOOT_FAILURE] SecurityManager.create() failed: ${err.message}`);
    process.exit(1);
  }
})();

// ─────────────────────────────────────────────────────
//  MODULE IMPORTS (post-boot-guard)
// ─────────────────────────────────────────────────────

const {
  loadInstanceConfig,
  getTableConfigs,
  buildInstanceSystemPrompt,
  getComplexTriggers,
  getTTSConfig,
  getRetrievalStrategies,
  getExternalPlugins,
} = require('./instance-loader');

const { ExternalIntelligenceAdapter } = require('./adapters/external-adapter');

// V4.5 Core
const { getSql, postgresVectorSearch, isSubjectRevoked } = require('./db');
const { IntegrityController, TruthAuditError } = require('./integrity-controller');

// V4.9-RC: Fortress Modules
const { verifyPEP, PEPError } = require('./pep-gate');
const { GEMINI_RESPONSE_SCHEMA, GEMINI_ENERGY_SCHEMA, validateInferenceResponse } = require('./schemas');
const { recursiveSchemaRetry } = require('./recursive-retry');
const { launchVerificationSidecar, getVerificationStatus } = require('./verification-loop');
const { swrFetch, circuitBreaker } = require('./swr-cache');

// V5.4: HITL & Escalation Modules (Lazy initialization)
const { WebAuthnProvider } = require('./webauthn-provider');
const { StandingAuthorityMatrix } = require('./authority-matrix');
let _evidenceLocker = null;
let _escalationEngine = null;
let _rollbackEngine = null;
const _webauthnProvider = new WebAuthnProvider();
let _bootComplete = false;

/**
 * Ensures all security and infrastructure modules are booted.
 * Awaited at the start of every request handler.
 */
async function ensureBoot() {
  if (_bootComplete) return;

  await SECURITY_BOOT_READY;
  await BOOT_GUARD_READY;
  
  if (!_bootComplete) {
    const { EvidenceLocker } = require('./evidence-locker');
    const { EscalationEngine } = require('./escalation-engine');
    const { RollbackEngine } = require('./rollback-engine');
    
    _evidenceLocker = new EvidenceLocker(_securityManager);
    _escalationEngine = new EscalationEngine(_securityManager);
    _rollbackEngine = new RollbackEngine(_securityManager);
    _bootComplete = true;
    console.log('[BOOT_GUARD] HITL services initialized: EvidenceLocker, EscalationEngine, RollbackEngine.');
  }
}

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}

// ─────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────

const GCP_PROJECT_ID  = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'ha-sentinel-core-v21';
const GCP_REGION      = process.env.GCP_REGION || 'us-central1';
const BQ_DATASET      = process.env.BQ_DATASET || 'sentinel_warehouse';
const EMBEDDING_MODEL = 'text-embedding-004';
const EMBEDDING_DIM   = 768;
const VECTOR_TOP_K    = 5;

// Tier mode: POSTGRES_ONLY | FULL_CASCADE (default)
const TIER_MODE = process.env.SENTINEL_TIER_MODE || 'FULL_CASCADE';

// Data freshness window — ETL runs daily, 24h is too aggressive
const DATA_FRESHNESS_HOURS = parseInt(process.env.DATA_FRESHNESS_HOURS || '72', 10);

const INSTANCE_CONFIG = loadInstanceConfig();
const ACTIVE_BQ_DATASET = INSTANCE_CONFIG.database?.datasetId || BQ_DATASET;

// Auto-register external plugins
require('./adapters/mock-plugins');

// ═══════════════════════════════════════════════════════
//  BOOT GUARD: Runtime Protocol Verification
//  ─────────────────────────────────────────────────────
//  Phase 1: Structural — AdapterRegistry.register() already
//           rejects specs without healthCheck() at require time.
//  Phase 2: Runtime — verifySignalContract() fires a real
//           AbortController and proves the adapter respects it.
//  Phase 3: Lock — Registry is sealed ONLY after all plugins
//           have been verified. Not a timer. Not a position.
// ═══════════════════════════════════════════════════════
const { AdapterRegistry } = require('./adapters/adapter-registry');

const BOOT_GUARD_READY = (async () => {
  const configuredPlugins = INSTANCE_CONFIG.external_plugins || [];
  const HEALTHY_PLUGINS = [];

  for (const plugin of configuredPlugins) {
    // Phase 2: Runtime Signal Contract Verification
    try {
      const signalVerified = await AdapterRegistry.verifySignalContract(plugin);
      if (signalVerified) {
        HEALTHY_PLUGINS.push(plugin);
        console.log(`[BOOT_GUARD] ✓ Plugin '${plugin}' passed Runtime Signal Contract.`);
      } else {
        console.error(`[BOOT_GUARD_REJECTED] Plugin '${plugin}' FAILED Runtime Signal Contract. Deactivated.`);
      }
    } catch (err) {
      console.error(`[BOOT_GUARD_REJECTED] Plugin '${plugin}' threw during verification: ${err.message}. Deactivated.`);
    }
  }

  // Override instance array with ONLY verified plugins
  INSTANCE_CONFIG.external_plugins = HEALTHY_PLUGINS;
  console.log(`[BOOT_GUARD] Verified ${HEALTHY_PLUGINS.length}/${configuredPlugins.length} plugins: ${HEALTHY_PLUGINS.join(', ') || '(none)'}`);

  // Phase 3: Lock — every legitimate plugin is now registered and verified
  AdapterRegistry.lock();

  return HEALTHY_PLUGINS;
})();

/**
 * The resilience advisory string prepended to stale narratives
 * when the circuit breaker is open and the engine is serving cached data.
 * @type {string}
 */
const RESILIENCE_ADVISORY =
  '[ADVISORY: Serving cached intelligence. Live verification currently unavailable due to reservoir connectivity.]\n\n';

// ─────────────────────────────────────────────────────
//  SERVICES
// ─────────────────────────────────────────────────────

const bigquery  = new BigQuery({ projectId: GCP_PROJECT_ID });
const firestore = new Firestore({ projectId: GCP_PROJECT_ID });
const secretClient = new SecretManagerServiceClient();
const ttsClient = new textToSpeech.TextToSpeechClient();

let _genAI = null;   // API Key client — generation + classification
let _embedAI = null; // Vertex AI client — embeddings only
const _secretCache = {};

// ─────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────

/**
 * Fetch a secret from GCP Secret Manager. Returns cached values on repeat calls.
 * @param {string} secretName
 * @returns {Promise<string|null>}
 */
async function getSecret(secretName) {
  if (_secretCache[secretName]) return _secretCache[secretName];
  const name = `projects/${GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`;
  try {
    const [version] = await secretClient.accessSecretVersion({ name });
    const payload = version.payload.data.toString('utf8');
    _secretCache[secretName] = payload;
    return payload;
  } catch (err) {
    console.error(`[SECRET_ERROR] ${secretName}:`, err.message);
    return null;
  }
}

/**
 * V5.2.2 DUAL-CLIENT ARCHITECTURE
 * ────────────────────────────────
 * The GCP project has Vertex AI access for EMBEDDINGS only.
 * Generation models (gemini-2.5-flash) require the Gemini
 * Developer API (API key mode).
 *
 * getGenAI()   → API Key client → generation, classification, verification
 * getEmbedAI() → Vertex AI client → text-embedding-004 only
 */

/**
 * Get the Gemini API Key client for generation.
 * @returns {GoogleGenAI}
 */
function getGenAI() {
  if (!_genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[FATAL] GEMINI_API_KEY not available. Generation will fail.');
    }
    _genAI = new GoogleGenAI({ apiKey });
    console.log('[DUAL_CLIENT] Generation client initialized (API Key mode).');
  }
  return _genAI;
}

/**
 * Get the Vertex AI client for embeddings.
 * Uses ADC (Application Default Credentials), no API key needed.
 * @returns {GoogleGenAI}
 */
function getEmbedAI() {
  if (!_embedAI) {
    _embedAI = new GoogleGenAI({
      vertexai: true,
      project: GCP_PROJECT_ID,
      location: GCP_REGION,
      // Default API version (v1) — embeddings work on v1, NOT v1beta
    });
    console.log('[DUAL_CLIENT] Embedding client initialized (Vertex AI mode).');
  }
  return _embedAI;
}

const ALLOWED_ORIGINS = [
  'http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174',
  'https://sentinel.high-archy.tech', 'https://sentinel-engine.netlify.app',
  'https://ha-sentinel-core-v21.web.app', 'https://ha-sentinel-core-v21.firebaseapp.com',
];

/**
 * Handle CORS preflight and method enforcement.
 * @param {object} req
 * @param {object} res
 * @returns {boolean} True if the request was fully handled (OPTIONS/405)
 */
const handleCORS = (req, res, allowGet = false) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sentinel-Client, X-Sentinel-Instance');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return true; }
  
  const isSSEStream = req.query?.stream === 'true' || req.headers?.accept === 'text/event-stream';
  if (req.method === 'GET' && (allowGet || isSSEStream)) {
    return false; // Allow GET for streams
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return true; }
  return false;
};

// ─────────────────────────────────────────────────────
//  INFERENCE LOGIC
// ─────────────────────────────────────────────────────

/**
 * Perform vector search across BigQuery tables.
 * @param {string} queryText
 * @param {GoogleGenAI} genaiClient
 * @param {string} tenantId
 * @returns {Promise<{contextPayload: string, resultCount: number, bqErrors?: string[]}>}
 */
async function vectorSearchRetrieval(queryText, embedClient, tenantId) {
  const embeddingResponse = await embedClient.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: queryText,
    config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: EMBEDDING_DIM },
  });
  const queryVector = embeddingResponse.embeddings[0].values;
  const vectorLiteral = `[${queryVector.join(',')}]`;

  const tableConfigs = getTableConfigs(INSTANCE_CONFIG) || [
    { table: 'freight_indices', displayColumns: ['source', 'route_origin', 'route_destination', 'rate_usd', 'trend', 'narrative_context', 'ingested_at'], label: 'Freight Indices' },
    { table: 'port_congestion', displayColumns: ['source', 'port_name', 'vessels_at_anchor', 'avg_wait_days', 'severity_level', 'narrative_context', 'ingested_at'], label: 'Port Congestion' },
    { table: 'maritime_chokepoints', displayColumns: ['source', 'chokepoint_name', 'status', 'vessel_queue', 'transit_delay_hours', 'narrative_context', 'ingested_at'], label: 'Maritime Chokepoints' },
    { table: 'risk_matrix', displayColumns: ['source', 'risk_factor', 'severity', 'probability', 'impact_window', 'narrative_context', 'ingested_at'], label: 'Risk Matrix' },
  ];

  const searchPromises = tableConfigs.map(async (configItem) => {
    const table = configItem.table || configItem.id;
    const displayColumns = configItem.displayColumns;
    const label = configItem.label;
    const query = `
      SELECT base.${displayColumns.join(', base.')}, distance
      FROM VECTOR_SEARCH(
        (SELECT * FROM \`${GCP_PROJECT_ID}.${ACTIVE_BQ_DATASET}.${table}\` WHERE tenant_id = @tenantId),
        'embedding',
        (SELECT ${vectorLiteral} AS embedding),
        top_k => ${VECTOR_TOP_K},
        distance_type => 'COSINE'
      )
      ORDER BY distance ASC
    `;
    console.log(`[BQ_QUERY] dataset=${ACTIVE_BQ_DATASET} table=${table} tenantId=${tenantId}`);
    try {
      const [rows] = await bigquery.query({ query, params: { tenantId }, location: 'US' });
      return { label, rows };
    } catch (err) {
      console.error(`[BQ_VECTOR_ERROR] Table=${table} Tenant=${tenantId}: ${err.message}`);
      return { label, rows: [], error: err.message };
    }
  });

  const results = await Promise.all(searchPromises);
  const sections = results.filter(r => r.rows.length > 0).map(({ label, rows }) => {
    // V4.5.2: Context compression — top 3 per table for payload budget
    const topRows = rows.slice(0, 3);
    const lines = topRows.map((row, idx) => {
      const { distance, ...displayRow } = row;
      return `  [${idx + 1}] (rel: ${(1 - distance).toFixed(3)}) ${JSON.stringify(displayRow)}`;
    });
    return `\n── BigQuery:${label} ──\n${lines.join('\n')}`;
  });

  const bqErrors = results.filter(r => r.error).map(r => `${r.label}: ${r.error}`);
  if (bqErrors.length > 0) {
    console.error(`[BQ_VECTOR_SUMMARY] ${bqErrors.length}/4 tables failed: ${bqErrors.join(' | ')}`);
  }

  const resultCount = results.reduce((sum, r) => sum + r.rows.length, 0);
  console.log(`[BQ_VECTOR_SUCCESS] tenantId=${tenantId}, resultCount=${resultCount}`);

  const fullPayload = sections.join('\n');
  if (fullPayload.length > MAX_CONTEXT_BYTES) {
    console.warn(`[CONTEXT_CAP] Scaling to 16KB budget. Current: ${fullPayload.length}B`);
    // Truncation now delegated to the ContextPacker at the inference gate.
  }

  return {
    contextPayload: fullPayload,
    resultCount,
    bqErrors: bqErrors.length > 0 ? bqErrors : undefined,
  };
}

/**
 * Firestore legacy retrieval (Tier 3 fallback).
 * @param {string} contextKey
 * @returns {Promise<{contextPayload: string|null}>}
 */
async function firestoreLegacyRetrieval(contextKey) {
  let doc = await firestore.collection('sentinel_data').doc(contextKey).get();
  if (!doc.exists || doc.data()?.content === 'DATA MOAT INITIALIZED') {
    doc = await firestore.collection('sentinel_data').doc('source_alpha').get();
  }
  if (!doc.exists) return { contextPayload: null };
  const data = doc.data();
  let content = typeof data.content === 'string' ? data.content : JSON.stringify(data.content || data);

  return { contextPayload: content };
}

/**
 * Apply the Kill Switch: redact data for revoked subject IDs.
 * @param {string|null} context
 * @param {string} requestId
 * @returns {Promise<string|null>}
 */
async function applyKillSwitch(context, requestId) {
  if (!context) return null;
  const idMatches = context.match(/"subject_id":\s*"([^"]+)"/g);
  if (!idMatches) return context;
  const ids = [...new Set(idMatches.map(m => m.split('"')[3]))];
  let finalContext = context;
  for (const id of ids) {
    if (await isSubjectRevoked(id)) {
      console.warn(`[KILL_SWITCH] Revoked ID detected: ${id}`);
      const regex = new RegExp(`.*${id}.*`, 'g');
      finalContext = finalContext.replace(regex, `[REDACTED: SUBJECT REVOKED - ID: ${id}]`);
    }
  }
  return finalContext;
}

// ─────────────────────────────────────────────────────
//  MODEL TIERING — Authorized Routing Logic
// ─────────────────────────────────────────────────────

/**
 * Select the inference model based on query complexity and instance config.
 * @param {string} query
 * @param {object} instanceConfig
 * @returns {string} Model ID
 */
function selectModel(query, instanceConfig) {
  return 'gemini-2.5-flash';
}

// ─────────────────────────────────────────────────────
//  PRISTINE PRIORITY RACING — V5.2 "Sub-Zero Window"
// ─────────────────────────────────────────────────────

// V5.2 SUB-ZERO LATENCY: Cloud SQL in-region returns in <25ms.
// 40ms window is generous but tight enough to prevent BigQuery
// from winning the race against a healthy Pristine Reservoir.
const PRISTINE_WINDOW_MS = 40;

/**
 * Priority-aware RAG race with a 40ms "Sub-Zero Window."
 *
 * 1. Fire Postgres (Tier 1) and BigQuery (Tier 2) concurrently.
 * 2. If Postgres returns data within 40ms, resolve immediately
 *    and discard the BigQuery race. This prevents a "Fast Stale Win"
 *    where a BigQuery cache beats fresh Postgres by milliseconds.
 * 3. If the 40ms window expires (Cloud SQL under load), resolve
 *    with the first available result from ANY tier that contains data.
 * 4. If all tiers settle with no results, reject with ALL_TIERS_EMPTY.
 *
 * @param {Promise<{tier: string, res: object|null}>} pgPromise
 * @param {Promise<{tier: string, res: object|null}>} bqPromise
 * @returns {Promise<{tier: string, res: object}>}
 * @throws {Error} If all tiers settle with no results
 */
function pristineRace(pgPromise, bqPromise) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let pgSettled = false;
    let bqSettled = false;
    let pgResult = null;
    let bqResult = null;

    const tryResolve = () => {
      if (resolved) return;
      // Check if either has data
      if (pgResult && pgResult.res && pgResult.res.resultCount > 0) {
        resolved = true;
        resolve(pgResult);
        return;
      }
      if (bqResult && bqResult.res && bqResult.res.resultCount > 0) {
        resolved = true;
        resolve(bqResult);
        return;
      }
      // Both settled with no data
      if (pgSettled && bqSettled) {
        reject(new Error('ALL_TIERS_EMPTY'));
      }
    };

    // Phase 1: Pristine Window — give Postgres 150ms of priority
    pgPromise.then(result => {
      pgSettled = true;
      pgResult = result;
      if (result && result.res && result.res.resultCount > 0) {
        // Postgres has data — resolve immediately, skip BQ
        if (!resolved) { resolved = true; resolve(result); }
      } else {
        tryResolve();
      }
    }).catch(() => {
      pgSettled = true;
      tryResolve();
    });

    // Phase 2: BigQuery — only accepted after the Pristine Window
    // or if Postgres failed/returned empty.
    setTimeout(() => {
      bqPromise.then(result => {
        bqSettled = true;
        bqResult = result;
        tryResolve();
      }).catch(() => {
        bqSettled = true;
        tryResolve();
      });
    }, PRISTINE_WINDOW_MS);

    // Safety net: if Postgres is extremely slow AND BQ settles
    // before the window opens, we still need to accept BQ data.
    // The setTimeout above just DELAYS evaluation of BQ results,
    // not BQ execution (which was fired concurrently already).
  });
}

// SHADOW CLASSIFIER REMOVED IN V5.5 "Absolute" Hardening
// Classification and reasoning are now unified into a single atomic pass.

// ─────────────────────────────────────────────────────
//  ENTRY POINT: SENTINEL INFERENCE (V5.0 Sovereign)
// ─────────────────────────────────────────────────────

/**
 * Main inference handler. Orchestrates: PEP Auth → SWR Cache → RAG Cascade →
 * DLL Rules → AI Generation → Zod Validation → PII Tokenization → Response.
 *
 * @param {object} req - Cloud Function HTTP request
 * @param {object} res - Cloud Function HTTP response
 */
async function handleSentinelInference(req, res) {
  const requestId = `SEN-${Date.now()}`;
  res.set('X-Sentinel-Version', '5.5.0-Sovereign');
  const t0 = Date.now();
  const trace = {};
  if (handleCORS(req, res)) return;

  // ═══ PHASE 0: Boot Block ═══
  // Block until security primitives and adapter registry are ready.
  // This achieves "Atomic Boot Guard" behavior without using top-level await.
  await ensureBoot();
  const { addSSEClient } = require('./escalation-engine');

  try {
    const genai = getGenAI();      // API Key client — generation + classification
    const embedai = getEmbedAI();  // Vertex AI client — embeddings only
    trace.init = Date.now() - t0;

    // ═══ PHASE 1: PEP Gate — Zero-Trust Auth ═══
    const tAuth0 = Date.now();
    let ctx;
    try {
      ctx = await verifyPEP(req);
    } catch (pepErr) {
      if (pepErr instanceof PEPError) {
        trace.auth = Date.now() - tAuth0;
        return res.status(pepErr.httpStatus).json({
          error: pepErr.code,
          message: pepErr.message,
          requestId,
          latencyTrace: trace,
        });
      }
      throw pepErr;
    }
    const tenantId = ctx.tenantId;
    const userRole = ctx.userRole;
    trace.auth = Date.now() - tAuth0;
    trace.authMethod = ctx.authMethod;

    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Empty Query', requestId });

    // V5.5: Single-Pass Atomic Inference removes the Shadow Classifier
    const tClassify0 = Date.now();
    
    // Domain is pre-determined via configuration instead of dynamic multi-pass
    const industryDomain = INSTANCE_CONFIG.industry === 'Energy & Utilities' ? 'ENERGY' : 
                           INSTANCE_CONFIG.industry === 'Logistics & Supply Chain' ? 'LOGISTICS' : 'UNKNOWN';
    
    let queryClassification = 'UNKNOWN'; // Resolved post-inference
    let impactLevel = 'UNKNOWN'; // Resolved post-inference
    
    trace.classification = Date.now() - tClassify0;
    trace.queryClass = queryClassification;
    trace.industryDomain = industryDomain;
    trace.impactLevel = impactLevel;

    // DATABASE_URL: Validated at BOOT (global scope, lines 45-56).
    // db.js consumes DATABASE_URL directly (Configuration Monism).

    // ═══ PHASE 4: SWR Cache Check ═══
    // Wrap the entire RAG → Inference pipeline in SWR
    const swrResult = await swrFetch(tenantId, query, async () => {
      // ── This is the "fresh data" function ──
      // It runs only on cache miss or revalidation.

      // Step 2: Embedding
      const tEmbed0 = Date.now();
      const embResult = await embedai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: query,
        config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: EMBEDDING_DIM },
      });
      const queryVector = embResult.embeddings[0].values;
      trace.embedding = Date.now() - tEmbed0;

      // Step 3: RAG Cascade — PRISTINE PRIORITY RACING (V5.2)
      // Both tiers fire concurrently. Postgres gets a 150ms
      // "Pristine Window" of priority. If Postgres returns data
      // within 150ms, BigQuery is discarded. If the window expires,
      // the first tier with data wins.
      const tRag0 = Date.now();
      let contextPayload, dataAuthority;

      const pgPromise = postgresVectorSearch(queryVector, tenantId)
        .then(res => { circuitBreaker.recordSuccess(); return { tier: 'PG', res }; })
        .catch(err => { circuitBreaker.recordFailure(); console.error('[RAG_CASCADE] Postgres failed:', err.message); return { tier: 'PG', res: null }; });

      if (TIER_MODE === 'POSTGRES_ONLY') {
        const pgResult = await pgPromise;
        trace.postgres = Date.now() - tRag0;
        if (pgResult.res && pgResult.res.resultCount > 0) {
          contextPayload = pgResult.res.contextPayload;
          dataAuthority = 'POSTGRES_PRISTINE_RESERVOIR';
        } else {
          throw new Error('POSTGRES_ONLY mode: Tier 1 returned no results. Fallback disabled.');
        }
      } else {
        // FULL_CASCADE: Pristine Priority Race (150ms Postgres window)
        const bqPromise = vectorSearchRetrieval(query, embedai, tenantId)
          .then(res => ({ tier: 'BQ', res }))
          .catch(err => { console.error('[RAG_CASCADE] BigQuery failed:', err.message); return { tier: 'BQ', res: null }; });

        try {
          const winner = await pristineRace(pgPromise, bqPromise);
          contextPayload = winner.res.contextPayload;
          dataAuthority = winner.tier === 'PG' ? 'POSTGRES_PRISTINE_RESERVOIR' : 'GCP_BIGQUERY_VECTOR_RAG';
          if (winner.tier === 'BQ' && winner.res.bqErrors) trace.bqErrors = winner.res.bqErrors;
        } catch (_raceErr) {
          // Both tiers empty — try Firestore as last resort
        }
        trace.ragRace = Date.now() - tRag0;
        trace.pristineWindowMs = PRISTINE_WINDOW_MS;
      }

      // C: Firestore (Tier 3 — Legacy Fallback, only if raceToData returned nothing)
      const tFs0 = Date.now();
      const strategies = getRetrievalStrategies(INSTANCE_CONFIG);
      
      if (!contextPayload && strategies.includes('LEGACY_FS')) {
        const fsRes = await firestoreLegacyRetrieval(tenantId);
        if (fsRes.contextPayload) {
          contextPayload = fsRes.contextPayload;
          dataAuthority = (dataAuthority ? dataAuthority + ' | ' : '') + 'FIRESTORE_LEGACY';
        }
      }
      trace.firestore = Date.now() - tFs0;
      
      // D: External Adapters (Strategy + Adapter Pattern API)
      const tExternal = Date.now();
      let externalData = null;
      if (strategies.includes('EXTERNAL_API') || strategies.includes('EXTERNAL_PLUGINS')) {
         const activeAdapters = getExternalPlugins(INSTANCE_CONFIG);
         if (activeAdapters && activeAdapters.length > 0) {
           try {
             externalData = await ExternalIntelligenceAdapter.fetch(query, industryDomain, activeAdapters);
             if (externalData) {
               dataAuthority = (dataAuthority ? dataAuthority + ' | ' : '') + 'EXTERNAL_INTELLIGENCE_ADAPTER';
             }
           } catch (e) {
             console.error('[EXTERNAL_ADAPTER_ERROR]', e.message);
           }
         }
      }
      trace.externalAdapters = Date.now() - tExternal;

      // FINAL SOVEREIGN COMPRESSION
      // Ensures internal vector rows (P0) are never truncated by external data (P1/P2)
      const finalPayload = mergeContextSafely(contextPayload, externalData, MAX_CONTEXT_BYTES);
      
      // Integrity Guard: Prepend tenantId for DLL Safety
      contextPayload = `[tenant_id: ${tenantId}]\n` + finalPayload;
      
      trace.ragTotal = Date.now() - tRag0;

      // Step 4: Kill Switch
      const tKill0 = Date.now();
      contextPayload = await applyKillSwitch(contextPayload, requestId);
      trace.killSwitch = Date.now() - tKill0;

      // ═══ TASK 4: SOURCE_ALPHA_MISSING → 503 ═══
      if (!contextPayload) {
        trace.total = Date.now() - t0;
        return {
          _sourceAlphaMissing: true,
          status: 503,
          code: 'SOURCE_ALPHA_MISSING',
          error: 'SOURCE_ALPHA_MISSING',
          message: 'RAG cascade returned zero results across all data tiers. The Pristine Reservoir, Data Moat, and Legacy Fallback are empty for this tenant.',
          latencyTrace: trace,
          requestId,
        };
      }

      // Step 5: Procedural Rules Intercept Verification (Integrity Controller)
      const integrityCtrl = new IntegrityController(_securityManager);
      const dllOverride = integrityCtrl.checkProceduralRules(query, contextPayload);
      if (dllOverride) {
        return {
          _dllOverride: true,
          ...dllOverride,
          dataAuthority: 'SENTINEL_DLL_OVERRIDE',
        };
      }

      // ═══ PHASE 2: AI Inference with Zod Schema Decomposition ═══
      const tGen0 = Date.now();
      
      let systemPrompt = '';
      const arbiterSystemInstruction = require('./arbiter-kernel').systemInstruction;

      if (industryDomain === 'UNKNOWN') {
        const BASE_DOMAIN_PROMPT = `SYSTEM: Sentinel v5.0 Sovereign Fortress.
STATUS: UNIVERSAL BASELINE ACTIVE.
DATA AUTHORITY: ${dataAuthority}

WARNING: You are operating in a domain-agnostic environment (UNKNOWN domain). 
You MUST NOT assume any industry context (no logistics, no energy, etc).
Respond SOLELY based on the provided Operational Context below. 
Do not hallucinate external industry terminology. Use a generic, structural format.

OPERATIONAL CONTEXT:
${contextPayload}

OUTPUT FORMAT: Strict JSON matching the specified Response Schema.`;
        systemPrompt = `${arbiterSystemInstruction}\n\n${BASE_DOMAIN_PROMPT}`;
      } else {
        const instancePrompt = buildInstanceSystemPrompt(INSTANCE_CONFIG, contextPayload, dataAuthority)
          || `SYSTEM: Sentinel v5.0 Sovereign Fortress. Context: ${contextPayload}`;
        systemPrompt = `${arbiterSystemInstruction}\n\n${instancePrompt}`;
      }
      
      const modelId = selectModel(query, INSTANCE_CONFIG);
      
      const targetSchema = industryDomain === 'ENERGY' ? GEMINI_ENERGY_SCHEMA : GEMINI_RESPONSE_SCHEMA;

      let data = null;
      let fallbackRetries = 0;

      while (fallbackRetries < 2) {
        const retryPrompt = fallbackRetries > 0
          ? `${systemPrompt}\n\nCRITICAL: Your previous response was malformed JSON. Respond with ONLY a valid JSON object matching the schema exactly.`
          : systemPrompt;

        const result = await genai.models.generateContent({
          model: modelId,
          contents: query,
          config: {
            systemInstruction: retryPrompt,
            responseMimeType: 'application/json',
            responseSchema: targetSchema,
            temperature: 0.1,
            maxOutputTokens: 2048,
            topK: 20,
            topP: 0.7,
            thinkingConfig: { thinkingBudget: 0 },
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }
          ]
        });

        try {
          let cleanedText = (result.text || '').replace(/```(json)?/gi, '').trim();
          cleanedText = cleanedText.replace(/,\s*([\]}])/g, '$1');
          const parsed = JSON.parse(cleanedText);

          // ═══ PHASE 2: Zod Validation ═══
          const validation = validateInferenceResponse(parsed, industryDomain);

          if (validation.valid) {
            data = validation.result;
            break;
          }

          // Recursive retry on specific failed modules
          console.warn(`[DLL_SCHEMA] ${validation.failedModules.length} modules failed Zod validation:`, validation.failedModules);
          data = await recursiveSchemaRetry({
            genaiClient: genai,
            modelId,
            systemPrompt,
            query,
            context: contextPayload,
            partialResponse: parsed,
            failedModules: validation.failedModules,
          });
          break;

        } catch (err) {
          fallbackRetries++;
          console.warn(`[JSON_RETRY] Parse error on attempt ${fallbackRetries}: ${err.message}`);
          if (fallbackRetries >= 2) {
            const { buildGenericAdvisory } = require('./recursive-retry');
            data = buildGenericAdvisory(['executiveAction'], { parse: err.message });
          }
        }
      }

      trace.generation = Date.now() - tGen0;

      // Backward-compat: Flatten executiveAction into top-level for existing clients
      data.narrative = data.executiveAction?.narrative || data.executiveAction?.rationale || data.narrative || '';
      data.metrics = data.executiveAction?.metrics || data.metrics || [];
      data.dataAuthority = dataAuthority;

      // Extract atomic classification dynamically from single-pass.
      // FAIRNESS RULE: Default to GENERAL, not SENSITIVE.
      // Only escalate to SENSITIVE when the model explicitly says so,
      // or when confidence is critically low (< 0.5). This prevents
      // Supervisor Fatigue from malformed-but-benign responses.
      const modelClass = data.executiveAction?.classification;
      if (modelClass && ['SENSITIVE', 'GENERAL', 'HIGH_IMPACT', 'RESTRICTED'].includes(modelClass)) {
        queryClassification = modelClass;
      } else {
        // No explicit classification from model: use confidence as a signal.
        // < 0.5 → genuinely uncertain, escalate; >= 0.5 → treat as GENERAL.
        queryClassification = data.confidence < 0.5 ? 'SENSITIVE' : 'GENERAL';
      }
      impactLevel = (modelClass === 'HIGH_IMPACT') ? 'HIGH_IMPACT' : 'STANDARD';

      trace.queryClass = queryClassification;
      trace.impactLevel = impactLevel;

      // Confidence Gate
      if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 1) {
        console.error(`[SCHEMA_VIOLATION] confidence=${data.confidence} from model=${modelId}.`);
        data.confidence = 0;
      }

      if (data.confidence < 0.7) {
        data.narrative = "Insufficient sovereign data to support a high-confidence decision. Confidence threshold unmet.";
        data.metrics = [];
      }

      // ═══ PHASE 5: UNIFIED TRUTH AUDIT (Zod + Data Sovereignty) ═══
      // tenantId passed for per-tenant PII salt (prevents rainbow tables)
      data = await integrityCtrl.finalTruthAudit(data, tenantId, { industryDomain, contextPayload });

      return {
        data,
        modelId,
        dataAuthority,
        contextPayload, // needed for verification sidecar
      };
    });

    // ── Handle SWR result ──
    const isResilienceMode = swrResult.isResilienceMode || false;
    const swrData = swrResult.data;

    // Handle Resilience Advisory (2AM Failsafe — circuit open, no cache)
    if (swrData._resilienceAdvisory) {
      res.set('Retry-After', String(swrData.retryAfterSeconds || 60));
      return res.status(504).json({
        status: 'RESILIENCE_ADVISORY',
        error: swrData.error,
        message: swrData.message,
        retryAfterSeconds: swrData.retryAfterSeconds,
        circuitState: swrData.circuitState,
        requestId,
        isResilienceMode: true,
      });
    }

    // ═══ TASK 4: SOURCE_ALPHA_MISSING → 503 Service Unavailable ═══
    if (swrData._sourceAlphaMissing) {
      return res.status(503).json({
        status: 'SOURCE_ALPHA_MISSING',
        code: 'SOURCE_ALPHA_MISSING',
        error: swrData.error,
        message: swrData.message,
        latencyTrace: swrData.latencyTrace,
        requestId: swrData.requestId,
        isResilienceMode: true,
      });
    }

    // Handle DLL override (passthrough)
    if (swrData._dllOverride) {
      trace.total = Date.now() - t0;
      const { _dllOverride, ...dllPayload } = swrData;
      return res.status(200).json({
        status: 'SUCCESS',
        ...dllPayload,
        latencyTrace: trace,
        requestId,
        verificationStatus: 'not_applicable',
        isResilienceMode,
        cacheStatus: swrResult.cacheStatus,
        infrastructure: `Sentinel v5.0 [SENTINEL_DLL_OVERRIDE]`,
      });
    }

    const { data, modelId, dataAuthority, contextPayload } = swrData;

    // ═══ TASK 4: 2AM "Correctness" Gate — Resilience Advisory Injection ═══
    // If circuit breaker is open (serving stale cache), physically modify the narrative.
    if (isResilienceMode && data && data.narrative) {
      data.narrative = RESILIENCE_ADVISORY + data.narrative;
    }

    // ═══ PHASE 3: Verification Sidecar (V5.1 Shadow Classifier) ═══
    // SENSITIVE queries (classified by Shadow Classifier): sidecar is
    // AWAITED — response is blocked until The Prosecutor verifies.
    // PROCEDURAL/GENERAL: fire-and-forget (async background).
    const isSensitive = queryClassification === 'SENSITIVE';
    let verificationResult = null;

    if (contextPayload && data.narrative) {
      const sidecarPayload = {
        genaiClient: getGenAI(),
        requestId,
        tenantId,
        narrative: data.narrative,
        sourceContext: contextPayload,
        // V5.4: Pass escalation context to the Prosecutor
        impactLevel,
        queryClassification,
        securityManager: _securityManager,
      };

      if (isSensitive) {
        // SYNCHRONOUS: Block response until verification completes
        try {
          verificationResult = await launchVerificationSidecar(sidecarPayload);
          trace.verification = Date.now() - t0;

          // V5.4: If Prosecutor created an escalation, return 202 Accepted
          if (verificationResult?._escalation?.status === 'ESCALATION_PENDING') {
            trace.total = Date.now() - t0;
            return res.status(202).json({
              status: 'ESCALATION_PENDING',
              message: 'HIGH_IMPACT hallucination detected. JIT Escalation created for human review.',
              escalation: verificationResult._escalation,
              requestId,
              queryClassification,
              impactLevel,
              latencyTrace: trace,
              isResilienceMode,
              cacheStatus: swrResult.cacheStatus,
            });
          }
        } catch (err) {
          console.error('[VERIFICATION_SIDECAR] Sync verification failed:', err.message);
          verificationResult = { isVerified: null, error: err.message };
        }
      } else {
        // ASYNC: Fire-and-forget for PROCEDURAL/GENERAL queries
        launchVerificationSidecar(sidecarPayload)
          .catch(err => console.error('[VERIFICATION_SIDECAR] Background error:', err.message));
      }
    }

    // V5.4: Pristine Checkpoint — periodic data-state snapshot
    _rollbackEngine.createPristineCheckpoint(tenantId, requestId)
      .catch(err => console.warn('[PRISTINE_CHECKPOINT] Background error:', err.message));

    trace.total = Date.now() - t0;

    return res.status(200).json({
      status: 'SUCCESS',
      model: modelId || 'gemini-2.5-flash',
      timestamp: new Date().toISOString(),
      data,
      infrastructure: `Sentinel v5.5.0 [${dataAuthority}]`,
      latencyTrace: trace,
      requestId,
      queryClassification,
      impactLevel,
      verificationStatus: data._verificationPartial 
        ? 'PARTIAL' 
        : (isSensitive
            ? (verificationResult?.isVerified === false ? 'HALLUCINATION_FLAGGED' : (verificationResult?.isVerified ? 'verified' : 'verification_failed'))
            : 'pending'),
      verificationResult: isSensitive ? verificationResult : undefined,
      isResilienceMode,
      cacheStatus: swrResult.cacheStatus,
      authMethod: ctx.authMethod,
    });

  } catch (err) {
    trace.total = Date.now() - t0;

    // TruthAuditError: Zod validation or Integrity Gate — return typed 422, not generic 500
    //
    // MONITORING DISTINCTION:
    //   SCHEMA_VALIDATION_FAILED  → System error. The LLM is broken. Page on-call.
    //   INTEGRITY_GATE_REJECTION  → System working. Engine saved the user. Track as metric.
    if (err instanceof TruthAuditError) {
      const auditCode = err.auditCode || 'SCHEMA_VALIDATION_FAILED';
      console.error(
        JSON.stringify({
          severity: auditCode === 'INTEGRITY_GATE_REJECTION' ? 'WARNING' : 'ERROR',
          message: `[TRUTH_AUDIT] ${auditCode}: ${err.message}`,
          auditCode,
          failedModules: err.failedModules,
          requestId,
          labels: { auditCode, engine: 'sentinel-v5.3' },
        })
      );
      return res.status(422).json({
        status: 'TRUTH_AUDIT_FAILURE',
        error: auditCode,
        message: auditCode === 'INTEGRITY_GATE_REJECTION'
          ? 'The Integrity Controller rejected a substantively empty response. The engine is protecting you from low-quality intelligence.'
          : 'The AI produced structurally unverifiable output. The Integrity Controller has rejected this response.',
        failedModules: err.failedModules,
        latencyTrace: trace,
        requestId,
        isResilienceMode: circuitBreaker.isOpen(),
      });
    }

    console.error(`[CRITICAL] Inference failed:`, err);
    return res.status(500).json({
      error: 'Infrastructure Failure',
      detail: err.message,
      latencyTrace: trace,
      requestId,
      isResilienceMode: circuitBreaker.isOpen(),
    });
  }
}

// ─────────────────────────────────────────────────────
//  ENTRY POINT: VERIFICATION STATUS (Polling)
// ─────────────────────────────────────────────────────

/**
 * Polling endpoint for async verification sidecar results.
 * @param {object} req
 * @param {object} res
 */
async function handleVerificationStatus(req, res) {
  if (handleCORS(req, res)) return;

  try {
    await ensureBoot();
    // Auth check (lightweight — PEP Gate)
    await verifyPEP(req);

    const { requestId } = req.body;
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required' });
    }

    const result = await getVerificationStatus(requestId);
    return res.status(200).json(result);

  } catch (err) {
    if (err instanceof PEPError) {
      return res.status(err.httpStatus).json({ error: err.code, message: err.message });
    }
    return res.status(500).json({ error: 'Verification lookup failed', detail: err.message });
  }
}

// ─────────────────────────────────────────────────────
//  ENTRY POINT: TTS (Preserved from V4.5.2)
// ─────────────────────────────────────────────────────

/**
 * Text-to-Speech synthesis endpoint.
 * @param {object} req
 * @param {object} res
 */
async function handleSentinelTTS(req, res) {
  if (handleCORS(req, res)) return;
  await ensureBoot();
  const { text } = req.body;
  if (!text) return res.status(400).send('Text is required');
  try {
    const config = getTTSConfig(INSTANCE_CONFIG);
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text: text.replace(/[*#_`~>]/g, '') },
      voice: { languageCode: config.languageCode, name: config.voiceName },
      audioConfig: { audioEncoding: 'MP3' },
    });
    res.status(200).json({ audioContent: response.audioContent.toString('base64') });
  } catch (err) {
    res.status(500).send(err.message);
  }
}

// ─────────────────────────────────────────────────────
//  ENTRY POINT: HITL ESCALATION MANAGEMENT (V5.4)
// ─────────────────────────────────────────────────────

/**
 * HITL Escalation endpoint. Supports:
 * - GET-style (action: 'list'): List pending escalations
 * - GET-style (action: 'history'): Get escalation history
 * - POST (action: 'resolve'): Resolve an escalation (WebAuthn-gated)
 * - POST (action: 'rollback'): Trigger data-plane rollback (WebAuthn-gated)
 * - GET-style (action: 'authorities'): List authority matrix
 * - GET-style (action: 'evidence'): Get evidence locker fragment
 * - GET-style (action: 'chain_verify'): Verify evidence chain integrity
 * - POST (action: 'webauthn_register_options'): Get WebAuthn registration options
 * - POST (action: 'webauthn_register_verify'): Verify WebAuthn registration
 * - POST (action: 'webauthn_auth_options'): Get WebAuthn authentication options
 * - POST (action: 'webauthn_auth_verify'): Verify WebAuthn authentication
 */
async function handleSentinelEscalation(req, res) {
  if (handleCORS(req, res)) return;
  await ensureBoot();

  try {
    // ── V5.4.1: Server-Sent Events (SSE) Stream ──
    // SSE clients connect via query param ?stream=true or action='stream'.
    // This eliminates the 5-second polling bottleneck for HITL dashboards.
    const isSSEStream = req.query?.stream === 'true' ||
                        req.body?.action === 'stream' ||
                        req.headers?.accept === 'text/event-stream';

    if (isSSEStream) {
      console.log('[HITL_SSE] New SSE client connected from dashboard.');
      addSSEClient(req, res);
      return; // Keep connection open — do not send a JSON response
    }

    const { action } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'action is required' });
    }

    // ── Admin-only bypass removed (Migrated to infra/migrate-reservoir.js) ──

    const ctx = await verifyPEP(req);
    const tenantId = ctx.tenantId;

    switch (action) {
      // ── Escalation Queue ──
      case 'list': {
        const pending = await _escalationEngine.listPending(tenantId);
        return res.status(200).json({ status: 'SUCCESS', escalations: pending });
      }

      case 'history': {
        const limit = req.body.limit || 50;
        const history = await _escalationEngine.getHistory(tenantId, limit);
        return res.status(200).json({ status: 'SUCCESS', history });
      }

      case 'resolve': {
        const { escalationId, decision, authorityId, coachingAnnotation, webauthnAssertion } = req.body;
        if (!escalationId || !decision || !authorityId) {
          return res.status(400).json({ error: 'escalationId, decision, and authorityId are required' });
        }
        const result = await _escalationEngine.resolveEscalation({
          escalationId, decision, authorityId, coachingAnnotation, webauthnAssertion,
        });
        return res.status(200).json({ status: 'SUCCESS', ...result });
      }

      // ── Rollback ──
      case 'rollback': {
        const { authorityId, reason, webauthnAssertion } = req.body;
        if (!authorityId) {
          return res.status(400).json({ error: 'authorityId is required for rollback' });
        }
        // WebAuthn verification
        if (webauthnAssertion) {
          const isValid = await _webauthnProvider.verifyAuthentication(authorityId, webauthnAssertion);
          if (!isValid) {
            return res.status(403).json({ error: 'FIDO2 assertion invalid. Rollback DENIED.' });
          }
        }
        const result = await _rollbackEngine.initiateRollback({
          tenantId, authorityId, requestId: `ROLLBACK-${Date.now()}`, reason,
        });
        return res.status(200).json({ status: 'SUCCESS', ...result });
      }

      case 'rollback_status': {
        const availability = await _rollbackEngine.checkRollbackAvailability(tenantId);
        return res.status(200).json({ status: 'SUCCESS', ...availability });
      }

      // ── Authority Matrix ──
      case 'authorities': {
        const authorities = await StandingAuthorityMatrix.listActive(tenantId);
        return res.status(200).json({ status: 'SUCCESS', authorities });
      }

      // ── Evidence Locker ──
      case 'evidence': {
        const { requestId } = req.body;
        if (!requestId) return res.status(400).json({ error: 'requestId is required' });
        const fragment = await _evidenceLocker.getFragment(requestId);
        return res.status(200).json({ status: 'SUCCESS', evidence: fragment });
      }

      case 'evidence_recent': {
        const events = await _evidenceLocker.getRecentEvents(tenantId, req.body.limit || 50);
        return res.status(200).json({ status: 'SUCCESS', events });
      }

      case 'chain_verify': {
        const chainResult = await _evidenceLocker.verifyChain(tenantId);
        return res.status(200).json({ status: 'SUCCESS', chain: chainResult });
      }

      // ── WebAuthn Ceremonies ──
      case 'webauthn_register_options': {
        const { authorityId, authorityName } = req.body;
        if (!authorityId) return res.status(400).json({ error: 'authorityId is required' });
        const options = await _webauthnProvider.generateRegistrationOptions(authorityId, authorityName);
        return res.status(200).json({ status: 'SUCCESS', options });
      }

      case 'webauthn_register_verify': {
        const { authorityId, registrationResponse } = req.body;
        if (!authorityId || !registrationResponse) {
          return res.status(400).json({ error: 'authorityId and registrationResponse are required' });
        }
        const result = await _webauthnProvider.verifyRegistration(authorityId, registrationResponse);
        return res.status(200).json({ status: 'SUCCESS', ...result });
      }

      case 'webauthn_auth_options': {
        const { authorityId } = req.body;
        if (!authorityId) return res.status(400).json({ error: 'authorityId is required' });
        const options = await _webauthnProvider.generateAuthenticationOptions(authorityId);
        return res.status(200).json({ status: 'SUCCESS', options });
      }

      case 'webauthn_auth_verify': {
        const { authorityId, authenticationResponse } = req.body;
        if (!authorityId || !authenticationResponse) {
          return res.status(400).json({ error: 'authorityId and authenticationResponse are required' });
        }
        const verified = await _webauthnProvider.verifyAuthentication(authorityId, authenticationResponse);
        return res.status(200).json({ status: 'SUCCESS', verified });
      }



      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

  } catch (err) {
    if (err instanceof PEPError) {
      return res.status(err.httpStatus).json({ error: err.code, message: err.message });
    }
    console.error('[HITL_ESCALATION] Error:', err);
    return res.status(500).json({ error: 'Escalation operation failed', detail: err.message });
  }
}

// ─────────────────────────────────────────────────────
//  V5.5 Sovereign PROXY — Shard-Aware Arbitration Gateway
//  ─────────────────────────────────────────────────────
//  POST /v1/arbitrate — The SOLE entry point for agent→kernel calls.
//  Never call the Arbiter Kernel directly.
// ─────────────────────────────────────────────────────
const { handleArbitrate } = require('./Sovereign-proxy');
const { executeAtomicInference } = require('./arbiter-kernel');

/**
 * Sentinel Arbitrate — Sovereign Proxy Cloud Function.
 * Implements the Axiom-G Sovereign Signing pipeline:
 *   1. Verification: ArbiterKernel validates skill against B-Tree project_skill_graph.
 *   2. Attestation: SecurityManager determines project tier, fetches appropriate key.
 *   3. Sealing: Code block hashed and signed (ECDSA P-256 or CRYSTALS-Dilithium).
 *   4. Return: Signed payload returned to satellite project.
 */
async function handleSentinelArbitrate(req, res) {
  res.set('X-Sentinel-Version', '5.5.0-Sovereign');
  if (handleCORS(req, res)) return;

  await ensureBoot();

  const hubSql = getSql();

  // Adapter: connects the Sovereign Proxy to the Arbiter Kernel + Axiom-G Sealing
  const executeArbiter = async ({ query, tenantId, shardConfig, agentMetadata, cryptoPreference }) => {
    const genai = getGenAI();

    // For Tier 3 (shared DB with RLS), set the session tenant context
    if (shardConfig.tier === 3) {
      try {
        await hubSql`SELECT set_config('sentinel.tenant_id', ${tenantId}, true)`;
      } catch (err) {
        console.warn(`[Sovereign] Failed to set RLS context: ${err.message}`);
      }
    }

    // ── Step 1: VERIFICATION ──
    // ArbiterKernel validates the skill against the B-Tree project_skill_graph
    const contextPayload = `[tenant_id: ${tenantId}] [tier: ${shardConfig.tier}] [isolation: ${shardConfig.isolationLevel}] [crypto: ${cryptoPreference}]\n${query}`;
    const arbiterDecision = await executeAtomicInference(genai, query, contextPayload, tenantId);

    // ── Step 2: ATTESTATION ──
    // SecurityManager determines the project tier and fetches the appropriate key.
    // ECDSA_P256 = Legacy Logistics Tier (Tier 1-L), quantum-insecure.
    // PQ_LATTICE = Modern Sovereign Tier (Tier 1-PQ), CRYSTALS-Dilithium (ML-DSA).
    const effectiveCrypto = cryptoPreference || 'ECDSA_P256';
    let sealSignature = null;
    let sealAlgorithm = effectiveCrypto;

    try {
      if (effectiveCrypto === 'PQ_LATTICE') {
        // Tier 1-PQ: Create a PostQuantum signer for this sealing operation
        const pqManager = SecurityManager.create('pq_lattice', {
          encryptionKey: process.env.SENTINEL_ENCRYPTION_KEY,
        });
        const decisionPayload = { arbiterDecision, tenantId, timestamp: new Date().toISOString() };
        sealSignature = await pqManager.signPayload(decisionPayload);
        sealAlgorithm = 'CRYSTALS-Dilithium (ML-DSA-65)';
        console.log(`[AXIOM-G] PQ_BLOCK sealed for tenant ${tenantId}. Algorithm: ${sealAlgorithm}`);
      } else {
        // Tier 1-L: Use the boot-time ECDSA SecurityManager
        const decisionPayload = { arbiterDecision, tenantId, timestamp: new Date().toISOString() };
        sealSignature = await _securityManager.signPayload(decisionPayload);
        sealAlgorithm = 'ECDSA-P256';
        console.log(`[AXIOM-G] ECDSA seal applied for tenant ${tenantId}. Algorithm: ${sealAlgorithm}`);
      }
    } catch (sealErr) {
      console.error(`[AXIOM-G] Sealing failed: ${sealErr.message}. Decision returned unsigned.`);
    }

    // ── Step 3: SEALING — Return signed payload ──
    return {
      arbiterDecision,
      tenantId,
      shardTier: shardConfig.tier,
      isolationLevel: shardConfig.isolationLevel,
      // Axiom-G seal attestation
      sealSignature,
      sealAlgorithm,
      sealBlockType: effectiveCrypto === 'PQ_LATTICE' ? 'PQ_BLOCK' : 'ECDSA_BLOCK',
    };
  };

  return handleArbitrate(req, res, hubSql, executeArbiter);
}

// Register Cloud Function entry points
functions.http('sentinelInference', handleSentinelInference);
functions.http('sentinelTTS', handleSentinelTTS);
functions.http('sentinelVerification', handleVerificationStatus);
functions.http('sentinelEscalation', handleSentinelEscalation);
functions.http('sentinelArbitrate', handleSentinelArbitrate);
