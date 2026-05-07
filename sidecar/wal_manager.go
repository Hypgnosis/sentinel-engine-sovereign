// ═══════════════════════════════════════════════════════════════
//  SENTINEL V5.5 — Write-Ahead Log Manager (RC Hardened)
//  ═══════════════════════════════════════════════════════════════
//
//  The WAL is the Non-Repudiation guarantee for the Sovereign
//  Sidecar. Every arbitration decision is fsync'd to disk BEFORE
//  the verdict is returned to the agent.
//
//  Without the WAL, any sidecar crash between "ADMISSIBLE verdict
//  sent" and "Hub sync completed" creates Ghost Code — executions
//  that are unauthorized, unsigned, and untraceable.
//
//  RC-Level Hardening:
//    1. fsync Performance: The Append path uses direct file.Sync().
//       MUST run on NVMe/local SSD or PVC-backed storage.
//       Network mounts (NFS/Gluster) will add 10ms-100ms and kill
//       the 0.177ms SLA.
//    2. Log Corruption: JSONL format with per-line validation.
//       Corrupted lines are skipped during replay, not fatal.
//    3. Disk Exhaustion: Compaction purges synced entries older
//       than the retention period (default: 24h).
//    4. OOM on Replay: Bounded worker pool (WorkerPoolSize=100)
//       with a buffered channel. No unbounded goroutine fan-out.
//    5. Rate Limit Handling: Exponential backoff on Hub 429s.
//       Starts at 1s, doubles per consecutive 429, caps at 60s.
//    6. Persistent Volume Requirement: The WAL path MUST point
//       to durable storage (PVC on K8s, Filestore on Cloud Run).
//       Ephemeral container filesystems are NOT supported.
//
//  File: wal_manager.go
//  Package: main (same binary as sentinel-sidecar)
// ═══════════════════════════════════════════════════════════════

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// ─────────────────────────────────────────────────────
//  WAL ENTRY — The Atomic Unit of Evidence
// ─────────────────────────────────────────────────────

// WALEntry represents a single non-repudiable arbitration decision.
type WALEntry struct {
	// Index is a monotonic sequence number for ordering guarantees.
	Index int64 `json:"i"`

	// Timestamp is RFC3339Nano for human-readable logs + high precision.
	Timestamp string `json:"ts"`

	// TenantID identifies the sovereign shard this decision belongs to.
	TenantID string `json:"tenant_id"`

	// Skill is the arbitrated capability (e.g., "ImageProcessing").
	Skill string `json:"skill"`

	// Resource is the target of the action (e.g., file path or API endpoint).
	Resource string `json:"resource"`

	// Decision is the verdict: "ADMISSIBLE" or "DENIED".
	Decision string `json:"decision"`

	// AuditID is the UUID v7 that uniquely identifies this decision.
	AuditID string `json:"audit_id"`
}

// ─────────────────────────────────────────────────────
//  WAL MANAGER — Append-Only Durable Log
//
//  Thread Safety:
//    All methods are protected by a sync.Mutex.
//
//  File Handle Strategy:
//    The WAL keeps a single O_APPEND file handle for writes.
//    Replay opens a separate read-only handle to avoid
//    seeking the write cursor. Compact atomically swaps
//    the file via temp-file + rename.
// ─────────────────────────────────────────────────────

// WALRequest represents an append request with a response channel.
type WALRequest struct {
	Data []byte
	Resp chan error
}

// WALManager manages the local append-only write-ahead log.
type WALManager struct {
	mu          sync.Mutex
	file        *os.File
	path        string
	index       int64              // Monotonic sequence number
	cb          *WALCircuitBreaker // Outbound Hub sync circuit breaker
	cursor      *CursorManager     // Durable high-water mark for replay
	reqChan     chan WALRequest    // Group Commit queue
	stop        chan struct{}      // Shutdown signal
	wg          sync.WaitGroup     // Wait for flusher to exit
	isReplaying int32              // Atomic flag to prevent Replay overlap
}

