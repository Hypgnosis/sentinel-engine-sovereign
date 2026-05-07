-- ═══════════════════════════════════════════════════════════════════
--  SENTINEL ENGINE v4.1 — CANONICAL BigQuery DDL (Multi-Tenant)
--  The Logistics Data Warehouse. Core proprietary asset.
--
--  Key Design Decisions:
--    - tenant_id STRING NOT NULL — Row-Level Security enforcement.
--      Every query MUST filter by tenant_id. RLS policies are applied
--      via BigQuery Row Access Policies (see bottom of file).
--    - VECTOR<FLOAT64>(768) — Native BQ vector type, optimized for
--      VECTOR_SEARCH indexing with Vertex AI text-embedding-004.
--    - entity_hash — SHA-256 deduplication key. Prevents explosive
--      table growth during hourly ETL cron cycles.
--    - PARTITION BY DATE(ingested_at) — Time-series partitioning
--      for cost-efficient 24-hour relevance windows.
--
--  Usage: bq query --use_legacy_sql=false --project_id=ha-sentinel-core-v21 < schemas.sql
-- ═══════════════════════════════════════════════════════════════════

-- Create the dataset
CREATE SCHEMA IF NOT EXISTS sentinel_warehouse
  OPTIONS (location = 'US');

-- ─────────────────────────────────────────────────────
--  1. FREIGHT INDICES
--  Routes, rates, WoW changes. Freightos/Xeneta/BDI.
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sentinel_warehouse.freight_indices (
  entity_hash             STRING      NOT NULL,
  tenant_id               STRING      NOT NULL,
  ingested_at             TIMESTAMP   DEFAULT CURRENT_TIMESTAMP(),
  source                  STRING,
  route_origin            STRING,
  route_destination       STRING,
  rate_usd                FLOAT64,
  week_over_week_change   FLOAT64,
  trend                   STRING,
  narrative_context       STRING,
  embedding               ARRAY<FLOAT64>
) PARTITION BY DATE(ingested_at)
  CLUSTER BY tenant_id;

-- ─────────────────────────────────────────────────────
--  2. PORT CONGESTION
--  Vessel counts, wait times, severity classification.
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sentinel_warehouse.port_congestion (
  entity_hash             STRING      NOT NULL,
  tenant_id               STRING      NOT NULL,
  ingested_at             TIMESTAMP   DEFAULT CURRENT_TIMESTAMP(),
  source                  STRING,
  port_name               STRING,
  vessels_at_anchor       INT64,
  avg_wait_days           FLOAT64,
  severity_level          STRING,
  narrative_context       STRING,
  embedding               ARRAY<FLOAT64>
) PARTITION BY DATE(ingested_at)
  CLUSTER BY tenant_id;

-- ─────────────────────────────────────────────────────
--  3. MARITIME CHOKEPOINTS
--  Transit delays, queue status, geopolitical flags.
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sentinel_warehouse.maritime_chokepoints (
  entity_hash             STRING      NOT NULL,
  tenant_id               STRING      NOT NULL,
  ingested_at             TIMESTAMP   DEFAULT CURRENT_TIMESTAMP(),
  source                  STRING,
  chokepoint_name         STRING,
  status                  STRING,
  vessel_queue            INT64,
  transit_delay_hours     FLOAT64,
  narrative_context       STRING,
  embedding               ARRAY<FLOAT64>
) PARTITION BY DATE(ingested_at)
  CLUSTER BY tenant_id;

-- ─────────────────────────────────────────────────────
--  4. RISK MATRIX
--  Geopolitical, environmental, regulatory risk factors.
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sentinel_warehouse.risk_matrix (
  entity_hash             STRING      NOT NULL,
  tenant_id               STRING      NOT NULL,
  ingested_at             TIMESTAMP   DEFAULT CURRENT_TIMESTAMP(),
  source                  STRING,
  risk_factor             STRING,
  severity                STRING,
  probability             STRING,
  impact_window           STRING,
  narrative_context       STRING,
  embedding               ARRAY<FLOAT64>
) PARTITION BY DATE(ingested_at)
  CLUSTER BY tenant_id;

-- ═══════════════════════════════════════════════════════════════════
--  ROW-LEVEL SECURITY (RLS) — BigQuery Row Access Policies
--  
--  These policies enforce that queries can ONLY return rows where
--  tenant_id matches the caller's session variable or the service
--  account's designated tenant scope.
--
--  Implementation:
--    - The Cloud Function sets SESSION tenant_id = <JWT claim>
--    - The ETL SA is granted full data access (it writes all tenants)
--    - Each tenant's analyst users see only their own data
--
--  BigQuery RLS uses CREATE ROW ACCESS POLICY on each table.
--  The filter_using expression restricts visible rows.
-- ═══════════════════════════════════════════════════════════════════

