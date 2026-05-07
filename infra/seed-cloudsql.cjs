/**
 * PROJECT SUB-ZERO — Cloud SQL Seeder
 * ═══════════════════════════════════════════════════════════
 * Seeds the Pristine Reservoir on GCP Cloud SQL with the same
 * data that was in Supabase. Runs via the Cloud SQL Auth Proxy.
 *
 * USAGE:
 *   node infra/seed-cloudsql.cjs
 * 
 * REQUIRES:
 *   - Cloud SQL Auth Proxy running on port 5433
 *   - CLOUDSQL_PASSWORD env var (or uses default)
 *   - GOOGLE_CLOUD_PROJECT or ADC for Vertex AI embeddings
 */

const postgres = require('postgres');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────
const CLOUDSQL_HOST = process.env.CLOUDSQL_HOST || '127.0.0.1';
const CLOUDSQL_PORT = parseInt(process.env.CLOUDSQL_PORT || '5433');
const CLOUDSQL_USER = process.env.CLOUDSQL_USER || 'sentinel';
const CLOUDSQL_PASSWORD = process.env.CLOUDSQL_PASSWORD || '53ntin3l3ng1n3v5.2';
const CLOUDSQL_DB = process.env.CLOUDSQL_DB || 'sentinel_reservoir';

const TENANT_ID = 'rose_rocket';
const EMBEDDING_DIM = 768;

const sql = postgres({
  host: CLOUDSQL_HOST,
  port: CLOUDSQL_PORT,
  user: CLOUDSQL_USER,
  pass: CLOUDSQL_PASSWORD,
  database: CLOUDSQL_DB,
  ssl: false, // Auth Proxy handles encryption
  max: 5,
  connect_timeout: 30,
});

// ─── Embedding Generation ────────────────────────────
let ai = null;
async function getAI() {
  if (!ai) {
    const { GoogleGenAI } = await import('@google/genai');
    ai = new GoogleGenAI({
      vertexai: true,
      project: 'ha-sentinel-core-v21',
      location: 'us-central1',
    });
  }
  return ai;
}

async function generateEmbedding(text) {
  try {
    const client = await getAI();
    const response = await client.models.embedContent({
      model: 'text-embedding-004',
      contents: text,
      config: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: EMBEDDING_DIM },
    });
    return response.embeddings[0].values;
  } catch (err) {
    console.warn(`    ⚠ Embedding generation failed: ${err.message.substring(0, 60)}`);
    // Return a zero vector as fallback — can be re-embedded later
    return new Array(EMBEDDING_DIM).fill(0);
  }
}

function entityHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').substring(0, 16);
}

