-- SENTINEL ENGINE V4.5 — PostgreSQL Schema (Pristine Reservoir)
-- ═══════════════════════════════════════════════════════════
-- This schema represents the operational core for the V4.5 
-- high-speed RAG grounding engine.

-- Enable pgvector for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────────────────────────────
--  LOGISTICS DOMAIN TABLES
-- ─────────────────────────────────────────────────────

-- Freight Indices (Grounding for Freightos/Xeneta)
CREATE TABLE IF NOT EXISTS freight_indices (
    id SERIAL PRIMARY KEY,
    entity_hash TEXT UNIQUE NOT NULL,

    source TEXT NOT NULL,
    route_origin TEXT,
    route_destination TEXT,
    rate_usd NUMERIC,
    week_over_week_change NUMERIC,
    trend TEXT,
    narrative_context TEXT NOT NULL,
    embedding vector(768), -- Assuming Vertex AI text-embedding-004 (768d)
    ingested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Port Congestion (MarineTraffic)
CREATE TABLE IF NOT EXISTS port_congestion (
    id SERIAL PRIMARY KEY,
    entity_hash TEXT UNIQUE NOT NULL,

    source TEXT NOT NULL,
    port_name TEXT NOT NULL,
    vessels_at_anchor INTEGER,
    avg_wait_days NUMERIC,
    severity_level TEXT,
    narrative_context TEXT NOT NULL,
    embedding vector(768),
    ingested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Maritime Chokepoints (MarineTraffic)
CREATE TABLE IF NOT EXISTS maritime_chokepoints (
    id SERIAL PRIMARY KEY,
    entity_hash TEXT UNIQUE NOT NULL,

    source TEXT NOT NULL,
    chokepoint_name TEXT NOT NULL,
    status TEXT,
    vessel_queue INTEGER,
    transit_delay_hours NUMERIC,
    narrative_context TEXT NOT NULL,
    embedding vector(768),
    ingested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Risk Matrix (Internal)
CREATE TABLE IF NOT EXISTS risk_matrix (
    id SERIAL PRIMARY KEY,
    entity_hash TEXT UNIQUE NOT NULL,

    source TEXT NOT NULL,
    risk_factor TEXT NOT NULL,
    severity TEXT,
    probability TEXT,
    impact_window TEXT,
    narrative_context TEXT NOT NULL,
    embedding vector(768),
    ingested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────
--  SECURITY & IDENTITY (V5.0 Provisional)
-- ─────────────────────────────────────────────────────

-- Subject Revocation List (The "Kill Switch")
CREATE TABLE IF NOT EXISTS subject_revocation_list (
    subject_id TEXT PRIMARY KEY,
    revocation_reason TEXT,
    revoked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    revoked_by TEXT
);

-- ─────────────────────────────────────────────────────
--  INDEXES (High-Speed Retrieval)
-- ─────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_freight_vector ON freight_indices USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_port_vector ON port_congestion USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_choke_vector ON maritime_chokepoints USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_risk_vector ON risk_matrix USING hnsw (embedding vector_cosine_ops);


-- ─────────────────────────────────────────────────────
--  V5.4 HITL & ESCALATION MODULE
-- ─────────────────────────────────────────────────────

-- Standing Authority Matrix — Named Human Approvers
-- Maps blast-radius classifications to escalation tiers.
-- Fulfills NIST CSF 2.0 GOVERN function: "Conditional Execution."
CREATE TABLE IF NOT EXISTS standing_authority_matrix (
    unit_id TEXT PRIMARY KEY,

    config JSONB NOT NULL,
    grantor_id TEXT REFERENCES standing_authority_matrix(unit_id),
    signature TEXT NOT NULL,
    
    -- Legacy columns maintained for V5.4 compatibility during migration
    name TEXT,
    role TEXT,
    blast_radius TEXT,
    escalation_tier INTEGER,
    contact_channel TEXT,
    webhook_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Evidence Locker — Immutable Audit Ledger (KPMG Principle 4.4)
-- Append-only. Each entry HMAC-signed. Chain-of-custody via previous_signature.
-- This is not a log — it is a cryptographically signed receipt of truth.
CREATE TABLE IF NOT EXISTS evidence_locker (
    locker_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'PROSECUTOR_REJECTION',
        'ESCALATION_CREATED',
        'HUMAN_OVERRIDE',
        'HUMAN_CONFIRM_REJECTION',
        'COACHING_ANNOTATION',
        'ROLLBACK_TRIGGERED',
        'PRISTINE_CHECKPOINT',
        'AUTHORITY_MODIFIED'
    )),
    responsible_authority_id TEXT REFERENCES standing_authority_matrix(unit_id),
    payload JSONB NOT NULL,
    signature TEXT NOT NULL,
    previous_signature TEXT,       -- chain link to prior entry

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Escalation Requests — JIT Approval Queue
-- Status lifecycle: PENDING → OVERRIDE_RELEASED | CONFIRMED_BLOCKED | TTL_EXPIRED
CREATE TABLE IF NOT EXISTS escalation_requests (
    escalation_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,

    authority_id TEXT REFERENCES standing_authority_matrix(unit_id),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
        'PENDING', 'OVERRIDE_RELEASED', 'CONFIRMED_BLOCKED', 'TTL_EXPIRED'
    )),
    impact_level TEXT NOT NULL DEFAULT 'HIGH_IMPACT' CHECK (impact_level IN (
        'HIGH_IMPACT', 'STANDARD', 'LOW'
    )),
    blast_radius TEXT NOT NULL DEFAULT 'LOCAL',
    evidence_fragment JSONB NOT NULL,    -- { aiIntent, pristineData, prosecutorLogic }
    resolution_payload JSONB,
    coaching_annotation TEXT,
    ttl_expires_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT,
    webauthn_assertion_id TEXT,          -- links to the FIDO2 assertion used
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- WebAuthn Credentials — FIDO2 Hardware Key Storage
-- No "bypass" mode exists in V5.4. Every override MUST be hardware-signed.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    credential_id TEXT PRIMARY KEY,
    authority_id TEXT NOT NULL REFERENCES standing_authority_matrix(unit_id),
    public_key BYTEA NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT[],
    aaguid TEXT,                         -- authenticator attestation GUID
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add escalation link to verification_results
ALTER TABLE verification_results ADD COLUMN IF NOT EXISTS escalation_id TEXT;

-- ─────────────────────────────────────────────────────
--  V5.4 INDEXES
-- ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_evidence_request ON evidence_locker(request_id);
CREATE INDEX IF NOT EXISTS idx_evidence_type ON evidence_locker(event_type);
CREATE INDEX IF NOT EXISTS idx_evidence_created ON evidence_locker(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_escalation_status ON escalation_requests(status);
CREATE INDEX IF NOT EXISTS idx_escalation_ttl ON escalation_requests(ttl_expires_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_authority_active ON standing_authority_matrix(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_authority_blast ON standing_authority_matrix(blast_radius, escalation_tier);
CREATE INDEX IF NOT EXISTS idx_webauthn_authority ON webauthn_credentials(authority_id);
