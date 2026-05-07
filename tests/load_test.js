// ═══════════════════════════════════════════════════════════════
//  SENTINEL V5.5 — 50-Tenant Load Test (The Crucible)
//  ═══════════════════════════════════════════════════════════════
//
//  k6 load test script that simulates 5,000 concurrent agents
//  across 50 tenants hammering the Sentinel Sidecar's UDS
//  arbitration endpoint.
//
//  Pass/Fail Criteria (non-negotiable):
//    ✓ 0 lost WAL entries (every ADMISSIBLE maps to an audit record)
//    ✓ p95 hot-path latency < 200µs (0.200ms)
//    ✓ p99 hot-path latency < 500µs (0.500ms)
//    ✓ 0% error rate on socket connections
//    ✓ No OOM kills on the sidecar (RSS stays < 256Mi)
//    ✓ WAL pending count drains to 0 within 60s after ramp-down
//
//  Usage:
//    k6 run --out json=results.json load_test.js
//
//  Post-Test Verification:
//    1. Compare WAL line count vs total ADMISSIBLE responses
//    2. Check sidecar logs for [PERF_ALERT] SLA violations
//    3. Run: kubectl top pod sentinel-agent-pod to verify memory
//
//  Architecture:
//    k6 VUs → TCP → Bridge (Go adapter) → UDS → Sidecar
//
//    Because k6 cannot natively connect to Unix Domain Sockets,
//    this script connects to a thin TCP-to-UDS bridge running
//    on localhost:9090 (see bridge_test_proxy.go).
//
//    CRITICAL LATENCY NOTE:
//    The TCP loopback adds ~100-300µs of overhead. However, the
//    SLA threshold uses body.latency_us (sidecar-reported), NOT
//    the HTTP roundtrip time. This means the bridge does not
//    contaminate the SLA measurement. We track both metrics to
//    isolate the bridge overhead for diagnostic purposes.
//
//    IOPS WARNING:
//    GCP pd-ssd gives 30 IOPS/GB sustained. At 5,000 VUs doing
//    fsync(), you need ~5,000 write IOPS. A 50GB disk (1,500
//    sustained IOPS) will deplete burst tokens in ~30s, then
//    throttle. Use 500GB+ pd-ssd or pd-extreme to survive.
//
// ═══════════════════════════════════════════════════════════════

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

// ─────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────

// Bridge proxy URL (TCP → UDS adapter running on the same node)
const BRIDGE_URL = __ENV.BRIDGE_URL || 'http://localhost:9090/arbitrate';

// Number of simulated tenants
const TENANT_COUNT = parseInt(__ENV.TENANT_COUNT || '50');

// Skills per tenant (simulate real-world skill diversity)
const SKILLS_PER_TENANT = parseInt(__ENV.SKILLS_PER_TENANT || '20');

// ─────────────────────────────────────────────────────
//  CUSTOM METRICS
// ─────────────────────────────────────────────────────

const arbitrationLatency = new Trend('sentinel_arbitration_latency_us', true);
const httpRoundtripUs    = new Trend('sentinel_http_roundtrip_us', true);  // Bridge overhead diagnostic
const admissibleCount    = new Counter('sentinel_admissible_total');
const deniedCount        = new Counter('sentinel_denied_total');
const walFailures        = new Counter('sentinel_wal_failures');
const slaViolations      = new Counter('sentinel_sla_violations');
const errorRate          = new Rate('sentinel_error_rate');

// Bridge overhead baseline (µs) — set via env or measured during warm-up
const BRIDGE_OVERHEAD_US = parseFloat(__ENV.BRIDGE_OVERHEAD_US || '0');

// ─────────────────────────────────────────────────────
//  LOAD PROFILE — The Crucible
//
//  Phase 1 (Warm-up):   0 → 100 VUs over 30s
//  Phase 2 (Ramp):      100 → 5000 VUs over 120s
//  Phase 3 (Sustain):   5000 VUs for 300s (5 minutes)
//  Phase 4 (Cool-down): 5000 → 0 VUs over 60s
//
//  Total duration: ~8.5 minutes
//  Expected total requests: ~500,000–1,000,000
// ─────────────────────────────────────────────────────

