-- ═══════════════════════════════════════════════════════════════════
--  SENTINEL ENGINE V5.5 — Multi-Tenant Sharding Schema
--  Governance Hub (Primary DB) — Shard Map & Skill Graph
--
--  This schema lives in the Governance Hub database.
--  Tenant Spoke databases are provisioned dynamically via
--  provision_shard.js and Terraform (terraform/sharding.tf).
--
--  Architecture:
--    ┌──────────────────────┐
--    │   Governance Hub     │ ← This schema
--    │   (Primary DB)       │
--    │                      │
--    │  ● shard_map         │   Tenant → Shard routing
--    │  ● project_skill_graph│   B-Tree skill admissibility
--    │  ● shard_health      │   Spoke health telemetry
--    │  ● arbitration_log   │   Sovereign Proxy audit trail
--    └──────────┬───────────┘
--               │
--    ┌──────────▼───────────┐
--    │   Tenant Spoke N     │   Physically isolated data
--    │   (Sharded DB)       │
--    │                      │
--    │  ● freight_indices   │   Domain tables (same schema
--    │  ● port_congestion   │   as current postgres.sql)
--    │  ● maritime_chokepoints│
--    │  ● risk_matrix       │
--    │  ● evidence_locker   │
--    └──────────────────────┘
-- ═══════════════════════════════════════════════════════════════════

-- Required Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- GIN trigram index for wildcard skill matching
-- ─────────────────────────────────────────────────────
--  SHARD MAP — Physical Tenant Routing Registry
-- ─────────────────────────────────────────────────────

-- Defines the mapping from a project (tenant) to its
-- physical database shard and isolation level.
--
-- Isolation Levels:
--   Tier 3 (SANDBOX)    → Row-Level Security on shared DB
--   Tier 2 (DEV)        → Schema-level isolation (shared instance, separate schema)
--   Tier 1 (PRODUCTION) → Dedicated physical shard (separate Cloud SQL instance)

