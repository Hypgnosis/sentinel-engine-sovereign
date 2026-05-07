/**
 * SENTINEL ENGINE v4.1 — Industrial ETL Pipeline (Production)
 * ═══════════════════════════════════════════════════════════
 * Cloud Run Job that executes the Extract → Transform → Load
 * cycle for the Sentinel Data Warehouse.
 *
 * Pipeline Stages:
 *   1. EXTRACT  — Pull from live adapters (Freightos, Xeneta, MarineTraffic)
 *                 with Circuit Breaker fallback to static/cached data
 *   2. TRANSFORM — Sanitize, normalize, generate entity_hash,
 *                  build narrative_context, generate embeddings
 *   3. LOAD — Batch-insert into BigQuery with deduplication
 *
 * Secrets:   Google Cloud Secret Manager (runtime fetch — zero process.env)
 * Tenancy:   All rows stamped with tenant_id for RLS enforcement
 *
 * Deduplication Strategy:
 *   - entity_hash = SHA-256 of the row's business key fields
 *   - Before INSERT, MERGE against existing rows with same
 *     entity_hash from the last 24h to prevent duplicates
 *
 * Circuit Breaker:
 *   - If a live API call fails, log DEGRADED status in Cloud Logging
 *   - Fall back to most recent cached data in BigQuery
 *   - If no cache exists, fall back to static feed adapter
 *
 * Observability:
 *   - Structured JSON logging to Cloud Logging
 *   - Process exit code 0 = success, 1 = failure
 *   - Cloud Monitoring alerts trigger on non-zero exits
 *
 * Usage: node index.js
 * ═══════════════════════════════════════════════════════════
 */

import { createHash } from 'node:crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { generateEmbeddings } from './embeddings.js';
import {
  getFreightIndices as getStaticFreight,
  getPortCongestion as getStaticPorts,
  getChokepoints as getStaticChokepoints,
  getRiskMatrix as getStaticRisk,
} from './adapters/static-feed.js';
import {
  getFreightIndices as getLiveFreight,
  isAvailable as isFreightosAvailable,
} from './adapters/freightos.js';
import {
  getSpotContractSpreads as getLiveXenetaSpreads,
  isAvailable as isXenetaAvailable,
} from './adapters/xeneta.js';
import {
  getPortCongestion as getLivePortCongestion,
  getChokepoints as getLiveChokepoints,
  isAvailable as isMarineTrafficAvailable,
} from './adapters/marinetraffic.js';
import { 
  validate, 
  FreightIndexSchema, 
  XenetaSpreadSchema, 
  PortCongestionSchema, 
  ChokepointSchema, 
  RiskMatrixSchema 
} from './schemas.js';
import { sql, upsertRow, closeDb } from './db.js';

// ─────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────

const GCP_PROJECT_ID = 'ha-sentinel-core-v21';
const BQ_DATASET     = process.env.BQ_DATASET || 'sentinel_warehouse';

// Default tenant for ETL ingestion. In production, the ETL job
// is invoked per-tenant via Cloud Scheduler with --set-env-vars=TENANT_ID=xxx
const TENANT_ID = process.env.TENANT_ID || 'ha-internal';

const bigquery = new BigQuery({ projectId: GCP_PROJECT_ID });

// ─────────────────────────────────────────────────────
//  SECRET MANAGER — Runtime Secret Fetching
// ─────────────────────────────────────────────────────

const secretClient = new SecretManagerServiceClient();
const _secretCache = {};

/**
 * Fetches a secret from Google Cloud Secret Manager.
 * Caches in-memory for the lifetime of the Cloud Run Job execution.
 *
 * @param {string} secretName - e.g. 'FREIGHTOS_API_KEY'
 * @returns {Promise<string>} The secret value
 */
