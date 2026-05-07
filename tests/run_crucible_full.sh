#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  SENTINEL V5.5 — THE REAL CRUCIBLE
#
#  This script runs the FULL load test with live Hub sync.
#  It eliminates the "Air-Gapped Cheat" from LTC-1 by:
#    1. Starting Postgres + PgBouncer via Docker Compose
#    2. Building + starting the Hub Evidence API
#    3. Compiling the sidecar with real WAL Replay enabled (5s)
#    4. Starting the UDS bridge proxy
#    5. Running k6 with 200 VUs for 100s (local WSL2 ceiling)
#    6. Verifying WAL drain → Postgres reconciliation
#
#  Prerequisites (in WSL2):
#    - Docker Engine running (docker compose works)
#    - Go 1.22+ installed
#    - curl, jq available
#
#  Run from WSL2:
#    cd /mnt/d/Documents/Sentinel\ Engine
#    bash tests/run_crucible_full.sh
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ── Paths ────────────────────────────────────────────────
CRUCIBLE_DIR="/tmp/sentinel-crucible"
WAL_DIR="${CRUCIBLE_DIR}/wal"
SOCK="/tmp/sentinel_veritas.sock"
HUB_DIR="/mnt/d/Documents/Sentinel Engine/tests/crucible-hub"
SIDECAR_SRC="/mnt/d/Documents/Sentinel Engine/sidecar"

# Postgres via PgBouncer
HUB_DB_DSN="postgres://sentinel:crucible_test_2026@localhost:6432/sentinel_hub?sslmode=disable"
HUB_API_PORT="8081"
HUB_API_URL="http://127.0.0.1:${HUB_API_PORT}"

# Test parameters
WAL_REPLAY_INTERVAL="5"     # 5 seconds — REAL background sync
HUB_SYNC_INTERVAL="5"       # 5 seconds — REAL Hub sync

# PIDs for cleanup
PIDS=()

cleanup() {
  echo ""
  echo "═══ CLEANUP ════════════════════════════════════"
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  Killing PID $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done
  echo "  Stopping Docker Compose..."
  cd "${HUB_DIR}" && docker compose down -v 2>/dev/null || true
  echo "═══════════════════════════════════════════════"
}
trap cleanup EXIT INT TERM

echo "═══════════════════════════════════════════════"
echo "  SENTINEL V5.5 — THE REAL CRUCIBLE"
echo "  (Live Hub Sync + PgBouncer + WAL Replay)"
echo "═══════════════════════════════════════════════"

# ── Phase 0: Clean ───────────────────────────────────────
echo ""
echo "[0/6] Cleaning previous state..."
rm -f "${SOCK}"
rm -f "${WAL_DIR}/wal.jsonl"
rm -f "${CRUCIBLE_DIR}/sidecar.log"
rm -f "${CRUCIBLE_DIR}/bridge.log"
rm -f "${CRUCIBLE_DIR}/hub-api.log"
mkdir -p "${WAL_DIR}"

# ── Phase 1: Start Postgres + PgBouncer ─────────────────
echo ""
echo "[1/6] Starting Postgres + PgBouncer (Docker Compose)..."
cd "${HUB_DIR}"
docker compose down -v 2>/dev/null || true
docker compose up -d --wait

# Verify PgBouncer is healthy
echo "  Waiting for PgBouncer..."
for i in $(seq 1 20); do
  if docker exec crucible-pgbouncer pg_isready -h localhost -p 5432 2>/dev/null; then
    echo "  ✅ PgBouncer is ready"
    break
  fi
  sleep 1
done

# Verify the audit table exists
echo "  Verifying veritas_audit_log table..."
docker exec crucible-postgres psql -U sentinel -d sentinel_hub -c "\dt veritas_audit_log" 2>/dev/null | grep -q "veritas_audit_log" || {
  echo "  ❌ veritas_audit_log table not created. Check init.sql."
  exit 1
}
echo "  ✅ Table exists"

# ── Phase 2: Build + Start Hub API ──────────────────────
echo ""
echo "[2/6] Building Hub API..."
cd "${HUB_DIR}"
go mod tidy 2>/dev/null || true
go build -o "${CRUCIBLE_DIR}/hub-api" . 2>&1
echo "  ✅ Hub API built"

