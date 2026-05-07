import { execSync } from 'child_process';

const queries = [
    "SELECT COUNT(*) FROM sentinel_warehouse.freight_indices WHERE ingested_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)",
    "SELECT COUNT(*) FROM sentinel_warehouse.port_congestion WHERE ingested_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)",
    "SELECT COUNT(*) FROM sentinel_warehouse.maritime_chokepoints WHERE ingested_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)",
    "SELECT COUNT(*) FROM sentinel_warehouse.risk_matrix WHERE ingested_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)"
];

const projectId = 'ha-sentinel-core-v21';

queries.forEach(query => {
    try {
        console.log(`Running: ${query}`);
        const output = execSync(`bq query --use_legacy_sql=false --project_id=${projectId} --format=json "${query}"`).toString();
        const result = JSON.parse(output);
        console.log(`Result: ${result[0].f0_} rows fresh.`);
    } catch (e) {
        console.error(`Error: ${e.message}`);
    }
});