async function getSecret(secretName) {
  if (_secretCache[secretName]) {
    return _secretCache[secretName];
  }

  const name = `projects/${GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`;

  try {
    const [version] = await secretClient.accessSecretVersion({ name });
    const payload = version.payload.data.toString('utf8');
    _secretCache[secretName] = payload;

    log('INFO', 'SECRET_MANAGER_FETCH_SUCCESS', { secret: secretName });
    return payload;
  } catch (err) {
    log('WARNING', 'SECRET_MANAGER_FETCH_FAILURE', {
      secret: secretName,
      error: err.message,
    });
    return null; // Graceful — adapter will fall back to static
  }
}

// ─────────────────────────────────────────────────────
//  UTILITY: Entity Hash (SHA-256 Deduplication Key)
// ─────────────────────────────────────────────────────

function entityHash(...fields) {
  const input = fields.map(f => String(f ?? '')).join('|');
  return createHash('sha256').update(input).digest('hex');
}

// ─────────────────────────────────────────────────────
//  UTILITY: Structured Logger
// ─────────────────────────────────────────────────────

function log(severity, event, data = {}) {
  console.log(JSON.stringify({
    severity,
    event,
    pipeline: 'sentinel-etl',
    tenantId: TENANT_ID,
    timestamp: new Date().toISOString(),
    ...data,
  }));
}

// ─────────────────────────────────────────────────────
//  CIRCUIT BREAKER — Live API with Cached Fallback
// ─────────────────────────────────────────────────────

/**
 * Attempt a live API call. If it fails:
 *  1. Log DEGRADED status to Cloud Logging
 *  2. Attempt to read most recent cached data from BigQuery
 *  3. If no cache, fall back to static feed adapter
 *
 * @param {string} adapterName - Human-readable adapter name
 * @param {Function} liveFn - Async function returning live data
 * @param {Function} staticFn - Sync/async function returning static data
 * @param {string} bqTable - BigQuery table to query for recent cache
 * @param {Function} bqRowMapper - Maps BQ rows → adapter schema
 * @returns {Promise<{data: any, source: string}>}
 */
async function circuitBreaker(adapterName, liveFn, staticFn, bqTable, bqRowMapper) {
  // Attempt 1: Live API
  try {
    const data = await liveFn();
    log('INFO', 'LIVE_ADAPTER_SUCCESS', { adapter: adapterName });
    return { data, source: `LIVE:${adapterName}` };
  } catch (liveErr) {
    log('WARNING', 'CIRCUIT_BREAKER_DEGRADED', {
      adapter: adapterName,
      error: liveErr.message,
      message: `Live API call failed. Falling back to cached/static data.`,
    });
  }

  // Attempt 2: Most recent BigQuery cached data (last 24h)
  try {
    const query = `
      SELECT * FROM \`${GCP_PROJECT_ID}.${BQ_DATASET}.${bqTable}\`
      WHERE tenant_id = @tenantId
        AND ingested_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
      ORDER BY ingested_at DESC
      LIMIT 100
    `;
    const [rows] = await bigquery.query({
      query,
      params: { tenantId: TENANT_ID },
      location: 'US',
    });

    if (rows.length > 0) {
      log('INFO', 'CIRCUIT_BREAKER_CACHE_HIT', {
        adapter: adapterName,
        cachedRows: rows.length,
      });
      return { data: bqRowMapper(rows), source: `CACHED:${bqTable}` };
    }
  } catch (cacheErr) {
    log('WARNING', 'CIRCUIT_BREAKER_CACHE_MISS', {
      adapter: adapterName,
      error: cacheErr.message,
    });
  }

  // Attempt 3: Static feed (always available)
  log('INFO', 'CIRCUIT_BREAKER_STATIC_FALLBACK', { adapter: adapterName });
  const data = staticFn();
  return { data, source: `STATIC:${adapterName}` };
}

// ─────────────────────────────────────────────────────
//  STAGE 1: EXTRACT (Live-first with Circuit Breaker)
// ─────────────────────────────────────────────────────

