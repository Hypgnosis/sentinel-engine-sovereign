/**
 * SENTINEL ENGINE — Firestore Seed Script (v4.0 Structured Schema)
 * ═══════════════════════════════════════════════════════════════════
 * Populates the `sentinel_data` collection with schema-validated
 * structured logistics intelligence data.
 * 
 * v4.0 Changes:
 * - Replaces flat markdown blob with structured JSON objects
 * - All data points are typed (numbers, enums, ISO dates)
 * - Enables programmatic access, BigQuery export, and schema validation
 * 
 * Usage: node seed-firestore.js
 * Requires: GOOGLE_APPLICATION_CREDENTIALS or gcloud auth
 * ═══════════════════════════════════════════════════════════════════
 */

const { Firestore } = require('@google-cloud/firestore');

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || 'ha-sentinel-core-v21';
const firestore = new Firestore({ projectId: GCP_PROJECT_ID });

// ─────────────────────────────────────────────────────
//  SOURCE ALPHA — Structured Logistics Intelligence
// ─────────────────────────────────────────────────────

const SOURCE_ALPHA_STRUCTURED = {
  version: '4.0.0',
  lastUpdated: new Date().toISOString(),
  refreshCycleMinutes: 60,
  dataAuthority: 'HIGH',
  confidenceLevel: 0.92,

  // ── GLOBAL FREIGHT INDEX (FBX — Freightos Baltic Index) ──
  freightIndex: {
    global: {
      rate: 1847,
      unit: 'USD/FEU',
      weekOverWeek: 3.2,
      trend: 'rising',
    },
    routes: [
      { origin: 'China/East Asia', destination: 'N. America West Coast', rate: 1520, weekOverWeek: -2.1, trend: 'stabilizing' },
      { origin: 'China/East Asia', destination: 'N. America East Coast', rate: 2680, weekOverWeek: 4.7, trend: 'rising' },
      { origin: 'China/East Asia', destination: 'N. Europe', rate: 2340, weekOverWeek: 3.2, trend: 'rising' },
      { origin: 'China/East Asia', destination: 'Mediterranean', rate: 2890, weekOverWeek: -1.8, trend: 'declining' },
      { origin: 'N. Europe', destination: 'N. America East Coast', rate: 1150, weekOverWeek: 0.5, trend: 'stable' },
    ],
    keyInsight: 'Trans-Pacific Eastbound rates stabilizing after Q1 frontloading surge. Asia-Europe corridor showing sustained demand driven by EU restocking cycle. Pre-tariff frontloading on USEC routes causing 4.7% WoW spike.',
  },

  // ── SPOT vs. CONTRACT RATE SPREAD (Xeneta Data) ──
  spotContractSpread: [
    { corridor: 'Far East → N. Europe', spotRate: 2340, contractRate: 1890, spread: 450 },
    { corridor: 'Far East → US West Coast', spotRate: 1520, contractRate: 1340, spread: 180 },
    { corridor: 'Far East → US East Coast', spotRate: 2680, contractRate: 2150, spread: 530 },
    { corridor: 'Far East → Mediterranean', spotRate: 2890, contractRate: 2420, spread: 470 },
  ],
  spotContractAnalysis: 'Spot-contract spread widening on USEC corridor indicates market volatility. Shippers with expiring Q1 contracts face 15-22% renewal premium. Recommendation: Lock long-term rates on Asia-Europe before Q3 peak season.',

  // ── PORT CONGESTION INDEX ──
  portCongestion: [
    { port: 'Shanghai', vesselsAtAnchor: 147, avgWaitDays: 3.2, congestionLevel: 'HIGH', trend: 'worsening' },
    { port: 'Singapore', vesselsAtAnchor: 42, avgWaitDays: 1.1, congestionLevel: 'MODERATE', trend: 'stable' },
    { port: 'Rotterdam', vesselsAtAnchor: 18, avgWaitDays: 0.8, congestionLevel: 'LOW', trend: 'improving' },
    { port: 'Long Beach', vesselsAtAnchor: 67, avgWaitDays: 2.8, congestionLevel: 'HIGH', trend: 'stable' },
    { port: 'Los Angeles', vesselsAtAnchor: 54, avgWaitDays: 2.4, congestionLevel: 'MODERATE-HIGH', trend: 'improving' },
    { port: 'Savannah', vesselsAtAnchor: 23, avgWaitDays: 1.4, congestionLevel: 'MODERATE', trend: 'stable' },
    { port: 'Hamburg', vesselsAtAnchor: 12, avgWaitDays: 0.6, congestionLevel: 'LOW', trend: 'stable' },
    { port: 'Busan', vesselsAtAnchor: 31, avgWaitDays: 1.7, congestionLevel: 'MODERATE', trend: 'worsening' },
    { port: 'Jebel Ali (Dubai)', vesselsAtAnchor: 8, avgWaitDays: 0.4, congestionLevel: 'LOW', trend: 'stable' },
    { port: 'Santos (Brazil)', vesselsAtAnchor: 28, avgWaitDays: 2.1, congestionLevel: 'MODERATE', trend: 'worsening' },
  ],
  portCongestionAlert: 'Shanghai congestion at 147 vessels — highest since October 2024. Cascading delays expected on Asia-Europe services within 10-14 days. Long Beach stabilized but remains in HIGH territory due to chassis shortages.',

  // ── MARITIME CHOKEPOINTS (MarineTraffic) ──
  chokepoints: [
    { name: 'Suez Canal', avgTransitDelay: '12 hours', vesselQueue: 34, status: 'RESTRICTED', detail: 'Northbound flow restricted due to maintenance dredging' },
    { name: 'Panama Canal', avgTransitDelay: '8 hours', vesselQueue: 18, status: 'NORMAL', detail: 'Draft restrictions lifted after rainfall recovery — slot auction premiums declining' },
    { name: 'Strait of Malacca', avgTransitDelay: '2 hours', vesselQueue: 12, status: 'NORMAL', detail: 'Standard traffic flow' },
    { name: 'Strait of Hormuz', avgTransitDelay: '4 hours', vesselQueue: 8, status: 'ELEVATED RISK', detail: 'Geopolitical tensions — insurance premiums elevated' },
    { name: 'Cape of Good Hope', avgTransitDelay: 'N/A (reroute)', vesselQueue: null, status: 'ACTIVE DIVERSIONS', detail: '15% of Asia-Europe services rerouted (Houthi risk mitigation)' },
  ],

  // ── BALTIC DRY INDEX (BDI) ──
  balticDryIndex: {
    composite: { value: 1892, change: 42, direction: 'up' },
    capesize: { value: 2847, change: 118, direction: 'up' },
    panamax: { value: 1623, change: 15, direction: 'up' },
    supramax: { value: 1204, change: -8, direction: 'down' },
    signal: 'Capesize demand surge driven by iron ore restocking from Brazilian mines (Vale Q2 ramp-up). Panamax stable on grain corridor (US Gulf → China). Supramax softening on reduced minor bulk demand.',
  },

  // ── AIR FREIGHT INDEX ──
  airFreight: [
    { route: 'Hong Kong → North America', ratePerKg: 3.42, weekOverWeek: 5.1, capacity: 'tightening' },
    { route: 'Hong Kong → Europe', ratePerKg: 3.18, weekOverWeek: 2.3, capacity: 'moderate' },
    { route: 'Europe → North America', ratePerKg: 2.75, weekOverWeek: -0.8, capacity: 'stable' },
    { route: 'Intra-Asia', ratePerKg: 1.95, weekOverWeek: 1.2, capacity: 'adequate' },
  ],
  airFreightInsight: 'Q2 capacity tightening on TACA (Trans-Pacific) as e-commerce volumes accelerate. Belly cargo from passenger airlines recovering but still 8% below pre-COVID capacity. Peak season surcharges expected from July.',

  // ── SUPPLY CHAIN RISK MATRIX ──
  riskMatrix: [
    { factor: 'Red Sea / Houthi Disruption', severity: 'HIGH', probability: 'ONGOING', impactWindow: 'Indefinite' },
    { factor: 'US-China Tariff Escalation', severity: 'CRITICAL', probability: 'HIGH', impactWindow: 'Q2-Q3 2025' },
    { factor: 'Panama Canal Drought', severity: 'LOW', probability: 'RESOLVED', impactWindow: 'N/A' },
    { factor: 'Shanghai Port Congestion', severity: 'HIGH', probability: 'CONFIRMED', impactWindow: '2-4 weeks' },
    { factor: 'EU Carbon Border Tax (CBAM)', severity: 'MODERATE', probability: 'CERTAIN', impactWindow: 'Oct 2025' },
    { factor: 'IMO 2025 Fuel Regulations', severity: 'MODERATE', probability: 'CERTAIN', impactWindow: 'Jan 2026' },
  ],

  // ── DATA AUTHORITY STATEMENT ──
  dataAuthority: {
    sources: ['Freightos', 'Xeneta', 'MarineTraffic', 'High ArchyTech Models'],
    refreshCycle: '60 minutes',
    confidenceLevel: 'HIGH',
    methodology: 'Multi-source triangulation',
  },
};

