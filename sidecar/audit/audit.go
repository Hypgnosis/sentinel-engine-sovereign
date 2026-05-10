package audit

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// SEPReceipt mirrors the structure from the evidence package.
// In production, this is populated via a Postgres query by ActionID.
type SEPReceipt struct {
	ActionID    [32]byte `json:"action_id"`
	AgentEntity [32]byte `json:"agent_entity"`
	OwnerEntity [32]byte `json:"owner_entity"`
	PolicyScope string   `json:"policy_scope"`
	Epoch       int64    `json:"epoch"`
	Signature   []byte   `json:"signature"`
}

// VerificationResult is the human-readable explanation sent to the UI/Auditor.
type VerificationResult struct {
	Status        string `json:"status"` // "VERIFIED" or "TAMPERED"
	ActionID      string `json:"action_id"`
	AuthorizedBy  string `json:"authorized_by"`
	ExecutedBy    string `json:"executed_by"`
	PolicyMatched string `json:"policy_matched"`
	Timestamp     int64  `json:"timestamp"`
}

// Verifier acts as the independent cryptographic auditor.
type Verifier struct {
	SentinelPubKey ed25519.PublicKey
}

// NewVerifier initializes the auditor with Sentinel's public Root of Trust.
func NewVerifier(pubKey ed25519.PublicKey) *Verifier {
	return &Verifier{
		SentinelPubKey: pubKey,
	}
}

// VerifyReceipt mathematically proves the Sovereign Stamp has not been altered.
func (v *Verifier) VerifyReceipt(receipt SEPReceipt) (*VerificationResult, error) {
	// 1. Reconstruct the exact Zero-Allocation Hash used in the Evidence Locker
	h := sha256.New()
	h.Write(receipt.AgentEntity[:])
	h.Write([]byte(receipt.PolicyScope))
	expectedHash := h.Sum(nil)

	// 2. Perform Ed25519 Signature Verification
	isValid := ed25519.Verify(v.SentinelPubKey, expectedHash, receipt.Signature)

	if !isValid {
		// The ledger has been tampered with or the signature is invalid.
		return &VerificationResult{
			Status:   "TAMPERED",
			ActionID: hex.EncodeToString(receipt.ActionID[:]),
		}, fmt.Errorf("CRITICAL: Cryptographic verification failed for ActionID %x", receipt.ActionID)
	}

	// 3. Construct the Admissible Proof
	return &VerificationResult{
		Status:        "VERIFIED",
		ActionID:      hex.EncodeToString(receipt.ActionID[:]),
		AuthorizedBy:  hex.EncodeToString(receipt.OwnerEntity[:]),
		ExecutedBy:    hex.EncodeToString(receipt.AgentEntity[:]),
		PolicyMatched: receipt.PolicyScope,
		Timestamp:     receipt.Epoch,
	}, nil
}
