/**
 * SENTINEL ENGINE V4.5.2 — Postgres Seed + RLS Enforcement
 * ═══════════════════════════════════════════════════════════
 * This script:
 *   1. Enables pgvector extension
 *   2. Creates all 5 tables with proper schemas
 *   3. Enforces RLS on EVERY table (The "Manual Skull")
 *   4. Seeds the rose_rocket tenant with production data
 *   5. Generates 768-dim embeddings via Vertex AI
 *
 * Usage: node scripts/seed-postgres.js
 * Requires: DATABASE_URL in .env or environment
 * ═══════════════════════════════════════════════════════════
 */

import postgres from 'postgres';
import { createHash } from 'crypto';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

// ─────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[FATAL] DATABASE_URL not set. Cannot seed Postgres.');
  process.exit(1);
}

const TENANT_ID = 'rose_rocket';
const GCP_PROJECT_ID = 'ha-sentinel-core-v21';
const GCP_REGION = 'us-central1';
const EMBEDDING_MODEL = 'text-embedding-004';
const EMBEDDING_DIM = 768;

const sql = postgres(process.env.DATABASE_URL + '?pgbouncer=true', {
  ssl: 'require',
  max: 5,
  idle_timeout: 30,
  connect_timeout: 30,
});

let ai = null;
function getAI() {
  if (!ai) {
    ai = new GoogleGenAI({
      vertexai: true,
      project: GCP_PROJECT_ID,
      location: GCP_REGION,
    });
  }
  return ai;
}

// ─────────────────────────────────────────────────────
//  STEP 1: DDL — Create Tables + pgvector
// ─────────────────────────────────────────────────────

async function createTables() {
  console.log('[DDL] Enabling pgvector extension...');
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;

  console.log('[DDL] Creating tables...');

  await sql`
    CREATE TABLE IF NOT EXISTS freight_indices (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      entity_hash TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL,
      route_origin TEXT,
      route_destination TEXT,
      rate_usd NUMERIC,
      week_over_week_change NUMERIC,
      trend TEXT,
      narrative_context TEXT,
      embedding vector(${sql.unsafe(String(EMBEDDING_DIM))}),
      ingested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS port_congestion (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      entity_hash TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL,
      port_name TEXT,
      vessels_at_anchor INTEGER,
      avg_wait_days NUMERIC,
      severity_level TEXT,
      narrative_context TEXT,
      embedding vector(${sql.unsafe(String(EMBEDDING_DIM))}),
      ingested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS maritime_chokepoints (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      entity_hash TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL,
      chokepoint_name TEXT,
      status TEXT,
      vessel_queue INTEGER,
      transit_delay_hours NUMERIC,
      narrative_context TEXT,
      embedding vector(${sql.unsafe(String(EMBEDDING_DIM))}),
      ingested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS risk_matrix (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      entity_hash TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL,
      risk_factor TEXT,
      severity TEXT,
      probability TEXT,
      impact_window TEXT,
      narrative_context TEXT,
      embedding vector(${sql.unsafe(String(EMBEDDING_DIM))}),
      ingested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS subject_revocation_list (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      subject_id TEXT NOT NULL UNIQUE,
      reason TEXT,
      revoked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `;

  console.log('[DDL] ✅ All 5 tables created.');
}

// ─────────────────────────────────────────────────────
//  STEP 2: RLS — The "Manual Skull"
// ─────────────────────────────────────────────────────