echo "  Starting Hub API on :${HUB_API_PORT}..."
CRUCIBLE_DB_DSN="${HUB_DB_DSN}" \
  CRUCIBLE_HUB_PORT="${HUB_API_PORT}" \
  "${CRUCIBLE_DIR}/hub-api" > "${CRUCIBLE_DIR}/hub-api.log" 2>&1 &
HUB_PID=$!
PIDS+=($HUB_PID)
echo "  PID: ${HUB_PID}"
sleep 2

# Verify Hub API
HEALTH=$(curl -s "${HUB_API_URL}/health" 2>/dev/null || echo "{}")
if echo "${HEALTH}" | grep -q '"healthy"'; then
  echo "  ✅ Hub API is healthy: ${HEALTH}"
else
  echo "  ❌ Hub API failed to start. Logs:"
  cat "${CRUCIBLE_DIR}/hub-api.log"
  exit 1
fi

# ── Phase 3: Build + Start Sidecar ──────────────────────
echo ""
echo "[3/6] Building sentinel-sidecar..."
cd "${SIDECAR_SRC}"
go build -o "${CRUCIBLE_DIR}/sentinel-sidecar" . 2>&1
echo "  ✅ Sidecar built"

# Seed the graph
GRAPH_SRC="/mnt/d/Documents/Sentinel Engine/tests/crucible_graph.json"
if [ -f "${GRAPH_SRC}" ]; then
  cp "${GRAPH_SRC}" "${WAL_DIR}/graph.json"
  echo "  Graph seeded (50 tenants × 10 skills)"
else
  echo "  ⚠ No graph seed found — all requests will be DENIED"
fi

export SENTINEL_SIDECAR_SOCKET="${SOCK}"
export SENTINEL_WAL_PATH="${WAL_DIR}/wal.jsonl"
export SENTINEL_GRAPH_SNAPSHOT="${WAL_DIR}/graph.json"
export SENTINEL_HUB_URL="${HUB_API_URL}"
export SENTINEL_TENANT_ID="crucible-test"
export SENTINEL_HUB_SYNC_INTERVAL="${HUB_SYNC_INTERVAL}"
export SENTINEL_WAL_REPLAY_INTERVAL="${WAL_REPLAY_INTERVAL}"
export SENTINEL_SOCKET_GROUP=""

echo "  Starting sidecar (Hub Sync: ${HUB_SYNC_INTERVAL}s, WAL Replay: ${WAL_REPLAY_INTERVAL}s)..."
"${CRUCIBLE_DIR}/sentinel-sidecar" > "${CRUCIBLE_DIR}/sidecar.log" 2>&1 &
SIDECAR_PID=$!
PIDS+=($SIDECAR_PID)
echo "  PID: ${SIDECAR_PID}"

# Wait for socket
for i in $(seq 1 10); do
  if [ -S "${SOCK}" ]; then
    echo "  ✅ Socket ready: ${SOCK}"
    break
  fi
  if ! kill -0 ${SIDECAR_PID} 2>/dev/null; then
    echo "  ❌ Sidecar crashed. Logs:"
    cat "${CRUCIBLE_DIR}/sidecar.log"
    exit 1
  fi
  sleep 0.5
done

if [ ! -S "${SOCK}" ]; then
  echo "  ❌ Socket not created after 5s. Logs:"
  cat "${CRUCIBLE_DIR}/sidecar.log"
  exit 1
fi

# ── Phase 4: Start Bridge Proxy ─────────────────────────
echo ""
echo "[4/6] Starting bridge proxy on :9090..."
BRIDGE_SRC="/mnt/d/Documents/Sentinel Engine/tests"
cd "${BRIDGE_SRC}"

# Build if not already built
if [ ! -f "${CRUCIBLE_DIR}/bridge_test_proxy" ]; then
  go build -o "${CRUCIBLE_DIR}/bridge_test_proxy" bridge_test_proxy.go
fi

SENTINEL_SIDECAR_SOCKET="${SOCK}" "${CRUCIBLE_DIR}/bridge_test_proxy" > "${CRUCIBLE_DIR}/bridge.log" 2>&1 &
BRIDGE_PID=$!
PIDS+=($BRIDGE_PID)
echo "  PID: ${BRIDGE_PID}"
sleep 1

