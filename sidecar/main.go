// ═══════════════════════════════════════════════════════════════════
//  SENTINEL V5.5 — Sovereign Sidecar (Speed-of-Thought Arbitration)
//  ═══════════════════════════════════════════════════════════════════
//
//  A high-performance Go daemon that co-locates with Antigravity agents
//  and Gemini Gems on the same node. Replaces HTTP-based Veritas Proxy
//  calls with Unix Domain Socket IPC for sub-0.177ms arbitration.
//
//  Architecture:
//    Python Agent → UDS → Sidecar (in-memory O(1) lookup)
//                                  ↓ (background goroutine)
//                         Governance Hub (Dilithium seal + audit log)
//
//  Showstoppers addressed:
//    - Socket Cleanup: Stale socket removed at boot
//    - Dirty Read Gap: Local WAL guarantees no lost decisions
//    - Empty Graph at 2 AM: Disk snapshot persistence for cold boot
//    - SLA Monitoring: Per-request latency tracking with alerting
//
//  Required ENV:
//    SENTINEL_SIDECAR_SOCKET  — UDS path (default: /tmp/sentinel_veritas.sock)
//    SENTINEL_GRAPH_SNAPSHOT  — Disk snapshot path (default: /var/sentinel/graph.json)
//    SENTINEL_WAL_PATH        — Write-ahead log path (default: /var/sentinel/wal.jsonl)
//    SENTINEL_HUB_URL         — Governance Hub URL for background sync
//    SENTINEL_TENANT_ID       — Tenant this sidecar is scoped to
//
//  Build:
//    cd sidecar && go build -o sentinel-sidecar .
//
//  Run:
//    ./sentinel-sidecar
//
// ═══════════════════════════════════════════════════════════════════

package main

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// ─────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

var (
	SocketPath    = envOr("SENTINEL_SIDECAR_SOCKET", "/tmp/sentinel_veritas.sock")
	SocketGroup   = envOr("SENTINEL_SOCKET_GROUP", "sentinel-runners")
	SnapshotPath  = envOr("SENTINEL_GRAPH_SNAPSHOT", "/var/sentinel/graph.json")
	WALPath       = envOr("SENTINEL_WAL_PATH", "/var/sentinel/wal.jsonl")
	HubURL        = envOr("SENTINEL_HUB_URL", "")
	TenantID      = envOr("SENTINEL_TENANT_ID", "")
	HubSyncSec    = envOr("SENTINEL_HUB_SYNC_INTERVAL", "15")
	WALReplaySec  = envOr("SENTINEL_WAL_REPLAY_INTERVAL", "30")
	SLATarget     = 177 * time.Microsecond
)

// ─────────────────────────────────────────────────────
//  SKILL GRAPH — Thread-Safe In-Memory Cache
// ─────────────────────────────────────────────────────

// SkillEntry holds the admissibility state and rank for a single skill.
type SkillEntry struct {
	Admissible bool   `json:"admissible"`
	Rank       int    `json:"rank"`
	UpdatedAt  string `json:"updated_at"`
}

// SkillGraph is the core in-memory lookup table.
// Keys are "tenantId:skillName" for O(1) access.
type SkillGraph struct {
	mu     sync.RWMutex
	skills map[string]SkillEntry
}

func NewSkillGraph() *SkillGraph {
	return &SkillGraph{
		skills: make(map[string]SkillEntry),
	}
}

// Check performs the sub-microsecond admissibility lookup.
func (sg *SkillGraph) Check(tenantID, skill string) (SkillEntry, bool) {
	key := tenantID + ":" + skill
	sg.mu.RLock()
	entry, found := sg.skills[key]
	sg.mu.RUnlock()
	return entry, found
}

// Upsert adds or updates a skill entry (called by graph sync).
func (sg *SkillGraph) Upsert(tenantID, skill string, entry SkillEntry) {
	key := tenantID + ":" + skill
	sg.mu.Lock()
	sg.skills[key] = entry
	sg.mu.Unlock()
}