// ─── Step 0: Schema ──────────────────────────────────
async function createSchema() {
  console.log('\n[STEP 0] Creating schema on Cloud SQL...');

  await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  console.log('  ✓ pgvector extension enabled');

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS freight_indices (
      id SERIAL PRIMARY KEY,
      entity_hash TEXT UNIQUE NOT NULL,
      tenant_id TEXT NOT NULL,
      source TEXT NOT NULL,
      route_origin TEXT,
      route_destination TEXT,
      rate_usd NUMERIC,
      week_over_week_change NUMERIC,
      trend TEXT,
      narrative_context TEXT NOT NULL,
      embedding vector(768),
      ingested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS port_congestion (
      id SERIAL PRIMARY KEY,
      entity_hash TEXT UNIQUE NOT NULL,
      tenant_id TEXT NOT NULL,
      source TEXT NOT NULL,
      port_name TEXT NOT NULL,
      vessels_at_anchor INTEGER,
      avg_wait_days NUMERIC,
      severity_level TEXT,
      narrative_context TEXT NOT NULL,
      embedding vector(768),
      ingested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS maritime_chokepoints (
      id SERIAL PRIMARY KEY,
      entity_hash TEXT UNIQUE NOT NULL,
      tenant_id TEXT NOT NULL,
      source TEXT NOT NULL,
      chokepoint_name TEXT NOT NULL,
      status TEXT,
      vessel_queue INTEGER,
      transit_delay_hours NUMERIC,
      narrative_context TEXT NOT NULL,
      embedding vector(768),
      ingested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS risk_matrix (
      id SERIAL PRIMARY KEY,
      entity_hash TEXT UNIQUE NOT NULL,
      tenant_id TEXT NOT NULL,
      source TEXT NOT NULL,
      risk_factor TEXT NOT NULL,
      severity TEXT,
      probability TEXT,
      impact_window TEXT,
      narrative_context TEXT NOT NULL,
      embedding vector(768),
      ingested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS subject_revocation_list (
      subject_id TEXT PRIMARY KEY,
      revocation_reason TEXT,
      revoked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      revoked_by TEXT
    )
  `);

  console.log('  ✓ All 5 tables created');
}

// ─── Step 1: Seed Data ───────────────────────────────
async function seedTable(tableName, rows) {
  console.log(`\n  Seeding ${tableName} (${rows.length} rows)...`);

  for (const row of rows) {
    const narrative = row.narrative_context || JSON.stringify(row);
    const hash = entityHash({ ...row, tenant_id: TENANT_ID });
    const embedding = await generateEmbedding(narrative);
    const vectorStr = `[${embedding.join(',')}]`;

    const fullRow = { ...row, tenant_id: TENANT_ID, entity_hash: hash };

    try {
      await sql`
        INSERT INTO ${sql(tableName)} ${sql(fullRow)}
        ON CONFLICT (entity_hash) DO UPDATE SET
          narrative_context = EXCLUDED.narrative_context,
          ingested_at = CURRENT_TIMESTAMP
      `;
      await sql.unsafe(
        `UPDATE ${tableName} SET embedding = '${vectorStr}' WHERE entity_hash = '${hash}'`
      );
      const label = row.route_origin || row.port_name || row.chokepoint_name || row.risk_factor || 'row';
      console.log(`    ✓ ${label}`);
    } catch (err) {
      console.error(`    ✗ Failed: ${err.message.substring(0, 80)}`);
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

  const total = freightData.length + portData.length + chokepointData.length + riskData.length;
  console.log(`\n  Total: ${total} rows seeded for tenant '${TENANT_ID}'`);
}

// ─── Step 2: Indexes ─────────────────────────────────
async function createIndexes() {
  console.log('\n[STEP 2] Creating vector + tenant indexes...');

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_freight_vector ON freight_indices USING hnsw (embedding vector_cosine_ops)',
    'CREATE INDEX IF NOT EXISTS idx_port_vector ON port_congestion USING hnsw (embedding vector_cosine_ops)',
    'CREATE INDEX IF NOT EXISTS idx_choke_vector ON maritime_chokepoints USING hnsw (embedding vector_cosine_ops)',
    'CREATE INDEX IF NOT EXISTS idx_risk_vector ON risk_matrix USING hnsw (embedding vector_cosine_ops)',
    'CREATE INDEX IF NOT EXISTS idx_freight_tenant ON freight_indices(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_port_tenant ON port_congestion(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_choke_tenant ON maritime_chokepoints(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_risk_tenant ON risk_matrix(tenant_id)',
  ];

  for (const ddl of indexes) {
    try {
      await sql.unsafe(ddl);
      const name = ddl.match(/idx_\w+/)?.[0] || 'index';
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.warn(`  ⚠ ${err.message.substring(0, 60)}`);
    }
  }
}

// ─── Step 3: Verify ──────────────────────────────────
async function verify() {
  console.log('\n[STEP 3] Verifying row counts:');
  const tables = ['freight_indices', 'port_congestion', 'maritime_chokepoints', 'risk_matrix'];

  for (const table of tables) {
    try {
      const [row] = await sql.unsafe(`SELECT COUNT(*)::int as count FROM ${table}`);
      console.log(`  ${table}: ${row.count} rows`);
    } catch (err) {
      console.log(`  ${table}: ERROR (${err.message.substring(0, 40)})`);
    }
  }
}

// ─── Main ────────────────────────────────────────────
async function main() {
  const t0 = Date.now();

  console.log('═══════════════════════════════════════════════════════');
  console.log('  PROJECT SUB-ZERO: Cloud SQL Seeder');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Target: Cloud SQL (${CLOUDSQL_HOST}:${CLOUDSQL_PORT})`);
  console.log(`  Tenant: ${TENANT_ID}`);
  console.log('═══════════════════════════════════════════════════════\n');

  try {
    // Test connection
    console.log('[CONNECT] Testing Cloud SQL connection...');
    const [r] = await sql.unsafe('SELECT current_user, current_database()');
    console.log(`  ✓ Connected as ${r.current_user} to ${r.current_database}`);

    await createSchema();

    console.log('\n[STEP 1] Seeding data with Vertex AI embeddings...');
    await seedAll();

    await createIndexes();
    await verify();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  ✅ RESERVOIR SEEDING COMPLETE');
    console.log(`  Duration: ${elapsed}s`);
    console.log('');
    console.log('  Next steps:');
    console.log('    1. Update DATABASE_URL in Secret Manager');
    console.log('    2. Set INSTANCE_CONNECTION_NAME');
    console.log('    3. Deploy the Cloud Function');
    console.log('    4. Disable public IP: gcloud sql instances patch sentinel-reservoir --no-assign-ip');
    console.log('═══════════════════════════════════════════════════════');

  } catch (err) {
    console.error('\n[FATAL] Seeding failed:', err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