async function extract() {
  log('INFO', 'ETL_EXTRACT_START');

  // ── Pre-flight: Fetch ALL API keys from Secret Manager ──
  const [freightosKey, xenetaKey, marineTrafficKey] = await Promise.all([
    getSecret('FREIGHTOS_API_KEY'),
    getSecret('XENETA_API_KEY'),
    getSecret('MARINETRAFFIC_API_KEY'),
  ]);

  // Inject secrets into adapter environment for the duration of this run
  // (adapters read process.env at call time, not import time)
  if (freightosKey)     process.env.FREIGHTOS_API_KEY     = freightosKey;
  if (xenetaKey)        process.env.XENETA_API_KEY        = xenetaKey;
  if (marineTrafficKey) process.env.MARINETRAFFIC_API_KEY  = marineTrafficKey;

  // ── Freight Indices (Freightos live → BQ cache → static) ──
  const freightResult = await circuitBreaker(
    'Freightos',
    isFreightosAvailable() ? getLiveFreight : () => { throw new Error('No API key'); },
    getStaticFreight,
    'freight_indices',
    (rows) => ({
      global: rows.find(r => r.route_origin === 'Global Composite') || rows[0],
      routes: rows.filter(r => r.route_origin !== 'Global Composite'),
      spotContractSpreads: [],
      airFreight: [],
    }),
  );

  // Validate Freightos global & routes
  if (freightResult.data.global) {
    validate(FreightIndexSchema, freightResult.data.global, 'Freightos:Global');
  }
  (freightResult.data.routes || []).forEach(r => validate(FreightIndexSchema, r, 'Freightos:Route'));

  // ── Xeneta Spot/Contract Spreads (Xeneta live → BQ cache → static) ──
  const xenetaResult = await circuitBreaker(
    'Xeneta',
    isXenetaAvailable() ? getLiveXenetaSpreads : () => { throw new Error('No Xeneta API key'); },
    () => getStaticFreight().spotContractSpreads || [],
    'freight_indices',
    (rows) => rows
      .filter(r => r.source === 'Xeneta')
      .map(r => ({
        source: r.source,
        route_origin: r.route_origin,
        route_destination: r.route_destination,
        rate_usd: r.rate_usd,
        week_over_week_change: r.week_over_week_change,
        trend: r.trend,
        narrative_context: r.narrative_context,
      })),
  );

  // Validate Xeneta spreads
  (xenetaResult.data || []).forEach(s => validate(XenetaSpreadSchema, s, 'Xeneta'));

  // Merge Xeneta spreads into the freight data envelope
  const freightData = freightResult.data;
  freightData.spotContractSpreads = Array.isArray(xenetaResult.data)
    ? xenetaResult.data
    : [];

  // ── Port Congestion (MarineTraffic live → BQ cache → static) ──
  const portResult = await circuitBreaker(
    'MarineTraffic:Ports',
    isMarineTrafficAvailable() ? getLivePortCongestion : () => { throw new Error('No MarineTraffic API key'); },
    getStaticPorts,
    'port_congestion',
    (rows) => rows.map(r => ({
      source: r.source,
      port_name: r.port_name,
      vessels_at_anchor: r.vessels_at_anchor,
      avg_wait_days: r.avg_wait_days,
      severity_level: r.severity_level,
      narrative_context: r.narrative_context,
    })),
  );

  // Validate Port data
  (portResult.data || []).forEach(p => validate(PortCongestionSchema, p, 'MarineTraffic:Ports'));

  // ── Chokepoints (MarineTraffic live → BQ cache → static) ──
  const chokeResult = await circuitBreaker(
    'MarineTraffic:Chokepoints',
    isMarineTrafficAvailable() ? getLiveChokepoints : () => { throw new Error('No MarineTraffic API key'); },
    getStaticChokepoints,
    'maritime_chokepoints',
    (rows) => rows.map(r => ({
      source: r.source,
      chokepoint_name: r.chokepoint_name,
      status: r.status,
      vessel_queue: r.vessel_queue,
      transit_delay_hours: r.transit_delay_hours,
      narrative_context: r.narrative_context,
    })),
  );

  // Validate Chokepoint data
  (chokeResult.data || []).forEach(c => validate(ChokepointSchema, c, 'MarineTraffic:Chokepoints'));

  // ── Risk Matrix (static — internally curated, no live API) ──
  const riskResult = await circuitBreaker(
    'RiskMatrix',
    () => { throw new Error('Risk matrix is internally curated'); },
    getStaticRisk,
    'risk_matrix',
    (rows) => rows,
  );

  // Validate Risk Matrix
  (riskResult.data || []).forEach(r => validate(RiskMatrixSchema, r, 'RiskMatrix'));

  const portData  = portResult.data;
  const chokeData = chokeResult.data;
  const riskData  = riskResult.data;

  const counts = {
    freightRoutes: (freightData.routes?.length || 0) + (freightData.spotContractSpreads?.length || 0) + (freightData.airFreight?.length || 0) + 1,
    xenetaSpreads: freightData.spotContractSpreads?.length || 0,
    ports: Array.isArray(portData) ? portData.length : 0,
    chokepoints: Array.isArray(chokeData) ? chokeData.length : 0,
    risks: Array.isArray(riskData) ? riskData.length : 0,
    sources: {
      freight: freightResult.source,
      xeneta: xenetaResult.source,
      ports: portResult.source,
      chokepoints: chokeResult.source,
      risk: riskResult.source,
    },
  };

  log('INFO', 'ETL_EXTRACT_COMPLETE', counts);
  return { freightData, portData, chokeData, riskData };
}

