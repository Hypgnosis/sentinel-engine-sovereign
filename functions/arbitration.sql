-- Formal Arbitration Interface Tables (Sentinel V5.5)

CREATE TABLE IF NOT EXISTS arbitration_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requesting_agent TEXT NOT NULL,
    action TEXT NOT NULL,
    context JSONB NOT NULL,
    target_domain TEXT,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS arbitration_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES arbitration_requests(id) ON DELETE CASCADE,
    authority_unit TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('permit', 'escalate', 'deny', 'reduce')),
    reasoning TEXT,
    legibility_record JSONB NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES arbitration_requests(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('attenuate', 'suspend', 'revoke')),
    attenuated_scope JSONB,
    supervisor_timeout BOOLEAN DEFAULT FALSE,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for High-Capacity Querying
CREATE INDEX IF NOT EXISTS idx_arb_requests_context ON arbitration_requests USING GIN (context);
CREATE INDEX IF NOT EXISTS idx_arb_responses_legibility ON arbitration_responses USING GIN (legibility_record);
CREATE INDEX IF NOT EXISTS idx_gov_findings_trigger ON governance_findings (trigger);
CREATE INDEX IF NOT EXISTS idx_gov_findings_action ON governance_findings (action);
