/**
 * SENTINEL ENGINE V4.9-RC — SWR Cache (Stale-While-Revalidate)
 * ═══════════════════════════════════════════════════════════════
 * Redis-backed resilience layer for the "2 AM Failure" scenario.
 *
 * Uses Upstash Redis (serverless) via REDIS_URL env var.
 * Implements dynamic TTLs based on query category and a
 * circuit breaker that serves stale cache when Postgres is down.
 *
 * TTL Matrix:
 *   Mission-Critical (chokepoints, security)  → 300s  (5 min)
 *   Operational (ports, traffic, berths)       → 3600s (60 min)
 *   Static (contracts, rates, tariffs)         → 86400s (24 hr)
 * ═══════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────
//  UPSTASH REDIS CLIENT (REST API)
//  Works in any serverless environment without TCP sockets.
// ─────────────────────────────────────────────────────

let _redisAvailable = null; // null = unknown, true/false = tested
let _redisUrl = null;
let _redisToken = null;

function initRedis() {
  _redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
  _redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || null;

  if (!_redisUrl) {
    console.warn('[SWR_CACHE] No REDIS_URL configured. Cache layer DISABLED.');
    _redisAvailable = false;
    return false;
  }

  _redisAvailable = true;
  console.log('[SWR_CACHE] Redis configured via REST endpoint.');
  return true;
}

/**
 * Upstash REST API command executor.
 * @param {string[]} command - Redis command as array (e.g. ['GET', 'key'])
 * @returns {Promise<any>} Redis response
 */