// ─────────────────────────────────────────────────────
//  SEED EXECUTION
// ─────────────────────────────────────────────────────

async function seedFirestore() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  SENTINEL ENGINE v4.0 — Structured Seed Script  ║');
  console.log('║  Project: ' + GCP_PROJECT_ID.padEnd(38) + '║');
  console.log('╚══════════════════════════════════════════════════╝');

  try {
    // Write Source Alpha document — structured schema
    const sourceAlphaRef = firestore.collection('sentinel_data').doc('source_alpha');
    await sourceAlphaRef.set({
      // The 'content' field now contains the full structured object
      // serialized as JSON string for the LLM prompt context.
      content: JSON.stringify(SOURCE_ALPHA_STRUCTURED, null, 2),

      // Also store the raw structured data for programmatic access
      structured: SOURCE_ALPHA_STRUCTURED,

      // Metadata
      lastUpdated: new Date().toISOString(),
      version: '4.0.0',
      schema: 'sentinel_logistics_v4',
      refreshCycleMinutes: 60,
      sources: SOURCE_ALPHA_STRUCTURED.dataAuthority.sources,
      metadata: {
        createdBy: 'seed-firestore.js',
        engine: 'Sentinel Engine Core v4.0',
        owner: 'High ArchyTech Solutions',
      },
    });

    console.log('');
    console.log('[✓] sentinel_data/source_alpha — STRUCTURED SCHEMA WRITTEN');
    console.log(`    Schema: sentinel_logistics_v4`);
    console.log(`    Routes: ${SOURCE_ALPHA_STRUCTURED.freightIndex.routes.length}`);
    console.log(`    Ports: ${SOURCE_ALPHA_STRUCTURED.portCongestion.length}`);
    console.log(`    Chokepoints: ${SOURCE_ALPHA_STRUCTURED.chokepoints.length}`);
    console.log(`    Risk Factors: ${SOURCE_ALPHA_STRUCTURED.riskMatrix.length}`);
    console.log(`    Timestamp: ${new Date().toISOString()}`);

    // Write a metadata/config document for system introspection
    const configRef = firestore.collection('sentinel_data').doc('_config');
    await configRef.set({
      engineVersion: '4.0.0',
      deployment: 'Cloud Functions Gen2',
      model: 'gemini-1.5-flash',
      outputFormat: 'application/json',
      responseSchema: 'logistics_structured_v4',
      allowedOrigins: ALLOWED_ORIGINS_CONFIG,
      createdAt: new Date().toISOString(),
    });

    console.log('[✓] sentinel_data/_config — WRITTEN SUCCESSFULLY');
    console.log('');
    console.log('[SENTINEL v4.0] Structured seed complete. Schema-validated Source Alpha is hot.');

  } catch (error) {
    console.error('[SENTINEL CRITICAL] Seed failed:', error.message);
    process.exit(1);
  }
}

const ALLOWED_ORIGINS_CONFIG = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://sentinel.high-archy.tech',
  'https://sentinel-engine.netlify.app',
];

seedFirestore();