CREATE TABLE IF NOT EXISTS shard_map (
    project_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_name   TEXT NOT NULL,
    
    -- Shard Configuration
    database_tier SMALLINT NOT NULL DEFAULT 3 CHECK (database_tier BETWEEN 1 AND 3),
    isolation_level TEXT NOT NULL DEFAULT 'ROW_LEVEL' CHECK (isolation_level IN (
        'ROW_LEVEL',       -- Tier 3: Shared DB, RLS policies
        'SCHEMA_LEVEL',    -- Tier 2: Shared instance, dedicated schema
        'DEDICATED_SHARD'  -- Tier 1: Physically separate Cloud SQL
    )),
    
    -- Connection Routing
    -- SECURITY: shard_dsn is AES-256-GCM encrypted at the application layer
    -- using SecurityManager.encryptField() with the Master Key from Secret Manager.
    -- The SovereignProxy MUST call SecurityManager.decryptField() before using this value.
    -- NEVER store plaintext DSNs. NEVER log decrypted DSNs.
    shard_dsn         TEXT,      -- AES-256-GCM encrypted DATABASE_URL (ciphertext)
    shard_instance_id TEXT,      -- Cloud SQL instance connection name
    shard_schema      TEXT,      -- Schema name (for Tier 2 isolation)
    storage_path      TEXT,      -- Artifact storage prefix
    
    -- Axiom-G: Sovereign Signing Integration (V5.5 Dual-Track)
    -- Determines which cryptographic algorithm seals arbiter decisions.
    --   ECDSA_P256   → Legacy Logistics Tier (Tier 1-L). Quantum-Insecure.
    --   PQ_LATTICE   → Modern Sovereign Tier (Tier 1-PQ). CRYSTALS-Dilithium (ML-DSA).
    crypto_tier TEXT NOT NULL DEFAULT 'ECDSA_P256' CHECK (crypto_tier IN (
        'ECDSA_P256',    -- Legacy: ECDSA P-256 (quantum-insecure)
        'PQ_LATTICE'     -- Modern: CRYSTALS-Dilithium / ML-DSA (post-quantum)
    )),
    
    -- Capacity & Limits
    max_queries_per_minute  INTEGER DEFAULT 350,
    max_storage_bytes       BIGINT DEFAULT 10737418240,  -- 10 GB default
    
    -- Lifecycle
    status TEXT NOT NULL DEFAULT 'PROVISIONING' CHECK (status IN (
        'PROVISIONING', 'ACTIVE', 'ROTATING', 'SUSPENDED', 'DECOMMISSIONING', 'ARCHIVED'
    )),
    provisioned_at  TIMESTAMPTZ DEFAULT NOW(),
    activated_at    TIMESTAMPTZ,
    suspended_at    TIMESTAMPTZ,
    suspension_reason TEXT,
    
    -- Metadata
    created_by TEXT NOT NULL DEFAULT 'system',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shard_tier ON shard_map(database_tier);
CREATE INDEX IF NOT EXISTS idx_shard_status ON shard_map(status) WHERE status = 'ACTIVE';


-- ─────────────────────────────────────────────────────
--  PROJECT SKILL GRAPH — B-Tree Optimized Admissibility
-- ─────────────────────────────────────────────────────

-- Controls which skills/capabilities each project (tenant)
-- is authorized to invoke. The admissibility_rank determines
-- whether a skill invocation is auto-approved, requires human
-- audit, or is denied outright.
--
-- Admissibility Ranks:
--   0 → DENIED         (Skill is prohibited for this project)
--   1 → AUDIT_REQUIRED (Skill requires human review before execution)
--   2 → AUTO_APPROVE   (Skill is pre-authorized for autonomous execution)

CREATE TABLE IF NOT EXISTS project_skill_graph (
    project_id          UUID NOT NULL REFERENCES shard_map(project_id) ON DELETE CASCADE,
    skill_name          VARCHAR(255) NOT NULL,
    admissibility_rank  SMALLINT NOT NULL DEFAULT 0 CHECK (admissibility_rank BETWEEN 0 AND 2),
    
    -- Audit Trail
    last_verified       TIMESTAMPTZ,
    verified_by         TEXT,
    denial_reason       TEXT,         -- Required when admissibility_rank = 0
    
    -- Usage Telemetry
    invocation_count    BIGINT DEFAULT 0,
    last_invoked_at     TIMESTAMPTZ,
    avg_latency_ms      NUMERIC,
    
    -- Governance
    granted_by          TEXT,         -- Authority unit that approved this skill
    grant_expires_at    TIMESTAMPTZ,  -- Optional TTL on the grant
    
    PRIMARY KEY (project_id, skill_name)
);

-- B-Tree composite index for high-speed exact skill lookups during arbitration.
-- The Sovereign Proxy queries this on EVERY /v1/arbitrate call.
CREATE INDEX IF NOT EXISTS idx_skill_lookup 
    ON project_skill_graph USING btree (project_id, skill_name);

-- GIN trigram index for wildcard skill matching (e.g., math.*, network.*).
-- Required when Gems projects use pattern-based skill resolution.
-- Requires: CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_skill_wildcard
    ON project_skill_graph USING gin (skill_name gin_trgm_ops);

-- Partial index for denied skills (fast audit queries)
CREATE INDEX IF NOT EXISTS idx_skill_denied 
    ON project_skill_graph (project_id) 
    WHERE admissibility_rank = 0;

-- Partial index for expiring grants (cron cleanup)
CREATE INDEX IF NOT EXISTS idx_skill_expiring 
    ON project_skill_graph (grant_expires_at) 
    WHERE grant_expires_at IS NOT NULL;


-- ─────────────────────────────────────────────────────
--  TENANT CRYPTO CONFIGS — PQ Key Version Registry
-- ─────────────────────────────────────────────────────

-- Tracks the Dilithium (ML-DSA) key lifecycle per tenant.
-- Without this, rotating PQ keys causes permanent
-- "Execution Blocked" errors when Gems attempt to verify
-- a v2.0 signature with a v1.0 public key.
--
-- Lifecycle: PENDING → ACTIVE_SIGNING → DEPRECATED_VERIFICATION → PURGED
-- Grace Period: 30 days between DEPRECATED and PURGE.

CREATE TABLE IF NOT EXISTS tenant_crypto_configs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Key Version
    key_version       INTEGER NOT NULL DEFAULT 1,
    algorithm         TEXT NOT NULL DEFAULT 'ML-DSA-65' CHECK (algorithm IN (
        'ECDSA-P256', 'ML-DSA-65'
    )),
    
    -- Key Material References (never store raw private keys here)
    -- These are KMS resource URIs or Secret Manager paths.
    public_key_ref    TEXT NOT NULL,    -- KMS URI or inline PEM (public only)
    private_key_ref   TEXT,             -- KMS URI (null when PURGED)
    
    -- Pending key during rotation (pre-promotion)
    pending_public_key TEXT,
    
    -- Lifecycle Status
    status TEXT NOT NULL DEFAULT 'ACTIVE_SIGNING' CHECK (status IN (
        'PENDING',                   -- Generated but not yet promoted
        'ACTIVE_SIGNING',            -- Current signing + verification key
        'DEPRECATED_VERIFICATION',   -- Can verify old blocks, cannot sign new ones
        'PURGED'                     -- Private key deleted, public key retained for audit
    )),
    
    -- Rotation Tracking
    promoted_at         TIMESTAMPTZ,     -- When key became ACTIVE_SIGNING
    deprecated_at       TIMESTAMPTZ,     -- When key moved to DEPRECATED
    purge_eligible_at   TIMESTAMPTZ,     -- deprecated_at + 30 days
    purged_at           TIMESTAMPTZ,     -- When private key was physically deleted
    last_rotation_event TIMESTAMPTZ,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by TEXT DEFAULT 'system',
    
    UNIQUE (key_version)
);

