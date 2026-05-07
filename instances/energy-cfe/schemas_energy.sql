-- ═══════════════════════════════════════════════════════════════════
--  SENTINEL ENGINE v4.1 — ENERGY VERTICAL (CFE)
--  BigQuery DDL: sentinel_warehouse_energy
--
--  Dataset:    sentinel_warehouse_energy
--  Project:    ha-sentinel-core-v21
--  Client:     CFE — Comisión Federal de Electricidad
--  Vertical:   Energy & Grid Resiliency
--
--  Key Design Decisions (same as core):
--    - tenant_id STRING NOT NULL — Row-Level Security enforcement.
--    - VECTOR<FLOAT64>(768)     — Vertex AI text-embedding-004 (768 dim).
--    - entity_hash              — SHA-256 dedup key for ETL idempotency.
--    - PARTITION BY DATE(ingested_at) — 24h relevance window partitioning.
--    - CLUSTER BY tenant_id    — Cost-efficient tenant-scoped scans.
--
--  Usage:
--    bq query --use_legacy_sql=false \
--             --project_id=ha-sentinel-core-v21 \
--             < instances/energy-cfe/schemas_energy.sql
-- ═══════════════════════════════════════════════════════════════════

-- Create the Energy Dataset (sovereign, never shared with logistics)
CREATE SCHEMA IF NOT EXISTS sentinel_warehouse_energy
  OPTIONS (location = 'US');

-- ─────────────────────────────────────────────────────────────────
--  TABLE 1: GRID TELEMETRY
--  Real-time SCADA telemetry from HV substations.
--  Sources: SCADA API, synchrophasors, smart meters.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sentinel_warehouse_energy.grid_telemetry (
  entity_hash         STRING      NOT NULL,
  tenant_id           STRING      NOT NULL,
  ingested_at         TIMESTAMP   DEFAULT CURRENT_TIMESTAMP(),
  source              STRING,                   -- e.g., 'SCADA_CFE_NORTE'
  substation_id       STRING,                   -- e.g., 'SUB-MTY-001'
  region              STRING,                   -- e.g., 'ZONA_NORTE', 'ZMCM'
  load_pct            FLOAT64,                  -- % of rated capacity (0–100+)
  voltage_kv          FLOAT64,                  -- Bus voltage in kilovolts
  voltage_status      STRING,                   -- 'NORMAL', 'BAJO', 'CRITICO'
  frequency_hz        FLOAT64,                  -- System frequency (nominal: 60 Hz)
  reactive_power_mvar FLOAT64,                  -- Reactive power in MVAR
  active_power_mw     FLOAT64,                  -- Active power in MW
  n1_contingency      BOOL,                     -- TRUE if N-1 contingency active
  narrative_context   STRING,                   -- LLM-readable summary for RAG
  embedding           ARRAY<FLOAT64>            -- Vertex AI text-embedding-004
) PARTITION BY DATE(ingested_at)
  CLUSTER BY tenant_id;

-- ─────────────────────────────────────────────────────────────────
--  TABLE 2: ASSET HEALTH
--  Condition monitoring for HV assets (transformers, breakers).
--  Sources: Thermal cameras, DGA analysis, maintenance records.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sentinel_warehouse_energy.asset_health (
  entity_hash         STRING      NOT NULL,
  tenant_id           STRING      NOT NULL,
  ingested_at         TIMESTAMP   DEFAULT CURRENT_TIMESTAMP(),
  source              STRING,                   -- e.g., 'TERMOGRAFIA_Q1_2026'
  asset_id            STRING,                   -- e.g., 'TRF-TOP-AT1'
  asset_type          STRING,                   -- 'TRANSFORMADOR', 'INTERRUPTOR', 'REACTOR'
  substation_id       STRING,                   -- Parent substation reference
  manufacturer        STRING,
  voltage_class_kv    FLOAT64,                  -- e.g., 400, 230, 115
  last_maintenance    TIMESTAMP,
  next_maintenance    TIMESTAMP,
  thermal_index       FLOAT64,                  -- °C — hotspot temperature
  dga_h2_ppm          FLOAT64,                  -- Dissolved gas: Hydrogen (ppm)
  dga_co_ppm          FLOAT64,                  -- Dissolved gas: CO (ppm)
  health_score        FLOAT64,                  -- 0.0 (critical) – 1.0 (excellent)
  criticality         STRING,                   -- 'CRITICO', 'ALTO', 'MEDIO', 'BAJO'
  action_required     STRING,                   -- 'INMEDIATO', 'PROGRAMADO', 'MONITOREO'
  narrative_context   STRING,
  embedding           ARRAY<FLOAT64>
) PARTITION BY DATE(ingested_at)
  CLUSTER BY tenant_id;

