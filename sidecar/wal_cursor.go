// ═══════════════════════════════════════════════════════════════
//  SENTINEL V5.5 — WAL Cursor Manager (Durable High-Water Mark)
//  ═══════════════════════════════════════════════════════════════
//
//  The Cursor eliminates the O(N²) compact-on-every-sync disaster.
//
//  Instead of rewriting the entire WAL file to flip synced:true
//  booleans, the cursor tracks the HIGHEST successfully-synced WAL
//  index in a separate 8-byte file. The WAL remains append-only
//  and is NEVER rewritten during normal operation.
//
//  Replay Algorithm:
//    1. Read cursor: highWaterMark = CursorManager.Get()
//    2. Scan WAL: skip entries where entry.Index <= highWaterMark
//    3. Push pending entries to Hub
//    4. On Hub 201: advance cursor STRICTLY AFTER acknowledgment
//
//  Crash Safety:
//    - Cursor update uses the Atomic Write-then-Rename pattern:
//      Write to wal.cursor.tmp → fsync → rename to wal.cursor
//    - If the sidecar crashes mid-rename, the old cursor survives
//      and replay re-processes the last successfully-acknowledged
//      batch (idempotent via ON CONFLICT DO NOTHING on the Hub).
//    - If wal.cursor is corrupted (0 bytes, garbage), the replayer
//      resets to index 0 and replays everything. This is safe
//      because the Hub's unique constraint prevents duplicates.
//
//  Invariant (THE GOLDEN RULE):
//    The cursor MUST be advanced ONLY AFTER the Hub returns
//    HTTP 200/201 for that entry. Advancing before acknowledgment
//    creates a Data Black Hole — skipped entries that are never
//    synced to the Hub.
//
//  File: wal_cursor.go
//  Package: main (same binary as sentinel-sidecar)
// ═══════════════════════════════════════════════════════════════

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// CursorManager tracks the highest WAL index that has been
// successfully acknowledged by the Governance Hub.
type CursorManager struct {
	mu   sync.Mutex
	path string // e.g., /var/sentinel/wal/wal.cursor
}

// NewCursorManager creates a cursor manager for the given path.
// The cursor file is created alongside the WAL file to ensure
// they share the same durable mount.
func NewCursorManager(walPath string) *CursorManager {
	cursorPath := strings.TrimSuffix(walPath, filepath.Ext(walPath)) + ".cursor"
	cm := &CursorManager{path: cursorPath}

	current := cm.Get()
	log.Printf("[WAL_CURSOR] Initialized at %s (high-water mark: %d)", cursorPath, current)
	return cm
}

// Get reads the current high-water mark from disk.
// Returns 0 if the cursor file doesn't exist or is corrupt,
// which causes a full replay from the beginning of the WAL.
// This is safe because the Hub enforces idempotency via
// ON CONFLICT DO NOTHING on sidecar_audit_id.
func (c *CursorManager) Get() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()

	data, err := os.ReadFile(c.path)
	if err != nil {
		// No cursor file — start from beginning
		return 0
	}

	val, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		// Corrupt cursor — log and start from beginning
		log.Printf("[WAL_CURSOR] Corrupt cursor file (content: %q) — resetting to 0", string(data))
		return 0
	}

	// Sanity: cursor must be non-negative
	if val < 0 {
		log.Printf("[WAL_CURSOR] Negative cursor value (%d) — resetting to 0", val)
		return 0
	}

	return val
}

// Set atomically updates the high-water mark using the
// Write-then-Rename pattern for crash safety.
//
// CRITICAL: This MUST only be called AFTER the Hub has
// acknowledged the entries up to this index with HTTP 200/201.
// Calling Set() before Hub acknowledgment creates a Data Black
// Hole — entries the replayer will skip but the Hub never received.
//
// Atomicity Guarantee:
//   1. Write the new index to wal.cursor.tmp
//   2. fsync the temp file (bits on platter)
//   3. Rename wal.cursor.tmp → wal.cursor (atomic on POSIX)
//
// If the process crashes at step 1 or 2: old cursor survives.
// If the process crashes at step 3: rename is atomic, so either
// the old or new cursor is present — never a half-written file.
func (c *CursorManager) Set(index int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	tmpPath := c.path + ".tmp"
	content := []byte(strconv.FormatInt(index, 10))

	// Step 1: Write to temp file
	if err := os.WriteFile(tmpPath, content, 0640); err != nil {
		return fmt.Errorf("CURSOR_WRITE_FAIL: %w", err)
	}

	// Step 2: fsync the temp file to guarantee durability
	f, err := os.OpenFile(tmpPath, os.O_RDONLY, 0)
	if err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("CURSOR_OPEN_FAIL: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("CURSOR_FSYNC_FAIL: %w", err)
	}
	f.Close()

	// Step 3: Atomic rename (POSIX guarantee)
	if err := os.Rename(tmpPath, c.path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("CURSOR_RENAME_FAIL: %w", err)
	}

	return nil
}

// Path returns the cursor file path (used by diagnostics).
func (c *CursorManager) Path() string {
	return c.path
}