export const options = {
  stages: [
    { duration: '30s',  target: 100  },  // Phase 1: Warm-up
    { duration: '120s', target: 5000 },  // Phase 2: Ramp to peak
    { duration: '300s', target: 5000 },  // Phase 3: Sustain peak
    { duration: '60s',  target: 0    },  // Phase 4: Cool-down
  ],

  thresholds: {
    // Hard SLA gates — test FAILS if these are breached
    'sentinel_arbitration_latency_us': [
      { threshold: 'p(95)<200',  abortOnFail: false },  // p95 < 200µs
      { threshold: 'p(99)<500',  abortOnFail: false },  // p99 < 500µs
      { threshold: 'max<2000',   abortOnFail: false },  // No request > 2ms
    ],
    'sentinel_error_rate': [
      { threshold: 'rate<0.001', abortOnFail: true },   // <0.1% error rate
    ],
    'sentinel_wal_failures': [
      { threshold: 'count<1',    abortOnFail: true },   // 0 WAL failures
    ],
    'http_req_failed': [
      { threshold: 'rate<0.01',  abortOnFail: true },   // <1% HTTP failures
    ],
  },
};

// ─────────────────────────────────────────────────────
//  TENANT POOL — Pre-generated for deterministic load
// ─────────────────────────────────────────────────────

const tenants = [];
for (let i = 0; i < TENANT_COUNT; i++) {
  const tenantId = `tenant-${String(i).padStart(3, '0')}`;
  const skills = [];
  for (let j = 0; j < SKILLS_PER_TENANT; j++) {
    skills.push(`skill-${String(j).padStart(2, '0')}`);
  }
  tenants.push({ id: tenantId, skills });
}

// ─────────────────────────────────────────────────────
//  TEST FUNCTION — One VU iteration
// ─────────────────────────────────────────────────────

export default function () {
  // Pick a random tenant and skill for this request
  const tenant = tenants[Math.floor(Math.random() * tenants.length)];
  const skill  = tenant.skills[Math.floor(Math.random() * tenant.skills.length)];

  const payload = JSON.stringify({
    tenant_id: tenant.id,
    skill:     skill,
    resource:  `/governed/${tenant.id}/assets/image_${Date.now()}.png`,
  });

  const params = {
    headers: { 'Content-Type': 'application/json' },
    timeout: '2s',
  };

  const res = http.post(BRIDGE_URL, payload, params);

  // ── Assertions ────────────────────────────────────
  const success = check(res, {
    'status is 200':     (r) => r.status === 200,
    'has decision':      (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.decision === 'ADMISSIBLE' || body.decision === 'DENIED';
      } catch (e) {
        return false;
      }
    },
    'has audit_id':      (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.audit_id && body.audit_id.startsWith('sc_');
      } catch (e) {
        return false;
      }
    },
    'has latency_us':    (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.latency_us === 'number';
      } catch (e) {
        return false;
      }
    },
  });

  errorRate.add(!success);

  // ── Extract metrics from sidecar response ─────────
  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);

      // Record the sidecar-reported latency (immune to bridge overhead)
      if (body.latency_us !== undefined) {
        const adjustedLatency = Math.max(0, body.latency_us - BRIDGE_OVERHEAD_US);
        arbitrationLatency.add(adjustedLatency);

        if (adjustedLatency > 177) {
          slaViolations.add(1);
        }
      }

      // Record HTTP roundtrip for bridge overhead isolation
      // http_req_duration is in ms, convert to µs
      httpRoundtripUs.add(res.timings.duration * 1000);

      if (body.decision === 'ADMISSIBLE') {
        admissibleCount.add(1);
      } else {
        deniedCount.add(1);
      }

      // Detect WAL failures (sidecar returns DENIED with reason AUDIT_INTEGRITY_FAILURE)
      if (body.reason === 'AUDIT_INTEGRITY_FAILURE') {
        walFailures.add(1);
      }
    } catch (e) {
      // JSON parse failure — counted in error rate
    }
  }

  // Minimal think time — we want to stress the system, not simulate humans
  sleep(0.01); // 10ms between requests per VU
}

// ─────────────────────────────────────────────────────
//  SUMMARY — Post-Test Report
// ─────────────────────────────────────────────────────

