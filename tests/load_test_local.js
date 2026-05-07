// ═══════════════════════════════════════════════════════════════
//  SENTINEL V5.5 — Local Crucible (WSL2 Scaled)
//  ═══════════════════════════════════════════════════════════════
//
//  Scaled-down load test for local WSL2 execution. Validates the
//  full arbitration pipeline without requiring production-grade
//  hardware. The full 5,000 VU Crucible runs on GKE.
//
//  Usage:
//    .\tests\k6.exe run tests\load_test_local.js
//
// ═══════════════════════════════════════════════════════════════

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

const BRIDGE_URL = __ENV.BRIDGE_URL || 'http://localhost:9090/arbitrate';
const TENANT_COUNT = 50;
const SKILLS_PER_TENANT = 20;

// ── METRICS ─────────────────────────────────────────────
const arbitrationLatency = new Trend('sentinel_latency_us', true);
const httpRoundtripUs    = new Trend('sentinel_http_us', true);
const admissibleCount    = new Counter('admissible_total');
const deniedCount        = new Counter('denied_total');
const walFailures        = new Counter('wal_failures');
const slaViolations      = new Counter('sla_violations');
const errorRate          = new Rate('error_rate');

// ── LOAD PROFILE (Local Crucible) ───────────────────────
export const options = {
  stages: [
    { duration: '10s', target: 50  },   // Warm-up
    { duration: '20s', target: 200 },   // Ramp
    { duration: '60s', target: 200 },   // Sustain
    { duration: '10s', target: 0   },   // Cool-down
  ],
  thresholds: {
    'sentinel_latency_us': [
      { threshold: 'p(95)<500',   abortOnFail: false },  // Relaxed for WSL2
      { threshold: 'p(99)<2000',  abortOnFail: false },
    ],
    'error_rate': [
      { threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '10s' },
    ],
    'wal_failures': [
      { threshold: 'count<1', abortOnFail: true },
    ],
    'http_req_failed': [
      { threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '10s' },
    ],
  },
};

// ── TENANT POOL ─────────────────────────────────────────
const tenants = [];
for (let i = 0; i < TENANT_COUNT; i++) {
  const tenantId = `tenant-${String(i).padStart(3, '0')}`;
  const skills = [];
  for (let j = 0; j < SKILLS_PER_TENANT; j++) {
    skills.push(`skill-${String(j).padStart(2, '0')}`);
  }
  tenants.push({ id: tenantId, skills });
}

// ── TEST FUNCTION ───────────────────────────────────────
export default function () {
  const tenant = tenants[Math.floor(Math.random() * tenants.length)];
  const skill  = tenant.skills[Math.floor(Math.random() * tenant.skills.length)];

  const payload = JSON.stringify({
    tenant_id: tenant.id,
    skill:     skill,
    resource:  `/governed/${tenant.id}/assets/image_${Date.now()}.png`,
  });

  const params = {
    headers: { 'Content-Type': 'application/json' },
    timeout: '5s',
  };

  const startMs = Date.now();
  const res = http.post(BRIDGE_URL, payload, params);
  const roundtripUs = (Date.now() - startMs) * 1000;

  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'has decision':  (r) => {
      try { return JSON.parse(r.body).decision !== undefined; }
      catch (e) { return false; }
    },
    'has audit_id':  (r) => {
      try { 
        let body = JSON.parse(r.body);
        return body.audit_id && body.audit_id.startsWith('sc_'); 
      }
      catch (e) { return false; }
    },
  });

  errorRate.add(!success);

  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);

      if (body.latency_us !== undefined) {
        arbitrationLatency.add(body.latency_us);
        if (body.latency_us > 177) slaViolations.add(1);
      }

      httpRoundtripUs.add(roundtripUs);

      if (body.decision === 'ADMISSIBLE') admissibleCount.add(1);
      else deniedCount.add(1);

      if (body.reason === 'AUDIT_INTEGRITY_FAILURE') walFailures.add(1);
    } catch (e) { /* parse error already counted */ }
  }

  sleep(0.01); // 10ms think time to prevent overwhelming WSL
}

// ── SUMMARY ─────────────────────────────────────────────
export function handleSummary(data) {
  const lat = data.metrics && data.metrics.sentinel_latency_us;
  const admissible = data.metrics && data.metrics.admissible_total && data.metrics.admissible_total.values ? data.metrics.admissible_total.values.count : 0;
  const denied = data.metrics && data.metrics.denied_total && data.metrics.denied_total.values ? data.metrics.denied_total.values.count : 0;
  const walf = data.metrics && data.metrics.wal_failures && data.metrics.wal_failures.values ? data.metrics.wal_failures.values.count : 0;
  const sla = data.metrics && data.metrics.sla_violations && data.metrics.sla_violations.values ? data.metrics.sla_violations.values.count : 0;
  const total = admissible + denied;

  console.log('\n═══════════════════════════════════════════════');
  console.log('  SENTINEL V5.5 — LOCAL CRUCIBLE RESULTS');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Total Requests:  ${total}`);
  console.log(`  Admissible:      ${admissible}`);
  console.log(`  Denied:          ${denied}`);
  console.log(`  WAL Failures:    ${walf}`);
  console.log(`  SLA Violations:  ${sla}`);
  console.log('───────────────────────────────────────────────');

  if (lat) {
    const p50 = lat.values && lat.values['p(50)'] ? lat.values['p(50)'] : 0;
    const p95 = lat.values && lat.values['p(95)'] ? lat.values['p(95)'] : 0;
    const p99 = lat.values && lat.values['p(99)'] ? lat.values['p(99)'] : 0;
    const max = lat.values && lat.values.max ? lat.values.max : 0;
    console.log(`  Sidecar p50:  ${p50.toFixed(0)}µs`);
    console.log(`  Sidecar p95:  ${p95.toFixed(0)}µs  ${p95 < 500 ? '✅' : '❌'}`);
    console.log(`  Sidecar p99:  ${p99.toFixed(0)}µs  ${p99 < 2000 ? '✅' : '❌'}`);
    console.log(`  Sidecar max:  ${max.toFixed(0)}µs`);
  }

  console.log('───────────────────────────────────────────────');

  const allPassed = Object.keys(data.metrics || {}).every(k => {
    const m = data.metrics[k];
    return !m.thresholds || Object.values(m.thresholds).every(t => t.ok);
  });

  console.log(`  VERDICT: ${allPassed ? '✅ CRUCIBLE PASSED' : '❌ CRUCIBLE FAILED'}`);
  console.log('═══════════════════════════════════════════════\n');

  return {};
}