// Snapshot serializes the entire graph to disk for cold-boot recovery.
func (sg *SkillGraph) Snapshot(path string) error {
	sg.mu.RLock()
	defer sg.mu.RUnlock()

	data, err := json.MarshalIndent(sg.skills, "", "  ")
	if err != nil {
		return fmt.Errorf("snapshot marshal failed: %w", err)
	}

	// Atomic write: write to temp, then rename (prevents corruption on crash)
	tmpPath := path + ".tmp"
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return fmt.Errorf("snapshot dir creation failed: %w", err)
	}
	if err := os.WriteFile(tmpPath, data, 0640); err != nil {
		return fmt.Errorf("snapshot write failed: %w", err)
	}
	return os.Rename(tmpPath, path)
}

// LoadSnapshot restores the graph from a disk snapshot (cold-boot recovery).
// Returns the number of entries loaded, or 0 if no snapshot exists.
func (sg *SkillGraph) LoadSnapshot(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil // No snapshot — first boot
		}
		return 0, fmt.Errorf("snapshot read failed: %w", err)
	}

	var skills map[string]SkillEntry
	if err := json.Unmarshal(data, &skills); err != nil {
		return 0, fmt.Errorf("snapshot unmarshal failed: %w", err)
	}

	sg.mu.Lock()
	sg.skills = skills
	sg.mu.Unlock()

	return len(skills), nil
}

// Size returns the number of entries in the graph.
func (sg *SkillGraph) Size() int {
	sg.mu.RLock()
	defer sg.mu.RUnlock()
	return len(sg.skills)
}

// ─────────────────────────────────────────────────────
//  WAL — Write-Ahead Log (see wal_manager.go)
//
//  WALEntry, WALManager, Append, Replay, Compact, and
//  PendingCount are defined in wal_manager.go.
// ─────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────
//  TELEMETRY — SLA Tracking
// ─────────────────────────────────────────────────────

// Telemetry tracks per-request latency and SLA violations.
type Telemetry struct {
	totalRequests  atomic.Int64
	slaViolations  atomic.Int64
	totalLatencyNs atomic.Int64
}

func (t *Telemetry) Record(elapsed time.Duration) {
	t.totalRequests.Add(1)
	t.totalLatencyNs.Add(int64(elapsed))
	if elapsed > SLATarget {
		t.slaViolations.Add(1)
		log.Printf("[PERF_ALERT] SLA violated: %v (target: %v)", elapsed, SLATarget)
	}
}

func (t *Telemetry) Report() {
	total := t.totalRequests.Load()
	if total == 0 {
		return
	}
	avgNs := t.totalLatencyNs.Load() / total
	violations := t.slaViolations.Load()
	log.Printf("[TELEMETRY] Requests: %d | Avg: %v | SLA violations: %d (%.1f%%)",
		total,
		time.Duration(avgNs),
		violations,
		float64(violations)/float64(total)*100,
	)
}

// ─────────────────────────────────────────────────────
//  UUID v7 — Time-Ordered, Globally Unique Audit IDs
//
//  Replaces time.UnixNano() to prevent collision under
//  high concurrency. UUID v7 encodes a 48-bit Unix ms
//  timestamp + 74 bits of crypto-random uniqueness.
//  Format: "sc_0190a3d2-7b1a-7f3c-8e4d-1a2b3c4d5e6f"
// ─────────────────────────────────────────────────────

func generateUUIDv7() string {
	now := time.Now().UnixMilli()

	var uuid [16]byte

	// Bytes 0-5: 48-bit big-endian Unix millisecond timestamp
	binary.BigEndian.PutUint16(uuid[0:2], uint16(now>>32))
	binary.BigEndian.PutUint32(uuid[2:6], uint32(now))

	// Bytes 6-15: crypto-random
	if _, err := rand.Read(uuid[6:]); err != nil {
		// Fallback: this should never happen
		log.Printf("[UUID_WARN] crypto/rand failed: %v", err)
	}

	// Set version (7) and variant (RFC 4122)
	uuid[6] = (uuid[6] & 0x0F) | 0x70 // Version 7
	uuid[8] = (uuid[8] & 0x3F) | 0x80 // Variant 10

	return fmt.Sprintf("sc_%s", hex.EncodeToString(uuid[:]))
}