# Verify bridge
RESPONSE=$(curl -s -X POST http://127.0.0.1:9090/arbitrate \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"crucible-test","skill":"ping","resource":"/test/ping"}' 2>&1)

if echo "${RESPONSE}" | grep -q '"decision"'; then
  echo "  ✅ Bridge is live: ${RESPONSE}"
else
  echo "  ❌ Bridge not responding. Logs:"
  cat "${CRUCIBLE_DIR}/bridge.log"
  exit 1
fi

# ── Phase 5: Execute Crucible ────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  🔥 THE CRUCIBLE — LIVE HUB SYNC 🔥"
echo "═══════════════════════════════════════════════"
echo "  VUs:             200 (WSL2 local ceiling)"
echo "  Duration:        100s"
echo "  Hub Sync:        ENABLED (${HUB_SYNC_INTERVAL}s)"
echo "  WAL Replay:      ENABLED (${WAL_REPLAY_INTERVAL}s)"
echo "  Circuit Breaker: ACTIVE"
echo "  PgBouncer Pool:  50 txn-mode connections"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Run k6 from Windows PowerShell:"
echo ""
echo "    cd 'd:\Documents\Sentinel Engine'"
echo "    .\tests\k6.exe run .\tests\load_test_local.js"
echo ""
echo "  Or with JSON output:"
echo "    .\tests\k6.exe run --out json=tests/crucible_full_results.json .\tests\load_test_local.js"
echo ""
echo "  Monitoring commands (in separate terminals):"
echo "    # Watch Hub API telemetry:"
echo "    watch -n 5 curl -s http://127.0.0.1:${HUB_API_PORT}/health"
echo ""
echo "    # Watch WAL growth:"
echo "    watch -n 5 wc -l ${WAL_DIR}/wal.jsonl"
echo ""
echo "    # Watch sidecar logs (circuit breaker + replay):"
echo "    tail -f ${CRUCIBLE_DIR}/sidecar.log | grep -E 'REPLAY|CIRCUIT'"
echo ""
echo "    # Watch Hub API logs:"
echo "    tail -f ${CRUCIBLE_DIR}/hub-api.log"
echo ""
echo "  Waiting for processes (Ctrl+C to stop)..."

# ── Phase 6: Wait + Post-Test Verification ──────────────
wait || true

# If we get here (after k6 finishes or Ctrl+C), run verification
echo ""
echo "═══════════════════════════════════════════════"
echo "  POST-CRUCIBLE VERIFICATION"
echo "═══════════════════════════════════════════════"

# Wait for WAL drain (30s grace period for replay to finish)
echo "  Waiting 30s for WAL drain..."
sleep 30

# Count WAL entries
WAL_TOTAL=$(wc -l < "${WAL_DIR}/wal.jsonl" 2>/dev/null || echo "0")
WAL_PENDING=$(grep -c '"synced":false' "${WAL_DIR}/wal.jsonl" 2>/dev/null || echo "0")
WAL_SYNCED=$(grep -c '"synced":true' "${WAL_DIR}/wal.jsonl" 2>/dev/null || echo "0")

# Count DB entries
DB_ROWS=$(docker exec crucible-postgres psql -U sentinel -d sentinel_hub -t -c \
  "SELECT COUNT(*) FROM veritas_audit_log;" 2>/dev/null | tr -d ' ')

echo ""
echo "  WAL Total:    ${WAL_TOTAL}"
echo "  WAL Synced:   ${WAL_SYNCED}"
echo "  WAL Pending:  ${WAL_PENDING}"
echo "  DB Rows:      ${DB_ROWS}"
echo ""

if [ "${WAL_PENDING}" -eq "0" ] 2>/dev/null; then
  echo "  ✅ WAL fully drained to Hub"
else
  echo "  ⚠️  ${WAL_PENDING} entries still pending"
fi

if [ "${DB_ROWS}" -gt "0" ] 2>/dev/null; then
  echo "  ✅ Postgres has ${DB_ROWS} audit records"
else
  echo "  ❌ Postgres is empty — Hub sync never worked"
fi

# Circuit breaker status from sidecar logs
echo ""
echo "  Circuit Breaker Events:"
grep -c "CIRCUIT_BREAKER" "${CRUCIBLE_DIR}/sidecar.log" 2>/dev/null && echo " events found" || echo "  None (healthy path)"

echo ""
echo "═══════════════════════════════════════════════"
echo "  CRUCIBLE COMPLETE"
echo "═══════════════════════════════════════════════"