async function enforceRLS() {
  console.log('[RLS] Enforcing Row Level Security on all tables...');

  const tables = [
    'freight_indices',
    'port_congestion',
    'maritime_chokepoints',
    'risk_matrix',
    'subject_revocation_list',
  ];

  for (const table of tables) {
    try {
      await sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      console.log(`  ✅ RLS enabled on ${table}`);
    } catch (err) {
      // Already enabled is fine
      if (err.message.includes('already enabled')) {
        console.log(`  ⚠️  RLS already enabled on ${table}`);
      } else {
        console.warn(`  ⚠️  RLS enable warning on ${table}: ${err.message}`);
      }
    }

    // Create tenant isolation policy (idempotent with IF NOT EXISTS-style approach)
    try {
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE tablename = '${table}' AND policyname = 'tenant_isolation_${table}'
          ) THEN
            CREATE POLICY "tenant_isolation_${table}" ON ${table}
              FOR ALL USING (tenant_id = current_setting('app.tenant_id', true));
          END IF;
        END
        $$;
      `);
      console.log(`  ✅ Tenant isolation policy on ${table}`);
    } catch (err) {
      console.warn(`  ⚠️  Policy warning on ${table}: ${err.message}`);
    }
  }

  console.log('[RLS] ✅ Multi-tenancy boundary enforced.');
}

// ─────────────────────────────────────────────────────
//  STEP 3: Seed Data — rose_rocket Tenant
// ─────────────────────────────────────────────────────

function entityHash(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').substring(0, 16);
}

async function generateEmbedding(text) {
  const client = getAI();
  const response = await client.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: EMBEDDING_DIM },
  });
  return response.embeddings[0].values;
}

async function seedTable(tableName, rows, narrativeField = 'narrative_context') {
  console.log(`[SEED] Seeding ${tableName} with ${rows.length} rows...`);

  for (const row of rows) {
    const narrative = row[narrativeField] || JSON.stringify(row);
    const hash = entityHash({ ...row, tenant_id: TENANT_ID });

    // Generate embedding
    const embedding = await generateEmbedding(narrative);
    const vectorStr = `[${embedding.join(',')}]`;

    // Build the row with tenant_id
    const fullRow = { ...row, tenant_id: TENANT_ID, entity_hash: hash };

    try {
      await sql`
        INSERT INTO ${sql(tableName)} ${sql(fullRow)}
        ON CONFLICT (entity_hash) DO UPDATE SET
          narrative_context = EXCLUDED.narrative_context,
          ingested_at = CURRENT_TIMESTAMP
      `;
      // Update embedding separately (vector type needs unsafe)
      await sql.unsafe(
        `UPDATE ${tableName} SET embedding = '${vectorStr}' WHERE entity_hash = '${hash}'`
      );
      console.log(`  ✅ ${row.route_origin || row.port_name || row.chokepoint_name || row.risk_factor || 'row'}`);
    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}`);
    }
  }
}

