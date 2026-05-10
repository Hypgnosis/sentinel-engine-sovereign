package audit

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
)

// ─────────────────────────────────────────────────────
//  HANDLER — /v1/audit/verify/{action_id}
//
//  This handler is physically decoupled from the 145µs
//  execution hot-path. It runs on its own HTTP listener
//  goroutine and reads from the SEP WAL file (or, in
//  production, from the PostgreSQL "Data Moat" replica).
//
//  It NEVER touches the channel buffer, the skill graph,
//  or the arbitration socket.
// ─────────────────────────────────────────────────────

// AuditHandler serves the verification API.
type AuditHandler struct {
	verifier *Verifier
	sepPath  string
	mu       sync.Mutex // Serializes file reads (cold-path, no contention)
}

// NewAuditHandler creates the handler with the Sentinel public key and SEP WAL path.
func NewAuditHandler(verifier *Verifier, sepPath string) *AuditHandler {
	return &AuditHandler{
		verifier: verifier,
		sepPath:  sepPath,
	}
}

// ServeHTTP handles GET /v1/audit/verify/{action_id}
func (ah *AuditHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"code":405,"message":"Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// Extract action_id from path: /v1/audit/verify/{action_id}
	path := strings.TrimPrefix(r.URL.Path, "/v1/audit/verify/")
	if path == "" || path == r.URL.Path {
		http.Error(w, `{"code":400,"message":"Missing action_id parameter"}`, http.StatusBadRequest)
		return
	}
	actionID := path

	// Search the SEP WAL for the matching receipt
	receipt, err := ah.findReceipt(actionID)
	if err != nil {
		log.Printf("[AUDIT] Receipt lookup failed for %s: %v", actionID, err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"code":    404,
			"message": "Receipt not found",
			"details": err.Error(),
		})
		return
	}

	// Run the cryptographic verification
	result, verifyErr := ah.verifier.VerifyReceipt(*receipt)

	w.Header().Set("Content-Type", "application/json")

	if verifyErr != nil {
		// Signature verification failed — evidence has been tampered with
		log.Printf("[AUDIT_ALERT] TAMPERED receipt detected: %s — %v", actionID, verifyErr)
		w.WriteHeader(http.StatusConflict) // 409 Conflict
		json.NewEncoder(w).Encode(result)
		return
	}

	// Cryptographic proof is valid
	log.Printf("[AUDIT] VERIFIED: %s (policy: %s)", actionID, result.PolicyMatched)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(result)
}

// findReceipt scans the SEP WAL file for a receipt matching the given action_id.
// In production, this is replaced by a Postgres query against the Data Moat replica.
func (ah *AuditHandler) findReceipt(actionID string) (*SEPReceipt, error) {
	ah.mu.Lock()
	defer ah.mu.Unlock()

	f, err := os.Open(ah.sepPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	// Increase buffer for large WAL lines
	scanner.Buffer(make([]byte, 256*1024), 256*1024)

	for scanner.Scan() {
		var receipt SEPReceipt
		if err := json.Unmarshal(scanner.Bytes(), &receipt); err != nil {
			continue // Skip corrupt lines
		}

		// Compare: the action_id stored in the receipt is a [32]byte,
		// the query parameter is a hex string. Match by hex encoding.
		receiptHex := hex.EncodeToString(receipt.ActionID[:])

		// Trim trailing zeros for prefix matching (action_id may be shorter than 32 bytes)
		receiptTrimmed := strings.TrimRight(receiptHex, "0")
		actionTrimmed := strings.TrimRight(actionID, "0")

		if receiptTrimmed == actionTrimmed || receiptHex == actionID {
			return &receipt, nil
		}
	}

	return nil, os.ErrNotExist
}

// StartAuditServer launches the audit verification API on a dedicated HTTP port.
// This runs in its own goroutine, physically decoupled from the UDS hot-path.
func StartAuditServer(port string, verifier *Verifier, sepPath string) {
	handler := NewAuditHandler(verifier, sepPath)

	mux := http.NewServeMux()
	mux.Handle("/v1/audit/verify/", handler)

	// Health check for the audit subsystem
	mux.HandleFunc("/v1/audit/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "healthy",
			"service": "sentinel-audit-verifier",
		})
	})

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  5000000000,  // 5s
		WriteTimeout: 10000000000, // 10s
	}

	log.Printf("[AUDIT_API] Verification endpoint live on :%s/v1/audit/verify/{action_id}", port)

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("[AUDIT_API] Server failed: %v", err)
	}
}
