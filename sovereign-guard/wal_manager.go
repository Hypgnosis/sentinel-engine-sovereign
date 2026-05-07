package main

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/lib/pq"
)

type WALEntry struct {
	Index     int64  `json:"i"`
	Timestamp string `json:"ts"`
	TenantID  string `json:"tenant_id,omitempty"`
	Skill     string `json:"skill"`
	Resource  string `json:"resource"`
	Decision  string `json:"decision"`
	AuditID   string `json:"audit_id"`
}

type WALRequest struct {
	Entry WALEntry
	Resp  chan error
}

type WALManager struct {
	mu          sync.Mutex
	file        *os.File
	path        string
	index       int64
	cursor      *CursorManager
	reqChan     chan WALRequest
	stop        chan struct{}
	wg          sync.WaitGroup
	isReplaying int32
}

func NewWALManager(path string) (*WALManager, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return nil, fmt.Errorf("WAL_DIR_FAIL: %w", err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0640)
	if err != nil {
		return nil, fmt.Errorf("WAL_OPEN_FAIL: %w", err)
	}

	maxIndex := recoverMaxIndex(path)
	wm := &WALManager{
		file:    f,
		path:    path,
		index:   maxIndex,
		cursor:  &CursorManager{path: path + ".cursor"},
		reqChan: make(chan WALRequest, 10000),
		stop:    make(chan struct{}),
	}
	wm.wg.Add(1)
	go wm.flusher()
	log.Printf("[WAL_BOOT] Opened %s (recovered index: %d)", path, maxIndex)
	return wm, nil
}

func recoverMaxIndex(path string) int64 {
	f, err := os.Open(path)
	if err != nil { return 0 }
	defer f.Close()

	var maxIdx int64
	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) == 0 && err != nil { break }
		var entry WALEntry
		if json.Unmarshal(line, &entry) == nil && entry.Index > maxIdx {
			maxIdx = entry.Index
		}
	}
	return maxIdx
}

func (w *WALManager) Append(entry WALEntry) error {
	req := WALRequest{Entry: entry, Resp: make(chan error, 1)}
	select {
	case w.reqChan <- req:
		return <-req.Resp
	case <-w.stop:
		return fmt.Errorf("WAL_CLOSED")
	}
}

func (w *WALManager) flusher() {
	defer w.wg.Done()
	const maxBatch = 500
	const maxWait = 1 * time.Millisecond
	timer := time.NewTimer(maxWait)
	if !timer.Stop() { <-timer.C }
	var batch []WALRequest
	var buf bytes.Buffer

	flush := func() {
		if len(batch) == 0 { return }
		w.mu.Lock()
		for i := range batch {
			w.index++
			batch[i].Entry.Index = w.index
			b, err := json.Marshal(batch[i].Entry)
			if err == nil {
				buf.Write(b)
				buf.WriteByte('\n')
			}
		}
		var syncErr error
		if buf.Len() > 0 {
			if _, err := w.file.Write(buf.Bytes()); err != nil {
				syncErr = fmt.Errorf("WAL_WRITE_FAIL: %w", err)
			} else if err = w.file.Sync(); err != nil {
				syncErr = fmt.Errorf("WAL_SYNC_FAIL: %w", err)
			}
		}
		w.mu.Unlock()

		for _, req := range batch { req.Resp <- syncErr }
		batch = batch[:0]
		buf.Reset()
	}

	for {
		select {
		case <-w.stop:
			flush()
			return
		case req := <-w.reqChan:
			if len(batch) == 0 { timer.Reset(maxWait) }
			batch = append(batch, req)
			if len(batch) >= maxBatch {
				if !timer.Stop() {
					select { case <-timer.C: default: }
				}
				flush()
			}
		case <-timer.C:
			flush()
		}
	}
}

func (w *WALManager) Replay(db *sql.DB) {
	if !atomic.CompareAndSwapInt32(&w.isReplaying, 0, 1) { return }
	defer atomic.StoreInt32(&w.isReplaying, 0)

	w.mu.Lock()
	f, err := os.Open(w.path)
	w.mu.Unlock()
	if err != nil {
		log.Printf("[WAL_REPLAY] Open failed: %v", err)
		return
	}

	startOffset := w.cursor.Get()
	if startOffset > 0 {
		if _, err := f.Seek(startOffset, 0); err != nil {
			f.Close()
			return
		}
	}

	var pending []WALEntry
	var pendingOffsets []int64
	var currentOffset = startOffset
	reader := bufio.NewReader(f)

	for {
		line, err := reader.ReadBytes('\n')
		if len(line) == 0 && err != nil { break }
		currentOffset += int64(len(line))
		var entry WALEntry
		if json.Unmarshal(line, &entry) == nil {
			pending = append(pending, entry)
			pendingOffsets = append(pendingOffsets, currentOffset)
		}
	}
	f.Close()

	if len(pending) == 0 { return }

	var highestSyncedOffset int64 = startOffset
	for i, entry := range pending {
		payload, _ := json.Marshal(entry)
		_, err := db.Exec(`
			INSERT INTO evidence_locker 
			(locker_id, request_id, event_type, payload, signature, created_at) 
			VALUES ($1, $2, 'AUTHORITY_MODIFIED', $3, 'WAL_REPLAY_SIGNATURE', NOW())
			ON CONFLICT (locker_id) DO NOTHING`,
			entry.AuditID, entry.AuditID, payload)

		if err != nil {
			log.Printf("[WAL_REPLAY] DB Insert failed for %s: %v", entry.AuditID, err)
			break
		}
		highestSyncedOffset = pendingOffsets[i]
	}

	if highestSyncedOffset > startOffset {
		if err := w.cursor.Set(highestSyncedOffset); err == nil {
			w.Compact()
		}
	}
}

func (w *WALManager) Compact() {
	highWaterMark := w.cursor.Get()
	if highWaterMark < 5*1024*1024 { return }

	f, err := os.Open(w.path)
	if err != nil { return }
	stat, err := f.Stat()
	if err != nil { f.Close(); return }
	snapshotSize := stat.Size()

	if _, err := f.Seek(highWaterMark, 0); err != nil { f.Close(); return }

	tmpPath := w.path + ".tmp"
	tmpFile, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0640)
	if err != nil { f.Close(); return }

	if _, err := io.CopyN(tmpFile, f, snapshotSize-highWaterMark); err != nil && err != io.EOF {
		f.Close(); tmpFile.Close(); os.Remove(tmpPath); return
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	stat, _ = f.Stat()
	finalSize := stat.Size()
	delta := finalSize - snapshotSize
	if delta > 0 {
		if _, err := io.CopyN(tmpFile, f, delta); err != nil && err != io.EOF {
			f.Close(); tmpFile.Close(); os.Remove(tmpPath); return
		}
	}
	f.Close(); tmpFile.Sync(); tmpFile.Close()

	if err := w.cursor.Set(0); err != nil { os.Remove(tmpPath); return }

	w.file.Close()
	if err := os.Rename(tmpPath, w.path); err != nil {
		w.file, _ = os.OpenFile(w.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0640)
		w.cursor.Set(highWaterMark)
		return
	}
	w.file, _ = os.OpenFile(w.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0640)
}

func (w *WALManager) Close() error {
	close(w.stop)
	w.wg.Wait()
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.file.Close()
}