async function redisCommand(command) {
  if (!_redisAvailable) return null;
  if (!_redisUrl) initRedis();
  if (!_redisAvailable) return null;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (_redisToken) headers['Authorization'] = `Bearer ${_redisToken}`;

    const response = await fetch(_redisUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      console.warn(`[SWR_CACHE] Redis HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data.result !== undefined ? data.result : null;
  } catch (err) {
    console.warn('[SWR_CACHE] Redis command failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────
//  DYNAMIC TTL CLASSIFICATION
// ─────────────────────────────────────────────────────

const TTL_RULES = [
  {
    category: 'MISSION_CRITICAL',
    ttl: 300,      // 5 minutes
    patterns: [
      'chokepoint', 'suez', 'panama', 'hormuz', 'malacca', 'bosphorus',
      'security', 'piracy', 'sanction', 'embargo', 'threat', 'kill switch',
      'revocation', 'critical', 'emergency',
    ],
  },
  {
    category: 'OPERATIONAL',
    ttl: 3600,     // 60 minutes
    patterns: [
      'port', 'berth', 'traffic', 'vessel', 'anchor', 'congestion',
      'queue', 'wait', 'transit', 'delay', 'AIS', 'vessel_risk',
      'turnaround', 'capacity', 'schedule',
    ],
  },
  {
    category: 'STATIC',
    ttl: 86400,    // 24 hours
    patterns: [
      'contract', 'rate', 'tariff', 'agreement', 'baseline', 'benchmark',
      'historical', 'trend', 'index', 'FBX', 'BDI', 'long-term',
      'policy', 'regulation', 'compliance',
    ],
  },
];

/**
 * Classifies a query into a TTL category.
 * @param {string} query - User query text
 * @returns {{ category: string, ttl: number }}
 */
function classifyQueryTTL(query) {
  const q = query.toLowerCase();

  for (const rule of TTL_RULES) {
    if (rule.patterns.some(p => q.includes(p))) {
      return { category: rule.category, ttl: rule.ttl };
    }
  }

  // Default: Operational (60 min)
  return { category: 'OPERATIONAL', ttl: 3600 };
}

/**
 * Generates a deterministic cache key.
 * @param {string} tenantId
 * @param {string} query
 * @returns {string}
 */
function cacheKey(tenantId, query) {
  const hash = crypto.createHash('sha256').update(query.toLowerCase().trim()).digest('hex').substring(0, 16);
  return `sentinel:${tenantId}:${hash}`;
}

// ─────────────────────────────────────────────────────
//  CIRCUIT BREAKER
// ─────────────────────────────────────────────────────

const circuitBreaker = {
  failures: 0,
  threshold: 3,
  state: 'CLOSED',    // CLOSED | OPEN | HALF_OPEN
  lastFailure: 0,
  resetTimeout: 60000, // 60s auto-reset

  /**
   * Record a successful database operation.
   */
  recordSuccess() {
    if (this.state === 'HALF_OPEN') {
      console.log('[CIRCUIT_BREAKER] Probe succeeded — closing circuit.');
    }
    this.failures = 0;
    this.state = 'CLOSED';
  },

  /**
   * Record a failed database operation.
   */
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
      console.error(`[CIRCUIT_BREAKER] OPEN — ${this.failures} consecutive failures. Serving cache only.`);
    } else {
      console.warn(`[CIRCUIT_BREAKER] Failure ${this.failures}/${this.threshold}.`);
    }
  },

  /**
   * Check if the circuit allows a database call.
   * @returns {boolean} True if allowed
   */
  allowRequest() {
    if (this.state === 'CLOSED') return true;

    // Auto-reset after timeout: allow one probe request
    if (this.state === 'OPEN' && Date.now() - this.lastFailure > this.resetTimeout) {
      this.state = 'HALF_OPEN';
      console.log('[CIRCUIT_BREAKER] HALF_OPEN — allowing probe request.');
      return true;
    }

    return this.state === 'HALF_OPEN';
  },

  /**
   * Check if we're in resilience mode (circuit is open).
   * @returns {boolean}
   */
  isOpen() {
    return this.state === 'OPEN';
  },
};

// ─────────────────────────────────────────────────────
//  SWR CACHE OPERATIONS
// ─────────────────────────────────────────────────────

/**
 * Attempt to retrieve a cached response.
 * Returns the cached data + metadata, or null if miss.
 *
 * @param {string} tenantId
 * @param {string} query
 * @returns {Promise<{data: object, meta: {category: string, cachedAt: string, isStale: boolean}}|null>}
 */
async function getCached(tenantId, query) {
  const key = cacheKey(tenantId, query);

  try {
    const raw = await redisCommand(['GET', key]);
    if (!raw) return null;

    const cached = JSON.parse(raw);
    const age = Date.now() - cached._cachedAt;
    const { ttl } = classifyQueryTTL(query);
    const isStale = age > ttl * 1000;

    console.log(`[SWR_CACHE] HIT key=${key} age=${Math.round(age / 1000)}s ttl=${ttl}s stale=${isStale}`);

    if (isStale && module.exports.circuitBreaker && module.exports.circuitBreaker.isOpen()) {
      if (cached.data && cached.data.narrative) {
        cached.data.narrative += "\n\n**ADVISORY: Serving cached intelligence. Live verification currently unavailable due to reservoir connectivity.**";
      }
    }

    return {
      data: cached.data,
      meta: {
        category: cached._category,
        cachedAt: new Date(cached._cachedAt).toISOString(),
        isStale,
        ageSeconds: Math.round(age / 1000),
      },
    };
  } catch (err) {
    console.warn('[SWR_CACHE] GET error:', err.message);
    return null;
  }
}

/**
 * Store a response in the cache with dynamic TTL.
 *
 * @param {string} tenantId
 * @param {string} query
 * @param {object} data - Response data to cache
 * @returns {Promise<void>}
 */
async function setCached(tenantId, query, data) {
  const key = cacheKey(tenantId, query);
  const { category, ttl } = classifyQueryTTL(query);

  const envelope = {
    data,
    _cachedAt: Date.now(),
    _category: category,
    _ttl: ttl,
  };

  try {
    // Grace period: 2x TTL so stale data survives for SWR
    const graceTTL = ttl * 2;
    await redisCommand(['SET', key, JSON.stringify(envelope), 'EX', graceTTL]);
    console.log(`[SWR_CACHE] SET key=${key} category=${category} ttl=${ttl}s grace=${graceTTL}s`);
  } catch (err) {
    console.warn('[SWR_CACHE] SET error:', err.message);
  }
}

/**
 * SWR wrapper for the inference pipeline.
 * Checks cache, serves stale if circuit is open, caches fresh responses.
 *
 * @param {string} tenantId
 * @param {string} query
 * @param {Function} freshDataFn - Async function that produces fresh data
 * @returns {Promise<{data: object, cacheStatus: string, isResilienceMode: boolean}>}
 */
async function swrFetch(tenantId, query, freshDataFn) {
  // Initialize Redis on first call
  if (_redisAvailable === null) initRedis();

  // 1. Check cache first
  const cached = await getCached(tenantId, query);

  // 2. If circuit breaker is OPEN, serve cache (stale or fresh)
  if (circuitBreaker.isOpen()) {
    if (cached) {
      console.warn('[SWR_CACHE] Circuit OPEN — serving stale cache.');
      return {
        data: cached.data,
        cacheStatus: 'STALE_CIRCUIT_OPEN',
        isResilienceMode: true,
      };
    }
    // No cache and circuit open — we have to try anyway
    console.warn('[SWR_CACHE] Circuit OPEN and NO cache — forcing probe.');
  }

  // 3. If fresh cache hit, return immediately
  if (cached && !cached.meta.isStale) {
    return {
      data: cached.data,
      cacheStatus: 'FRESH_HIT',
      isResilienceMode: false,
    };
  }

  // 4. If stale cache exists, serve it and revalidate in background
  if (cached && cached.meta.isStale && circuitBreaker.allowRequest()) {
    // Background revalidation (fire-and-forget)
    freshDataFn()
      .then(freshData => {
        circuitBreaker.recordSuccess();
        setCached(tenantId, query, freshData);
      })
      .catch(err => {
        circuitBreaker.recordFailure();
        console.warn('[SWR_CACHE] Background revalidation failed:', err.message);
      });

    return {
      data: cached.data,
      cacheStatus: 'STALE_REVALIDATING',
      isResilienceMode: false,
    };
  }

  // 5. No cache or cache expired beyond grace — fetch fresh
  if (circuitBreaker.allowRequest()) {
    try {
      const freshData = await freshDataFn();
      circuitBreaker.recordSuccess();
      await setCached(tenantId, query, freshData);

      return {
        data: freshData,
        cacheStatus: 'MISS_FETCHED',
        isResilienceMode: false,
      };
    } catch (err) {
      circuitBreaker.recordFailure();

      // If we have stale cache, serve it
      if (cached) {
        console.warn('[SWR_CACHE] Fresh fetch failed — serving stale cache.');
        return {
          data: cached.data,
          cacheStatus: 'STALE_FALLBACK',
          isResilienceMode: true,
        };
      }

      throw err; // No cache to fall back on
    }
  }

  // 2AM FAILSAFE: Circuit is OPEN and zero cache exists.
  // Return a structured advisory instead of a hard crash so the
  // inference handler can emit a clean 504 with actionable context.
  console.error('[SWR_CACHE] CIRCUIT_OPEN + NO_CACHE — emitting Resilience Advisory.');
  return {
    data: {
      _resilienceAdvisory: true,
      status: 504,
      error: 'GATEWAY_TIMEOUT',
      message: 'All data tiers are unreachable and no cached response is available. ' +
               'The circuit breaker is open. Retry after 60 seconds.',
      retryAfterSeconds: 60,
      circuitState: circuitBreaker.state,
    },
    cacheStatus: 'CIRCUIT_OPEN_NO_CACHE',
    isResilienceMode: true,
  };
}

module.exports = {
  // Core SWR
  swrFetch,
  getCached,
  setCached,
  // TTL
  classifyQueryTTL,
  cacheKey,
  TTL_RULES,
  // Circuit Breaker
  circuitBreaker,
  // Init
  initRedis,
};
