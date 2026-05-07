const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});
async function alter() {
  await pool.query(`
    ALTER TABLE standing_authority_matrix 
    RENAME COLUMN authority_id TO unit_id;
  `);
  await pool.query(`
    ALTER TABLE standing_authority_matrix 
    ADD COLUMN IF NOT EXISTS config JSONB,
    ADD COLUMN IF NOT EXISTS grantor_id TEXT,
    ADD COLUMN IF NOT EXISTS signature TEXT;
  `);
  console.log('Schema updated successfully');
  process.exit(0);
}
alter().catch(e => { console.error(e); process.exit(1); });