-- Active key lookup (hot path — every seal operation)
CREATE INDEX IF NOT EXISTS idx_crypto_active
    ON tenant_crypto_configs (status)
    WHERE status = 'ACTIVE_SIGNING';

-- Deprecated keys eligible for purge (cron job)
CREATE INDEX IF NOT EXISTS idx_crypto_purge_eligible
    ON tenant_crypto_configs (purge_eligible_at)
    WHERE status = 'DEPRECATED_VERIFICATION' AND purge_eligible_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crypto_version
    ON tenant_crypto_configs (key_version DESC);


-- ─────────────────────────────────────────────────────
--  EVIDENCE METADATA — PQ Rotation Audit Trail
-- ─────────────────────────────────────────────────────

-- Tracks high-level cryptographic events (Rotations, Purges)
-- that affect the global trust state of a tenant's evidence.
-- Satellite agents query this to know which Public Keys to trust.

CREATE TABLE IF NOT EXISTS evidence_metadata (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event           TEXT NOT NULL CHECK (event IN ('KEY_ROTATION', 'KEY_PURGE', 'ALGORITHM_UPGRADE')),
    
    -- Rotation Data
    old_key_version INTEGER,
    new_key_version INTEGER NOT NULL,
    new_public_key  TEXT NOT NULL,  -- The 2.4KB+ Dilithium public key
    
    timestamp       TIMESTAMPTZ DEFAULT NOW(),
    metadata        JSONB           -- Additional lattice parameters (NIST Level, etc.)
);

CREATE INDEX IF NOT EXISTS idx_evidence_meta_time 
    ON evidence_metadata (timestamp DESC);


-- ─────────────────────────────────────────────────────
--  SHARD HEALTH — Spoke Telemetry Registry
-- ─────────────────────────────────────────────────────

-- Tracks health and capacity metrics for each shard.
-- Populated by the shard health monitor (Cloud Scheduler job).