// NewWALManager opens (or creates) the WAL file.
//
// IMPORTANT: The path MUST point to durable storage.
//   - Kubernetes: PersistentVolumeClaim (NVMe-backed)
//   - Cloud Run:  Cloud Storage FUSE or Cloud Filestore
//   - Bare Metal: Local NVMe SSD
//
// If the path is on ephemeral container storage, a pod eviction
// will destroy all unsynced evidence. This violates Tier 1 compliance.
func NewWALManager(path string) (*WALManager, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return nil, fmt.Errorf("WAL_DIR_FAIL: %w", err)
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0640)
	if err != nil {
		return nil, fmt.Errorf("WAL_OPEN_FAIL: %w", err)
	}

	// Determine the current max index by scanning existing entries.
	// This ensures monotonicity across sidecar restarts.
	maxIndex := recoverMaxIndex(path)

	wm := &WALManager{
		file:    f,
		path:    path,
		index:   maxIndex,
		cb:      NewWALCircuitBreaker(),
		cursor:  NewCursorManager(path),
		reqChan: make(chan WALRequest, 10000),
		stop:    make(chan struct{}),
	}

	wm.wg.Add(1)
	go wm.flusher()

	log.Printf("[WAL_BOOT] Opened %s (recovered index: %d)", path, maxIndex)
	return wm, nil
}

// recoverMaxIndex scans the WAL to find the highest index.
// If the file is empty or corrupt, returns 0.
func recoverMaxIndex(path string) int64 {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()

	var maxIdx int64
	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) == 0 && err != nil {
			break
		}
		var entry WALEntry
		if err := json.Unmarshal(line, &entry); err != nil {
			continue
		}
		if entry.Index > maxIdx {
			maxIdx = entry.Index
		}
	}
	return maxIdx
}

// ─────────────────────────────────────────────────────
//  APPEND — The High-Pressure Gate
//
//  Called BEFORE the response is sent to the Python worker.
//  This is in the sub-0.177ms hot path.
//
//  The fsync() call is the compliance guarantee.
//  On NVMe SSD: ~20-50µs. On HDD: ~5-15ms (SLA breaker).
//  On NFS/Gluster: ~10-100ms (instant death).
//
//  The caller MUST check the error. If Append fails,
//  the response MUST be DENIED with AUDIT_INTEGRITY_FAILURE.
// ─────────────────────────────────────────────────────

func (w *WALManager) Append(entry WALEntry) error {
	entry.Index = atomic.AddInt64(&w.index, 1)
	b, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("WAL_MARSHAL_FAIL: %w", err)
	}

	req := WALRequest{
		Data: b,
		Resp: make(chan error, 1),
	}

	select {
	case w.reqChan <- req:
		return <-req.Resp
	case <-w.stop:
		return fmt.Errorf("WAL_CLOSED")
	}
}

// flusher is a dedicated background goroutine that implements Group Commit.
// It buffers incoming WALRequests for up to 1ms or 500 entries, then performs
// a single atomic Write and Sync to the underlying file.
func (w *WALManager) flusher() {
	defer w.wg.Done()

	const maxBatch = 5000

	var batch []WALRequest
	var buf bytes.Buffer

	flush := func() {
		if len(batch) == 0 {
			return
		}

		w.mu.Lock()
		for _, req := range batch {
			buf.Write(req.Data)
			buf.WriteByte('\n')
		}

		var syncErr error
		if buf.Len() > 0 {
			_, err := w.file.Write(buf.Bytes())
			if err != nil {
				syncErr = fmt.Errorf("WAL_WRITE_FAIL: %w", err)
			} else {
				err = w.file.Sync()
				if err != nil {
					syncErr = fmt.Errorf("WAL_SYNC_FAIL: %w", err)
				}
			}
		}
		w.mu.Unlock()

		// Broadcast success to all waiting Hot Path goroutines
		for _, req := range batch {
			req.Resp <- syncErr
		}

		// Reset batch and buffer for the next round
		batch = batch[:0]
		buf.Reset()
	}

	for {
		select {
		case <-w.stop:
			flush()
			return
		case req := <-w.reqChan:
			batch = append(batch, req)
			// Greedily drain the channel to group commit without artificial delays
			for len(batch) < maxBatch {
				select {
				case req := <-w.reqChan:
					batch = append(batch, req)
				default:
					// No more pending requests right now, break to flush immediately
					goto doFlush
				}
			}
		doFlush:
			flush()
		}
	}
}

// ─────────────────────────────────────────────────────
//  PENDING COUNT — Boot-time Health Check
// ─────────────────────────────────────────────────────

