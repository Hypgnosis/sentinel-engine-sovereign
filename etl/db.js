/**
 * SENTINEL ENGINE V4.5 — PostgreSQL Client (Neon/Supabase)
 * ═══════════════════════════════════════════════════════════
 * High-performance database connection for the Pristine Reservoir.
 */

import postgres from 'postgres';
import 'dotenv/config';

// The Database URL should be in Secret Manager or .env
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn('[DB_WARNING] DATABASE_URL not set. Postgres ingestion will be disabled.');
}

// PostgreSQL connection client
export const sql = DATABASE_URL ? postgres(DATABASE_URL, {
  ssl: 'require',
  max: 10,
  idle_timeout: 20,
  connect_timeout: 30,
}) : null;

/**
 * Helper to perform an upsert (Insert or Update on conflict)
 * using the entity_hash as the unique key.
 */
export async function upsertRow(tableName, row) {
  if (!sql) return;

  const { embedding, ...fields } = row;
  
  // Convert embedding array to postgres string format: [1,2,3]
  const vectorStr = embedding ? `[${embedding.join(',')}]` : null;

  try {
    // Basic dynamic insert with pg-vector support
    // Note: 'postgres' library handles arrays and objects natively
    await sql`
      INSERT INTO ${sql(tableName)} ${sql(fields)}
      ON CONFLICT (entity_hash) DO UPDATE
      SET 
        ${sql(fields)},
        embedding = ${vectorStr},
        ingested_at = CURRENT_TIMESTAMP
    `;
  } catch (err) {
    console.error(`[DB_ERROR] Failed to upsert into ${tableName}:`, err.message);
    throw err;
  }
}

/**
 * Close connection
 */
export async function closeDb() {
  if (sql) await sql.end();
}