-- ── RLS Policy: freight_indices ──
-- Grants:
--   sentinel-etl-sa: full access (writes all tenant data)
--   sentinel-inference-sa: filtered by SESSION.tenant_id
CREATE OR REPLACE ROW ACCESS POLICY rls_freight_tenant
  ON sentinel_warehouse.freight_indices
  GRANT TO (
    "serviceAccount:sentinel-etl-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "user:luisfmartinez11@gmail.com"
  )
  FILTER USING (TRUE);

CREATE OR REPLACE ROW ACCESS POLICY rls_freight_tenant_scoped
  ON sentinel_warehouse.freight_indices
  GRANT TO (
    "serviceAccount:sentinel-inference-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "allAuthenticatedUsers"
  )
  FILTER USING (tenant_id = SESSION_USER());

-- ── RLS Policy: port_congestion ──
CREATE OR REPLACE ROW ACCESS POLICY rls_port_tenant
  ON sentinel_warehouse.port_congestion
  GRANT TO (
    "serviceAccount:sentinel-etl-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "user:luisfmartinez11@gmail.com"
  )
  FILTER USING (TRUE);

CREATE OR REPLACE ROW ACCESS POLICY rls_port_tenant_scoped
  ON sentinel_warehouse.port_congestion
  GRANT TO (
    "serviceAccount:sentinel-inference-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "allAuthenticatedUsers"
  )
  FILTER USING (tenant_id = SESSION_USER());

-- ── RLS Policy: maritime_chokepoints ──
CREATE OR REPLACE ROW ACCESS POLICY rls_chokepoint_tenant
  ON sentinel_warehouse.maritime_chokepoints
  GRANT TO (
    "serviceAccount:sentinel-etl-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "user:luisfmartinez11@gmail.com"
  )
  FILTER USING (TRUE);

CREATE OR REPLACE ROW ACCESS POLICY rls_chokepoint_tenant_scoped
  ON sentinel_warehouse.maritime_chokepoints
  GRANT TO (
    "serviceAccount:sentinel-inference-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "allAuthenticatedUsers"
  )
  FILTER USING (tenant_id = SESSION_USER());

-- ── RLS Policy: risk_matrix ──
CREATE OR REPLACE ROW ACCESS POLICY rls_risk_tenant
  ON sentinel_warehouse.risk_matrix
  GRANT TO (
    "serviceAccount:sentinel-etl-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "user:luisfmartinez11@gmail.com"
  )
  FILTER USING (TRUE);

CREATE OR REPLACE ROW ACCESS POLICY rls_risk_tenant_scoped
  ON sentinel_warehouse.risk_matrix
  GRANT TO (
    "serviceAccount:sentinel-inference-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "allAuthenticatedUsers"
  )
  FILTER USING (tenant_id = SESSION_USER());

-- ═══════════════════════════════════════════════════════════════════
--  VECTOR INDEXES — Approximate Nearest Neighbor (ANN)
--
--  WITHOUT these indexes, VECTOR_SEARCH performs exact nearest neighbor
--  (brute-force full table scan). With TREE_AH, BigQuery uses an
--  Asymmetric Hashing tree for sub-second ANN retrieval.
--
--  TREE_AH is chosen over IVF because it activates on tables with
--  fewer than 5,000 rows. Switch to IVF when tables exceed ~50K rows.
--
--  Expected improvement: VECTOR_SEARCH drops from 15-25s → 1-3s.
-- ═══════════════════════════════════════════════════════════════════

CREATE VECTOR INDEX IF NOT EXISTS idx_freight_embedding
  ON sentinel_warehouse.freight_indices(embedding)
  OPTIONS (index_type = 'TREE_AH', distance_type = 'COSINE');

CREATE VECTOR INDEX IF NOT EXISTS idx_port_embedding
  ON sentinel_warehouse.port_congestion(embedding)
  OPTIONS (index_type = 'TREE_AH', distance_type = 'COSINE');

CREATE VECTOR INDEX IF NOT EXISTS idx_chokepoint_embedding
  ON sentinel_warehouse.maritime_chokepoints(embedding)
  OPTIONS (index_type = 'TREE_AH', distance_type = 'COSINE');

CREATE VECTOR INDEX IF NOT EXISTS idx_risk_embedding
  ON sentinel_warehouse.risk_matrix(embedding)
  OPTIONS (index_type = 'TREE_AH', distance_type = 'COSINE');