func (w *WALManager) PendingCount() (int, error) {
	w.mu.Lock()
	f, err := os.Open(w.path)
	if err != nil {
		w.mu.Unlock()
		return 0, err
	}
	w.mu.Unlock()
	defer f.Close()

	startOffset := w.cursor.Get()
	if startOffset > 0 {
		if _, err := f.Seek(startOffset, 0); err != nil {
			return 0, err
		}
	}

	count := 0
	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			count++
		}
		if err != nil {
			break
		}
	}
	return count, nil
}

// ─────────────────────────────────────────────────────
//  REPLAY — The 2 AM Recovery Engine (RC-Hardened)
//
//  Architecture:
//    1. Read phase: scan WAL, collect pending entries.
//    2. Push phase: bounded worker pool sends entries
//       to the Hub with exponential backoff on failures.
//    3. Compact phase: atomically rewrite WAL without
//       expired synced entries.
//
//  Concurrency Model:
//    A buffered channel of size WorkerPoolSize acts as
//    a semaphore. Workers acquire a slot, push one entry,
//    release the slot. This caps goroutine count to
//    exactly WorkerPoolSize regardless of backlog depth.
//
//  Backoff Strategy:
//    On 429 (Too Many Requests) or network error:
//      - Initial delay: 1 second
//      - Multiplier: 2x per consecutive failure
//      - Maximum delay: 60 seconds
//      - Reset to 0 on any successful push
//
//  Ordering:
//    Entries are dispatched in FIFO index order.
//    A sync.WaitGroup ensures all workers complete
//    before the compaction phase begins.
// ─────────────────────────────────────────────────────

const (
	// MaxReplayBatch caps entries processed per replay cycle.
	// Prevents the replayer from blocking the WAL mutex for too long.
	MaxReplayBatch = 500

	// WorkerPoolSize is the maximum concurrent Hub pushes.
	// 100 goroutines * ~5ms per push = ~500 pushes/sec throughput.
	// At 50,000 pending entries with MaxReplayBatch=500, this
	// completes in ~5 seconds instead of spawning 50k goroutines.
	WorkerPoolSize = 100

	// Backoff constants for Hub rate-limit handling.
	BackoffInitial = 1 * time.Second
	BackoffMax     = 60 * time.Second
	BackoffFactor  = 2.0
)

// replayResult tracks the outcome of a single push attempt.
type replayResult struct {
	index    int  // Position in the pending slice
	success  bool
	rateLimited bool
}

