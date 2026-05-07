/**
 * SENTINEL ENGINE V5.5 — Shard Provisioner
 * ═══════════════════════════════════════════════════════════
 * Provisions a tenant's shard entry in the Governance Hub.
 * For Tier 1 (Enterprise) tenants, the Cloud SQL instance must
 * be pre-provisioned via Terraform (terraform/sharding.tf).
 *
 * Usage:
 *   # Tier 3 (Sandbox — Row-Level, shared DB)
 *   node scripts/provision_shard.js "acme_logistics" "Acme Logistics" --tier 3
 *
 *   # Tier 2 (Dev — Schema-Level, separate schema on shared instance)
 *   node scripts/provision_shard.js "acme_logistics" "Acme Logistics" --tier 2
 *
 *   # Tier 1 (Production — Dedicated shard, pre-provisioned via TF)
 *   node scripts/provision_shard.js "acme_logistics" "Acme Logistics" --tier 1 \
 *     --shard-instance "ha-sentinel-core-v21:us-central1:sentinel-shard-acme-logistics"
 *
 * Prerequisites:
 *   - DATABASE_URL pointing to the Governance Hub
 *   - For Tier 1: Cloud SQL shard instance already provisioned
 *   - Application Default Credentials
 * ═══════════════════════════════════════════════════════════
 */

const postgres = require('postgres');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────

const TIER_DEFAULTS = {
  3: {
    isolationLevel: 'ROW_LEVEL',
    maxQueriesPerMinute: 100,
    maxStorageBytes: 1073741824,  // 1 GB
    storagePrefixTemplate: '/artifacts/sentinel/users/{uid}/sandbox',
  },
  2: {
    isolationLevel: 'SCHEMA_LEVEL',
    maxQueriesPerMinute: 350,
    maxStorageBytes: 10737418240,  // 10 GB
    storagePrefixTemplate: '/artifacts/sentinel/public/data/dev_skill_graph',
  },
  1: {
    isolationLevel: 'DEDICATED_SHARD',
    maxQueriesPerMinute: 1000,
    maxStorageBytes: 107374182400,  // 100 GB
    storagePrefixTemplate: null,  // Set from shard instance ID
  },
};

// Default skills granted to new tenants (rank 2 = AUTO_APPROVE)
const DEFAULT_SKILLS = [
  { name: 'sentinel:inference', rank: 2, grantedBy: 'system' },
  { name: 'sentinel:vector_search', rank: 2, grantedBy: 'system' },
  { name: 'sentinel:cache_read', rank: 2, grantedBy: 'system' },
  { name: 'sentinel:cache_write', rank: 2, grantedBy: 'system' },
  { name: 'sentinel:audit_read', rank: 1, grantedBy: 'system' },  // Requires audit
  { name: 'sentinel:evidence_write', rank: 1, grantedBy: 'system' },
  { name: 'sentinel:escalation_create', rank: 1, grantedBy: 'system' },
  { name: 'sentinel:tenant_admin', rank: 0, grantedBy: 'system' },  // Denied by default
  { name: 'sentinel:shard_migrate', rank: 0, grantedBy: 'system' },
];

// ─────────────────────────────────────────────────────
//  ARGUMENT PARSING
// ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node provision_shard.js "<tenant_id>" "<Tenant Name>" [options]');
    console.error('');
    console.error('Options:');
    console.error('  --tier <1|2|3>               Database tier (default: 3)');
    console.error('  --shard-instance <conn_name>  Cloud SQL instance (required for Tier 1)');
    console.error('  --shard-dsn <dsn>            DATABASE_URL for the shard (Tier 1)');
    console.error('  --max-qpm <number>           Override max queries per minute');
    console.error('');
    console.error('Examples:');
    console.error('  node provision_shard.js "acme" "Acme Corp" --tier 3');
    console.error('  node provision_shard.js "acme" "Acme Corp" --tier 1 --shard-instance "proj:region:instance"');
    process.exit(1);
  }

  const tenantId = args[0];
  const tenantName = args[1];
  
  let tier = 3;
  let shardInstance = null;
  let shardDsn = null;
  let maxQpm = null;

  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case '--tier':
        tier = parseInt(args[++i], 10);
        if (![1, 2, 3].includes(tier)) {
          console.error('ERROR: --tier must be 1, 2, or 3.');
          process.exit(1);
        }
        break;
      case '--shard-instance':
        shardInstance = args[++i];
        break;
      case '--shard-dsn':
        shardDsn = args[++i];
        break;
      case '--max-qpm':
        maxQpm = parseInt(args[++i], 10);
        break;
    }
  }

  if (tier === 1 && !shardInstance) {
    console.error('ERROR: Tier 1 (Enterprise) requires --shard-instance.');
    console.error('Provision the shard first via: terraform apply -var="enterprise_shards={...}"');
    process.exit(1);
  }

  return { tenantId, tenantName, tier, shardInstance, shardDsn, maxQpm };
}

// ─────────────────────────────────────────────────────
//  MAIN — Shard Provisioning Pipeline
// ─────────────────────────────────────────────────────