// ─────────────────────────────────────────────────────
//  HUB SYNC — Live Graph Propagation
//
//  Closes the "Lobbyist Trap": the sidecar is no longer
//  a static permission cache. Every N seconds it pulls
//  the current skill graph from the Governance Hub and
//  atomically replaces the in-memory map.
//
//  Protocol: GET {HUB_URL}/v1/graph?tenant_id={TENANT_ID}
//  Response: { "skills": { "tenantId:skill": { ... } } }
//
//  If the Hub is unreachable, the sidecar continues
//  serving from the last known-good snapshot. No panic.
// ─────────────────────────────────────────────────────

// HubGraphResponse is the expected response from the Hub.
type HubGraphResponse struct {
	Skills map[string]SkillEntry `json:"skills"`
}

// startHubSync launches a periodic goroutine that pulls
// the live skill graph from the Governance Hub.
func startHubSync(graph *SkillGraph) {
	if HubURL == "" {
		log.Println("[HUB_SYNC] Disabled — no SENTINEL_HUB_URL configured")
		return
	}
	if TenantID == "" {
		log.Println("[HUB_SYNC] Disabled — no SENTINEL_TENANT_ID configured")
		return
	}

	interval, err := strconv.Atoi(HubSyncSec)
	if err != nil || interval < 5 {
		interval = 15
	}

	client := &http.Client{Timeout: 5 * time.Second}
	endpoint := fmt.Sprintf("%s/v1/graph?tenant_id=%s", HubURL, TenantID)

	// Immediate sync on boot (non-blocking — don't delay socket readiness)
	go func() {
		syncGraphFromHub(client, endpoint, graph)
	}()

	go func() {
		ticker := time.NewTicker(time.Duration(interval) * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			syncGraphFromHub(client, endpoint, graph)
		}
	}()

	log.Printf("[HUB_SYNC] Enabled — pulling every %ds from %s", interval, endpoint)
}

