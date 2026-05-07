/**
 * SENTINEL ENGINE V5.5.0 — BigQuery Audit Log Exporter
 * ══════════════════════════════════════════════════════════════════════
 * Streams ECDSA-signed Evidence Locker records to BigQuery in real-time.
 *
 * WHY BigQuery and not just Postgres?
 *   - Postgres is the operational store (mutable, tenant-isolated).
 *   - BigQuery is the immutable audit archive (append-only, off-container).
 *   - KPMG Principle 4.4 requires a second-copy audit trail that is
 *     structurally independent of the primary data plane.
 *   - BigQuery's audit export can be connected to Data Studio, Chronicle
 *     SIEM, or exported to a customer's own GCS bucket for compliance.
 *
 * DESIGN RULES:
 *   - Non-blocking. BQ insert failures NEVER cause the primary request to fail.
 *   - Structured as a streaming insert (insertAll), not a batch load job.
 *   - Includes the ECDSA signature so auditors can verify the record
 *     without trusting this pipeline.
 *   - All errors are logged as structured JSON for Cloud Monitoring alerts.
 * ══════════════════════════════════════════════════════════════════════
 */

'use strict';

const { BigQuery } = require('@google-cloud/bigquery');

// ─────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID
  || process.env.GCP_PROJECT
  || process.env.GOOGLE_CLOUD_PROJECT
  || 'ha-sentinel-core-v21';

const BQ_DATASET   = 'sentinel_governance';
const BQ_TABLE     = 'audit_log';
const ENGINE_BUILD = '3d55e3f'; // Pinned at deploy time — update on each release

// Singleton BQ client (created lazily — does not block cold start)
let _bq = null;
function getBQ() {
  if (!_bq) {
    _bq = new BigQuery({ projectId: GCP_PROJECT_ID });
  }
  return _bq;
}

// ─────────────────────────────────────────────────────
//  SCHEMA (reference — created by setup script)
// ─────────────────────────────────────────────────────
//
// Dataset:  sentinel_governance
// Table:    audit_log
// Partition: ingestion_time (DATE)
// Clustering: tenant_id, decision
//
// Fields:
//   inserted_at        TIMESTAMP   REQUIRED
//   engine_build       STRING      REQUIRED  — git commit hash
//   request_id         STRING      REQUIRED
//   tenant_id          STRING      REQUIRED
//   decision           STRING      REQUIRED  — permit|deny|halt|escalate
//   authority_unit_id  STRING      NULLABLE
//   contract_id        STRING      NULLABLE
//   confidence         FLOAT64     NULLABLE
//   classification     STRING      NULLABLE  — GENERAL|SENSITIVE|HIGH_IMPACT|RESTRICTED
//   impact_level       STRING      NULLABLE  — STANDARD|HIGH_IMPACT
//   narrative_summary  STRING      NULLABLE  — first 500 chars of narrative
//   legibility_record  JSON        NULLABLE  — full JSON blob
//   governance_finding JSON        NULLABLE  — full JSON blob
//   signature          STRING      REQUIRED  — ECDSA P-256 hex signature
//   data_authority     STRING      NULLABLE
// ─────────────────────────────────────────────────────

/**
 * Stream one Evidence Locker record to BigQuery.
 * Non-blocking — must be called with fire-and-forget semantics.
 *
 * @param {object} params
 * @param {string} params.request_id
 * @param {string} params.tenant_id
 * @param {string} params.decision         - 'permit'|'deny'|'halt'|'escalate'
 * @param {string} [params.authority_unit_id]
 * @param {string} [params.contract_id]
 * @param {number} [params.confidence]
 * @param {string} [params.classification]
 * @param {string} [params.impact_level]
 * @param {string} [params.narrative]      - truncated to 500 chars
 * @param {object} [params.legibility_record]
 * @param {object} [params.governance_finding]
 * @param {string} params.signature        - ECDSA P-256 hex signature
 * @param {string} [params.data_authority]
 * @returns {Promise<void>}
 */
