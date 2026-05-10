-- 1. The highly optimized Data Moat Schema
CREATE TABLE veritas_evidence_ledger (
    action_id      BYTEA PRIMARY KEY,  -- 32 bytes
    agent_entity   BYTEA NOT NULL,     -- 32 bytes
    owner_entity   BYTEA NOT NULL,     -- 32 bytes
    policy_scope   TEXT NOT NULL,
    epoch          BIGINT NOT NULL,
    signature      BYTEA NOT NULL      -- 64 bytes (Ed25519)
);

-- Index for temporal auditing (Auditors will frequently query by time ranges)
CREATE INDEX idx_evidence_epoch ON veritas_evidence_ledger(epoch);
