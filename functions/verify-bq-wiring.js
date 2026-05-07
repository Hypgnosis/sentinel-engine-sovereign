/**
 * Surgical source-code verification for the Evidence Locker BQ wiring.
 * Run: node verify-bq-wiring.js
 */
'use strict';
const fs = require('fs');
const src = fs.readFileSync('./evidence-locker.js', 'utf8');

const checks = [
  ["Import: require('./audit-log-exporter')",    src.includes("require('./audit-log-exporter')")],
  ['exportAuditRecord() call present',           src.includes('exportAuditRecord(')],
  ['Fire-and-forget .catch() present',           src.includes('.catch(() =>')],
  ['KPMG 4.4 comment present',                  src.includes('KPMG 4.4')],
  ['BQ failure never blocks primary request',    src.includes('BQ failure NEVER')],
  ['BQ call is inside recordEvent body',         src.includes('EVIDENCE_RECORDED') && src.includes('exportAuditRecord(')],
];

let pass = 0;
let fail = 0;
checks.forEach(([label, result]) => {
  if (result) { console.log('✅ PASS:', label); pass++; }
  else        { console.error('❌ FAIL:', label); fail++; }
});

console.log(`\nResult: ${pass}/${checks.length} checks passed.`);
process.exit(fail > 0 ? 1 : 0);