-- ─────────────────────────────────────────────────────────────────
--  TABLE 3: WEATHER IMPACT
--  Meteorological risk models for the national grid.
--  Sources: SMN (Servicio Meteorológico Nacional), CONAGUA, NOAA.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sentinel_warehouse_energy.weather_impact (
  entity_hash         STRING      NOT NULL,
  tenant_id           STRING      NOT NULL,
  ingested_at         TIMESTAMP   DEFAULT CURRENT_TIMESTAMP(),
  source              STRING,                   -- e.g., 'SMN', 'CONAGUA_CICLONES'
  region              STRING,                   -- e.g., 'GOLFO_SUR', 'PENINSULA_YUCATAN'
  alert_type          STRING,                   -- 'HURACAN', 'GRANIZADA', 'VIENTO_EXTREMO', 'CALOR'
  storm_name          STRING,                   -- e.g., 'BERYL', 'HELENE'
  storm_category      INT64,                    -- Saffir-Simpson scale (1–5)
  wind_speed_kph      FLOAT64,                  -- Max sustained winds
  temperature_c       FLOAT64,                  -- Ambient temperature
  humidity_pct        FLOAT64,
  precipitation_mm    FLOAT64,
  alert_level         STRING,                   -- 'VERDE', 'AMARILLO', 'NARANJA', 'ROJO'
  affected_lines      INT64,                    -- Estimated transmission lines at risk
  estimated_load_drop_mw FLOAT64,               -- Estimated demand reduction from storm
  narrative_context   STRING,
  embedding           ARRAY<FLOAT64>
) PARTITION BY DATE(ingested_at)
  CLUSTER BY tenant_id;

-- ═══════════════════════════════════════════════════════════════════
--  ROW-LEVEL SECURITY — BigQuery Row Access Policies (CFE Dataset)
--  Mirrors the RLS architecture from the core logistics dataset.
-- ═══════════════════════════════════════════════════════════════════

-- ── RLS: grid_telemetry ──
CREATE OR REPLACE ROW ACCESS POLICY rls_grid_telemetry_admin
  ON sentinel_warehouse_energy.grid_telemetry
  GRANT TO (
    "serviceAccount:sentinel-etl-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "user:luisfmartinez11@gmail.com"
  )
  FILTER USING (TRUE);

CREATE OR REPLACE ROW ACCESS POLICY rls_grid_telemetry_tenant
  ON sentinel_warehouse_energy.grid_telemetry
  GRANT TO (
    "serviceAccount:sentinel-inference-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "allAuthenticatedUsers"
  )
  FILTER USING (tenant_id = SESSION_USER());

-- ── RLS: asset_health ──
CREATE OR REPLACE ROW ACCESS POLICY rls_asset_health_admin
  ON sentinel_warehouse_energy.asset_health
  GRANT TO (
    "serviceAccount:sentinel-etl-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "user:luisfmartinez11@gmail.com"
  )
  FILTER USING (TRUE);

CREATE OR REPLACE ROW ACCESS POLICY rls_asset_health_tenant
  ON sentinel_warehouse_energy.asset_health
  GRANT TO (
    "serviceAccount:sentinel-inference-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "allAuthenticatedUsers"
  )
  FILTER USING (tenant_id = SESSION_USER());

-- ── RLS: weather_impact ──
CREATE OR REPLACE ROW ACCESS POLICY rls_weather_impact_admin
  ON sentinel_warehouse_energy.weather_impact
  GRANT TO (
    "serviceAccount:sentinel-etl-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "user:luisfmartinez11@gmail.com"
  )
  FILTER USING (TRUE);

CREATE OR REPLACE ROW ACCESS POLICY rls_weather_impact_tenant
  ON sentinel_warehouse_energy.weather_impact
  GRANT TO (
    "serviceAccount:sentinel-inference-sa@ha-sentinel-core-v21.iam.gserviceaccount.com",
    "allAuthenticatedUsers"
  )
  FILTER USING (tenant_id = SESSION_USER());

-- ═══════════════════════════════════════════════════════════════════
--  VECTOR INDEXES — Approximate Nearest Neighbor (TREE_AH)
--  Same strategy as core: TREE_AH for <50K rows, switch to IVF at scale.
-- ═══════════════════════════════════════════════════════════════════

CREATE VECTOR INDEX IF NOT EXISTS idx_grid_telemetry_embedding
  ON sentinel_warehouse_energy.grid_telemetry(embedding)
  OPTIONS (index_type = 'TREE_AH', distance_type = 'COSINE');

CREATE VECTOR INDEX IF NOT EXISTS idx_asset_health_embedding
  ON sentinel_warehouse_energy.asset_health(embedding)
  OPTIONS (index_type = 'TREE_AH', distance_type = 'COSINE');

CREATE VECTOR INDEX IF NOT EXISTS idx_weather_impact_embedding
  ON sentinel_warehouse_energy.weather_impact(embedding)
  OPTIONS (index_type = 'TREE_AH', distance_type = 'COSINE');
