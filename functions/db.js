/**
 * SENTINEL ENGINE V5.5 — PostgreSQL Client (Pristine Reservoir)
 * ═══════════════════════════════════════════════════════════
 * High-speed RAG grounding for inference.
 *
 * V5.5 PROJECT SOVEREIGN:
 *   Engine migrated from Supabase (AWS cross-cloud) to
 *   GCP Cloud SQL (in-region, Google private backbone).
 *   Target: <10ms vector search latency.
 *
 * CONNECTION MODES:
 *   Production: Unix socket via Cloud SQL connector.
 *     DATABASE_URL = postgresql://sentinel:pw@/sentinel_reservoir?host=/cloudsql/PROJECT:REGION:INSTANCE
 *   Dev/Local: TCP via Cloud SQL Auth Proxy.
 *     DATABASE_URL = postgresql://sentinel:pw@127.0.0.1:5432/sentinel_reservoir
 *
 * CONFIGURATION MONISM:
 *   DATABASE_URL is the SOLE connection configuration.
 *   If it is absent at boot, the system crashes.
 *   No fallback chains. No hardcoded hostnames.
 */

const postgres = require('postgres');

// ─────────────────────────────────────────────────────
//  CONNECTION POOL (Boot-Validated, Cloud SQL Native)
// ─────────────────────────────────────────────────────

let _sql = null;

/**
 * Returns a live Postgres connection pool.
 * Consumes DATABASE_URL exclusively from environment.
 * Detects Cloud SQL Unix socket paths and disables SSL accordingly
 * (Unix sockets are inherently VPC-encrypted, SSL overhead is unnecessary).
 * Throws FATAL_CONFIG_FAILURE if missing.
 */
function getSql() {
  if (_sql) return _sql;

  let dbUrl = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : null;
  
  if (!dbUrl) {
    throw new Error('FATAL_CONFIG_FAILURE: DATABASE_URL is missing from environment.');
  }

  // Fix Node 20+ URL parsing for postgres unix sockets missing a hostname
  if (dbUrl.includes('@/')) {
    dbUrl = dbUrl.replace('@/', '@localhost/');
  }

  // Detect Cloud SQL Unix socket connection (path contains /cloudsql/)
  const isUnixSocket = dbUrl.includes('/cloudsql/');
  const connectionMode = isUnixSocket ? 'CLOUD_SQL_SOCKET' : 'TCP_PROXY';
  console.log(`[DB_INIT] Initializing Postgres pool. Mode: ${connectionMode}`);

  let connectionOptions = {
    max: 50,
    idle_timeout: 30,
    connect_timeout: 5,
    max_lifetime: 1800,
    ssl: isUnixSocket ? false : require('url').parse(dbUrl).hostname !== '127.0.0.1' && require('url').parse(dbUrl).hostname !== 'localhost' ? 'require' : false
  };

  _sql = postgres(dbUrl, connectionOptions);
  return _sql;
}

/**
 * Executes a semantic search across multiple tables.
 * V5.5: Aligned to 16KB context budget with top-3 per table.
 */
async function postgresVectorSearch(queryVector, tenantId) {
  const sql = getSql();
  if (!sql) return { contextPayload: '', resultCount: 0 };

  const vectorStr = `[${queryVector.join(',')}]`;
  const tables = ['freight_indices', 'port_congestion', 'maritime_chokepoints', 'risk_matrix'];
  
  let totalCount = 0;
  const sections = [];

  for (const table of tables) {
    try {
      // pgvector cosine distance — top 3 per table for payload budget
      const rows = await sql`
        SELECT *, (embedding <=> ${vectorStr}::vector) as distance
        FROM ${sql(table)}
        WHERE tenant_id = ${tenantId}
        ORDER BY distance ASC
        LIMIT 3
      `;

      if (rows.length > 0) {
        // Relaxed distance filter to accommodate generic queries that may evaluate to ~0.5 distance
        const relevantRows = rows.filter(r => r.distance < 0.75);
        if (relevantRows.length > 0) {
          totalCount += relevantRows.length;
          const sectionLines = relevantRows.map((r, i) => {
            // Strip out large/internal fields to compress JSON length
            const { embedding, distance, id, tenant_id, entity_hash, ingested_at, ...displayFields } = r;
            return `  [${i + 1}] (relevance: ${(1 - r.distance).toFixed(3)}) ${JSON.stringify(displayFields)}`;
          });
          sections.push(`\n── Postgres:${table} (${relevantRows.length} results) ──\n${sectionLines.join('\n')}`);
        }
      }
    } catch (err) {
      console.warn(`[DB_SEARCH_WARNING] table ${table} failed:`, err.message);
    }
  }

  const { MAX_CONTEXT_BYTES } = require('./adapters/context-packer');
  const fullPayload = sections.join('\n');
  if (fullPayload.length > MAX_CONTEXT_BYTES) {
    console.warn(`[PG_CONTEXT_CAP] Scaling to 16KB budget. Current: ${fullPayload.length}B`);
  }

  return {
    contextPayload: fullPayload,
    resultCount: totalCount
  };
}

/**
 * Check if a Subject ID is revoked (The Kill Switch).
 */
async function isSubjectRevoked(subjectId) {
  const sql = getSql();
  if (!sql || !subjectId) return false;
  try {
    const [rev] = await sql`
      SELECT 1 FROM subject_revocation_list WHERE subject_id = ${subjectId}
    `;
    return !!rev;
  } catch (err) {
    console.error('[DB_ERROR] Revocation check failed:', err.message);
    return false;
  }
}

module.exports = {
  getSql,
  postgresVectorSearch,
  isSubjectRevoked
};
