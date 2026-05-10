# Production Data Moat Swap (PostgreSQL)

## Architecture
In production, the `evidence.go` hot-path continues to write to the NVMe `wal.jsonl` to guarantee the 145µs execution SLA.
A secondary background process (or FluentBit/Vector agent) drains the WAL into the PostgreSQL "Data Moat" replica.
The Audit Verification API (`handler.go`) must then be switched to query this Postgres replica instead of parsing the raw WAL file.

## Schema Migration
Deploy the following highly optimized schema to the PostgreSQL instance:

```sql
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
```

## Go Codebase Update (handler.go)
Swap the `findReceipt` function in `handler.go` to the following `pgx` implementation to ensure maximum read performance:

```go
// handler.go - Production findReceipt Implementation
import (
	"context"
	"encoding/hex"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sentinel-engine/sidecar/audit"
)

func findReceipt(ctx context.Context, db *pgxpool.Pool, actionIDHex string) (*audit.KYEReceipt, error) {
	actionIDBytes, err := hex.DecodeString(actionIDHex)
	if err != nil || len(actionIDBytes) != 32 {
		return nil, fmt.Errorf("invalid action ID format")
	}

	var receipt audit.KYEReceipt
	copy(receipt.ActionID[:], actionIDBytes)

	// High-performance binary extraction
	query := `
		SELECT agent_entity, owner_entity, policy_scope, epoch, signature 
		FROM veritas_evidence_ledger 
		WHERE action_id = $1
	`
	
	var agentBytes, ownerBytes []byte
	err = db.QueryRow(ctx, query, actionIDBytes).Scan(
		&agentBytes, 
		&ownerBytes, 
		&receipt.PolicyScope, 
		&receipt.Epoch, 
		&receipt.Signature,
	)

	if err != nil {
		return nil, err // Will return pgx.ErrNoRows if tampering resulted in deletion
	}

	copy(receipt.AgentEntity[:], agentBytes)
	copy(receipt.OwnerEntity[:], ownerBytes)

	return &receipt, nil
}
```

*Status: Go codebase frozen. Ready for CI/CD pipeline and sovereign cell deployments.*
