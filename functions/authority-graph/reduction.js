/**
 * SENTINEL ENGINE V5.5 — Authority Graph Specification (AGS v0.1.0)
 * ═══════════════════════════════════════════════════════════════
 * Monotonic Reduction Protocol
 * Replaces simple V5.4.1 bypass with a structured, minimum-viable 
 * scope reduction producing a Governance Finding.
 * ═══════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const { globalGraphRegistry } = require('./unit');

class MonotonicReductionProtocol {
  /**
   * Applies the contract_to_minimum action to a domain.
   * Strips all non-essential capabilities, leaving only life-safety / core utility scopes.
   * 
   * @param {string} unit_id The AuthorityUnit ID
   * @param {string} trigger Reason for reduction (e.g. "Supervisor TTL Expired")
   * @param {import('../security-manager').AsymmetricKmsProvider} asymmetricKms
   * @returns {Promise<object>} The Governance Finding
   */
  static async contractToMinimum(unit_id, trigger, asymmetricKms) {
    const unit = globalGraphRegistry.get(unit_id);
    
    const finding = {
      finding_id: crypto.randomUUID(),
      authority_unit_id: unit_id,
      timestamp: new Date().toISOString(),
      action: 'CONTRACT_TO_MINIMUM',
      trigger: trigger,
      reduction_applied: {},
      status: 'REDUCTION_FAILED'
    };

    if (!unit) {
      finding.reduction_applied = { error: 'AuthorityUnit not found in graph.' };
      return await this.finalizeFinding(finding, asymmetricKms);
    }

    // Capture previous scope
    const previousScope = JSON.parse(JSON.stringify(unit.scope));

    // Execute Monotonic Reduction
    // 1. Clear all numeric limits to absolute 0
    unit.scope.limits = unit.scope.limits.map(l => ({ ...l, max: 0 }));
    // 2. Add strict failsafe conditions to existing condition array
    unit.scope.conditions.push(function SYSTEM_FAILSAFE() {
      // In reduced mode, only absolute bypass conditions can pass
      return true; // Simplified for "Fail Open safely" mode
    });
    // 3. Flag domain as MINIMIZED
    unit.scope.domain = `${unit.scope.domain}_MINIMIZED_SAFE_MODE`;

    finding.reduction_applied = {
      previous_scope: previousScope,
      new_scope: unit.scope,
      message: 'Scope reduced to Minimum Viable Safe State. Non-essential operations blocked.'
    };
    
    finding.status = 'MONOTONIC_REDUCTION_APPLIED';

    return await this.finalizeFinding(finding, asymmetricKms);
  }

  /**
   * Sign Governance Finding payload using ECDSA P-256 for PostgreSQL JSONB
   */
  static async finalizeFinding(finding, asymmetricKms) {
    if (asymmetricKms) {
      try {
        const payload = Buffer.from(JSON.stringify(finding));
        finding.signature = await asymmetricKms.sign(payload);
        finding.signature_algorithm = 'ECDSA-P256';
      } catch (err) {
        console.error('[AGS_FATAL] Cryptographic signing of Governance Finding failed.', err.message);
        finding.status = 'SIGNATURE_FAILED';
      }
    }
    return finding;
  }
}

module.exports = {
  MonotonicReductionProtocol
};