async function provisionShard() {
  const { tenantId, tenantName, tier, shardInstance, shardDsn, maxQpm } = parseArgs();
  
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('FATAL: DATABASE_URL is required (must point to the Governance Hub).');
    process.exit(1);
  }

  const sql = postgres(dbUrl, { max: 5, idle_timeout: 10 });
  const tierConfig = TIER_DEFAULTS[tier];
  const startTime = Date.now();

  try {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  SENTINEL SHARD PROVISIONER V5.5                        ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Tenant:    ${tenantName.padEnd(43)}║`);
    console.log(`║  Tenant ID: ${tenantId.padEnd(43)}║`);
    console.log(`║  Tier:      ${tier} (${tierConfig.isolationLevel})`.padEnd(57) + '║');
    console.log('╚══════════════════════════════════════════════════════════╝');

    // ── Step 1: Insert Shard Map Entry ──
    console.log('\n[1] Registering tenant in shard_map...');

    const storagePath = tier === 1 
      ? `/artifacts/sentinel/enterprise/${tenantId}`
      : tierConfig.storagePrefixTemplate.replace('{uid}', tenantId);

    const [shardEntry] = await sql`
      INSERT INTO shard_map (
        tenant_id, tenant_name,
        database_tier, isolation_level,
        shard_dsn, shard_instance_id, shard_schema,
        storage_path,
        max_queries_per_minute, max_storage_bytes,
        status, activated_at, created_by
      ) VALUES (
        ${tenantId}, ${tenantName},
        ${tier}, ${tierConfig.isolationLevel},
        ${shardDsn || null}, ${shardInstance || null}, ${tier === 2 ? `tenant_${tenantId}` : null},
        ${storagePath},
        ${maxQpm || tierConfig.maxQueriesPerMinute}, ${tierConfig.maxStorageBytes},
        'ACTIVE', NOW(), 'provision_shard.js'
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        tenant_name = EXCLUDED.tenant_name,
        database_tier = EXCLUDED.database_tier,
        isolation_level = EXCLUDED.isolation_level,
        shard_dsn = EXCLUDED.shard_dsn,
        shard_instance_id = EXCLUDED.shard_instance_id,
        shard_schema = EXCLUDED.shard_schema,
        storage_path = EXCLUDED.storage_path,
        max_queries_per_minute = EXCLUDED.max_queries_per_minute,
        updated_at = NOW()
      RETURNING project_id
    `;

    console.log(`    ✅ Shard map entry created. project_id: ${shardEntry.project_id}`);

    // ── Step 2: Seed Default Skill Graph ──
    console.log('\n[2] Seeding project skill graph...');

    for (const skill of DEFAULT_SKILLS) {
      await sql`
        INSERT INTO project_skill_graph (
          project_id, skill_name, admissibility_rank,
          last_verified, verified_by, granted_by
        ) VALUES (
          ${shardEntry.project_id}, ${skill.name}, ${skill.rank},
          NOW(), 'provision_shard.js', ${skill.grantedBy}
        )
        ON CONFLICT (project_id, skill_name) DO NOTHING
      `;
      const rankLabel = { 0: 'DENIED', 1: 'AUDIT', 2: 'AUTO' }[skill.rank];
      console.log(`    ● ${skill.name.padEnd(30)} → ${rankLabel}`);
    }

    // ── Step 3: Tier-Specific Setup ──
    if (tier === 2) {
      console.log(`\n[3] Creating isolated schema "tenant_${tenantId}"...`);
      await sql`CREATE SCHEMA IF NOT EXISTS ${sql(`tenant_${tenantId}`)}`;
      console.log(`    ✅ Schema created.`);
    } else if (tier === 3) {
      console.log(`\n[3] Tier 3: RLS policies will be enforced automatically.`);
    } else {
      console.log(`\n[3] Tier 1: Shard instance "${shardInstance}" must be pre-provisioned via Terraform.`);
    }

    // ── Step 4: Register Shard Health Entry ──
    if (tier === 1 && shardInstance) {
      console.log('\n[4] Registering shard health entry...');
      await sql`
        INSERT INTO shard_health (shard_instance_id, tenant_count, last_health_check)
        VALUES (${shardInstance}, 1, NOW())
        ON CONFLICT (shard_instance_id) DO UPDATE SET
          tenant_count = shard_health.tenant_count + 1,
          last_health_check = NOW()
      `;
      console.log('    ✅ Shard health registered.');
    }

    // ── Summary ──
    const durationMs = Date.now() - startTime;

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  ✅ SHARD PROVISIONED SUCCESSFULLY                      ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Project ID:  ${shardEntry.project_id}`.padEnd(57) + '║');
    console.log(`║  Tier:        ${tier} (${tierConfig.isolationLevel})`.padEnd(57) + '║');
    console.log(`║  Storage:     ${storagePath}`.padEnd(57) + '║');
    console.log(`║  QPM Limit:   ${maxQpm || tierConfig.maxQueriesPerMinute}`.padEnd(57) + '║');
    console.log(`║  Skills:      ${DEFAULT_SKILLS.length} registered`.padEnd(57) + '║');
    console.log(`║  Duration:    ${(durationMs / 1000).toFixed(1)}s`.padEnd(57) + '║');
    console.log('╚══════════════════════════════════════════════════════════╝');

  } catch (err) {
    console.error('\n❌ SHARD PROVISIONING FAILED');
    console.error(`   Error: ${err.message}`);
    console.error(`   Stack: ${err.stack}`);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

provisionShard();
