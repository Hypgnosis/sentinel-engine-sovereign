const postgres = require('postgres');

// Test Cloud SQL connection through the proxy
const sql = postgres({
  host: '127.0.0.1',
  port: 5433,
  user: 'sentinel',
  pass: '53ntin3l3ng1n3v5.2',
  database: 'sentinel_reservoir',
  ssl: false,
  max: 1,
  connect_timeout: 10,
});

async function test() {
  try {
    const result = await sql.unsafe('SELECT current_user, current_database()');
    console.log('Cloud SQL SUCCESS:', result[0]);
  } catch (err) {
    console.error('Cloud SQL FAIL:', err.message);
  } finally {
    await sql.end();
  }
}

test();
