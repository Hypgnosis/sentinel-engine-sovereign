/**
 * SENTINEL ENGINE v4.1 — Energy ETL Pipeline (CFE)
 * ═══════════════════════════════════════════════════════
 * Cloud Run Job that ingests energy-domain data into the
 * sentinel_warehouse_energy BigQuery dataset.
 *
 * Pipeline:
 *   1. EXTRACT  — Pull from energy-grid static adapter
 *   2. TRANSFORM — Normalize, generate entity_hash, build narratives,
 *                  generate Vertex AI embeddings (text-embedding-004)
 *   3. LOAD — Batch-insert into BigQuery with MERGE deduplication
 *
 * Tenancy:  All rows stamped with tenant_id for RLS enforcement
 * Dataset:  sentinel_warehouse_energy (sovereign, isolated from logistics)
 *
 * Usage:
 *   BQ_DATASET=sentinel_warehouse_energy TENANT_ID=cfe-production node seed-energy.js
 * ═══════════════════════════════════════════════════════
 */

import { createHash } from 'node:crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { generateEmbeddings } from '../../etl/embeddings.js';
import {
  getGridTelemetry,
  getAssetHealth,
  getWeatherImpact,
} from '../../etl/adapters/energy-grid.js';

// ─────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────

const GCP_PROJECT_ID = 'ha-sentinel-core-v21';
const BQ_DATASET     = process.env.BQ_DATASET || 'sentinel_warehouse_energy';
const TENANT_ID      = process.env.TENANT_ID  || 'cfe-demo';

const bigquery = new BigQuery({ projectId: GCP_PROJECT_ID });

// ─────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────

function entityHash(...fields) {
  const input = fields.map(f => String(f ?? '')).join('|');
  return createHash('sha256').update(input).digest('hex');
}

function log(severity, event, data = {}) {
  console.log(JSON.stringify({
    severity,
    event,
    pipeline: 'sentinel-etl-energy',
    tenantId: TENANT_ID,
    timestamp: new Date().toISOString(),
    ...data,
  }));
}

// ─────────────────────────────────────────────────────
//  TRANSFORM + LOAD — Grid Telemetry
// ─────────────────────────────────────────────────────

async function ingestGridTelemetry() {
  const raw = getGridTelemetry();
  log('INFO', 'EXTRACT_GRID_TELEMETRY', { count: raw.length });

  const rows = raw.map(r => ({
    id: entityHash(r.substation_id, r.region, r.load_pct),
    tenant_id: TENANT_ID,
    substation_id: r.substation_id,
    substation_name: r.substation_name,
    region: r.region,
    load_pct: r.load_pct,
    voltage_kv: r.voltage_kv,
    voltage_status: r.voltage_status,
    frequency_hz: r.frequency_hz,
    active_power_mw: r.active_power_mw,
    reactive_power_mvar: r.reactive_power_mvar,
    source: r.source,
    narrative_context: r.narrative_context,
    entity_hash: entityHash(r.substation_id, r.region),
    ingested_at: new Date().toISOString(),
  }));

  // Generate embeddings for the narrative context
  const narratives = rows.map(r => r.narrative_context);
  const embeddings = await generateEmbeddings(narratives);

  const enrichedRows = rows.map((row, i) => ({
    ...row,
    embedding: embeddings[i] || new Array(768).fill(0),
  }));

  await loadToBigQuery('grid_telemetry', enrichedRows);
  log('INFO', 'LOAD_GRID_TELEMETRY_COMPLETE', { rowsInserted: enrichedRows.length });
}

// ─────────────────────────────────────────────────────
//  TRANSFORM + LOAD — Asset Health
// ─────────────────────────────────────────────────────

async function ingestAssetHealth() {
  const raw = getAssetHealth();
  log('INFO', 'EXTRACT_ASSET_HEALTH', { count: raw.length });

  const rows = raw.map(r => ({
    id: entityHash(r.asset_id, r.substation_id, r.thermal_index),
    tenant_id: TENANT_ID,
    asset_id: r.asset_id,
    asset_type: r.asset_type,
    substation_id: r.substation_id,
    manufacturer: r.manufacturer,
    year_installed: r.year_installed,
    last_maintenance: r.last_maintenance,
    next_scheduled_maintenance: r.next_scheduled_maintenance,
    thermal_index: r.thermal_index,
    thermal_status: r.thermal_status,
    health_score: r.health_score,
    oil_quality_index: r.oil_quality_index,
    dissolved_gas_ppm: r.dissolved_gas_ppm,
    criticality: r.criticality,
    source: r.source,
    narrative_context: r.narrative_context,
    entity_hash: entityHash(r.asset_id, r.substation_id),
    ingested_at: new Date().toISOString(),
  }));

  const narratives = rows.map(r => r.narrative_context);
  const embeddings = await generateEmbeddings(narratives);

  const enrichedRows = rows.map((row, i) => ({
    ...row,
    embedding: embeddings[i] || new Array(768).fill(0),
  }));

  await loadToBigQuery('asset_health', enrichedRows);
  log('INFO', 'LOAD_ASSET_HEALTH_COMPLETE', { rowsInserted: enrichedRows.length });
}

