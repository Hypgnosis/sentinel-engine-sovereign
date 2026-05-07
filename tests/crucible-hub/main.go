// ═══════════════════════════════════════════════════════════════
//  SENTINEL V5.5 — Crucible Hub API
//
//  A lightweight HTTP server that simulates the Governance Hub's
//  evidence ingestion endpoint. Accepts WAL entries via POST and
//  writes them to the veritas_audit_log table in Postgres via
//  PgBouncer.
//
//  This is the "other end" of the background sync path that was
//  missing from the LTC-1 test. It must survive 5,000 VUs worth
//  of WAL replay traffic without tipping the DB over 80% CPU.
//
//  Architecture:
//    Sidecar WAL Replay → POST /v1/evidence/ingest → Hub API
//      → PgBouncer (transaction pool) → Postgres INSERT
//
//  ENV:
//    CRUCIBLE_HUB_PORT     — Listen port (default: 8081)
//    CRUCIBLE_DB_DSN       — Postgres DSN via PgBouncer
//    CRUCIBLE_MAX_WORKERS  — Concurrent DB writers (default: 50)
//
//  Build:
//    cd tests/crucible-hub && go build -o hub-api .
//
//  Run:
//    CRUCIBLE_DB_DSN="postgres://sentinel:crucible_test_2026@localhost:6432/sentinel_hub?sslmode=disable" \
//      ./hub-api
// ═══════════════════════════════════════════════════════════════

package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	_ "github.com/lib/pq"
)

// ─── Configuration ──────────────────────────────────

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

var (
	listenPort = envOr("CRUCIBLE_HUB_PORT", "8081")
	dbDSN      = envOr("CRUCIBLE_DB_DSN", "postgres://sentinel:crucible_test_2026@localhost:6432/sentinel_hub?sslmode=disable")
	maxWorkers = 50
)

// ─── WAL Entry (matches sidecar WALEntry) ───────────

type WALEntry struct {
	Index       int    `json:"i"`
	Timestamp   string `json:"ts"`
	TenantID    string `json:"tenant_id"`
	Skill       string `json:"skill"`
	Resource    string `json:"resource"`
	Decision    string `json:"decision"`
	AuditID     string `json:"audit_id"`
	SyncedToHub bool   `json:"synced"`
}

// ─── Telemetry ──────────────────────────────────────

type HubTelemetry struct {
	ingested   atomic.Int64
	errors     atomic.Int64
	duplicates atomic.Int64
	latencySum atomic.Int64 // microseconds cumulative
}

func (t *HubTelemetry) Report() {
	total := t.ingested.Load()
	errs := t.errors.Load()
	dups := t.duplicates.Load()
	avgUs := int64(0)
	if total > 0 {
		avgUs = t.latencySum.Load() / total
	}
	log.Printf("[HUB_TELEMETRY] Ingested: %d | Errors: %d | Duplicates: %d | Avg Insert: %dµs",
		total, errs, dups, avgUs)
}

// ─── Database ───────────────────────────────────────

var (
	db  *sql.DB
	tel HubTelemetry

	insertStmt *sql.Stmt
)

const insertSQL = `
INSERT INTO veritas_audit_log (
    tenant_id, skill_name, resource_path, arbiter_decision,
    sidecar_audit_id, wal_timestamp, wal_sequence
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (sidecar_audit_id) DO NOTHING
`

func initDB() {
	var err error
	db, err = sql.Open("postgres", dbDSN)
	if err != nil {
		log.Fatalf("[FATAL] DB open failed: %v", err)
	}

	// Match PgBouncer pool sizing:
	// - MaxOpen should be <= PgBouncer's default_pool_size (50)
	// - MaxIdle should be ~50% of MaxOpen
	db.SetMaxOpenConns(maxWorkers)
	db.SetMaxIdleConns(maxWorkers / 2)
	db.SetConnMaxLifetime(5 * time.Minute)

	// Verify connectivity
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		log.Fatalf("[FATAL] DB ping failed: %v", err)
	}
	log.Printf("[DB] Connected to PgBouncer (MaxOpen: %d, MaxIdle: %d)", maxWorkers, maxWorkers/2)

	// Prepare the insert statement for maximum throughput
	insertStmt, err = db.Prepare(insertSQL)
	if err != nil {
		log.Fatalf("[FATAL] Prepare failed: %v", err)
	}
}

// ─── Evidence Ingest Handler ────────────────────────

func handleIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var entry WALEntry
	if err := json.NewDecoder(r.Body).Decode(&entry); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON: %v", err), http.StatusBadRequest)
		tel.errors.Add(1)
		return
	}

	start := time.Now()

	// Parse the WAL timestamp
	var walTS *time.Time
	if entry.Timestamp != "" {
		if t, err := time.Parse(time.RFC3339Nano, entry.Timestamp); err == nil {
			walTS = &t
		}
	}

	// Insert with ON CONFLICT DO NOTHING for idempotency
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	result, err := insertStmt.ExecContext(ctx,
		entry.TenantID,
		entry.Skill,
		entry.Resource,
		entry.Decision,
		entry.AuditID,
		walTS,
		entry.Index,
	)

	elapsed := time.Since(start)

	if err != nil {
		log.Printf("[INGEST_ERROR] %s: %v", entry.AuditID, err)
		http.Error(w, fmt.Sprintf("DB error: %v", err), http.StatusInternalServerError)
		tel.errors.Add(1)
		return
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		// ON CONFLICT DO NOTHING — duplicate
		tel.duplicates.Add(1)
	}

	tel.ingested.Add(1)
	tel.latencySum.Add(elapsed.Microseconds())

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "ingested",
		"audit_id":  entry.AuditID,
		"insert_us": elapsed.Microseconds(),
	})
}

// ─── Health Check ───────────────────────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		http.Error(w, "DB unhealthy", http.StatusServiceUnavailable)
		return
	}

	// Count total ingested rows
	var count int64
	db.QueryRowContext(ctx, "SELECT COUNT(*) FROM veritas_audit_log").Scan(&count)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "healthy",
		"db_rows":    count,
		"ingested":   tel.ingested.Load(),
		"errors":     tel.errors.Load(),
		"duplicates": tel.duplicates.Load(),
	})
}

// ─── Main ───────────────────────────────────────────

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("═══════════════════════════════════════════════")
	log.Println("  SENTINEL V5.5 — Crucible Hub API")
	log.Printf("  Port:       %s", listenPort)
	log.Printf("  DB DSN:     %s", dbDSN[:min(len(dbDSN), 50)]+"...")
	log.Printf("  MaxWorkers: %d", maxWorkers)
	log.Println("═══════════════════════════════════════════════")

	if v, err := strconv.Atoi(envOr("CRUCIBLE_MAX_WORKERS", "50")); err == nil {
		maxWorkers = v
	}

	initDB()
	defer db.Close()
	defer insertStmt.Close()

	// Periodic telemetry
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			tel.Report()
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/evidence/ingest", handleIngest)
	mux.HandleFunc("/health", handleHealth)

	server := &http.Server{
		Addr:         ":" + listenPort,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 5 * time.Second,
		IdleTimeout:  30 * time.Second,
	}

	log.Printf("[READY] Hub API listening on :%s", listenPort)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("[FATAL] Server failed: %v", err)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