// ─────────────────────────────────────────────────────
//  STAGE 2: TRANSFORM (Normalize + Embed + tenant_id)
// ─────────────────────────────────────────────────────

async function transform({ freightData, portData, chokeData, riskData }) {
  log('INFO', 'ETL_TRANSFORM_START');

  // ── Normalize freight indices (with tenant_id) ──
  const freightRows = [];

  // Global composite
  if (freightData.global) {
    freightRows.push({
      entity_hash: entityHash('freight', freightData.global.route_origin, freightData.global.route_destination, freightData.global.rate_usd),
      tenant_id: TENANT_ID,
      source: freightData.global.source,
      route_origin: freightData.global.route_origin,
      route_destination: freightData.global.route_destination,
      rate_usd: freightData.global.rate_usd,
      week_over_week_change: freightData.global.week_over_week_change,
      trend: freightData.global.trend,
      narrative_context: freightData.global.narrative_context,
    });
  }

  // Individual routes
  for (const route of (freightData.routes || [])) {
    freightRows.push({
      entity_hash: entityHash('freight', route.route_origin, route.route_destination, route.rate_usd),
      tenant_id: TENANT_ID,
      source: route.source,
      route_origin: route.route_origin,
      route_destination: route.route_destination,
      rate_usd: route.rate_usd,
      week_over_week_change: route.week_over_week_change,
      trend: route.trend,
      narrative_context: route.narrative_context,
    });
  }

  // Spot/Contract spreads (also freight index table)
  for (const spread of (freightData.spotContractSpreads || [])) {
    freightRows.push({
      entity_hash: entityHash('spread', spread.route_origin, spread.route_destination, spread.rate_usd),
      tenant_id: TENANT_ID,
      source: spread.source,
      route_origin: spread.route_origin,
      route_destination: spread.route_destination,
      rate_usd: spread.rate_usd,
      week_over_week_change: spread.week_over_week_change,
      trend: spread.trend,
      narrative_context: spread.narrative_context,
    });
  }

  // Air freight
  for (const af of (freightData.airFreight || [])) {
    freightRows.push({
      entity_hash: entityHash('airfreight', af.route_origin, af.route_destination, af.rate_usd),
      tenant_id: TENANT_ID,
      source: af.source,
      route_origin: af.route_origin,
      route_destination: af.route_destination,
      rate_usd: af.rate_usd,
      week_over_week_change: af.week_over_week_change,
      trend: af.trend,
      narrative_context: af.narrative_context,
    });
  }

  // ── Normalize port congestion (with tenant_id) ──
  const portRows = (Array.isArray(portData) ? portData : []).map(p => ({
    entity_hash: entityHash('port', p.port_name, p.vessels_at_anchor),
    tenant_id: TENANT_ID,
    source: p.source,
    port_name: p.port_name,
    vessels_at_anchor: p.vessels_at_anchor,
    avg_wait_days: p.avg_wait_days,
    severity_level: p.severity_level,
    narrative_context: p.narrative_context,
  }));

  // ── Normalize chokepoints (with tenant_id) ──
  const chokeRows = (Array.isArray(chokeData) ? chokeData : []).map(c => ({
    entity_hash: entityHash('choke', c.chokepoint_name, c.status, c.vessel_queue),
    tenant_id: TENANT_ID,
    source: c.source,
    chokepoint_name: c.chokepoint_name,
    status: c.status,
    vessel_queue: c.vessel_queue,
    transit_delay_hours: c.transit_delay_hours,
    narrative_context: c.narrative_context,
  }));

  // ── Normalize risk matrix (with tenant_id) ──
  const riskRows = (Array.isArray(riskData) ? riskData : []).map(r => ({
    entity_hash: entityHash('risk', r.risk_factor, r.severity, r.probability),
    tenant_id: TENANT_ID,
    source: r.source,
    risk_factor: r.risk_factor,
    severity: r.severity,
    probability: r.probability,
    impact_window: r.impact_window,
    narrative_context: r.narrative_context,
  }));

  // ── Generate Embeddings ──
  log('INFO', 'ETL_EMBEDDING_START', {
    totalTexts: freightRows.length + portRows.length + chokeRows.length + riskRows.length,
  });

  const allNarratives = [
    ...freightRows.map(r => r.narrative_context),
    ...portRows.map(r => r.narrative_context),
    ...chokeRows.map(r => r.narrative_context),
    ...riskRows.map(r => r.narrative_context),
  ];

  const allEmbeddings = await generateEmbeddings(allNarratives);

  // Distribute embeddings back to rows
  let embIdx = 0;
  for (const row of freightRows) { row.embedding = allEmbeddings[embIdx++]; }
  for (const row of portRows)    { row.embedding = allEmbeddings[embIdx++]; }
  for (const row of chokeRows)   { row.embedding = allEmbeddings[embIdx++]; }
  for (const row of riskRows)    { row.embedding = allEmbeddings[embIdx++]; }

  log('INFO', 'ETL_TRANSFORM_COMPLETE', {
    freightRows: freightRows.length,
    portRows: portRows.length,
    chokeRows: chokeRows.length,
    riskRows: riskRows.length,
    embeddingsGenerated: allEmbeddings.length,
  });

  return { freightRows, portRows, chokeRows, riskRows };
}