async function seedAll() {
  // ── Freight Indices ──
  const freightData = [
    { source: 'Freightos', route_origin: 'Global Composite', route_destination: 'Global Composite', rate_usd: 1847, week_over_week_change: 3.2, trend: 'rising', narrative_context: 'FBX Global Container Index at $1,847/FEU, up 3.2% WoW. Trans-Pacific Eastbound stabilizing after Q1 frontloading surge. Asia-Europe corridor showing sustained demand driven by EU restocking cycle.' },
    { source: 'Freightos', route_origin: 'China/East Asia', route_destination: 'N. America West Coast', rate_usd: 1520, week_over_week_change: -2.1, trend: 'stabilizing', narrative_context: 'Trans-Pacific Westbound USWC rate at $1,520/FEU, declining 2.1% WoW as Q1 frontloading surge subsides. Carrier blank sailings expected to support rate floors.' },
    { source: 'Freightos', route_origin: 'China/East Asia', route_destination: 'N. America East Coast', rate_usd: 2680, week_over_week_change: 4.7, trend: 'rising', narrative_context: 'USEC rates spiking 4.7% WoW to $2,680/FEU due to pre-tariff frontloading on East Coast corridor. Shippers accelerating shipments ahead of Q2 tariff escalation window.' },
    { source: 'Freightos', route_origin: 'China/East Asia', route_destination: 'N. Europe', rate_usd: 2340, week_over_week_change: 3.2, trend: 'rising', narrative_context: 'Asia-Europe rates at $2,340/FEU rising 3.2% WoW. EU restocking cycle driving sustained demand. Red Sea diversions adding 10-14 days to transit times.' },
    { source: 'Freightos', route_origin: 'China/East Asia', route_destination: 'Mediterranean', rate_usd: 2890, week_over_week_change: -1.8, trend: 'declining', narrative_context: 'Mediterranean corridor rates declining 1.8% WoW to $2,890/FEU. Seasonal adjustment in play. However, rates remain elevated vs historical averages due to Red Sea rerouting.' },
    { source: 'Freightos', route_origin: 'N. Europe', route_destination: 'N. America East Coast', rate_usd: 1150, week_over_week_change: 0.5, trend: 'stable', narrative_context: 'Transatlantic USEC rate stable at $1,150/FEU. Low volatility corridor with adequate capacity balance.' },
    { source: 'Xeneta', route_origin: 'Far East', route_destination: 'N. Europe', rate_usd: 2340, week_over_week_change: 0, trend: 'rising', narrative_context: 'Far East to N. Europe spot at $2,340 vs contract $1,890 (spread: $450). Spot-contract spread widening indicates rising market volatility.' },
    { source: 'Xeneta', route_origin: 'Far East', route_destination: 'US West Coast', rate_usd: 1520, week_over_week_change: 0, trend: 'stabilizing', narrative_context: 'Far East to USWC spot at $1,520 vs contract $1,340 (spread: $180). Relatively tight spread signals market stabilization.' },
    { source: 'Xeneta', route_origin: 'Far East', route_destination: 'US East Coast', rate_usd: 2680, week_over_week_change: 0, trend: 'rising', narrative_context: 'Far East to USEC spot at $2,680 vs contract $2,150 (spread: $530). Widest spread across all corridors. Shippers with expiring Q1 contracts face 15-22% renewal premium.' },
  ];

  // ── Port Congestion ──
  const portData = [
    { source: 'MarineTraffic', port_name: 'Shanghai', vessels_at_anchor: 147, avg_wait_days: 3.2, severity_level: 'HIGH', narrative_context: 'Shanghai congestion at 147 vessels — highest since October 2024. Cascading delays expected on Asia-Europe services within 10-14 days.' },
    { source: 'MarineTraffic', port_name: 'Singapore', vessels_at_anchor: 42, avg_wait_days: 1.1, severity_level: 'MODERATE', narrative_context: 'Singapore vessel anchorage at 42, moderate congestion. Standard transshipment hub operations.' },
    { source: 'MarineTraffic', port_name: 'Rotterdam', vessels_at_anchor: 18, avg_wait_days: 0.8, severity_level: 'LOW', narrative_context: 'Rotterdam operating at optimal efficiency. 18 vessels at anchor with 0.8-day average wait time.' },
    { source: 'MarineTraffic', port_name: 'Long Beach', vessels_at_anchor: 67, avg_wait_days: 2.8, severity_level: 'HIGH', narrative_context: 'Long Beach stabilized but remains HIGH due to chassis shortages. 67 vessels at anchor, 2.8-day average wait.' },
    { source: 'MarineTraffic', port_name: 'Los Angeles', vessels_at_anchor: 54, avg_wait_days: 2.4, severity_level: 'MODERATE-HIGH', narrative_context: 'LA port congestion improving. Vessel count down to 54, wait times decreasing to 2.4 days.' },
    { source: 'MarineTraffic', port_name: 'Savannah', vessels_at_anchor: 23, avg_wait_days: 1.4, severity_level: 'MODERATE', narrative_context: 'Savannah port moderate congestion at 23 vessels, 1.4-day wait. Steady throughput.' },
    { source: 'MarineTraffic', port_name: 'Hamburg', vessels_at_anchor: 12, avg_wait_days: 0.6, severity_level: 'LOW', narrative_context: 'Hamburg low congestion — 12 vessels, 0.6-day wait. Northern Europe corridor operating smoothly.' },
    { source: 'MarineTraffic', port_name: 'Busan', vessels_at_anchor: 31, avg_wait_days: 1.7, severity_level: 'MODERATE', narrative_context: 'Busan congestion worsening to 31 vessels. Transshipment overflow from Shanghai delays.' },
    { source: 'MarineTraffic', port_name: 'Jebel Ali (Dubai)', vessels_at_anchor: 8, avg_wait_days: 0.4, severity_level: 'LOW', narrative_context: 'Jebel Ali operating at minimal congestion. 8 vessels, 0.4-day wait.' },
    { source: 'MarineTraffic', port_name: 'Santos (Brazil)', vessels_at_anchor: 28, avg_wait_days: 2.1, severity_level: 'MODERATE', narrative_context: 'Santos congestion worsening — 28 vessels at anchor, 2.1-day average wait. Brazil grain export season pressure.' },
  ];

  // ── Maritime Chokepoints ──
  const chokepointData = [
    { source: 'MarineTraffic', chokepoint_name: 'Suez Canal', status: 'RESTRICTED', vessel_queue: 34, transit_delay_hours: 12, narrative_context: 'Suez Canal northbound flow restricted due to maintenance dredging. 34-vessel queue, 12-hour average transit delay.' },
    { source: 'MarineTraffic', chokepoint_name: 'Panama Canal', status: 'NORMAL', vessel_queue: 18, transit_delay_hours: 8, narrative_context: 'Panama Canal draft restrictions lifted after rainfall recovery. Slot auction premiums declining. 18-vessel queue.' },
    { source: 'MarineTraffic', chokepoint_name: 'Strait of Malacca', status: 'NORMAL', vessel_queue: 12, transit_delay_hours: 2, narrative_context: 'Strait of Malacca standard traffic flow. 12-vessel queue, 2-hour transit delay.' },
    { source: 'MarineTraffic', chokepoint_name: 'Strait of Hormuz', status: 'ELEVATED RISK', vessel_queue: 8, transit_delay_hours: 4, narrative_context: 'Strait of Hormuz under elevated geopolitical tension. Insurance premiums elevated for transiting vessels.' },
    { source: 'MarineTraffic', chokepoint_name: 'Cape of Good Hope', status: 'ACTIVE DIVERSIONS', vessel_queue: null, transit_delay_hours: null, narrative_context: '15% of Asia-Europe services rerouted via Cape of Good Hope for Houthi risk mitigation. Adds 10-14 days to transit.' },
  ];

  // ── Risk Matrix ──
  const riskData = [
    { source: 'High ArchyTech Models', risk_factor: 'Red Sea / Houthi Disruption', severity: 'HIGH', probability: 'ONGOING', impact_window: 'Indefinite', narrative_context: 'Red Sea / Houthi disruption remains ongoing. Indefinite timeline. 15% of Asia-Europe services diverted via Cape of Good Hope. Insurance premiums 200-300% above baseline.' },
    { source: 'High ArchyTech Models', risk_factor: 'US-China Tariff Escalation', severity: 'CRITICAL', probability: 'HIGH', impact_window: 'Q2-Q3 2025', narrative_context: 'US-China tariff escalation probability HIGH for Q2-Q3 2025. Pre-tariff frontloading driving USEC rate spikes. Supply chain reconfiguration toward Vietnam, India accelerating.' },
    { source: 'High ArchyTech Models', risk_factor: 'Panama Canal Drought', severity: 'LOW', probability: 'RESOLVED', impact_window: 'N/A', narrative_context: 'Panama Canal drought resolved after sustained rainfall recovery. Draft restrictions lifted. Slot auction premiums normalizing.' },
    { source: 'High ArchyTech Models', risk_factor: 'Shanghai Port Congestion', severity: 'HIGH', probability: 'CONFIRMED', impact_window: '2-4 weeks', narrative_context: 'Shanghai port congestion confirmed at 147 vessels — highest since Oct 2024. Cascading delays expected on Asia-Europe services. Impact window: 2-4 weeks.' },
    { source: 'High ArchyTech Models', risk_factor: 'EU Carbon Border Tax (CBAM)', severity: 'MODERATE', probability: 'CERTAIN', impact_window: 'Oct 2025', narrative_context: 'EU CBAM implementation certain for October 2025. Will add compliance costs to carbon-intensive shipping routes. Moderate severity — manageable with advance planning.' },
    { source: 'High ArchyTech Models', risk_factor: 'IMO 2025 Fuel Regulations', severity: 'MODERATE', probability: 'CERTAIN', impact_window: 'Jan 2026', narrative_context: 'IMO 2025 fuel regulations certain for January 2026. Moderate severity — fuel surcharges expected to increase 3-5%. Carriers already adjusting fleet mix.' },
  ];

  await seedTable('freight_indices', freightData);
  await seedTable('port_congestion', portData);
  await seedTable('maritime_chokepoints', chokepointData);
  await seedTable('risk_matrix', riskData);

  console.log(`\n[SEED] ✅ Total: ${freightData.length + portData.length + chokepointData.length + riskData.length} rows seeded for tenant '${TENANT_ID}'.`);
}

// ─────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('═══════════════════════════════════════════');
  console.log(' SENTINEL ENGINE V4.5.2 — Postgres Seeder');
  console.log('═══════════════════════════════════════════');
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Database: ${DATABASE_URL.replace(/:[^:@]*@/, ':***@')}\n`);

  try {
    await createTables();
    await enforceRLS();
    await seedAll();

    // Verify counts
    console.log('\n[VERIFY] Row counts:');
    const tables = ['freight_indices', 'port_congestion', 'maritime_chokepoints', 'risk_matrix'];
    for (const t of tables) {
      const [{ count }] = await sql`SELECT COUNT(*) as count FROM ${sql(t)} WHERE tenant_id = ${TENANT_ID}`;
      console.log(`  ${t}: ${count} rows`);
    }

    console.log(`\n✅ Postgres seeding complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('   Ready for SENTINEL_TIER_MODE=POSTGRES_ONLY');

  } catch (err) {
    console.error('[FATAL]', err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