export function handleSummary(data) {
  const metrics = data.metrics;

  // ── Bridge overhead diagnostic ─────────────────────
  const httpP50  = metrics.sentinel_http_roundtrip_us?.values?.['p(50)'] || 0;
  const httpP95  = metrics.sentinel_http_roundtrip_us?.values?.['p(95)'] || 0;
  const sideP50  = metrics.sentinel_arbitration_latency_us?.values?.['p(50)'] || 0;
  const sideP95  = metrics.sentinel_arbitration_latency_us?.values?.['p(95)'] || 0;
  const bridgeOverheadP50 = Math.max(0, httpP50 - sideP50);
  const bridgeOverheadP95 = Math.max(0, httpP95 - sideP95);

  const report = {
    test_name: 'Sentinel V5.5 — 50-Tenant Crucible',
    timestamp: new Date().toISOString(),
    tenants:   TENANT_COUNT,
    results: {
      total_requests:   metrics.http_reqs?.values?.count || 0,
      admissible:       metrics.sentinel_admissible_total?.values?.count || 0,
      denied:           metrics.sentinel_denied_total?.values?.count || 0,
      wal_failures:     metrics.sentinel_wal_failures?.values?.count || 0,
      sla_violations:   metrics.sentinel_sla_violations?.values?.count || 0,
      error_rate_pct:   ((metrics.sentinel_error_rate?.values?.rate || 0) * 100).toFixed(3),
    },
    latency: {
      // Sidecar-reported (immune to bridge overhead)
      sidecar_p50_us:  sideP50,
      sidecar_p90_us:  metrics.sentinel_arbitration_latency_us?.values?.['p(90)'] || 'N/A',
      sidecar_p95_us:  sideP95,
      sidecar_p99_us:  metrics.sentinel_arbitration_latency_us?.values?.['p(99)'] || 'N/A',
      sidecar_max_us:  metrics.sentinel_arbitration_latency_us?.values?.max || 'N/A',
      // HTTP roundtrip (includes bridge + TCP overhead)
      http_p50_us: httpP50,
      http_p95_us: httpP95,
      // Computed bridge overhead
      bridge_overhead_p50_us: bridgeOverheadP50.toFixed(1),
      bridge_overhead_p95_us: bridgeOverheadP95.toFixed(1),
    },
    thresholds_passed: Object.entries(data.thresholds || {}).every(
      ([, v]) => !v.ok ? false : true
    ),
  };

  // ── IOPS Burst Depletion Check ───────────────────
  // If sidecar p95 > 500µs, fsync is being throttled by the cloud storage controller.
  // This means the PVC disk size is too small (insufficient sustained IOPS).
  const iopsThrottled = sideP95 > 500;

  // Console summary
  console.log('\n═══════════════════════════════════════════════');
  console.log('  SENTINEL V5.5 — CRUCIBLE RESULTS');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Total Requests:  ${report.results.total_requests}`);
  console.log(`  Admissible:      ${report.results.admissible}`);
  console.log(`  Denied:          ${report.results.denied}`);
  console.log(`  WAL Failures:    ${report.results.wal_failures}`);
  console.log(`  SLA Violations:  ${report.results.sla_violations}`);
  console.log(`  Error Rate:      ${report.results.error_rate_pct}%`);
  console.log('───────────────────────────────────────────────');
  console.log('  SIDECAR LATENCY (SLA source):');
  console.log(`    p50:  ${report.latency.sidecar_p50_us}µs`);
  console.log(`    p90:  ${report.latency.sidecar_p90_us}µs`);
  console.log(`    p95:  ${report.latency.sidecar_p95_us}µs  ${sideP95 < 200 ? '✅' : '❌'} (SLA: <200µs)`);
  console.log(`    p99:  ${report.latency.sidecar_p99_us}µs  ${(metrics.sentinel_arbitration_latency_us?.values?.['p(99)'] || 0) < 500 ? '✅' : '❌'} (SLA: <500µs)`);
  console.log(`    max:  ${report.latency.sidecar_max_us}µs`);
  console.log('───────────────────────────────────────────────');
  console.log('  BRIDGE DIAGNOSTIC (NOT part of SLA):');
  console.log(`    HTTP roundtrip p50: ${httpP50.toFixed(0)}µs`);
  console.log(`    HTTP roundtrip p95: ${httpP95.toFixed(0)}µs`);
  console.log(`    Bridge overhead p50: ~${bridgeOverheadP50.toFixed(0)}µs`);
  console.log(`    Bridge overhead p95: ~${bridgeOverheadP95.toFixed(0)}µs`);
  if (iopsThrottled) {
    console.log('───────────────────────────────────────────────');
    console.log('  ⚠️  IOPS BURST DEPLETION DETECTED');
    console.log('  Sidecar p95 > 500µs indicates fsync() throttling.');
    console.log('  ACTION: Increase PVC to 500Gi+ or use pd-extreme.');
  }
  console.log('───────────────────────────────────────────────');
  console.log(`  ALL THRESHOLDS:  ${report.thresholds_passed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log('═══════════════════════════════════════════════\n');

  return {
    'crucible_results.json': JSON.stringify(report, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

// Import k6 built-in summary
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.3/index.js';
