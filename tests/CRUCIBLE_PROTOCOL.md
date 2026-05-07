# SENTINEL V5.5 — THE CRUCIBLE EXECUTION PROTOCOL

**Status:** RC-Ready (Pending Crucible)
**Objective:** Mathematical verification of sub-0.177ms SLA and 100% WAL Durability under extreme load.

---

## Phase 0: Infrastructure Verification (Before Touching k6)

### 0.1 PVC IOPS Budget

**The Physics:**
| Disk Size (pd-ssd) | Sustained IOPS | 5,000 VU fsync() Verdict |
|---------------------|----------------|--------------------------|
| 5 GB                | 150            | INSTANT DEATH            |
| 50 GB               | 1,500          | Depletes burst in ~30s   |
| 500 GB              | 15,000         | SURVIVES CRUCIBLE        |
| pd-extreme (any)    | Provisioned    | Best option              |

```bash
# Verify your PVC is actually 500Gi
kubectl get pvc -n sentinel-sovereign sentinel-wal-pvc -o jsonpath='{.spec.resources.requests.storage}'
# Expected: 500Gi

# Verify storage class
kubectl get pvc -n sentinel-sovereign sentinel-wal-pvc -o jsonpath='{.spec.storageClassName}'
# Expected: premium-rwo (or hyperdisk-extreme)
```

### 0.2 PgBouncer Limits

```bash
# Verify PgBouncer is configured for 10,000 client connections
kubectl exec -n sentinel-sovereign $(kubectl get pod -n sentinel-sovereign -l app=sentinel -o jsonpath='{.items[0].metadata.name}') \
  -c pgbouncer -- pgbouncer -R -d /etc/pgbouncer/pgbouncer.ini 2>&1 | grep max_client_conn
# Expected: max_client_conn = 10000

# Or check the running env:
kubectl exec -n sentinel-sovereign <pod> -c pgbouncer -- env | grep MAX_CLIENT_CONN
# Expected: MAX_CLIENT_CONN=10000

# Verify Cloud SQL max_connections
kubectl exec -n sentinel-sovereign <pod> -c pgbouncer -- psql -h localhost -p 6432 -c "SHOW max_connections;"
# Expected: 150
```

### 0.3 WAL Mount Durability

```bash
# The sidecar runs ValidateDurableMount() at boot.
# If it started successfully, the mount is verified.
# Double-check by looking at the sidecar logs:
kubectl logs -n sentinel-sovereign <pod> -c sentinel-sidecar | grep "MOUNT_VALIDATION"
# Expected: [BOOT] MOUNT_VALIDATION: PASSED
```

### 0.4 Bridge Proxy

```bash
# Start the TCP→UDS bridge on the same node as the sidecar pod
# This MUST run on the same node (or port-forward to the pod)
kubectl port-forward -n sentinel-sovereign <pod> 9090:9090 &

# Or deploy bridge_test_proxy.go inside the pod:
kubectl cp tests/bridge_test_proxy.go <pod>:/tmp/ -c sentinel-sidecar
kubectl exec <pod> -c sentinel-sidecar -- go run /tmp/bridge_test_proxy.go &

# Verify the bridge responds:
curl -s -X POST http://localhost:9090/arbitrate \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"test-001","skill":"ping","resource":"/test"}' | jq .
# Expected: { "decision": "ADMISSIBLE" or "DENIED", "latency_us": <number>, "audit_id": "sc_..." }
```

---

## Phase 1: Baseline (10 VUs, 30 seconds)

Before the full Crucible, establish your baseline latency with zero contention.

```bash
# Run a quick baseline (10 VUs, 30s)
k6 run --vus 10 --duration 30s tests/load_test.js 2>&1 | tee crucible_baseline.log
```

**Expected baseline:**
| Metric | Target |
|--------|--------|
| Sidecar p50 | < 50µs |
| Sidecar p95 | < 100µs |
| Bridge overhead | 100–300µs |
| WAL failures | 0 |

If the baseline already shows p95 > 200µs, **STOP**. Your storage is too slow. Do not proceed to Phase 2.

---

## Phase 2: The Crucible (5,000 VUs, 8.5 minutes)

```bash
# Execute the full Crucible
# BRIDGE_OVERHEAD_US: set to your baseline bridge overhead (from Phase 1)
# This is subtracted from sidecar-reported latency for SLA calculation
BRIDGE_OVERHEAD_US=0 k6 run \
  --out json=crucible_results_raw.json \
  tests/load_test.js 2>&1 | tee crucible_full.log
```

**Monitor in parallel terminals:**

```bash
# Terminal 2: Watch sidecar memory (must stay < 256Mi)
watch -n 5 kubectl top pod -n sentinel-sovereign -l app=sentinel

# Terminal 3: Watch PgBouncer connection pool
watch -n 5 kubectl exec -n sentinel-sovereign <pod> -c pgbouncer -- \
  psql -p 6432 pgbouncer -c "SHOW POOLS;"

# Terminal 4: Watch WAL growth
watch -n 10 kubectl exec -n sentinel-sovereign <pod> -c sentinel-sidecar -- \
  wc -l /var/sentinel/wal.jsonl

# Terminal 5: Watch for IOPS throttling (disk latency)
watch -n 5 kubectl exec -n sentinel-sovereign <pod> -c sentinel-sidecar -- \
  cat /proc/diskstats | grep -E "sda|nvme"
```

---

## Phase 3: Chaos Injection — The Murder Test (Minute 2)