func syncGraphFromHub(client *http.Client, endpoint string, graph *SkillGraph) {
	resp, err := client.Get(endpoint)
	if err != nil {
		log.Printf("[HUB_SYNC] Pull failed (will retry): %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		log.Printf("[HUB_SYNC] Hub returned %d: %s", resp.StatusCode, string(body))
		return
	}

	var hubResp HubGraphResponse
	if err := json.NewDecoder(resp.Body).Decode(&hubResp); err != nil {
		log.Printf("[HUB_SYNC] Decode failed: %v", err)
		return
	}

	if len(hubResp.Skills) == 0 {
		log.Println("[HUB_SYNC] Hub returned empty graph — keeping current state")
		return
	}

	// Atomic replacement of the in-memory graph
	graph.mu.Lock()
	graph.skills = hubResp.Skills
	graph.mu.Unlock()

	log.Printf("[HUB_SYNC] Graph updated: %d skills loaded", len(hubResp.Skills))

	// Persist immediately so cold-boot recovery uses fresh data
	if err := graph.Snapshot(SnapshotPath); err != nil {
		log.Printf("[HUB_SYNC] Post-sync snapshot failed: %v", err)
	}
}

// ─────────────────────────────────────────────────────
//  WAL REPLAY — Draining Unsynced Evidence
//
//  Closes the "Shadow Execution" gap. On boot and
//  periodically, the WAL is scanned for entries where
//  synced == false. Each is POSTed to the Hub. On
//  success, the WAL is compacted (rewritten without
//  the synced entries) to prevent unbounded growth.
//
//  If the Hub is down, entries stay in the WAL and
//  are retried on the next cycle. No data is lost.
// ─────────────────────────────────────────────────────

func startWALReplay(wal *WALManager) {
	if HubURL == "" {
		log.Println("[WAL_REPLAY] Disabled — no SENTINEL_HUB_URL configured")
		return
	}

	interval, err := strconv.Atoi(WALReplaySec)
	if err != nil || interval < 1 {
		interval = 30
	}

	// Immediate replay on boot
	go func() {
		wal.Replay(HubURL)
	}()

	go func() {
		ticker := time.NewTicker(time.Duration(interval) * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			wal.Replay(HubURL)
		}
	}()

	log.Printf("[WAL_REPLAY] Enabled — replaying every %ds (batch cap: %d)", interval, MaxReplayBatch)
}

// ─────────────────────────────────────────────────────
//  SOCKET SECURITY — Group-Restricted Access
//
//  The UDS must be readable/writable ONLY by members of
//  the sentinel-runners group. 0660 + chown :GID prevents
//  rogue processes from impersonating agents.
// ─────────────────────────────────────────────────────

func restrictSocketToGroup(socketPath, groupName string) {
	grp, err := user.LookupGroup(groupName)
	if err != nil {
		log.Printf("[SOCKET_SEC] Group '%s' not found: %v — socket left with owner-only perms", groupName, err)
		// Fallback: owner-only (0600) is safer than world-readable
		os.Chmod(socketPath, 0600)
		return
	}

	gid, err := strconv.Atoi(grp.Gid)
	if err != nil {
		log.Printf("[SOCKET_SEC] Invalid GID for '%s': %v", groupName, err)
		os.Chmod(socketPath, 0600)
		return
	}

	// chown :sentinel-runners on the socket
	if err := os.Chown(socketPath, -1, gid); err != nil {
		log.Printf("[SOCKET_SEC] Chown failed: %v — requires root or matching UID", err)
		os.Chmod(socketPath, 0600)
		return
	}

	// 0660: owner + group can read/write, others blocked
	if err := os.Chmod(socketPath, 0660); err != nil {
		log.Printf("[SOCKET_SEC] Chmod failed: %v", err)
		return
	}

	log.Printf("[SOCKET_SEC] Socket restricted to group '%s' (GID %d) with mode 0660", groupName, gid)
}

// ─────────────────────────────────────────────────────
//  IPC PROTOCOL — Request/Response over UDS
// ─────────────────────────────────────────────────────

// ArbitrationRequest is the inbound payload from Python/Antigravity agents.
type ArbitrationRequest struct {
	TenantID string `json:"tenant_id"`
	Skill    string `json:"skill"`
	Resource string `json:"resource"`
}

// ArbitrationResponse is the immediate verdict returned to the caller.
type ArbitrationResponse struct {
	Decision  string `json:"decision"`
	Reason    string `json:"reason,omitempty"`
	AuditID   string `json:"audit_id"`
	LatencyUs int64  `json:"latency_us"`
}

// ─────────────────────────────────────────────────────
//  CONNECTION HANDLER — The Sub-0.177ms Hot Path
// ─────────────────────────────────────────────────────

func handleConnection(conn net.Conn, graph *SkillGraph, wal *WALManager, tel *Telemetry) {
	defer conn.Close()
	start := time.Now()

	// 1. PARSE: Decode the request from the Unix socket
	decoder := json.NewDecoder(conn)
	var req ArbitrationRequest
	if err := decoder.Decode(&req); err != nil {
		log.Printf("[PARSE_ERROR] %v", err)
		return
	}

	// 2. ARBITRATE: O(1) in-memory lookup (sub-microsecond)
	decision := "DENIED"
	reason := "SKILL_NOT_IN_GRAPH"
	entry, found := graph.Check(req.TenantID, req.Skill)
	if found && entry.Admissible {
		decision = "ADMISSIBLE"
		reason = ""
	} else if found && !entry.Admissible {
		reason = "SKILL_SUSPENDED"
	}

	auditID := generateUUIDv7()
	elapsed := time.Since(start)

	// 3. WAL: Persist the decision BEFORE responding (Dirty Read protection)
	//    This is the compliance guarantee: the decision is on disk before
	//    the caller proceeds. If the Hub sync fails, the WAL can be replayed.
	walEntry := WALEntry{
		Timestamp:   time.Now().UTC().Format(time.RFC3339Nano),
		TenantID:    req.TenantID,
		Skill:       req.Skill,
		Resource:    req.Resource,
		Decision:    decision,
		AuditID:     auditID,
	}

	if err := wal.Append(walEntry); err != nil {
		// WAL write failure is CRITICAL — we cannot guarantee non-repudiation.
		// Deny the request rather than allow an unlogged execution.
		log.Printf("[WAL_CRITICAL] Append failed: %v — denying request", err)
		resp := ArbitrationResponse{
			Decision:  "DENIED",
			Reason:    "AUDIT_INTEGRITY_FAILURE",
			AuditID:   auditID,
			LatencyUs: elapsed.Microseconds(),
		}
		json.NewEncoder(conn).Encode(resp)
		tel.Record(time.Since(start))
		return
	}

	// 4. RESPOND: Return the verdict to the caller
	resp := ArbitrationResponse{
		Decision:  decision,
		Reason:    reason,
		AuditID:   auditID,
		LatencyUs: elapsed.Microseconds(),
	}
	json.NewEncoder(conn).Encode(resp)

	// 5. TELEMETRY: Record latency
	tel.Record(time.Since(start))

	// 6. BACKGROUND SYNC: NOT done per-request.
	//    The WAL is the durability guarantee. The background WAL Replay
	//    batch drainer (startWALReplay) handles all outbound Hub sync.
	//    Spawning a goroutine per request would create an unbounded leak:
	//      5,000 VUs × ~200 req/s = 1,000,000 goroutines/s → OOM death.
	//    The batch drainer uses a bounded worker pool (WorkerPoolSize=100)
	//    with rate-limit backoff and circuit-breaker-style stop signaling.
}

// ─────────────────────────────────────────────────────
//  BACKGROUND: Periodic Graph Snapshot + Telemetry
// ─────────────────────────────────────────────────────

func startPeriodicTasks(graph *SkillGraph, tel *Telemetry) {
	// Snapshot the graph every 60 seconds for cold-boot recovery
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if err := graph.Snapshot(SnapshotPath); err != nil {
				log.Printf("[SNAPSHOT_ERROR] %v", err)
			} else {
				log.Printf("[SNAPSHOT] Graph persisted (%d entries)", graph.Size())
			}
		}
	}()

	// Report telemetry every 30 seconds
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			tel.Report()
		}
	}()
}

