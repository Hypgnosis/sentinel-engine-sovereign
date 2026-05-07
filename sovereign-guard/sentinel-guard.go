package main

import (
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	_ "github.com/lib/pq"
)

type SkillGraph struct {
	skills map[string]bool
}

func loadSkillGraph(path string) (*SkillGraph, error) {
	data, err := ioutil.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("[SKILL_GRAPH] Warning: %s does not exist, creating empty graph", path)
			return &SkillGraph{skills: make(map[string]bool)}, nil
		}
		return nil, err
	}
	var skills map[string]bool
	if err := json.Unmarshal(data, &skills); err != nil {
		return nil, err
	}
	return &SkillGraph{skills: skills}, nil
}

type SentinelServer struct {
	graph *SkillGraph
	wal   *WALManager
}

type ArbitrationRequest struct {
	Skill    string `json:"skill"`
	Resource string `json:"resource"`
}

type ArbitrationResponse struct {
	Decision  string `json:"decision"`
	AuditID   string `json:"audit_id"`
	LatencyUs int64  `json:"latency_us"`
}

func (s *SentinelServer) handleArbitrate(w http.ResponseWriter, r *http.Request) {
	var req ArbitrationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	start := time.Now()

	decision := "DENIED"
	if s.graph.skills[req.Skill] {
		decision = "ADMISSIBLE"
	}

	nowStr := strconv.FormatInt(start.UnixNano(), 10)
	auditID := "sc_" + nowStr
	walEntry := WALEntry{
		Timestamp: nowStr,
		Skill:     req.Skill,
		Resource:  req.Resource,
		Decision:  decision,
		AuditID:   auditID,
	}

	if err := s.wal.Append(walEntry); err != nil {
		log.Printf("[WAL_CRITICAL] Append failed: %v", err)
		http.Error(w, "AUDIT_INTEGRITY_FAILURE", http.StatusInternalServerError)
		return
	}

	elapsedUs := time.Since(start).Microseconds()

	resp := ArbitrationResponse{
		Decision:  decision,
		AuditID:   auditID,
		LatencyUs: elapsedUs,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	sovereignScope := os.Getenv("SENTINEL_SOVEREIGN_SCOPE")
	if sovereignScope == "" {
		sovereignScope = "UNSET_SCOPE"
	}
	authorizedIdentity := os.Getenv("SENTINEL_AUTHORIZED_IDENTITY")
	if authorizedIdentity == "" {
		authorizedIdentity = "UNSET_IDENTITY"
	}

	log.Println("═══════════════════════════════════════════════")
	log.Println("  SENTINEL V5.5 — TMU Sovereign Stamp (mTLS)")
	log.Printf("  Scope:    %s", sovereignScope)
	log.Printf("  Identity: %s", authorizedIdentity)
	log.Println("═══════════════════════════════════════════════")

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres:postgres@localhost:5432/sentinel?sslmode=disable"
	}
	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		log.Fatalf("DB open failed: %v", err)
	}
	defer db.Close()

	walPath := os.Getenv("SENTINEL_WAL_PATH")
	if walPath == "" {
		walPath = "/var/sentinel/wal.jsonl"
	}
	wal, err := NewWALManager(walPath)
	if err != nil {
		log.Fatalf("WAL init failed: %v", err)
	}
	defer wal.Close()

	// Replay loop
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			wal.Replay(db)
		}
	}()

	graphPath := os.Getenv("SENTINEL_SKILLS_PATH")
	if graphPath == "" {
		graphPath = "/var/sentinel/skills.json"
	}
	graph, err := loadSkillGraph(graphPath)
	if err != nil {
		log.Fatalf("Graph load failed: %v", err)
	}

	server := &SentinelServer{graph: graph, wal: wal}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/arbitrate", server.handleArbitrate)

	// mTLS Configuration
	caCert, err := ioutil.ReadFile("/var/sentinel/certs/ca.crt")
	if err != nil {
		log.Printf("Warning: Failed to read CA cert: %v. Starting without mTLS for development if required, but mTLS is required in PROD.", err)
	}
	caCertPool := x509.NewCertPool()
	if caCert != nil {
		caCertPool.AppendCertsFromPEM(caCert)
	}

	tlsConfig := &tls.Config{
		ClientCAs:  caCertPool,
		ClientAuth: tls.RequireAndVerifyClientCert,
	}

	srv := &http.Server{
		Addr:      ":9443",
		Handler:   mux,
		TLSConfig: tlsConfig,
	}

	log.Printf("[READY] Sovereign Stamp listening on %s", srv.Addr)
	if err := srv.ListenAndServeTLS("/var/sentinel/certs/server.crt", "/var/sentinel/certs/server.key"); err != nil {
		log.Fatalf("ListenAndServeTLS: %v", err)
	}
}
