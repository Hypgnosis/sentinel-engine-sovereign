/**
 * Fetch latest verification results from Cloud SQL
 */
const postgres = require('postgres');

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    return;
  }

  const sql = postgres(url, { ssl: 'require' });

  try {
    console.log('--- SENTINEL AUDIT: LATEST VERIFICATION RESULTS ---\n');
    const rows = await sql`
      SELECT request_id, tenant_id, is_verified, discrepancies, verification_notes, verified_at
      FROM verification_results
      ORDER BY verified_at DESC
      LIMIT 5
    `;

    if (rows.length === 0) {
      console.log('No verification logs found.');
      return;
    }

    rows.forEach((row, i) => {
      const status = row.is_verified === true ? '✅ VERIFIED' : row.is_verified === false ? '❌ FLAG_DETECTED' : '⚠️ UNCERTAIN';
      console.log(`[${i+1}] REQUEST: ${row.request_id} | TENANT: ${row.tenant_id}`);
      console.log(`    VERDICT: ${status}`);
      console.log(`    TIMESTAMP: ${row.verified_at.toISOString()}`);
      console.log(`    NOTES: ${row.verification_notes}`);
      
      const disc = row.discrepancies;
      if (disc && disc.length > 0) {
        console.log(`    DISCREPANCIES (${disc.length}):`);
        disc.forEach(d => console.log(`      - ${d}`));
      } else {
        console.log('    DISCREPANCIES: None - Narrative aligns with sources.');
      }
      console.log('-----------------------------------------------------\n');
    });

  } catch (err) {
    console.error('Audit failed:', err.message);
  } finally {
    await sql.end();
  }
}

run();
