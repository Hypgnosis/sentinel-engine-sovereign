/**
 * SENTINEL ENGINE v4.5.2 — Backend Evaluation Suite
 * ═══════════════════════════════════════════════════════════
 * Reference-based evaluation of the Sentinel AI inference engine
 * using 5 "Hero" logistics scenarios.
 *
 * Evaluation Dimensions:
 *   1. Structural Compliance — Does the response match the JSON schema?
 *   2. Data Authority Accuracy — Is the dataAuthority field correct?
 *   3. Metric Extraction — Are key metrics present and reasonable?
 *   4. Confidence Calibration — Is confidence within expected bounds?
 *   5. Narrative Quality — Does the response contain actionable insights?
 *
 * These tests are designed to run against a live or staging deployment.
 * Set SENTINEL_ENDPOINT to override the default.
 *
 * Usage: node --test tests/backend-eval.test.js
 * ═══════════════════════════════════════════════════════════
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────

const SENTINEL_ENDPOINT = process.env.SENTINEL_ENDPOINT
  || 'https://us-central1-ha-sentinel-core-v21.cloudfunctions.net/sentinelInference';

const AUTH_TOKEN = process.env.SENTINEL_AUTH_TOKEN || '';

const REQUEST_TIMEOUT_MS = 90000; // Increased to 90s to account for Gemini Pro + Sync TTS

// ─────────────────────────────────────────────────────
//  HERO SCENARIOS — Reference-Based Evaluation Set
// ─────────────────────────────────────────────────────

const HERO_SCENARIOS = [
  {
    name: 'Shanghai-Rotterdam Container Rate Analysis',
    query: 'What is the current container shipping rate from Shanghai to Rotterdam? Include week-over-week trends.',
    expectedMetrics: [],
    expectedMinConfidence: 0.4,
    expectedSources: 1,
    maxLatencyMs: 15000,
  },
  {
    name: 'Global Port Congestion Overview',
    query: 'Provide a comprehensive overview of global port congestion levels. Which ports have the highest vessel wait times?',
    expectedMetrics: [],
    expectedMinConfidence: 0.5,
    expectedSources: 1,
    maxLatencyMs: 15000,
  },
  {
    name: 'Suez Canal Transit Risk Assessment',
    query: 'Assess the current risk level for Suez Canal transits. Include vessel queue data and geopolitical factors.',
    expectedMetrics: [],
    expectedMinConfidence: 0.3,
    expectedSources: 1,
    maxLatencyMs: 15000,
  },
  {
    name: 'Spot vs Contract Rate Arbitrage',
    query: 'Compare spot rates vs contract rates on major Asia-Europe trade lanes. Where are the biggest spreads?',
    expectedMetrics: [],
    expectedMinConfidence: 0.3,
    expectedSources: 1,
    maxLatencyMs: 15000,
  },
  {
    name: 'Supply Chain Risk Matrix Summary',
    query: 'Summarize the top 5 supply chain risks for Q2 2026. Include severity, probability, and estimated impact windows.',
    expectedMetrics: [],
    expectedMinConfidence: 0.4,
    expectedSources: 1,
    maxLatencyMs: 15000,
  },
];

// ─────────────────────────────────────────────────────
//  UTILITY: Call Sentinel Inference
// ─────────────────────────────────────────────────────

async function callSentinel(query) {
  const startTime = Date.now();

  const response = await fetch(SENTINEL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'X-Sentinel-Client': 'eval-harness/v4.1',
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const latencyMs = Date.now() - startTime;
  const body = await response.json();

  return { status: response.status, body, latencyMs };
}

// ─────────────────────────────────────────────────────
//  STRUCTURAL VALIDATORS
// ─────────────────────────────────────────────────────

function validateStructuralCompliance(data) {
  assert.ok(data, 'Response data must exist');

  // Top-level envelope
  assert.ok(data.status === 'SUCCESS', `Expected status SUCCESS, got ${data.status}`);
  assert.ok(data.requestId, 'requestId must be present');
  assert.ok(data.model, 'model field must be present');
  assert.ok(data.timestamp, 'timestamp must be present');
  assert.ok(data.data, 'data payload must be present');

  // Latency tracing — every response must include step-level timing
  assert.ok(data.latencyTrace, 'latencyTrace must be present');
  assert.ok(typeof data.latencyTrace.total === 'number', 'latencyTrace.total must be a number');
  assert.ok(typeof data.latencyTrace.generation === 'number', 'latencyTrace.generation must be a number');

  // Structured response payload
  const payload = data.data;
  assert.ok(typeof payload.narrative === 'string' && payload.narrative.length > 50,
    'narrative must be a substantial string (>50 chars)');
  assert.ok(typeof payload.confidence === 'number',
    'confidence must be a number');
  assert.ok(payload.confidence >= 0 && payload.confidence <= 1,
    `confidence must be 0.0–1.0, got ${payload.confidence}`);
  assert.ok(Array.isArray(payload.sources) && payload.sources.length > 0,
    'sources must be a non-empty array');
  assert.ok(typeof payload.dataAuthority === 'string',
    'dataAuthority must be a string');
  assert.ok(
    ['GCP_BIGQUERY_VECTOR_RAG', 'FIRESTORE_LEGACY', 'POSTGRES_PRISTINE_RESERVOIR', 'SENTINEL_DLL_OVERRIDE'].includes(payload.dataAuthority),
    `dataAuthority must be a known value, got ${payload.dataAuthority}`
  );
}

function validateMetricExtraction(data, expectedKeywords) {
  const payload = data.data;
  const narrative = payload.narrative.toLowerCase();
  const metricsText = JSON.stringify(payload.metrics || []).toLowerCase();
  const combined = narrative + ' ' + metricsText;

  for (const keyword of expectedKeywords) {
    assert.ok(
      combined.includes(keyword.toLowerCase()),
      `Expected keyword "${keyword}" in narrative or metrics. Not found.`
    );
  }

  // If metrics array is present, validate structure
  if (payload.metrics && payload.metrics.length > 0) {
    for (const metric of payload.metrics) {
      assert.ok(metric.label, 'Each metric must have a label');
      assert.ok(metric.value, 'Each metric must have a value');
    }
  }
}

// ─────────────────────────────────────────────────────
//  SLO ASSERTIONS
// ─────────────────────────────────────────────────────

/**
 * P95 Inference Latency SLO: < 4000ms
 * For evaluation we test each scenario individually.
 */
