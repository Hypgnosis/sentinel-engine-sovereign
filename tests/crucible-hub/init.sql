-- ═══════════════════════════════════════════════════════════════
--  SENTINEL V5.5 — Crucible Hub Schema
--  
--  Minimal schema for the sovereign_audit_log table used during
--  the Crucible load test. Matches the production schema from
--  sharding.sql but without the shard_map FK (standalone test).
-- ═══════════════════════════════════════════════════════════════

-- Sidecar WAL entries land here via POST /v1/evidence/ingest
CREATE TABLE IF NOT EXISTS sovereign_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Sidecar WAL fields (direct mapping)
    tenant_id       TEXT NOT NULL,
    skill_name      TEXT,
    resource_path   TEXT,
    arbiter_decision TEXT NOT NULL CHECK (arbiter_decision IN (
        'ADMISSIBLE', 'DENIED', 'ESCALATED', 'RATE_LIMITED', 'SHARD_UNAVAILABLE'
    )),
    sidecar_audit_id TEXT NOT NULL UNIQUE,  -- The sc_ UUIDv7 from the WAL
    
    -- Timing
    sidecar_latency_us  BIGINT,
    wal_timestamp       TIMESTAMPTZ,
    ingested_at         TIMESTAMPTZ DEFAULT NOW(),
    
    -- Integrity
    wal_sequence        BIGINT,            -- Monotonic counter from the WAL
    synced              BOOLEAN DEFAULT TRUE
);

-- Hot query: "how many entries per tenant in the last hour?"
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time 
    ON sovereign_audit_log (tenant_id, ingested_at DESC);

-- Hot query: "any DENIED decisions?"
CREATE INDEX IF NOT EXISTS idx_audit_decision 
    ON sovereign_audit_log (arbiter_decision, ingested_at DESC);

-- Uniqueness on sidecar_audit_id prevents double-ingestion from WAL replay
-- (Already handled by UNIQUE constraint above)

-- Pre-warm: analyze the empty table so the planner has stats
ANALYZE sovereign_audit_log;