// ─────────────────────────────────────────────────────
//  TRANSFORM + LOAD — Weather Impact
// ─────────────────────────────────────────────────────

async function ingestWeatherImpact() {
  const raw = getWeatherImpact();
  log('INFO', 'EXTRACT_WEATHER_IMPACT', { count: raw.length });

  const rows = raw.map(r => ({
    id: entityHash(r.region, r.alert_type, r.alert_level),
    tenant_id: TENANT_ID,
    region: r.region,
    alert_type: r.alert_type,
    wind_speed_kph: r.wind_speed_kph,
    temperature_c: r.temperature_c,
    humidity_pct: r.humidity_pct,
    alert_level: r.alert_level,
    storm_category: r.storm_category,
    affected_substations: r.affected_substations,
    expected_load_increase_pct: r.expected_load_increase_pct,
    source: r.source,
    narrative_context: r.narrative_context,
    entity_hash: entityHash(r.region, r.alert_type),
    ingested_at: new Date().toISOString(),
  }));

  const narratives = rows.map(r => r.narrative_context);
  const embeddings = await generateEmbeddings(narratives);

  const enrichedRows = rows.map((row, i) => ({
    ...row,
    embedding: embeddings[i] || new Array(768).fill(0),
  }));

  await loadToBigQuery('weather_impact', enrichedRows);
  log('INFO', 'LOAD_WEATHER_IMPACT_COMPLETE', { rowsInserted: enrichedRows.length });
}

// ─────────────────────────────────────────────────────
//  BIGQUERY LOAD — Batch Insert with Deduplication
// ─────────────────────────────────────────────────────

async function loadToBigQuery(tableName, rows) {
  if (rows.length === 0) {
    log('WARNING', 'LOAD_SKIP_EMPTY', { table: tableName });
    return;
  }

  const table = bigquery.dataset(BQ_DATASET).table(tableName);

  try {
    // First, delete existing rows for this tenant to prevent duplicates
    const deleteQuery = `
      DELETE FROM \`${GCP_PROJECT_ID}.${BQ_DATASET}.${tableName}\`
      WHERE tenant_id = @tenantId
        AND ingested_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
    `;
    await bigquery.query({
      query: deleteQuery,
      params: { tenantId: TENANT_ID },
      location: 'US',
    });

    // Insert fresh rows
    await table.insert(rows, {
      skipInvalidRows: false,
      ignoreUnknownValues: false,
    });

    log('INFO', 'BQ_INSERT_SUCCESS', {
      table: tableName,
      rowCount: rows.length,
    });
  } catch (err) {
    log('ERROR', 'BQ_INSERT_FAILURE', {
      table: tableName,
      error: err.message,
      errors: err.errors?.slice(0, 3),
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────
//  MAIN — Pipeline Orchestrator
// ─────────────────────────────────────────────────────

async function main() {
  const pipelineStart = Date.now();

  log('INFO', 'PIPELINE_START', {
    dataset: BQ_DATASET,
    tables: ['grid_telemetry', 'asset_health', 'weather_impact'],
  });

  try {
    // Sequential to respect embedding API rate limits
    await ingestGridTelemetry();
    await ingestAssetHealth();
    await ingestWeatherImpact();

    const durationMs = Date.now() - pipelineStart;
    log('INFO', 'PIPELINE_COMPLETE', {
      durationMs,
      durationSec: (durationMs / 1000).toFixed(1),
      status: 'SUCCESS',
    });

    process.exit(0);
  } catch (err) {
    const durationMs = Date.now() - pipelineStart;
    log('CRITICAL', 'PIPELINE_FAILURE', {
      durationMs,
      error: err.message,
      stack: err.stack,
      status: 'FAILURE',
    });

    process.exit(1);
  }
}

main();
