/**
 * SENTINEL ENGINE V5.5 — Authority Graph Specification (AGS v0.1.0)
 * ═══════════════════════════════════════════════════════════════
 * The Arbitration Interface
 * Enforces strictly tiered evaluation precedence.
 * ═══════════════════════════════════════════════════════════════
 */

const { globalUnitLoader } = require('./unit');
const crypto = require('crypto');

class ArbitrationInterface {
  /**
   * Evaluates an action across the Multi-Tier Precedence.
   * 
   * @param {object} params
   * @param {string} params.request_id 
   * @param {object} params.action 
   * @param {object} params.context 
   * @param {import('../security-manager').AsymmetricKmsProvider} params.asymmetricKms
   * @returns {Promise<object>} Legibility Record
   */
  static async evaluateDecision({ request_id, action, context, asymmetricKms }) {
    const { source_unit_id, target_unit_id, domain, tenant_id } = action;

    const record = {
      decision_id: crypto.randomUUID(),
      request_id,
      authority_unit_id: source_unit_id,
      target_unit_id: target_unit_id || null,
      delegation_chain: [],
      contracts_traversed: [],
      tier_resolved_at: null,
      status: 'DENIED',
      timestamp: new Date().toISOString(),
      metadata: { context_keys: Object.keys(context) }
    };

    let sourceUnit;
    try {
      sourceUnit = await globalUnitLoader.loadGraph(source_unit_id, tenant_id || 'SYSTEM');
    } catch (err) {
      console.warn(`[ARBITRATION] Failed to hydrate source unit: ${err.message}`);
      record.status = 'DENIED_NO_AMBIENT_AUTHORITY';
      return await this.finalize(record, asymmetricKms);
    }
    record.delegation_chain = sourceUnit.provenance.chain;

    try {
      // 1. Pairwise/Composition Contract
      if (target_unit_id) {
        let targetUnit;
        try {
          targetUnit = await globalUnitLoader.loadGraph(target_unit_id, tenant_id || 'SYSTEM');
        } catch (err) {
          // pass
        }
        if (targetUnit) {
          record.contracts_traversed.push('PAIRWISE_CONTRACT');
          // Dummy pairwise resolution logic
          if (sourceUnit.scope.domain !== targetUnit.scope.domain && !action.override_cross_domain) {
             record.status = 'DENIED_PAIRWISE_CONFLICT';
             record.tier_resolved_at = 'PAIRWISE';
             return await this.finalize(record, asymmetricKms);
          }
        }
      }

      // 2. Domain Contract
      record.contracts_traversed.push('DOMAIN_CONTRACT');
      if (sourceUnit.scope.domain !== domain && sourceUnit.scope.domain !== 'SYSTEM') {
        record.status = 'DENIED_DOMAIN_MISMATCH';
        record.tier_resolved_at = 'DOMAIN';
        return await this.finalize(record, asymmetricKms);
      }

      // 3. Constitutional Review (Mandatory invariant check)
      record.contracts_traversed.push('CONSTITUTIONAL_REVIEW');

      // Verify Provenance Chain Integrity (KMS)
      if (sourceUnit.provenance && sourceUnit.provenance.signature) {
        const provenancePayload = Buffer.from(JSON.stringify(sourceUnit.provenance.chain));
        const isValid = await asymmetricKms.verify(provenancePayload, sourceUnit.provenance.signature);
        if (!isValid) {
          record.status = 'DENIED_PROVENANCE_FORGERY';
          record.tier_resolved_at = 'CONSTITUTIONAL';
          return await this.finalize(record, asymmetricKms);
        }
      }
      
      // Check formal NLI contradiction semantic conditions at the constitutional level
      if (sourceUnit.evaluateConditions && !sourceUnit.evaluateConditions(context)) {
        record.status = 'DENIED_CONSTITUTIONAL_CONDITIONS_FAILED';
        record.tier_resolved_at = 'CONSTITUTIONAL';
        return await this.finalize(record, asymmetricKms);
      }

      // Invariant: Irreversible actions (like refunds or power resets) MUST have a KMS provider
      // to sign the resulting Legibility Record.
      if (action.is_irreversible && !asymmetricKms) {
        record.status = 'DENIED_CONSTITUTIONAL_NO_AUDIT_TRAIL';
        record.tier_resolved_at = 'CONSTITUTIONAL';
        return await this.finalize(record, asymmetricKms); // Fails default deny
      }

      // Default Allow if traversed all without denial
      record.status = 'PERMIT';
      record.tier_resolved_at = 'CONSTITUTIONAL';
      return await this.finalize(record, asymmetricKms);

    } catch (err) {
      record.status = 'DENIED_EVALUATION_ERROR';
      record.metadata.error = err.message;
      record.tier_resolved_at = 'SYSTEM_FAULT';
      return await this.finalize(record, asymmetricKms);
    }
  }

  /**
   * Finalizes the Legibility Record. 
   * A Permit is STRICTLY FORBIDDEN if this record cannot be generated and cryptographically signed.
   * 
   * @param {object} record 
   * @param {import('../security-manager').AsymmetricKmsProvider} asymmetricKms 
   * @returns {Promise<object>}
   */
  static async finalize(record, asymmetricKms) {
    if (!asymmetricKms && record.status === 'PERMIT') {
      console.error('[AGS_FATAL] Cannot issue PERMIT without cryptographic Legibility Record generation. Converting to DENY.');
      record.status = 'DENIED_LEGIBILITY_FAILURE';
    }

    if (asymmetricKms) {
      try {
        const payload = Buffer.from(JSON.stringify(record));
        record.signature = await asymmetricKms.sign(payload);
        record.signature_algorithm = 'ECDSA-P256';
      } catch (err) {
        console.error('[AGS_FATAL] Cryptographic signing failed.', err.message);
        if (record.status === 'PERMIT') {
          record.status = 'DENIED_SIGNATURE_FAILURE';
        }
      }
    }

    return record;
  }
}

module.exports = {
  ArbitrationInterface
};
