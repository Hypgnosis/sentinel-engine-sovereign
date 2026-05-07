require('dotenv').config();
const { getSql, postgresVectorSearch } = require('./db');
const { Firestore } = require('@google-cloud/firestore');

async function runIntegrationTest() {
  console.log('[TEST] Starting full-stack integration test...');
  
  // 1. Test Postgres Connectivity
  console.log('\n--- Postgres Connectivity Test ---');
  const sql = getSql();
  if (!sql) {
    console.error('❌ Failed to initialize SQL connection.');
  } else {
    try {
      const [{ version }] = await sql`SELECT version();`;
      console.log('✅ Connected to Postgres:', version.substring(0, 50) + '...');
      
      // Perform a dummy vector search (0-vector) to test query execution
      const dummyVector = new Array(768).fill(0);
      try {
        const result = await postgresVectorSearch(dummyVector, 'test-tenant-123');
        console.log(`✅ Postgres Vector Search successful. Found ${result.resultCount} results.`);
      } catch (e) {
         if (e.message.includes('relation "document_embeddings" does not exist') || e.message.includes('column')) {
            console.log('⚠️ Postgres Vector Search table might not be seeded, but connection works.', e.message);
         } else {
            console.error('❌ Postgres Vector Search failed:', e.message);
         }
      }
    } catch (e) {
      console.error('❌ Postgres connection error:', e.message);
    }
  }

  // 2. Test Firestore Connectivity
  console.log('\n--- Firestore Connectivity Test ---');
  try {
    const firestore = new Firestore({ projectId: process.env.GCP_PROJECT || 'ha-sentinel-core-v21' });
    const collections = await firestore.listCollections();
    console.log(`✅ Connected to Firestore. Found ${collections.length} collections.`);
    
    const doc = await firestore.collection('sentinel_data').doc('source_alpha').get();
    if (doc.exists) {
        console.log('✅ Legacy source_alpha document exists.');
    } else {
        console.log('⚠️ Legacy source_alpha document does not exist, but connection works.');
    }
  } catch (e) {
    console.error('❌ Firestore connection error:', e.message);
  }
  
  console.log('\n[TEST] Integration checks completed.');
  process.exit(0);
}

runIntegrationTest();