CREATE TABLE IF NOT EXISTS shard_health (
    shard_instance_id  TEXT PRIMARY KEY,
    tenant_count       INTEGER DEFAULT 0,
    
    -- Capacity
    storage_used_bytes BIGINT DEFAULT 0,
    storage_limit_bytes BIGINT DEFAULT 107374182400,  -- 100 GB
    connection_count   INTEGER DEFAULT 0,
    max_connections    INTEGER DEFAULT 100,
    
    -- Performance
    avg_query_latency_ms  NUMERIC,
    p99_query_latency_ms  NUMERIC,
    queries_per_second     NUMERIC,
    
    -- Health
    last_health_check     TIMESTAMPTZ,
    is_healthy            BOOLEAN DEFAULT TRUE,
    last_failover_at      TIMESTAMPTZ,
    
    updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ─────────────────────────────────────────────────────
--  Sovereign PROXY AUDIT LOG — Arbitration Trail
-- ─────────────────────────────────────────────────────

-- Every call to /v1/arbitrate is logged here.
-- This is the governance audit trail for the Sovereign Proxy.
-- Append-only by design. Never update, never delete.

CREATE TABLE IF NOT EXISTS Sovereign_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Request Context
    project_id      UUID REFERENCES shard_map(project_id),
    agent_role      TEXT NOT NULL,
    agent_source    TEXT NOT NULL,
    
    -- Routing Decision
    resolved_shard  TEXT,           -- Which shard was routed to
    resolved_tier   SMALLINT,      -- Tier at resolution time
    
    -- Skill Check
    skill_name      TEXT,
    skill_rank      SMALLINT,      -- Admissibility rank at query time
    
    -- Arbiter Decision
    arbiter_decision TEXT NOT NULL CHECK (arbiter_decision IN (
        'ROUTED', 'DENIED', 'ESCALATED', 'RATE_LIMITED', 'SHARD_UNAVAILABLE'
    )),
    denial_reason   TEXT,
    
    -- Payload Fingerprint (never store raw payloads in audit log)
    payload_hash    TEXT NOT NULL,  -- SHA-256 of the action_payload
    payload_size_bytes INTEGER,
    
    -- Axiom-G: Cryptographic Attestation
    crypto_algorithm  TEXT,         -- Algorithm used to seal (ECDSA_P256 or PQ_LATTICE)
    crypto_standard   VARCHAR(50) DEFAULT 'ECDSA_P256',  -- NIST standard identifier
    key_version_id    UUID,         -- FK to tenant_crypto_configs.id for PQ traceability
    seal_signature    TEXT,         -- Signature of the sealed arbiter decision (2.4KB+ for Dilithium)
    
    -- Timing
    latency_ms      NUMERIC,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_Sovereign_time 
    ON Sovereign_audit_log (created_at DESC);

-- Decision analytics
CREATE INDEX IF NOT EXISTS idx_Sovereign_decision 
    ON Sovereign_audit_log (arbiter_decision, created_at DESC);

-- Partition hint: For production volumes, partition by month:
-- CREATE TABLE Sovereign_audit_log (...) PARTITION BY RANGE (created_at);


-- ─────────────────────────────────────────────────────
--  ROW LEVEL SECURITY — Tier 3 (Sandbox) Policies
-- ─────────────────────────────────────────────────────

-- For Tier 3 (shared DB) tenants, enforce RLS on all domain tables.
-- The application sets the session variable 'sentinel.tenant_id'
-- before executing any query.

-- Enable RLS on domain tables (idempotent)
DO $$
BEGIN
    -- Only enable if the tables exist (they may be in spoke DBs)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'freight_indices') THEN
        ALTER TABLE freight_indices ENABLE ROW LEVEL SECURITY;
        ALTER TABLE freight_indices FORCE ROW LEVEL SECURITY;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'port_congestion') THEN
        ALTER TABLE port_congestion ENABLE ROW LEVEL SECURITY;
        ALTER TABLE port_congestion FORCE ROW LEVEL SECURITY;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'maritime_chokepoints') THEN
        ALTER TABLE maritime_chokepoints ENABLE ROW LEVEL SECURITY;
        ALTER TABLE maritime_chokepoints FORCE ROW LEVEL SECURITY;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'risk_matrix') THEN
        ALTER TABLE risk_matrix ENABLE ROW LEVEL SECURITY;
        ALTER TABLE risk_matrix FORCE ROW LEVEL SECURITY;
    END IF;
END
$$;

-- RLS Policies: Tenant can only see their own rows
-- Uses current_setting('sentinel.tenant_id') set by the Sovereign Proxy
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'freight_indices') THEN
        DROP POLICY IF EXISTS tenant_isolation_freight ON freight_indices;
        CREATE POLICY tenant_isolation_freight ON freight_indices
            USING (tenant_id = current_setting('sentinel.tenant_id', true));
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'port_congestion') THEN
        DROP POLICY IF EXISTS tenant_isolation_port ON port_congestion;
        CREATE POLICY tenant_isolation_port ON port_congestion
            USING (tenant_id = current_setting('sentinel.tenant_id', true));
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'maritime_chokepoints') THEN
        DROP POLICY IF EXISTS tenant_isolation_choke ON maritime_chokepoints;
        CREATE POLICY tenant_isolation_choke ON maritime_chokepoints
            USING (tenant_id = current_setting('sentinel.tenant_id', true));
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'risk_matrix') THEN
        DROP POLICY IF EXISTS tenant_isolation_risk ON risk_matrix;
        CREATE POLICY tenant_isolation_risk ON risk_matrix
            USING (tenant_id = current_setting('sentinel.tenant_id', true));
    END IF;
END
$$;