// ─────────────────────────────────────────────────────
//  STAGE 3: LOAD (BigQuery MERGE with Deduplication)
// ─────────────────────────────────────────────────────

async function loadTable(tableName, rows) {
  if (rows.length === 0) {
    log('INFO', 'ETL_LOAD_SKIP', { table: tableName, reason: 'no rows' });
    return;
  }

  const tableRef = `${GCP_PROJECT_ID}.${BQ_DATASET}.${tableName}`;

  // Use MERGE to deduplicate by entity_hash within the last 24h.
  // This prevents explosive growth during hourly cron fires.
  //
  // Strategy: Delete existing rows with same entity_hash from today,
  // then insert fresh rows. This is an atomic approach via DML.
  const entityHashes = rows.map(r => r.entity_hash);

  // Step 1: Delete stale duplicates from today (scoped to tenant)
  const deleteQuery = `
    DELETE FROM \`${tableRef}\`
    WHERE entity_hash IN UNNEST(@hashes)
      AND tenant_id = @tenantId
      AND ingested_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
  `;

  try {
    await bigquery.query({
      query: deleteQuery,
      params: { hashes: entityHashes, tenantId: TENANT_ID },
      location: 'US',
    });
  } catch (err) {
    // Table might not exist yet on first run — ignore delete errors
    log('WARNING', 'ETL_DEDUP_DELETE_SKIP', { table: tableName, error: err.message });
  }

  // Step 2: DML INSERT with VECTOR support (row-by-row for vector column)
  for (const row of rows) {
    const { embedding, ...originalFields } = row;
    const fields = Object.fromEntries(Object.entries(originalFields).filter(([_, v]) => v != null));
    const columns = Object.keys(fields);
    const placeholders = columns.map(c => `@${c}`);

    // VECTOR columns require special handling — pass as array literal
    const query = `
      INSERT INTO \`${tableRef}\` (${columns.join(', ')}, embedding)
      VALUES (${placeholders.join(', ')}, ${vectorLiteral(embedding)})
    `;

    await bigquery.query({
      query,
      params: fields,
      location: 'US',
    });
  }

  log('INFO', 'ETL_LOAD_BQ_COMPLETE', { table: tableName, rowsInserted: rows.length });

  // Step 3: Upsert into PostgreSQL (Pristine Reservoir)
  if (sql) {
    log('INFO', 'ETL_LOAD_POSTGRES_START', { table: tableName });
    try {
      for (const row of rows) {
        await upsertRow(tableName, row);
      }
      log('INFO', 'ETL_LOAD_POSTGRES_COMPLETE', { table: tableName, rowsUpserted: rows.length });
    } catch (err) {
      log('ERROR', 'ETL_LOAD_POSTGRES_FAILURE', { table: tableName, error: err.message });
    }
  }
}