**At the 2-minute mark** (during peak ramp), force-kill the sidecar process.

```bash
# BEFORE the kill: Record the WAL line count
BEFORE_KILL=$(kubectl exec -n sentinel-sovereign <pod> -c sentinel-sidecar -- wc -l /var/sentinel/wal.jsonl | awk '{print $1}')
echo "WAL entries before kill: $BEFORE_KILL"

# Force-kill the sidecar process (NOT the pod — we want the PVC to persist)
kubectl exec -n sentinel-sovereign <pod> -c sentinel-sidecar -- kill -9 1

# Wait for the liveness probe to restart the container (10-15s)
sleep 20

# AFTER restart: Check WAL survived
AFTER_KILL=$(kubectl exec -n sentinel-sovereign <pod> -c sentinel-sidecar -- wc -l /var/sentinel/wal.jsonl | awk '{print $1}')
echo "WAL entries after restart: $AFTER_KILL"

# INVARIANT: AFTER_KILL >= BEFORE_KILL
# If AFTER_KILL < BEFORE_KILL, the PVC mount is not durable. STOP.
if [ "$AFTER_KILL" -lt "$BEFORE_KILL" ]; then
  echo "❌ CRITICAL: WAL ENTRIES LOST. PVC IS NOT DURABLE."
  echo "   Lost entries: $((BEFORE_KILL - AFTER_KILL))"
  exit 1
fi
echo "✅ WAL survived kill -9. No entries lost."
```

---

## Phase 4: Post-Crucible Verification

### 4.1 WAL Integrity Audit

```bash
# Total ADMISSIBLE responses from k6
K6_ADMISSIBLE=$(cat crucible_results.json | jq '.results.admissible')

# Total WAL entries with verdict ADMISSIBLE
WAL_ADMISSIBLE=$(kubectl exec -n sentinel-sovereign <pod> -c sentinel-sidecar -- \
  grep -c '"verdict":"ADMISSIBLE"' /var/sentinel/wal.jsonl)

echo "k6 ADMISSIBLE count:  $K6_ADMISSIBLE"
echo "WAL ADMISSIBLE count: $WAL_ADMISSIBLE"

# INVARIANT: WAL_ADMISSIBLE == K6_ADMISSIBLE
if [ "$WAL_ADMISSIBLE" -ne "$K6_ADMISSIBLE" ]; then
  echo "❌ GHOST CODE DETECTED: $((K6_ADMISSIBLE - WAL_ADMISSIBLE)) executions have no audit record."
  exit 1
fi
echo "✅ 100% WAL integrity. Zero ghost code."
```

### 4.2 WAL Drain Verification

After k6 cool-down, the WAL replay workers must drain all pending entries to the Hub.

```bash
# Wait 60 seconds for WAL drain
sleep 60

# Check pending count (entries not yet synced to Hub)
PENDING=$(kubectl exec -n sentinel-sovereign <pod> -c sentinel-sidecar -- \
  grep -c '"synced":false' /var/sentinel/wal.jsonl 2>/dev/null || echo "0")

echo "WAL pending after drain: $PENDING"

if [ "$PENDING" -gt "0" ]; then
  echo "⚠️  WARNING: $PENDING entries still pending. Check Hub connectivity."
fi
```

### 4.3 PgBouncer Health

```bash
# Check for any connection pool exhaustion events
kubectl logs -n sentinel-sovereign <pod> -c pgbouncer | grep -i "closing because" | wc -l
# Expected: 0 (no forced closures)

kubectl logs -n sentinel-sovereign <pod> -c pgbouncer | grep -i "no more connections" | wc -l
# Expected: 0 (pool never exhausted)
```

---

## Board-Level Success Criteria

**DO NOT declare Release Candidate status unless ALL invariants hold:**

| # | Metric | Target | Failure State |
|---|--------|--------|---------------|
| 1 | Hot Path Latency (p95) | < 200µs | Sidecar memory lock contention or fsync blocking |
| 2 | Hot Path Latency (p99) | < 500µs | GC pauses or disk I/O stalls |
| 3 | WAL Durability | 0 Lost Entries | k6 ADMISSIBLE count MUST equal WAL line count after chaos kill |
| 4 | WAL Drain | 0 Pending (60s) | Hub is unreachable or replay workers are deadlocked |
| 5 | Error Rate | < 0.1% | Socket backpressure or PgBouncer rejection |
| 6 | Sidecar Memory | < 256Mi RSS | Unbounded goroutines or WAL buffer leak |
| 7 | Hub Database CPU | < 80% | PgBouncer misconfigured or query inefficiency |
| 8 | Circuit Breaker | Half-Open Recovery | If Hub API throttled, CB must open, limit, and recover |
| 9 | IOPS Throttle | None detected | PVC disk too small (increase to 500Gi+ or pd-extreme) |

---

## Failure Playbook

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| p95 spikes at minute 3 | IOPS burst depletion | Increase PVC to 500Gi or use pd-extreme |
| `connection refused` errors | PgBouncer max_client_conn too low | Set to 10000 |
| WAL entries lost after kill | PVC not mounted or fsync disabled | Verify `ValidateDurableMount` passes |
| OOM kill on sidecar | Unbounded goroutines in replayer | Verify worker pool cap = 100 |
| HTTP errors > 1% | Bridge proxy overloaded | Run bridge on same node as pod |
| Circuit breaker stuck OPEN | Recovery timeout too long | Reduce from 30s or check Hub health |