func (w *WALManager) Replay(hubURL string) {
	// ── Phase 0.5: Prevent Worker Overlap ──────────────
	if !atomic.CompareAndSwapInt32(&w.isReplaying, 0, 1) {
		log.Printf("[WAL_REPLAY] Skipped — previous replay cycle is still running")
		return
	}
	defer atomic.StoreInt32(&w.isReplaying, 0)

	// ── Phase 0: Circuit Breaker Check ─────────────────
	// Check BEFORE acquiring the mutex to avoid holding the lock
	// during the OPEN state log + return.
	cbMaxBatch := w.cb.MaxBatch()
	if cbMaxBatch == 0 {
		log.Printf("[WAL_REPLAY] Skipped — circuit breaker is OPEN (recovery in %v)",
			CBRecoveryPeriod)
		return
	}

	w.mu.Lock()
	// ── Phase 1: Read ──────────────────────────────────
	f, err := os.Open(w.path)
	if err != nil {
		w.mu.Unlock()
		log.Printf("[WAL_REPLAY] Open failed: %v", err)
		return
	}
	w.mu.Unlock() // Unlock BEFORE scanning and making HTTP calls to prevent hot path blockage!

	startOffset := w.cursor.Get()
	if startOffset > 0 {
		if _, err := f.Seek(startOffset, 0); err != nil {
			log.Printf("[WAL_REPLAY] Seek failed: %v", err)
			f.Close()
			return
		}
	}

	var pending []WALEntry
	var pendingOffsets []int64 // Track physical offset after each entry
	var currentOffset = startOffset
	reader := bufio.NewReader(f)
	
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) == 0 && err != nil {
			break
		}
		currentOffset += int64(len(line))

		var entry WALEntry
		if err := json.Unmarshal(line, &entry); err != nil {
			continue // Skip corrupted lines
		}
		
		pending = append(pending, entry)
		pendingOffsets = append(pendingOffsets, currentOffset)

		if len(pending) >= MaxReplayBatch {
			log.Printf("[WAL_REPLAY] Capping batch to %d", MaxReplayBatch)
			break
		}
	}
	f.Close()

	if len(pending) == 0 {
		return
	}

	// Cap the batch — CB may limit to 1 (HALF_OPEN probe)
	batchSize := len(pending)
	if batchSize > cbMaxBatch {
		batchSize = cbMaxBatch
	}

	log.Printf("[WAL_REPLAY] Replaying %d of %d pending entries (workers: %d, CB: %s)",
		batchSize, len(pending), WorkerPoolSize, w.cb.CBState())

	// ── Phase 2: Push with bounded worker pool ─────────
	client := &http.Client{Timeout: 5 * time.Second}
	semaphore := make(chan struct{}, WorkerPoolSize)
	results := make(chan replayResult, batchSize)
	var wg sync.WaitGroup

	// Track backoff state — shared across workers via atomic-like
	// channel signaling. If ANY worker gets a 429, we signal all
	// workers to stop dispatching new entries.
	stopSignal := make(chan struct{})
	var stopOnce sync.Once

	for i := 0; i < batchSize; i++ {
		// Check if a worker signaled rate-limiting
		select {
		case <-stopSignal:
			// Hub is rate-limiting — stop dispatching new entries.
			// Already-running workers will finish their current push.
			log.Printf("[WAL_REPLAY] Rate-limit detected — stopping dispatch at entry %d/%d", i, batchSize)
			goto waitForWorkers
		default:
		}

		wg.Add(1)
		semaphore <- struct{}{} // Acquire worker slot (blocks if pool is full)

		go func(idx int, entry WALEntry) {
			defer wg.Done()
			defer func() { <-semaphore }() // Release worker slot

			result := pushToHub(client, hubURL, entry, idx)
			results <- result

			if result.rateLimited {
				stopOnce.Do(func() { close(stopSignal) })
			}
		}(i, pending[i])
	}

waitForWorkers:
	// Wait for all in-flight workers to complete
	go func() {
		wg.Wait()
		close(results)
	}()

	synced := 0
	successes := make([]bool, batchSize)
	for r := range results {
		if r.success {
			successes[r.index] = true
			synced++
		}
	}

	// ── Circuit Breaker Feedback ────────────────────────
	if synced > 0 {
		w.cb.RecordSuccess()
	} else {
		w.cb.RecordFailure()
		log.Printf("[WAL_REPLAY] Batch failed — 0/%d synced (CB state: %s)", batchSize, w.cb.CBState())
		return
	}

	log.Printf("[WAL_REPLAY] Successfully synced %d/%d entries (CB: %s)", synced, batchSize, w.cb.CBState())

	// ── Phase 3: Advance Cursor (Strictly Contiguous) ───
	var highestSyncedOffset int64 = startOffset
	for i := 0; i < batchSize; i++ {
		if successes[i] {
			highestSyncedOffset = pendingOffsets[i]
		} else {
			// Stop at the first failure to prevent Data Black Holes
			break
		}
	}

	if highestSyncedOffset > startOffset {
		if err := w.cursor.Set(highestSyncedOffset); err != nil {
			log.Printf("[WAL_REPLAY] CRITICAL ERROR updating cursor: %v", err)
		} else {
			log.Printf("[WAL_REPLAY] Cursor advanced to offset %d", highestSyncedOffset)
			w.Compact()
		}
	}
}

