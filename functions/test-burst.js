const { getSql } = require('./db');
const crypto = require('crypto');

async function runBurstTest() {
  const sql = getSql();
  if (!sql) {
    console.error('No DB connection.');
    process.exit(1);
  }

  console.log('Generating 1,000 Monotonic Reduction events...');
  
  const startTime = Date.now();
  const requestIds = [];
  
  // Insert 1000 requests first to satisfy foreign key constraints
  for (let i = 0; i < 1000; i++) {
    const id = crypto.randomUUID();
    requestIds.push(id);
  }

  // Use a transaction/batch insert for speed of the setup
  await sql`
    INSERT INTO arbitration_requests (id, requesting_agent, action, context, target_domain)
    SELECT * FROM UNNEST (
      ${sql.array(requestIds)}::uuid[],
      ${sql.array(Array(1000).fill('BurstAgent'))}::text[],
      ${sql.array(Array(1000).fill('STRESS_TEST'))}::text[],
      ${sql.array(Array(1000).fill({ test: true }))}::jsonb[],
      ${sql.array(Array(1000).fill('Core'))}::text[]
    )
  `;

  // Now insert 1000 governance findings
  // Out of 1000, 1 will have the specific trigger we will search for.
  const triggers = Array(1000).fill('CPU_OVERLOAD');
  triggers[420] = 'CRITICAL_CORE_BREACH_77';

  await sql`
    INSERT INTO governance_findings (request_id, trigger, action, attenuated_scope, supervisor_timeout)
    SELECT * FROM UNNEST (
      ${sql.array(requestIds)}::uuid[],
      ${sql.array(triggers)}::text[],
      ${sql.array(Array(1000).fill('attenuate'))}::text[],
      ${sql.array(Array(1000).fill({ limit: 50 }))}::jsonb[],
      ${sql.array(Array(1000).fill(false))}::boolean[]
    )
  `;

  console.log(`Setup complete in ${Date.now() - startTime}ms. Beginning audit...`);

  // Run the SELECT query
  const queryStart = process.hrtime.bigint();
  
  const result = await sql`
    SELECT * FROM governance_findings
    WHERE trigger = 'CRITICAL_CORE_BREACH_77'
  `;

  const queryEnd = process.hrtime.bigint();
  const latencyMs = Number(queryEnd - queryStart) / 1e6;

  console.log(`Audit query returned ${result.length} result(s).`);
  console.log(`Latency: ${latencyMs.toFixed(3)}ms`);

  if (latencyMs < 10) {
    console.log('✅ Civilization-Grade audit system achieved (<10ms).');
  } else {
    console.log('⚠️ Latency above 10ms. Tuning required.');
  }

  await sql.end();
}

runBurstTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
