/**
 * SENTINEL ENGINE V5.5 — Sovereign Proxy (Shard-Aware API Gateway)
 * ═══════════════════════════════════════════════════════════════════
 * The SOLE entry point for all agent-to-kernel communication.
 * Never call the Arbiter Kernel directly — all traffic flows
 * through POST /v1/arbitrate.
 *
 * Responsibilities:
 *   1. Tenant Resolution → Shard Routing (via shard_map)
 *   2. Skill Admissibility Check (via project_skill_graph)
 *   3. Rate Limiting (per-tenant, tier-aware)
 *   4. Audit Logging (append-only Sovereign_audit_log)
 *   5. Payload Fingerprinting (SHA-256, never stores raw payloads)
 *
 * V5.5 Hardening (Sovereign Sprint):
 *   - ShardConnectionPool: Persistent pool-per-shard (prevents max_connections exhaustion)
 *   - DSN Decryption Cache: 60s in-memory TTL (eliminates KMS round-trips on hot path)
 *   - Circuit Breaker: Shard resolution resilience (prevents cascading failures)
 *   - Blocking Audit: Tier 1 evidence writes are synchronous (non-repudiable)
 *
 * Architecture:
 *   Agent → Sovereign Proxy → Shard Router → Arbiter Kernel → Spoke DB
 *
 * @module Sovereign-proxy
 * @version 5.5.0-Sovereign
 * ═══════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const postgres = require('postgres');
const { decryptWithMasterKey } = require('./security-utils');

// ─────────────────────────────────────────────────────
//  SHARD CONNECTION POOL — Persistent Pool-Per-Shard
//  Prevents max_connections exhaustion under load.
//  Each unique shard DSN gets ONE reusable postgres pool.
// ─────────────────────────────────────────────────────

class ShardConnectionPool {
  /** @type {Map<string, import('postgres').Sql>} DSN hash → live pool */
  #pools = new Map();
  #maxPoolSize = 10;
  #idleTimeout = 30;

  /**
   * Get or create a persistent connection pool for a shard DSN.
   * @param {string} decryptedDsn - Plaintext DATABASE_URL
   * @returns {import('postgres').Sql}
   */
  acquire(decryptedDsn) {
    const key = crypto.createHash('sha256').update(decryptedDsn).digest('hex').slice(0, 16);

    if (this.#pools.has(key)) return this.#pools.get(key);

    const isUnix = decryptedDsn.includes('/cloudsql/');
    const pool = postgres(decryptedDsn, {
      max: this.#maxPoolSize,
      idle_timeout: this.#idleTimeout,
      connect_timeout: 5,
      max_lifetime: 1800,
      ssl: isUnix ? false : 'require',
    });

    this.#pools.set(key, pool);
    console.log(`[SHARD_POOL] Created pool for shard (key=${key}). Active pools: ${this.#pools.size}`);
    return pool;
  }

  /**
   * Gracefully close all shard pools (for shutdown).
   */
  async drainAll() {
    for (const [key, pool] of this.#pools) {
      try { await pool.end({ timeout: 5 }); } catch { /* best-effort */ }
      this.#pools.delete(key);
    }
    console.log('[SHARD_POOL] All pools drained.');
  }

  get activePoolCount() { return this.#pools.size; }
}


// ─────────────────────────────────────────────────────
//  DSN DECRYPTION CACHE — 60s In-Memory TTL
//  Eliminates KMS/SecretManager round-trips on hot path.
// ─────────────────────────────────────────────────────

class DsnDecryptionCache {
  /** @type {Map<string, {dsn: string, cachedAt: number}>} */
  #cache = new Map();
  #ttlMs = 60_000; // 60 seconds

  get(tenantId) {
    const entry = this.#cache.get(tenantId);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.#ttlMs) {
      this.#cache.delete(tenantId);
      return null;
    }
    return entry.dsn;
  }

  set(tenantId, dsn) {
    this.#cache.set(tenantId, { dsn, cachedAt: Date.now() });
  }

  invalidate(tenantId) { this.#cache.delete(tenantId); }
  flush() { this.#cache.clear(); }
}


// ─────────────────────────────────────────────────────
//  SHARD CIRCUIT BREAKER — Prevents Cascading Failures
//  Separate from the SWR inference circuit breaker.
// ─────────────────────────────────────────────────────

class ShardCircuitBreaker {
  #failures = 0;
  #threshold = 3;
  #state = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
  #lastFailure = 0;
  #resetMs = 30_000; // 30s — shorter than inference CB (shard issues resolve faster)

  recordSuccess() {
    this.#failures = 0;
    this.#state = 'CLOSED';
  }

  recordFailure() {
    this.#failures++;
    this.#lastFailure = Date.now();
    if (this.#failures >= this.#threshold) {
      this.#state = 'OPEN';
      console.error(`[SHARD_CB] OPEN — ${this.#failures} consecutive shard resolution failures.`);
    }
  }

  allowRequest() {
    if (this.#state === 'CLOSED') return true;
    if (this.#state === 'OPEN' && Date.now() - this.#lastFailure > this.#resetMs) {
      this.#state = 'HALF_OPEN';
      return true;
    }
    return this.#state === 'HALF_OPEN';
  }

  get isOpen() { return this.#state === 'OPEN'; }
  get state() { return this.#state; }
}


// ─────────────────────────────────────────────────────
//  SHARD ROUTER — Resolves tenant → physical database
// ─────────────────────────────────────────────────────

class ShardRouter {
  /** @type {Map<string, object>} */
  #shardCache = new Map();
  
  /** @type {number} Cache TTL in ms (60 seconds — prevents registry contention during rotation) */
  #cacheTTL = 60_000;

  /**
   * Resolve a tenant_id to its shard configuration.
   * Queries shard_map in the Governance Hub.
   *
   * @param {import('postgres').Sql} hubSql - Governance Hub DB connection
   * @param {string} tenantId
   * @returns {Promise<{projectId: string, tier: number, isolationLevel: string, shardDsn: string, shardInstanceId: string, shardSchema: string, storagePath: string, status: string}>}
   * @throws {ShardResolutionError} If tenant is not found or shard is unavailable
   */
  async resolve(hubSql, tenantId) {
    // Check cache first
    const cached = this.#shardCache.get(tenantId);
    if (cached && (Date.now() - cached._cachedAt) < this.#cacheTTL) {
      return cached;
    }

    const [shard] = await hubSql`
      SELECT 
        project_id,
        database_tier,
        isolation_level,
        shard_dsn,
        shard_instance_id,
        shard_schema,
        storage_path,
        status,
        max_queries_per_minute,
        crypto_tier
      FROM shard_map
      WHERE tenant_id = ${tenantId}
        AND status = 'ACTIVE'
    `;

    if (!shard) {
      throw new ShardResolutionError(
        'SHARD_NOT_FOUND',
        `No active shard mapping for tenant_id: ${tenantId}. ` +
        `Provision via: node scripts/provision_shard.js "${tenantId}"`,
        404
      );
    }

    const resolved = {
      projectId: shard.project_id,
      tier: shard.database_tier,
      isolationLevel: shard.isolation_level,
      shardDsn: shard.shard_dsn,        // NOTE: This is AES-256-GCM ciphertext.
      shardInstanceId: shard.shard_instance_id,
      shardSchema: shard.shard_schema,
      storagePath: shard.storage_path,
      maxQueriesPerMinute: shard.max_queries_per_minute,
      cryptoTier: shard.crypto_tier || 'ECDSA_P256',
      status: shard.status,
      _cachedAt: Date.now(),
    };

    this.#shardCache.set(tenantId, resolved);
    return resolved;
  }

  /**
   * Resolve and DECRYPT the shard DSN for actual database connection.
   * Uses DsnDecryptionCache (60s TTL) to avoid KMS round-trips.
   * This is the ONLY method that should be used to obtain a usable DSN.
   *
   * @param {import('postgres').Sql} hubSql
   * @param {string} tenantId
   * @param {import('./security-manager').SecurityManager} securityManager
   * @param {DsnDecryptionCache} dsnCache
   * @returns {Promise<{...shardConfig, decryptedDsn: string}>}
   */
  async resolveWithDecryptedDsn(hubSql, tenantId, securityManager, dsnCache) {
    const shardConfig = await this.resolve(hubSql, tenantId);

    if (!shardConfig.shardDsn) {
      // Tier 3 tenants use the Hub DB with RLS — no dedicated DSN
      return { ...shardConfig, decryptedDsn: null };
    }

    // Check decryption cache first (60s TTL)
    const cached = dsnCache ? dsnCache.get(tenantId) : null;
    if (cached) {
      return { ...shardConfig, decryptedDsn: cached };
    }

    try {
      const decryptedDsn = await securityManager.decryptField(shardConfig.shardDsn);
      if (dsnCache) dsnCache.set(tenantId, decryptedDsn);
      return { ...shardConfig, decryptedDsn };
    } catch (err) {
      console.error(`[SHARD_ROUTER] Failed to decrypt DSN for tenant ${tenantId}: ${err.message}`);
      throw new ShardResolutionError(
        'DSN_DECRYPT_FAILED',
        `Cannot decrypt shard DSN for tenant ${tenantId}. Master key may be rotated or corrupted.`,
        500
      );
    }
  }

  /**
   * Invalidate the cache for a specific tenant (e.g., after migration).
   * @param {string} tenantId
   */
  invalidate(tenantId) {
    this.#shardCache.delete(tenantId);
  }

  /**
   * Flush the entire shard cache.
   */
  flushAll() {
    this.#shardCache.clear();
  }
}


// ─────────────────────────────────────────────────────
//  SKILL GATE — Admissibility Enforcement
// ─────────────────────────────────────────────────────

class SkillGate {
  /**
   * Check if a skill is admissible for the given project.
   *
   * @param {import('postgres').Sql} hubSql
   * @param {string} projectId - UUID from shard_map
   * @param {string} skillName - The skill being invoked
   * @returns {Promise<{rank: number, status: 'DENIED'|'AUDIT_REQUIRED'|'AUTO_APPROVE', reason?: string}>}
   */
  async check(hubSql, projectId, skillName) {
    const [skill] = await hubSql`
      SELECT 
        admissibility_rank,
        denial_reason,
        grant_expires_at
      FROM project_skill_graph
      WHERE project_id = ${projectId}
        AND skill_name = ${skillName}
    `;

    // No entry = DENIED by default (fail-closed)
    if (!skill) {
      return {
        rank: 0,
        status: 'DENIED',
        reason: `Skill "${skillName}" is not registered in the project skill graph. Fail-closed.`,
      };
    }

    // Check grant expiry
    if (skill.grant_expires_at && new Date(skill.grant_expires_at) < new Date()) {
      return {
        rank: 0,
        status: 'DENIED',
        reason: `Skill grant expired at ${skill.grant_expires_at}.`,
      };
    }

    const STATUS_MAP = { 0: 'DENIED', 1: 'AUDIT_REQUIRED', 2: 'AUTO_APPROVE' };
    return {
      rank: skill.admissibility_rank,
      status: STATUS_MAP[skill.admissibility_rank] || 'DENIED',
      reason: skill.admissibility_rank === 0 ? skill.denial_reason : undefined,
    };
  }

  /**
   * Record a skill invocation for telemetry.
   * Fire-and-forget — never blocks the hot path.
   *
   * @param {import('postgres').Sql} hubSql
   * @param {string} projectId
   * @param {string} skillName
   * @param {number} latencyMs
   */
  async recordInvocation(hubSql, projectId, skillName, latencyMs) {
    try {
      await hubSql`
        UPDATE project_skill_graph
        SET 
          invocation_count = invocation_count + 1,
          last_invoked_at = NOW(),
          avg_latency_ms = COALESCE(
            (avg_latency_ms * invocation_count + ${latencyMs}) / (invocation_count + 1),
            ${latencyMs}
          )
        WHERE project_id = ${projectId} AND skill_name = ${skillName}
      `;
    } catch (err) {
      // Telemetry failures must never break the hot path
      console.warn(`[SKILL_GATE] Telemetry write failed: ${err.message}`);
    }
  }
}


// ─────────────────────────────────────────────────────
//  RATE LIMITER — Tier-Aware Throttling
// ─────────────────────────────────────────────────────

class TierRateLimiter {
  /** @type {Map<string, {count: number, windowStart: number}>} */
  #windows = new Map();

  /**
   * Check if the request is within the tenant's rate limit.
   * Uses a sliding window counter per tenant.
   *
   * @param {string} tenantId
   * @param {number} maxPerMinute - From shard_map.max_queries_per_minute
   * @returns {{allowed: boolean, remaining: number, resetAt: number}}
   */
  check(tenantId, maxPerMinute) {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute window

    let window = this.#windows.get(tenantId);

    // Reset window if expired
    if (!window || (now - window.windowStart) >= windowMs) {
      window = { count: 0, windowStart: now };
      this.#windows.set(tenantId, window);
    }

    window.count++;
    const allowed = window.count <= maxPerMinute;
    const remaining = Math.max(0, maxPerMinute - window.count);
    const resetAt = window.windowStart + windowMs;

    return { allowed, remaining, resetAt };
  }
}


// ─────────────────────────────────────────────────────
//  AUDIT LOGGER — Append-Only Governance Trail
// ─────────────────────────────────────────────────────

class SovereignAuditLogger {
  /**
   * Log an arbitration decision to the Sovereign_audit_log.
   * Append-only. Never update, never delete.
   *
   * TIER-AWARE BLOCKING POLICY:
   *   Tier 1 (Enterprise): BLOCKING write. Non-repudiable evidence.
   *   Tier 2/3 (Dev/Sandbox): Fire-and-forget for latency.
   *
   * @param {import('postgres').Sql} hubSql
   * @param {object} entry
   * @param {object} [opts]
   * @param {boolean} [opts.blocking=false] - Force synchronous write
   */
  async log(hubSql, entry, opts = {}) {
    const blocking = opts.blocking || (entry.resolvedTier === 1);
    const _write = async () => {
      await hubSql`
        INSERT INTO Sovereign_audit_log (
          tenant_id, project_id, agent_role, agent_source,
          resolved_shard, resolved_tier,
          skill_name, skill_rank,
          arbiter_decision, denial_reason,
          payload_hash, payload_size_bytes,
          crypto_algorithm, crypto_standard, key_version_id,
          seal_signature,
          latency_ms
        ) VALUES (
          ${entry.tenantId},
          ${entry.projectId || null},
          ${entry.agentRole},
          ${entry.agentSource},
          ${entry.resolvedShard || null},
          ${entry.resolvedTier || null},
          ${entry.skillName || null},
          ${entry.skillRank ?? null},
          ${entry.decision},
          ${entry.denialReason || null},
          ${entry.payloadHash},
          ${entry.payloadSizeBytes || null},
          ${entry.cryptoAlgorithm || null},
          ${entry.cryptoStandard || 'ECDSA_P256'},
          ${entry.keyVersionId || null},
          ${entry.sealSignature || null},
          ${entry.latencyMs || null}
        )
      `;
    };

    if (blocking) {
      // TIER 1: Synchronous — audit MUST succeed before response
      try {
        await _write();
      } catch (err) {
        console.error(`[Sovereign_AUDIT_CRITICAL] BLOCKING audit write failed (Tier ${entry.resolvedTier}): ${err.message}`);
        throw new Error(`AUDIT_INTEGRITY_FAILURE: Cannot guarantee non-repudiable evidence trail. ${err.message}`);
      }
    } else {
      // TIER 2/3: Fire-and-forget
      _write().catch(err => {
        console.error(`[Sovereign_AUDIT_WARN] Non-blocking audit write failed: ${err.message}`);
      });
    }
  }
}


// ─────────────────────────────────────────────────────
//  SHARD RESOLUTION ERROR
// ─────────────────────────────────────────────────────

class ShardResolutionError extends Error {
  constructor(code, message, httpStatus = 500) {
    super(message);
    this.name = 'ShardResolutionError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}


// ─────────────────────────────────────────────────────
//  Sovereign PROXY — Main Handler
// ─────────────────────────────────────────────────────

const shardRouter = new ShardRouter();
const skillGate = new SkillGate();
const rateLimiter = new TierRateLimiter();
const auditLogger = new SovereignAuditLogger();
const shardPool = new ShardConnectionPool();
const dsnCache = new DsnDecryptionCache();
const shardCircuitBreaker = new ShardCircuitBreaker();

/**
 * Validates and normalizes the /v1/arbitrate payload.
 *
 * Expected shape:
 * {
 *   "tenant_id": "PROJECT_UUID",
 *   "agent_metadata": { "role": "engineer", "source": "Antigravity" },
 *   "action_payload": "GENERATED_CODE_OR_SYSTEM_CALL",
 *   "crypto_preference": "PQ_LATTICE"  // Optional, defaults to shard crypto_tier
 * }
 *
 * @param {object} body
 * @returns {{tenantId: string, agentRole: string, agentSource: string, actionPayload: string, skillName?: string, cryptoPreference?: string}}
 * @throws {Error} If validation fails
 */
function validateArbitratePayload(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Sovereign_INVALID_PAYLOAD: Request body must be a JSON object.');
  }

  const { tenant_id, agent_metadata, action_payload, skill_name, crypto_preference } = body;

  if (!tenant_id || typeof tenant_id !== 'string') {
    throw new Error('Sovereign_MISSING_TENANT: tenant_id is required and must be a string.');
  }

  if (!agent_metadata || typeof agent_metadata !== 'object') {
    throw new Error('Sovereign_MISSING_AGENT: agent_metadata is required and must be an object with { role, source }.');
  }

  if (!agent_metadata.role || !agent_metadata.source) {
    throw new Error('Sovereign_INCOMPLETE_AGENT: agent_metadata must contain both "role" and "source" fields.');
  }

  if (!action_payload) {
    throw new Error('Sovereign_MISSING_PAYLOAD: action_payload is required.');
  }

  // Validate crypto_preference if provided
  const VALID_CRYPTO = ['ECDSA_P256', 'PQ_LATTICE'];
  if (crypto_preference && !VALID_CRYPTO.includes(crypto_preference)) {
    throw new Error(`Sovereign_INVALID_CRYPTO: crypto_preference must be one of: ${VALID_CRYPTO.join(', ')}`);
  }

  return {
    tenantId: tenant_id.trim(),
    agentRole: agent_metadata.role,
    agentSource: agent_metadata.source,
    actionPayload: typeof action_payload === 'string' 
      ? action_payload 
      : JSON.stringify(action_payload),
    skillName: skill_name || null,
    cryptoPreference: crypto_preference || null,
  };
}

/**
 * Compute SHA-256 fingerprint of a payload.
 * The Sovereign Proxy NEVER stores raw payloads — only hashes.
 *
 * @param {string} payload
 * @returns {string} Hex-encoded SHA-256
 */
function fingerprintPayload(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * POST /v1/arbitrate — The Sovereign Proxy entry point.
 *
 * Pipeline:
 *   1. Validate payload structure
 *   2. Resolve tenant → shard (via shard_map)
 *   3. Check rate limit (tier-aware)
 *   4. Check skill admissibility (via project_skill_graph)
 *   5. Route to Arbiter Kernel on the resolved shard
 *   6. Log the decision (append-only audit trail)
 *
 * @param {object} req - Express-compatible request
 * @param {object} res - Express-compatible response
 * @param {import('postgres').Sql} hubSql - Governance Hub DB connection
 * @param {function} executeArbiter - Arbiter Kernel execution function
 */
async function handleArbitrate(req, res, hubSql, executeArbiter) {
  const startTime = Date.now();
  let auditEntry = null;

  try {
    // ── Step 1: Validate ──
    const { tenantId, agentRole, agentSource, actionPayload, skillName, cryptoPreference } = 
      validateArbitratePayload(req.body);

    const payloadHash = fingerprintPayload(actionPayload);
    const payloadSize = Buffer.byteLength(actionPayload, 'utf8');

    auditEntry = {
      tenantId,
      agentRole,
      agentSource,
      payloadHash,
      payloadSizeBytes: payloadSize,
    };

    // ── Step 2: Resolve Shard (Circuit-Breaker Protected) ──
    if (shardCircuitBreaker.isOpen) {
      auditEntry.decision = 'SHARD_UNAVAILABLE';
      auditEntry.denialReason = `Shard circuit breaker OPEN. State: ${shardCircuitBreaker.state}`;
      auditEntry.latencyMs = Date.now() - startTime;
      auditLogger.log(hubSql, auditEntry).catch(() => {});

      return res.status(503).json({
        code: 'Sovereign_SHARD_CIRCUIT_OPEN',
        message: 'Shard resolution circuit breaker is open. Retry after 30 seconds.',
        retryAfter: 30,
      });
    }

    let shardConfig;
    try {
      shardConfig = await shardRouter.resolve(hubSql, tenantId);
      shardCircuitBreaker.recordSuccess();
    } catch (err) {
      if (err instanceof ShardResolutionError) {
        shardCircuitBreaker.recordFailure();
        auditEntry.decision = 'SHARD_UNAVAILABLE';
        auditEntry.denialReason = err.message;
        auditEntry.latencyMs = Date.now() - startTime;
        await auditLogger.log(hubSql, auditEntry);

        return res.status(err.httpStatus).json({
          code: err.code,
          message: err.message,
        });
      }
      shardCircuitBreaker.recordFailure();
      throw err;
    }

    auditEntry.projectId = shardConfig.projectId;
    auditEntry.resolvedShard = shardConfig.shardInstanceId;
    auditEntry.resolvedTier = shardConfig.tier;

    // ── Step 3: Rate Limit ──
    const rateResult = rateLimiter.check(tenantId, shardConfig.maxQueriesPerMinute);
    
    // Set rate limit headers regardless of outcome
    res.set('X-RateLimit-Limit', shardConfig.maxQueriesPerMinute.toString());
    res.set('X-RateLimit-Remaining', rateResult.remaining.toString());
    res.set('X-RateLimit-Reset', Math.ceil(rateResult.resetAt / 1000).toString());

    if (!rateResult.allowed) {
      auditEntry.decision = 'RATE_LIMITED';
      auditEntry.denialReason = `Exceeded ${shardConfig.maxQueriesPerMinute} req/min for Tier ${shardConfig.tier}`;
      auditEntry.latencyMs = Date.now() - startTime;
      await auditLogger.log(hubSql, auditEntry);

      return res.status(429).json({
        code: 'Sovereign_RATE_LIMITED',
        message: `Rate limit exceeded. Limit: ${shardConfig.maxQueriesPerMinute}/min. Reset: ${new Date(rateResult.resetAt).toISOString()}`,
        retryAfter: Math.ceil((rateResult.resetAt - Date.now()) / 1000),
      });
    }

    // ── Step 4: Skill Admissibility ──
    if (skillName) {
      const skillResult = await skillGate.check(hubSql, shardConfig.projectId, skillName);
      auditEntry.skillName = skillName;
      auditEntry.skillRank = skillResult.rank;

      if (skillResult.status === 'DENIED') {
        auditEntry.decision = 'DENIED';
        auditEntry.denialReason = skillResult.reason;
        auditEntry.latencyMs = Date.now() - startTime;
        await auditLogger.log(hubSql, auditEntry);

        return res.status(403).json({
          code: 'Sovereign_SKILL_DENIED',
          message: `Skill "${skillName}" is denied for this project.`,
          reason: skillResult.reason,
          admissibility_rank: skillResult.rank,
        });
      }

      if (skillResult.status === 'AUDIT_REQUIRED') {
        // For AUDIT_REQUIRED skills, we still route but flag for review
        auditEntry.decision = 'ESCALATED';
        console.log(`[Sovereign] Skill "${skillName}" requires audit. Routing with escalation flag.`);
      }
    }

    // ── Step 5: Resolve Crypto Algorithm (Axiom-G Dual-Track) ──
    // Request-level crypto_preference overrides shard default.
    // This enables per-request PQ_LATTICE for agents that support it,
    // even on shards that default to ECDSA_P256 (legacy logistics).
    const effectiveCrypto = cryptoPreference || shardConfig.cryptoTier || 'ECDSA_P256';
    auditEntry.cryptoAlgorithm = effectiveCrypto;

    // ── Step 6: Route to Arbiter Kernel (Pooled Connection + Inline Rehydration) ──
    // Tier 1/2: Acquire a persistent pooled connection to the shard.
    //           On DSN cache miss, the proxy decrypts INLINE using the
    //           lightweight AES-256-GCM utility (NOT the full SecurityManager).
    //           This eliminates the "Cache-Miss Black Hole" — the proxy is
    //           self-healing after container restarts and TTL expiry.
    // Tier 3:   Use the Hub DB with RLS session variable (no shard connection).
    let shardSql = null;
    if (shardConfig.tier <= 2 && shardConfig.shardDsn) {
      let dsn = dsnCache.get(tenantId);

      if (!dsn) {
        // ── INLINE REHYDRATION (The 2 AM Fix) ──
        // shardConfig.shardDsn is an AES-256-GCM ciphertext from the shard_map table.
        // Decrypt it using the SENTINEL_DSN_MASTER_KEY env variable.
        // This is a CPU-only operation (<0.1ms) — no KMS round-trip.
        try {
          dsn = decryptWithMasterKey(shardConfig.shardDsn);
          dsnCache.set(tenantId, dsn);
          console.log(`[Sovereign] DSN rehydrated for tenant ${tenantId} (Tier ${shardConfig.tier})`);
        } catch (decryptErr) {
          // CRYPTO_FAULT: Master key missing or ciphertext corrupted.
          // This is FATAL for this request but should NOT trip the circuit breaker
          // (shard resolution succeeded — it's the DSN that's bad).
          console.error(`[Sovereign_CRYPTO_FAULT] DSN decryption failed for tenant ${tenantId}: ${decryptErr.message}`);
          auditEntry.decision = 'DENIED';
          auditEntry.denialReason = `DSN_DECRYPT_FAILED: ${decryptErr.message}`;
          auditEntry.latencyMs = Date.now() - startTime;
          await auditLogger.log(hubSql, auditEntry);

          return res.status(500).json({
            code: 'Sovereign_CRYPTO_FAULT',
            message: 'Shard connection unavailable. Contact infrastructure team.',
            // Deliberately vague — never expose crypto internals to callers
          });
        }
      }

      // Acquire a persistent pooled connection from the decrypted DSN
      shardSql = shardPool.acquire(dsn);
    } else if (shardConfig.tier === 3) {
      console.log(`[Sovereign] Tier 3 routing: Setting RLS context for tenant ${tenantId}`);
    }

    const arbiterResult = await executeArbiter({
      query: actionPayload,
      tenantId,
      shardConfig,
      shardSql,  // Pooled shard connection (null for Tier 3 / unresolved)
      agentMetadata: { role: agentRole, source: agentSource },
      cryptoPreference: effectiveCrypto,
    });

    // ── Step 7: Audit & Respond ──
    const latencyMs = Date.now() - startTime;
    auditEntry.decision = auditEntry.decision || 'ROUTED';
    auditEntry.latencyMs = latencyMs;
    auditEntry.sealSignature = arbiterResult.sealSignature || null;

    // Tier-aware audit: Tier 1 = blocking (non-repudiable), Tier 2/3 = fire-and-forget
    await auditLogger.log(hubSql, auditEntry);

    // Fire-and-forget skill telemetry (never blocks hot path)
    if (skillName) {
      skillGate.recordInvocation(hubSql, shardConfig.projectId, skillName, latencyMs).catch(() => {});
    }

    return res.status(200).json({
      ...arbiterResult,
      _meta: {
        shard_tier: shardConfig.tier,
        isolation_level: shardConfig.isolationLevel,
        crypto_algorithm: effectiveCrypto,
        latency_ms: latencyMs,
        payload_hash: payloadHash,
      },
    });

  } catch (err) {
    const latencyMs = Date.now() - startTime;
    console.error(`[Sovereign_ERROR] ${err.message}`);

    // Attempt to log the failure
    if (auditEntry) {
      auditEntry.decision = 'DENIED';
      auditEntry.denialReason = err.message;
      auditEntry.latencyMs = latencyMs;
      auditLogger.log(hubSql, auditEntry).catch(() => {});
    }

    // Determine HTTP status from error type
    const isValidation = err.message.startsWith('Sovereign_');
    return res.status(isValidation ? 400 : 500).json({
      code: isValidation ? err.message.split(':')[0] : 'Sovereign_INTERNAL_ERROR',
      message: err.message,
    });
  }
}


module.exports = {
  // Core handler
  handleArbitrate,
  
  // Validation (exported for testing)
  validateArbitratePayload,
  fingerprintPayload,
  
  // Components (exported for advanced composition)
  ShardRouter,
  SkillGate,
  TierRateLimiter,
  SovereignAuditLogger,
  ShardResolutionError,
  ShardConnectionPool,
  DsnDecryptionCache,
  ShardCircuitBreaker,
  
  // Singleton instances
  shardRouter,
  skillGate,
  rateLimiter,
  auditLogger,
  shardPool,
  dsnCache,
  shardCircuitBreaker,
};