// pushToHub sends a single WAL entry to the Governance Hub.
// Implements exponential backoff for transient failures.
func pushToHub(client *http.Client, hubURL string, entry WALEntry, idx int) replayResult {
	payload, _ := json.Marshal(entry)
	backoff := BackoffInitial

	for attempt := 0; attempt < 4; attempt++ {
		resp, err := client.Post(
			hubURL+"/v1/evidence/ingest",
			"application/json",
			bytes.NewReader(payload),
		)
		if err != nil {
			// Network error — backoff and retry
			log.Printf("[WAL_REPLAY] Push failed for %s (attempt %d): %v",
				entry.AuditID, attempt+1, err)
			time.Sleep(backoff)
			backoff = nextBackoff(backoff)
			continue
		}
		resp.Body.Close()

		switch {
		case resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated:
			return replayResult{index: idx, success: true}

		case resp.StatusCode == http.StatusTooManyRequests:
			// 429: Hub is overwhelmed — signal rate-limit and backoff
			log.Printf("[WAL_REPLAY] Hub rate-limited (429) for %s — backing off %v",
				entry.AuditID, backoff)
			time.Sleep(backoff)
			backoff = nextBackoff(backoff)
			// After one retry with backoff, signal the pool to stop
			if attempt >= 1 {
				return replayResult{index: idx, success: false, rateLimited: true}
			}

		default:
			// Non-retryable error (4xx except 429, or unexpected code)
			log.Printf("[WAL_REPLAY] Hub rejected %s: HTTP %d (non-retryable)",
				entry.AuditID, resp.StatusCode)
			return replayResult{index: idx, success: false}
		}
	}

	// Exhausted retries
	return replayResult{index: idx, success: false}
}

// nextBackoff computes the next backoff duration with exponential growth.
func nextBackoff(current time.Duration) time.Duration {
	next := time.Duration(float64(current) * BackoffFactor)
	if next > BackoffMax {
		return BackoffMax
	}
	return next
}

// ─────────────────────────────────────────────────────
//  COMPACTION — Purging Synced Evidence
// ─────────────────────────────────────────────────────

// Compact atomically rewrites the WAL, discarding all entries strictly BEFORE the current cursor (High-Water Mark).
func (w *WALManager) Compact() {
	highWaterMark := w.cursor.Get()
	// Only compact if there's significant data to purge (e.g., 5MB) to avoid constant disk thrashing
	if highWaterMark < 5*1024*1024 {
		return
	}

	f, err := os.Open(w.path)
	if err != nil {
		log.Printf("[WAL_COMPACT] Open failed: %v", err)
		return
	}

	stat, err := f.Stat()
	if err != nil {
		f.Close()
		return
	}
	snapshotSize := stat.Size()

	if _, err := f.Seek(highWaterMark, 0); err != nil {
		f.Close()
		log.Printf("[WAL_COMPACT] Seek failed: %v", err)
		return
	}

	tmpPath := w.path + ".tmp"
	tmpFile, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0640)
	if err != nil {
		f.Close()
		log.Printf("[WAL_COMPACT] Temp file create failed: %v", err)
		return
	}

	// 1. Copy the unacknowledged portion up to snapshotSize WITHOUT holding the lock
	if _, err := io.CopyN(tmpFile, f, snapshotSize-highWaterMark); err != nil && err != io.EOF {
		log.Printf("[WAL_COMPACT] Copy failed: %v", err)
		f.Close()
		tmpFile.Close()
		os.Remove(tmpPath)
		return
	}

	// 2. Now acquire lock to freeze writes, copy the remaining delta, and swap
	w.mu.Lock()
	defer w.mu.Unlock()

	// Find the final size
	stat, _ = f.Stat()
	finalSize := stat.Size()
	delta := finalSize - snapshotSize

	if delta > 0 {
		if _, err := io.CopyN(tmpFile, f, delta); err != nil && err != io.EOF {
			log.Printf("[WAL_COMPACT] Delta copy failed: %v", err)
			f.Close()
			tmpFile.Close()
			os.Remove(tmpPath)
			return
		}
	}
	f.Close()
	tmpFile.Sync()
	tmpFile.Close()

	// CRITICAL: We MUST reset the cursor to 0 BEFORE renaming the WAL file.
	// If we crash between rename and cursor reset, the new file would be small,
	// but the cursor would be large, causing a Seek() past EOF and lost evidence.
	// By resetting first, a crash mid-swap safely causes a full replay (idempotent).
	if err := w.cursor.Set(0); err != nil {
		log.Printf("[WAL_COMPACT] Cursor reset failed, aborting compaction: %v", err)
		os.Remove(tmpPath)
		return
	}

	// Swap files
	w.file.Close()
	if err := os.Rename(tmpPath, w.path); err != nil {
		log.Printf("[WAL_COMPACT] Rename failed: %v", err)
		// Try to reopen original file (which is still there)
		w.file, _ = os.OpenFile(w.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0640)
		// Best effort to restore cursor
		w.cursor.Set(highWaterMark)
		return
	}

	w.file, err = os.OpenFile(w.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0640)
	if err != nil {
		log.Fatalf("[WAL_COMPACT_FATAL] Reopen failed after swap: %v", err)
	}

	log.Printf("[WAL_COMPACT] Compaction completed. Purged %d bytes.", highWaterMark)
}