// ─────────────────────────────────────────────────────
//  MAIN — Sidecar Lifecycle
// ─────────────────────────────────────────────────────

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("═══════════════════════════════════════════════")
	log.Println("  SENTINEL V5.5 — Sovereign Sidecar (Hardened)")
	log.Printf("  Socket:   %s (group: %s)", SocketPath, SocketGroup)
	log.Printf("  Snapshot: %s", SnapshotPath)
	log.Printf("  WAL:      %s", WALPath)
	log.Printf("  Hub:      %s", HubURL)
	log.Printf("  SLA:      %v", SLATarget)
	log.Println("═══════════════════════════════════════════════")

	// 1. CLEANUP: Remove stale socket from previous crash
	if _, err := os.Stat(SocketPath); err == nil {
		log.Println("[BOOT] Removing stale socket from previous run")
		os.Remove(SocketPath)
	}

	// 2. INIT: Create the skill graph
	graph := NewSkillGraph()

	// 3. RECOVERY: Load the last known-good graph from disk snapshot.
	//    This is the "2 AM Fix" — if the Hub is unreachable at boot,
	//    the Sidecar starts with the last persisted state rather than
	//    denying all requests.
	count, err := graph.LoadSnapshot(SnapshotPath)
	if err != nil {
		log.Printf("[BOOT_WARN] Snapshot load failed: %v — starting with empty graph", err)
	} else if count > 0 {
		log.Printf("[BOOT] Loaded %d skill entries from snapshot", count)
	} else {
		log.Println("[BOOT] No snapshot found — graph starts empty.")
		log.Println("[BOOT] Hub Sync will populate the graph within seconds.")
	}

	// 4. DURABLE MOUNT: Verify WAL storage is persistent (not ephemeral).
	//    This is the "Kill -9 Insurance" — if we're on container tmpfs,
	//    the canary test will fail and the sidecar refuses to start.
	if err := ValidateDurableMount(WALPath); err != nil {
		log.Fatalf("[FATAL] WAL storage is NOT durable: %v\n"+
			"  ► Kubernetes: Mount a PVC to %s\n"+
			"  ► Cloud Run: Attach Cloud Filestore or GCS FUSE\n"+
			"  ► Bare Metal: Use local NVMe SSD",
			err, filepath.Dir(WALPath))
	}

	// 4a. WAL: Open the write-ahead log
	wal, err := NewWALManager(WALPath)
	if err != nil {
		log.Fatalf("[FATAL] WAL initialization failed: %v", err)
	}
	defer wal.Close()

	// 4b. INTEGRITY: Post-crash structural health check
	report := wal.IntegrityCheck()
	log.Printf("[WAL_HEALTH] Lines: %d | Valid: %d | Corrupt: %d | Pending: %d | Synced: %d | Gaps: %d",
		report.TotalLines, report.ValidEntries, report.CorruptLines,
		report.PendingCount, report.SyncedCount, report.IndexGaps)
	if report.CorruptLines > 0 {
		log.Printf("[WAL_WARN] %d corrupted WAL lines detected — these will be skipped during replay", report.CorruptLines)
	}
	if report.IndexGaps > 0 {
		log.Printf("[WAL_WARN] %d index gaps detected — evidence may have been lost in a previous crash", report.IndexGaps)
	}
	if report.PendingCount > 0 {
		log.Printf("[BOOT] WAL has %d unsynced entries — background replay will drain them", report.PendingCount)
	}

	// 5. TELEMETRY
	tel := &Telemetry{}

	// 6. BACKGROUND TASKS: Periodic snapshot + telemetry reporting
	startPeriodicTasks(graph, tel)

	// 6a. HUB SYNC: Live graph propagation (closes "Lobbyist Trap")
	startHubSync(graph)

	// 6b. WAL REPLAY: Drain unsynced evidence (closes "Shadow Execution" gap)
	startWALReplay(wal)

	// 7. LISTEN: Open the Unix Domain Socket
	listener, err := net.Listen("unix", SocketPath)
	if err != nil {
		log.Fatalf("[FATAL] Socket listen failed: %v", err)
	}
	defer listener.Close()

	// 7a. SOCKET SECURITY: Restrict to sentinel-runners group (0660)
	//     Prevents rogue processes from impersonating agents.
	restrictSocketToGroup(SocketPath, SocketGroup)

	log.Printf("[READY] Sidecar accepting connections on %s", SocketPath)

	// 8. GRACEFUL SHUTDOWN: Handle SIGTERM/SIGINT for clean socket removal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		log.Printf("[SHUTDOWN] Received %v — persisting state", sig)

		// Final snapshot before exit
		if err := graph.Snapshot(SnapshotPath); err != nil {
			log.Printf("[SHUTDOWN_ERROR] Final snapshot failed: %v", err)
		}

		wal.Close()
		listener.Close()
		os.Remove(SocketPath)

		// Report final telemetry
		tel.Report()

		log.Println("[SHUTDOWN] Clean exit")
		os.Exit(0)
	}()

	// 9. ACCEPT LOOP
	for {
		conn, err := listener.Accept()
		if err != nil {
			// Check if the error is due to a closed listener (graceful shutdown)
			if opErr, ok := err.(*net.OpError); ok && opErr.Err.Error() == "use of closed network connection" {
				break
			}
			log.Printf("[ACCEPT_ERROR] %v", err)
			continue
		}
		go handleConnection(conn, graph, wal, tel)
	}
}
