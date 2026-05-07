#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  SENTINEL V5.5 — Crucible Local Runner
#  Starts the sidecar + bridge proxy in WSL2 for local load testing
# ═══════════════════════════════════════════════════════════════

set -e

CRUCIBLE_DIR="/tmp/sentinel-crucible"
WAL_DIR="${CRUCIBLE_DIR}/wal"
SOCK="/tmp/sentinel_veritas.sock"

# ── Clean previous runs ──────────────────────────────────
rm -f "${SOCK}"
rm -f "${WAL_DIR}/wal.jsonl"
rm -f "${CRUCIBLE_DIR}/sidecar.log"
rm -f "${CRUCIBLE_DIR}/bridge.log"

# ── Seed the skill graph (50 tenants × 10 skills) ───────
GRAPH_SRC="/mnt/d/Documents/Sentinel Engine/tests/crucible_graph.json"
if [ -f "${GRAPH_SRC}" ]; then
  cp "${GRAPH_SRC}" "${WAL_DIR}/graph.json"
  echo "  Graph seeded from Windows mount"
else
  echo "  ⚠ No graph seed found — sidecar starts with empty graph (all DENIED)"
fi

# ── Environment for standalone mode (no Hub, no DB) ──────
export SENTINEL_SIDECAR_SOCKET="${SOCK}"
export SENTINEL_WAL_PATH="${WAL_DIR}/wal.jsonl"
export SENTINEL_GRAPH_SNAPSHOT="${WAL_DIR}/graph.json"
export SENTINEL_HUB_URL="http://127.0.0.1:0"
export SENTINEL_TENANT_ID="crucible-test"
export SENTINEL_HUB_SYNC_INTERVAL="999999"
export SENTINEL_WAL_REPLAY_INTERVAL="999999"
export SENTINEL_SOCKET_GROUP=""

echo "═══════════════════════════════════════════════"
echo "  SENTINEL V5.5 — CRUCIBLE LOCAL RUNNER"
echo "═══════════════════════════════════════════════"
echo "  WAL Path:    ${WAL_DIR}/wal.jsonl"
echo "  Socket:      ${SOCK}"
echo "  Bridge:      http://0.0.0.0:9090/arbitrate"
echo "═══════════════════════════════════════════════"

# ── Start Sidecar ────────────────────────────────────────
echo "[1/2] Starting sentinel-sidecar..."
${CRUCIBLE_DIR}/sentinel-sidecar > ${CRUCIBLE_DIR}/sidecar.log 2>&1 &
SIDECAR_PID=$!
echo "       PID: ${SIDECAR_PID}"

# Wait for socket
for i in $(seq 1 10); do
  if [ -S "${SOCK}" ]; then
    echo "       Socket ready: ${SOCK}"
    break
  fi
  if ! kill -0 ${SIDECAR_PID} 2>/dev/null; then
    echo "  ❌ Sidecar crashed. Logs:"
    cat ${CRUCIBLE_DIR}/sidecar.log
    exit 1
  fi
  sleep 0.5
done

if [ ! -S "${SOCK}" ]; then
  echo "  ❌ Socket not created after 5s. Logs:"
  cat ${CRUCIBLE_DIR}/sidecar.log
  exit 1
fi

# ── Start Bridge Proxy ───────────────────────────────────
echo "[2/2] Starting bridge proxy on :9090..."
SENTINEL_SIDECAR_SOCKET="${SOCK}" ${CRUCIBLE_DIR}/bridge_test_proxy > ${CRUCIBLE_DIR}/bridge.log 2>&1 &
BRIDGE_PID=$!
echo "       PID: ${BRIDGE_PID}"
sleep 1

# ── Verify ───────────────────────────────────────────────
echo ""
echo "  Testing arbitration endpoint..."
RESPONSE=$(curl -s -X POST http://127.0.0.1:9090/arbitrate \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"crucible-test","skill":"ping","resource":"/test/ping"}' 2>&1)

echo "  Response: ${RESPONSE}"

if echo "${RESPONSE}" | grep -q '"decision"'; then
  echo ""
  echo "  ✅ CRUCIBLE STACK IS LIVE"
  echo ""
  echo "  Run k6 from Windows:"
  echo "    cd 'd:\\Documents\\Sentinel Engine'"
  echo "    .\\tests\\k6.exe run tests\\load_test.js"
  echo ""
  echo "  Sidecar PID: ${SIDECAR_PID}"
  echo "  Bridge PID:  ${BRIDGE_PID}"
  echo ""
  echo "  Waiting for processes (Ctrl+C to stop)..."
  wait
else
  echo "  ❌ Bridge not responding. Logs:"
  echo "  --- sidecar.log ---"
  cat ${CRUCIBLE_DIR}/sidecar.log
  echo "  --- bridge.log ---"
  cat ${CRUCIBLE_DIR}/bridge.log
  kill ${SIDECAR_PID} ${BRIDGE_PID} 2>/dev/null
  exit 1
fi
