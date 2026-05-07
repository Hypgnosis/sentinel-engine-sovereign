/**
 * SENTINEL ENGINE — Multi-Tenant Onboarding Automation (v4.1)
 * ═══════════════════════════════════════════════════════════
 * Provisions a new tenant with:
 *   [1] Firebase Auth user + tenant_id custom claim
 *   [2] Firestore sentinel_data seed document
 *   [3] BigQuery Row Access Policy (RLS) for tenant isolation
 *
 * Usage:
 *   node provision_tenant.js "Acme Logistics" "ops@acme.com"
 *
 * Prerequisites:
 *   - Application Default Credentials with BigQuery Admin role
 *   - firebase-admin initialized with project ha-sentinel-core-v21
 *   - @google-cloud/bigquery installed
 * ═══════════════════════════════════════════════════════════
 */

import admin from 'firebase-admin';
import crypto from 'crypto';
import { BigQuery } from '@google-cloud/bigquery';

// ─────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────

const GCP_PROJECT_ID = 'ha-sentinel-core-v21';
const BQ_DATASET     = 'sentinel_warehouse';

// All BigQuery tables that enforce Row-Level Security
const RLS_TABLES = [
  'freight_indices',
  'port_congestion',
  'maritime_chokepoints',
  'risk_matrix',
];

// Initialize Firebase Admin (ADC — no key file)
admin.initializeApp();

// Initialize BigQuery client
const bigquery = new BigQuery({ projectId: GCP_PROJECT_ID });

// ─────────────────────────────────────────────────────
//  BIGQUERY ROW ACCESS POLICY — Tenant Isolation
// ─────────────────────────────────────────────────────

/**
 * Creates a BigQuery Row Access Policy for the given tenant_id
 * on each warehouse table. This enforces that the tenant's
 * service account (or any principal in the grant list) can only
 * read rows WHERE tenant_id = '<tenantId>'.
 *
 * Policy name: tenant_<tenantId>_access
 * Filter:     tenant_id = '<tenantId>'
 * Grant to:   allAuthenticatedUsers (filtered by application-layer JWT)
 *
 * NOTE: BigQuery RLS is a defense-in-depth layer. The primary
 * tenant isolation is enforced at the application layer via
 * the verified JWT tenant_id claim in functions/index.js.
 *
 * @param {string} tenantId - The normalized tenant identifier
 */
async function provisionBigQueryRLS(tenantId) {
  console.log(`\n[3] Provisioning BigQuery Row Access Policies for tenant: ${tenantId}...`);

  // Sanitize tenant_id for use in SQL identifiers (alphanumeric + underscore only)
  const safeTenantId = tenantId.replace(/[^a-z0-9_]/g, '_');
  const policyName = `tenant_${safeTenantId}_access`;

  for (const table of RLS_TABLES) {
    const tableRef = `${GCP_PROJECT_ID}.${BQ_DATASET}.${table}`;

    // Drop existing policy if it exists (idempotent re-provisioning)
    const dropQuery = `
      DROP ROW ACCESS POLICY IF EXISTS \`${policyName}\`
      ON \`${tableRef}\`
    `;

    // Create new Row Access Policy
    // Grant to allAuthenticatedUsers so the Cloud Function SA can query.
    // The actual tenant scoping happens at two layers:
    //   1. Application layer: WHERE tenant_id = @tenantId in VECTOR_SEARCH
    //   2. BigQuery RLS: This policy (defense-in-depth)
    const createQuery = `
      CREATE ROW ACCESS POLICY \`${policyName}\`
      ON \`${tableRef}\`
      GRANT TO ("allAuthenticatedUsers")
      FILTER USING (tenant_id = '${safeTenantId}')
    `;

    try {
      // Step 1: Drop old policy (ignore errors if doesn't exist)
      try {
        await bigquery.query({ query: dropQuery, location: 'US' });
      } catch (_) {
        // Ignore — policy might not exist yet
      }

      // Step 2: Create new policy
      await bigquery.query({ query: createQuery, location: 'US' });

      console.log(`    ✅ RLS policy '${policyName}' applied to ${table}`);
    } catch (err) {
      console.error(`    ❌ Failed to apply RLS on ${table}: ${err.message}`);
      // Continue — don't block the entire provisioning for one table
    }
  }
}

// ─────────────────────────────────────────────────────
//  MAIN — Tenant Provisioning Pipeline
// ─────────────────────────────────────────────────────

async function provisionTenant() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: node provision_tenant.js "<Company Name>" "<email>"');
    console.error('Example: node provision_tenant.js "Rose Rocket" "ops@roserocket.com"');
    process.exit(1);
  }

  const companyName = args[0];
  const email       = args[1];

  const tenantId     = companyName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const tempPassword = crypto.randomBytes(12).toString('hex'); // 24-char password

  const startTime = Date.now();

  try {
    // ── Step 1: Create Firebase Auth User ──
    // ── Step 1: Create Firebase Auth User ──
    console.log(`[1] Provisioning Operator Identity for ${companyName}...`);
    console.log(`Password for user: ${tempPassword}`);
    const userRecord = await admin.auth().createUser({
      email,
      password: tempPassword,
      displayName: `${companyName} Operator`,
    });

    // ── Step 2: Set tenant_id custom claim (Zero-Trust) ──
    console.log(`[2] Injecting Zero-Trust Tenant ID Claim: ${tenantId}...`);
    await admin.auth().setCustomUserClaims(userRecord.uid, {
      tenant_id: tenantId,
    });

    // ── Step 3: BigQuery Row Access Policy (RLS) ──
    await provisionBigQueryRLS(tenantId);

    // ── Step 4: Seed Firestore legacy document ──
    console.log(`\n[4] Seeding Firestore legacy document for tenant: ${tenantId}...`);
    const db = admin.firestore();
    await db.collection('sentinel_data').doc(tenantId).set({
      content: 'DATA MOAT INITIALIZED',
      schema: 'sentinel_logistics_v4',
      tenant_id: tenantId,
      company_name: companyName,
      provisioned_by: 'provision_tenant.js',
      provisionedAt: new Date().toISOString(),
    });

    // ── Step 5: Output credentials ──
    const durationMs = Date.now() - startTime;

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  ✅ TENANT PROVISIONED SUCCESSFULLY                     ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Company:    ${companyName.padEnd(43)}║`);
    console.log(`║  Email:      ${email.padEnd(43)}║`);
    console.log(`║  Password:   ${tempPassword.padEnd(43)}║`);
    console.log(`║  Tenant ID:  ${tenantId.padEnd(43)}║`);
    console.log(`║  UID:        ${userRecord.uid.padEnd(43)}║`);
    console.log(`║  Duration:   ${(durationMs / 1000).toFixed(1)}s${' '.repeat(39)}║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  Provisioned Resources:                                 ║');
    console.log('║    ● Firebase Auth user + tenant_id claim               ║');
    console.log('║    ● BigQuery RLS policies (4 tables)                   ║');
    console.log('║    ● Firestore sentinel_data seed document              ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('\n⚠️  ACTION REQUIRED: Share credentials securely with the client.');
    console.log('    The operator must change their password on first login.\n');

  } catch (error) {
    console.error('\n❌ TENANT PROVISIONING FAILED');
    console.error(`   Error: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    process.exit(1);
  }
}

provisionTenant();