/**
 * Convert a float array to a BigQuery VECTOR literal.
 */
function vectorLiteral(arr) {
  if (!arr || arr.length === 0) return 'NULL';
  return `[${arr.join(',')}]`;
}

async function load({ freightRows, portRows, chokeRows, riskRows }) {
  log('INFO', 'ETL_LOAD_START');

  await loadTable('freight_indices', freightRows);
  await loadTable('port_congestion', portRows);
  await loadTable('maritime_chokepoints', chokeRows);
  await loadTable('risk_matrix', riskRows);

  log('INFO', 'ETL_LOAD_ALL_COMPLETE', {
    totalRows: freightRows.length + portRows.length + chokeRows.length + riskRows.length,
  });
}

// ─────────────────────────────────────────────────────
//  MAIN — Pipeline Orchestrator
// ─────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const ingestionId = `ING-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  log('INFO', 'ETL_PIPELINE_START', { ingestionId });

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  SENTINEL ENGINE v4.1 — Industrial ETL Pipeline         ║');
  console.log('║  Project:  ha-sentinel-core-v21                         ║');
  console.log('║  Tenant:   ' + TENANT_ID.padEnd(45) + '║');
  console.log('║  Ingestion: ' + ingestionId.padEnd(44) + '║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  try {
    // ── Pre-flight: Fetch Database URL from Secret Manager ──
    const dbUrl = await getSecret('DATABASE_URL');
    if (dbUrl) {
      process.env.DATABASE_URL = dbUrl;
      log('INFO', 'DATABASE_URL_LOADED');
    }

    // Stage 1: Extract (live-first w/ circuit breaker)
    const rawData = await extract();

    // Stage 2: Transform + Embed
    const normalizedData = await transform(rawData);

    // Stage 3: Load into BigQuery
    await load(normalizedData);

    const durationMs = Date.now() - startTime;
    log('INFO', 'ETL_PIPELINE_SUCCESS', {
      ingestionId,
      durationMs,
      durationSec: Math.round(durationMs / 1000),
    });

    console.log(`\n[SENTINEL ETL] Pipeline complete in ${Math.round(durationMs / 1000)}s.`);
    
    // Close database connection
    await closeDb();
    
    process.exit(0);

  } catch (error) {
    const durationMs = Date.now() - startTime;
    log('CRITICAL', 'ETL_PIPELINE_FAILURE', {
      ingestionId,
      durationMs,
      error: error.message,
      stack: error.stack,
    });

    console.error(`\n[SENTINEL ETL CRITICAL] Pipeline failed: ${error.message}`);
    process.exit(1);
  }
}

main();