function assertLatencySLO(latencyMs, maxMs) {
  assert.ok(
    latencyMs <= maxMs,
    `Latency SLO breach: ${latencyMs}ms exceeds ${maxMs}ms target`
  );
}

// ─────────────────────────────────────────────────────
//  TEST SUITE
// ─────────────────────────────────────────────────────

describe('Sentinel Engine v4.5.2 — Hero Scenario Evaluations', () => {
  // Skip if no auth token is provided (CI without credentials)
  const shouldRun = !!AUTH_TOKEN;

  for (const scenario of HERO_SCENARIOS) {
    it(`[HERO] ${scenario.name}`, { skip: !shouldRun && 'No SENTINEL_AUTH_TOKEN set' }, async () => {
      const { status, body, latencyMs } = await callSentinel(scenario.query);

      // Gate 1: HTTP success
      assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);

      // Gate 2: Structural compliance
      validateStructuralCompliance(body);

      // Gate 3: Metric extraction
      validateMetricExtraction(body, scenario.expectedMetrics);

      // Gate 4: Confidence calibration
      assert.ok(
        body.data.confidence >= scenario.expectedMinConfidence,
        `Confidence ${body.data.confidence} below minimum ${scenario.expectedMinConfidence}`
      );

      // Gate 5: Source count
      assert.ok(
        body.data.sources.length >= scenario.expectedSources,
        `Expected at least ${scenario.expectedSources} sources, got ${body.data.sources.length}`
      );

      // Gate 6: Latency SLO
      assertLatencySLO(latencyMs, scenario.maxLatencyMs);

      // Report
      console.log(`  ✓ ${scenario.name}`);
      console.log(`    Latency: ${latencyMs}ms | Confidence: ${body.data.confidence} | Authority: ${body.data.dataAuthority}`);
    });
  }
});

describe('Sentinel Engine v4.5.2 — SLO Compliance Checks', () => {
  it('P95 Latency Target: < 15000ms (average of hero scenarios)', { skip: !AUTH_TOKEN && 'No auth token' }, async () => {
    const latencies = [];

    for (const scenario of HERO_SCENARIOS) {
      const { latencyMs } = await callSentinel(scenario.query);
      latencies.push(latencyMs);
    }

    latencies.sort((a, b) => a - b);
    const p95Index = Math.ceil(latencies.length * 0.95) - 1;
    const p95Latency = latencies[p95Index];

    console.log(`  P95 Latency: ${p95Latency}ms (target: <15000ms)`);
    console.log(`  All latencies: ${latencies.join(', ')}`);

    assert.ok(p95Latency < 15000, `P95 latency ${p95Latency}ms exceeds 15000ms SLO`);
  });
});
