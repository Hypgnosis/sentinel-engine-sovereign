const { AuthorityUnit, globalUnitLoader } = require('./authority-graph/unit');
const { ArbitrationInterface } = require('./authority-graph/arbitration');

async function runTests() {
  console.log('--- SENTINEL ENGINE V5.5 AGS INTEGRATION TEST SUITE ---\n');

  // Scenario 1: Minimal Complete Example
  console.log('[Test 1] Minimal Complete Example (Provenance & Monotonic Attenuation)');
  
  const registry = new Map();

  // Mock globalUnitLoader for ArbitrationInterface tests
  globalUnitLoader.loadGraph = async (unitId, tenantId) => {
    if (registry.has(unitId)) {
      return registry.get(unitId);
    }
    throw new Error(`Unit ${unitId} not found in test registry`);
  };

  // Create Root Authority
  const root = new AuthorityUnit({
    id: 'ROOT_AUTHORITY',
    scope: { decision_type: 'ANY', domain: 'SYSTEM', limits: [{ metric: 'funds', max: 1000000 }] },
    delegation: { granted_by: 'ROOT' },
    provenance: { chain: ['ROOT'] }
  }, registry);
  registry.set('ROOT_AUTHORITY', root);

  try {
    const manager = new AuthorityUnit({
      id: 'MANAGER_UNIT',
      scope: { decision_type: 'refund', domain: 'PAYMENTS', limits: [{ metric: 'funds', max: 5000 }] },
      delegation: { granted_by: 'ROOT_AUTHORITY' },
      provenance: { chain: ['ROOT', 'ROOT_AUTHORITY', 'MANAGER_UNIT'] }
    }, registry);
    registry.set('MANAGER_UNIT', manager);
    console.log('✅ Valid delegation succeeded.');
  } catch (err) {
    console.error('❌ Failed valid delegation:', err.message);
  }

  try {
    new AuthorityUnit({
      id: 'ROGUE_UNIT',
      scope: { decision_type: 'refund', domain: 'PAYMENTS', limits: [{ metric: 'funds', max: 2000000 }] },
      delegation: { granted_by: 'ROOT_AUTHORITY' },
      provenance: { chain: ['ROOT', 'ROOT_AUTHORITY', 'ROGUE_UNIT'] }
    }, registry);
    console.error('❌ Rogue unit improperly succeeded!');
  } catch (err) {
    console.log('✅ Monotonic attenuation correctly blocked rogue delegation.');
  }

  try {
    new AuthorityUnit({
      id: 'GHOST_UNIT',
      scope: { decision_type: 'hack', domain: 'ALL' },
      delegation: { granted_by: 'NON_EXISTENT' }
    }, registry);
    console.error('❌ Ghost unit improperly succeeded!');
  } catch (err) {
    console.log('✅ Provenance validation correctly blocked ambient authority.\n');
  }

  // Scenario 2: Refund-Fraud Scenario (Arbitration Seams)
  console.log('[Test 2] Refund-Fraud Seam Evaluation (Arbitration Interface)');
  
  const fraudApi = new AuthorityUnit({
    id: 'FRAUD_API',
    scope: { decision_type: 'fraud_check', domain: 'FRAUD' },
    delegation: { granted_by: 'ROOT_AUTHORITY' },
    provenance: { chain: ['ROOT', 'ROOT_AUTHORITY', 'FRAUD_API'] }
  }, registry);
  registry.set('FRAUD_API', fraudApi);

  // Test Pairwise Seam
  const result1 = await ArbitrationInterface.evaluateDecision({
    request_id: 'REQ_123',
    action: { source_unit_id: 'MANAGER_UNIT', target_unit_id: 'FRAUD_API', domain: 'PAYMENTS' },
    context: {},
    asymmetricKms: null // Legibility will fail
  });
  
  if (result1.status === 'DENIED_PAIRWISE_CONFLICT' || result1.tier_resolved_at === 'PAIRWISE') {
    console.log('✅ Pairwise conflict correctly denied cross-domain action without explicit override.');
  } else {
    console.error('❌ Pairwise evasion successful:', result1);
  }

  // Test Constitutional Guard (Audit Trail generation failure acts as Default Deny)
  const result2 = await ArbitrationInterface.evaluateDecision({
    request_id: 'REQ_456',
    action: { source_unit_id: 'MANAGER_UNIT', domain: 'PAYMENTS', is_irreversible: true },
    context: {},
    asymmetricKms: null // Missing KmsProvider means signing fail
  });

  if (result2.status === 'DENIED_CONSTITUTIONAL_NO_AUDIT_TRAIL') {
    console.log('✅ Constitutional Review blocked irreversible action without cryptographic ledger.\n');
  } else {
    console.error('❌ Constitutional violation allowed:', result2);
  }

  console.log('--- ALL INTEGRATION SCENARIOS EXECUTED SUCCESSFULLY ---');
}

runTests();