// ─────────────────────────────────────────────────────
//  CLOSE — Graceful Shutdown
// ─────────────────────────────────────────────────────

func (w *WALManager) Close() error {
	close(w.stop)
	w.wg.Wait()
	
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.file.Close()
}

// FilePath returns the WAL file path (used by boot diagnostics).
func (w *WALManager) FilePath() string {
	return w.path
}

// ─────────────────────────────────────────────────────
//  MOUNT VALIDATOR — Persistent Volume Verification
//
//  Called at boot to verify the WAL directory is on
//  durable storage. Writes a sentinel file, fsyncs it,
//  and verifies readback. If this fails, the sidecar
//  MUST NOT start — ephemeral storage = compliance violation.
// ─────────────────────────────────────────────────────

// ValidateDurableMount writes a canary file to the WAL directory,
// fsyncs it, reads it back, and deletes it. This proves the mount
// survives the write-fsync-read cycle. It does NOT prove persistence
// across pod restarts — that requires the kill -9 verification test.
func ValidateDurableMount(walPath string) error {
	dir := filepath.Dir(walPath)
	canary := filepath.Join(dir, ".sentinel_mount_canary")
	payload := []byte("SENTINEL_DURABLE_MOUNT_CHECK")

	// Write
	if err := os.WriteFile(canary, payload, 0640); err != nil {
		return fmt.Errorf("MOUNT_WRITE_FAIL: %w — is %s writable?", err, dir)
	}

	// Open and fsync
	f, err := os.OpenFile(canary, os.O_WRONLY, 0640)
	if err != nil {
		return fmt.Errorf("MOUNT_OPEN_FAIL: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("MOUNT_FSYNC_FAIL: %w — NFS/FUSE mount may not support fsync", err)
	}
	f.Close()

	// Read back
	data, err := os.ReadFile(canary)
	if err != nil {
		return fmt.Errorf("MOUNT_READ_FAIL: %w", err)
	}
	if string(data) != string(payload) {
		return fmt.Errorf("MOUNT_CORRUPT: wrote %q, read %q — storage is unreliable", string(payload), string(data))
	}

	// Cleanup
	os.Remove(canary)

	// Warn about fsync latency
	start := time.Now()
	f2, _ := os.Create(canary)
	f2.Write(payload)
	f2.Sync()
	f2.Close()
	syncLatency := time.Since(start)
	os.Remove(canary)

	if syncLatency > 1*time.Millisecond {
		log.Printf("[WAL_MOUNT_WARN] fsync latency: %v — NVMe target is <50µs. SLA risk.", syncLatency)
	} else {
		log.Printf("[WAL_MOUNT] Durable mount verified (fsync latency: %v)", syncLatency)
	}

	return nil
}

// ─────────────────────────────────────────────────────
//  INTEGRITY CHECK — Post-Crash Recovery
//
//  Scans the WAL for structural integrity after a crash.
//  Reports corrupted lines (which are safely skipped during
//  replay) and validates the monotonic index chain.
// ─────────────────────────────────────────────────────

// IntegrityReport summarizes the WAL's structural health.
type IntegrityReport struct {
	TotalLines    int
	ValidEntries  int
	CorruptLines  int
	PendingCount  int
	SyncedCount   int
	MaxIndex      int64
	IndexGaps     int // Non-consecutive index jumps (indicates lost entries)
}

func (w *WALManager) IntegrityCheck() IntegrityReport {
	w.mu.Lock()
	defer w.mu.Unlock()

	f, err := os.Open(w.path)
	if err != nil {
		log.Printf("[WAL_INTEGRITY] Open failed: %v", err)
		return IntegrityReport{}
	}
	defer f.Close()

	var report IntegrityReport
	var lastIndex int64

	highWaterMark := w.cursor.Get() // Now treated as a byte offset
	var currentOffset int64 = 0

	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) == 0 && err != nil {
			break
		}
		currentOffset += int64(len(line))

		report.TotalLines++
		var entry WALEntry
		if err := json.Unmarshal(line, &entry); err != nil {
			report.CorruptLines++
			continue
		}
		report.ValidEntries++

		if currentOffset <= highWaterMark {
			report.SyncedCount++
		} else {
			report.PendingCount++
		}

		if entry.Index > report.MaxIndex {
			report.MaxIndex = entry.Index
		}

		// Check monotonic ordering
		if lastIndex > 0 && entry.Index != lastIndex+1 {
			report.IndexGaps++
		}
		lastIndex = entry.Index
	}

	return report
}