async function exportAuditRecord(params) {
  const {
    request_id,
    tenant_id,
    decision,
    authority_unit_id  = null,
    contract_id        = null,
    confidence         = null,
    classification     = null,
    impact_level       = null,
    narrative          = null,
    legibility_record  = null,
    governance_finding = null,
    signature,
    data_authority     = null,
  } = params;

  const row = {
    insertId: `${request_id}-${Date.now()}`, // dedup key for BQ insertAll
    json: {
      inserted_at:        BigQuery.timestamp(new Date()),
      engine_build:       ENGINE_BUILD,
      request_id,
      tenant_id,
      decision,
      authority_unit_id,
      contract_id,
      confidence,
      classification,
      impact_level,
      narrative_summary:  narrative ? String(narrative).substring(0, 500) : null,
      legibility_record:  legibility_record ? JSON.stringify(legibility_record) : null,
      governance_finding: governance_finding ? JSON.stringify(governance_finding) : null,
      signature,
      data_authority,
    },
  };

  try {
    const bq = getBQ();
    await bq
      .dataset(BQ_DATASET)
      .table(BQ_TABLE)
      .insert([row], { skipInvalidRows: false, ignoreUnknownValues: false });

    console.log(JSON.stringify({
      severity:   'INFO',
      eventType:  'AUDIT_LOG_EXPORTED',
      request_id,
      tenant_id,
      decision,
      message:    `[AUDIT_EXPORT] Decision record streamed to BQ audit_log.`,
    }));
  } catch (err) {
    // BQ export failure is NEVER allowed to break the primary request.
    // It is logged as a CRITICAL structured event so the Cloud Monitoring
    // alert ("Evidence Locker Write Failure") fires.
    const errDetail = err.errors
      ? JSON.stringify(err.errors.slice(0, 3))
      : err.message;

    console.error(JSON.stringify({
      severity:  'CRITICAL',
      eventType: 'AUDIT_EXPORT_FAILURE',
      request_id,
      tenant_id,
      error:     errDetail,
      message:   `[AUDIT_EXPORT] FAILED to stream audit record to BigQuery. Primary request not affected. BQ error: ${errDetail}`,
    }));
  }
}

/**
 * Idempotent setup: creates the sentinel_governance dataset and audit_log table
 * if they do not already exist.
 *
 * Run once during infra provisioning:
 *   node -e "require('./audit-log-exporter').ensureAuditTable()"
 */
async function ensureAuditTable() {
  const bq = getBQ();

  // Create dataset (no-op if exists)
  try {
    await bq.createDataset(BQ_DATASET, { location: 'US' });
    console.log(`[AUDIT_EXPORT] Dataset ${BQ_DATASET} created.`);
  } catch (err) {
    if (!err.message.includes('Already Exists')) {
      throw err;
    }
  }

  // Create table with schema + partitioning + clustering
  const schema = [
    { name: 'inserted_at',        type: 'TIMESTAMP', mode: 'REQUIRED' },
    { name: 'engine_build',       type: 'STRING',    mode: 'REQUIRED' },
    { name: 'request_id',         type: 'STRING',    mode: 'REQUIRED' },
    { name: 'tenant_id',          type: 'STRING',    mode: 'REQUIRED' },
    { name: 'decision',           type: 'STRING',    mode: 'REQUIRED' },
    { name: 'authority_unit_id',  type: 'STRING',    mode: 'NULLABLE' },
    { name: 'contract_id',        type: 'STRING',    mode: 'NULLABLE' },
    { name: 'confidence',         type: 'FLOAT64',   mode: 'NULLABLE' },
    { name: 'classification',     type: 'STRING',    mode: 'NULLABLE' },
    { name: 'impact_level',       type: 'STRING',    mode: 'NULLABLE' },
    { name: 'narrative_summary',  type: 'STRING',    mode: 'NULLABLE' },
    { name: 'legibility_record',  type: 'JSON',      mode: 'NULLABLE' },
    { name: 'governance_finding', type: 'JSON',      mode: 'NULLABLE' },
    { name: 'signature',          type: 'STRING',    mode: 'REQUIRED' },
    { name: 'data_authority',     type: 'STRING',    mode: 'NULLABLE' },
  ];

  const options = {
    schema,
    timePartitioning: {
      type:  'DAY',
      field: 'inserted_at',
    },
    clustering: {
      fields: ['tenant_id', 'decision'],
    },
  };

  try {
    const dataset = bq.dataset(BQ_DATASET);
    await dataset.createTable(BQ_TABLE, options);
    console.log(`[AUDIT_EXPORT] Table ${BQ_DATASET}.${BQ_TABLE} created with partitioning + clustering.`);
  } catch (err) {
    if (err.message.includes('Already Exists')) {
      console.log(`[AUDIT_EXPORT] Table ${BQ_DATASET}.${BQ_TABLE} already exists.`);
    } else {
      throw err;
    }
  }
}

module.exports = { exportAuditRecord, ensureAuditTable };