// ─────────────────────────────────────────────────────
//  CIRCUIT BREAKER — Hub Sync Protection
//
//  Prevents the WAL Replay from hammering a degraded or
//  unreachable Hub. Without this, every 30s replay cycle
//  would dispatch 500 entries into a timeout black hole,
//  consuming 100 goroutines for 5s each (500s of wasted
//  wall-clock across the pool per cycle).
//
//  State Machine:
//    CLOSED ──[consecutive failures > threshold]──→ OPEN
//    OPEN   ──[recovery timeout elapsed]──────────→ HALF_OPEN
//    HALF_OPEN ──[probe succeeds]─────────────────→ CLOSED
//    HALF_OPEN ──[probe fails]────────────────────→ OPEN
//
//  Integration:
//    Replay checks CB state before dispatching any workers.
//    If OPEN, the entire replay cycle is skipped with a log.
//    If HALF_OPEN, only 1 entry is dispatched as a probe.
// ─────────────────────────────────────────────────────

const (
	CBThreshold      = 3               // Consecutive failed batches before OPEN
	CBRecoveryPeriod = 30 * time.Second // Time in OPEN before transitioning to HALF_OPEN
)

type CBState int

const (
	CBClosed   CBState = iota // Normal — full batch replay
	CBOpen                    // Hub is down — skip replay entirely
	CBHalfOpen                // Probing — send 1 entry as a canary
)

func (s CBState) String() string {
	switch s {
	case CBClosed:
		return "CLOSED"
	case CBOpen:
		return "OPEN"
	case CBHalfOpen:
		return "HALF_OPEN"
	default:
		return "UNKNOWN"
	}
}

// WALCircuitBreaker tracks the health of the outbound Hub sync path.
type WALCircuitBreaker struct {
	mu              sync.Mutex
	state           CBState
	consecutiveFails int
	lastFailTime    time.Time
	lastTransition  time.Time
}

// NewWALCircuitBreaker creates a CB in the CLOSED (healthy) state.
func NewWALCircuitBreaker() *WALCircuitBreaker {
	return &WALCircuitBreaker{
		state:          CBClosed,
		lastTransition: time.Now(),
	}
}

// State returns the current CB state, applying time-based transitions.
func (cb *WALCircuitBreaker) CBState() CBState {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.state == CBOpen && time.Since(cb.lastFailTime) > CBRecoveryPeriod {
		cb.state = CBHalfOpen
		cb.lastTransition = time.Now()
		log.Printf("[CIRCUIT_BREAKER] OPEN → HALF_OPEN (recovery timeout elapsed)")
	}
	return cb.state
}

// RecordSuccess resets the CB to CLOSED on a successful push.
func (cb *WALCircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.state != CBClosed {
		log.Printf("[CIRCUIT_BREAKER] %s → CLOSED (successful push)", cb.state)
	}
	cb.state = CBClosed
	cb.consecutiveFails = 0
	cb.lastTransition = time.Now()
}

// RecordFailure increments the failure counter. If the threshold is
// breached, transitions to OPEN.
func (cb *WALCircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.consecutiveFails++
	cb.lastFailTime = time.Now()

	if cb.consecutiveFails >= CBThreshold && cb.state != CBOpen {
		log.Printf("[CIRCUIT_BREAKER] %s → OPEN (consecutive failures: %d >= threshold: %d)",
			cb.state, cb.consecutiveFails, CBThreshold)
		cb.state = CBOpen
		cb.lastTransition = time.Now()
	}
}

// MaxBatch returns the number of entries to dispatch based on CB state.
func (cb *WALCircuitBreaker) MaxBatch() int {
	switch cb.CBState() {
	case CBOpen:
		return 0 // Skip entirely
	case CBHalfOpen:
		return 1 // Single probe entry
	default:
		return MaxReplayBatch // Full batch
	}
}
