/**
 * SENTINEL ENGINE V5.5 — Authority Graph Specification (AGS v0.1.0)
 * ═══════════════════════════════════════════════════════════════
 * The Authority Unit Schema
 * Encapsulates formal decision boundaries.
 * 
 * Hardening: "Amnesia Flaw" fixed via Contextual Factory.
 * ═══════════════════════════════════════════════════════════════
 */

const { getSql } = require('../db');

class AuthorityUnit {
  /**
   * @param {object} params 
   * @param {Map} registry Local registry of hydrated units for validation
   */
  constructor(params, registry) {
    this.id = params.id;
    
    this.scope = {
      decision_type: params.scope.decision_type,
      domain: params.scope.domain,
      conditions: params.scope.conditions || [],
      limits: params.scope.limits || []
    };

    this.delegation = {
      granted_by: params.delegation?.granted_by || null,
      contract: params.delegation?.contract || null,
      re_delegation: params.delegation?.re_delegation || false
    };

    this.termination = {
      expiry: params.termination?.expiry || null,
      revocation_triggers: params.termination?.revocation_triggers || []
    };

    this.provenance = {
      chain: params.provenance?.chain || [this.id],
      verifiable: params.provenance?.verifiable || false,
      signature: params.provenance?.signature || null
    };

    this.validateProvenance(registry);
    this.validateMonotonicAttenuation(registry);
  }

  /**
   * Provenance Completeness:
   * Every non-root unit must have a chain terminating at a root authority.
   */
  validateProvenance(registry) {
    // A root authority grants itself
    if (this.delegation.granted_by === null || this.delegation.granted_by === 'ROOT') {
      if (this.provenance.chain[this.provenance.chain.length - 1] !== 'ROOT' &&
          this.provenance.chain[this.provenance.chain.length - 1] !== this.id) {
        throw new Error(`[AGS_VIOLATION] Provenance Completeness Failed: Root unit ${this.id} chain must terminate at itself or ROOT.`);
      }
      return true;
    }

    if (!this.provenance.chain.includes('ROOT') && !this.provenance.chain.includes(this.delegation.granted_by)) {
      throw new Error(`[AGS_VIOLATION] Provenance Completeness Failed: Non-root unit ${this.id} lacks valid root chain.`);
    }

    const grantor = registry.get(this.delegation.granted_by);
    if (!grantor) {
      throw new Error(`[AGS_VIOLATION] Undefined Grantor: Unit ${this.id} references non-existent grantor ${this.delegation.granted_by}. No Ambient Authority permitted.`);
    }

    return true;
  }

  /**
   * Monotonic Attenuation:
   * Delegated scope must be equal to or narrower than the grantor's scope on every dimension.
   */
  validateMonotonicAttenuation(registry) {
    if (!this.delegation.granted_by || this.delegation.granted_by === 'ROOT') return true;

    const grantor = registry.get(this.delegation.granted_by);
    if (!grantor) return false;

    // Check Domains (e.g. Grantor cannot grant ENERGY if they only own LOGISTICS, unless Grantor is SYSTEM)
    if (grantor.scope.domain !== 'SYSTEM' && grantor.scope.domain !== this.scope.domain) {
      throw new Error(`[AGS_VIOLATION] Monotonic Attenuation: Domain mismatch. Grantor is ${grantor.scope.domain}, Delegate requests ${this.scope.domain}.`);
    }

    // Check Limits (numeric bounding)
    for (const delegateLimit of this.scope.limits) {
      const grantorLimit = grantor.scope.limits.find(l => l.metric === delegateLimit.metric);
      if (grantorLimit && typeof grantorLimit.max === 'number' && typeof delegateLimit.max === 'number') {
        if (delegateLimit.max > grantorLimit.max) {
           throw new Error(`[AGS_VIOLATION] Monotonic Attenuation: Limit exceeded. Grantor provides max ${grantorLimit.max} for ${delegateLimit.metric}, Delegate requests ${delegateLimit.max}.`);
        }
      }
    }

    return true;
  }

  /**
   * Evaluate conditions (including formal NLI semantics)
   * @param {object} context 
   * @returns {boolean}
   */
  evaluateConditions(context) {
    // Time-bounded expiry limit check
    if (this.termination.expiry && Date.now() > this.termination.expiry) {
      console.warn(`[AGS_EXPIRED] AuthorityUnit ${this.id} passed expiry timestamp.`);
      return false;
    }

    // Evaluate logical predicates assigned to this graph
    for (const condition of this.scope.conditions) {
      if (typeof condition === 'function') {
         if (!condition(context)) return false;
      }
      // NLI semantics integration: If condition maps to an NLI contradiction check string
      if (typeof condition === 'string' && condition.startsWith('EXPECT_NO_CONTRADICTION')) {
         if (context.verdict && context.verdict.isVerified === false) {
           return false;
         }
      }
    }

    return true;
  }
}

/**
 * UnitLoader (Contextual Factory Pattern)
 * Hydrates AuthorityUnits and their entire provenance chain from PostgreSQL.
 */
class UnitLoader {
  constructor() {
    this.cache = new Map(); // Short-Lived Cache
    this.TTL_MS = 300000;   // 5 minutes
  }

  /**
   * Fetches an AuthorityUnit by ID, hydrating its entire chain.
   */
  async loadGraph(unitId, tenantId) {
    const cacheKey = `${tenantId}:${unitId}`;
    
    // 1. Check Short-Lived Cache (Performance Hack)
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.TTL_MS) {
         return cached.unit;
      }
    }

    const sql = getSql();
    
    // 2. Fetch the Provenance Chain (Recursive CTE)
    // Pulls from child (unitId) up to the ROOT
    const rows = await sql`
      WITH RECURSIVE provenance_chain AS (
          SELECT * FROM standing_authority_matrix 
          WHERE unit_id = ${unitId} AND tenant_id = ${tenantId}
          UNION ALL
          SELECT sam.* FROM standing_authority_matrix sam
          INNER JOIN provenance_chain pc ON sam.unit_id = pc.grantor_id
          WHERE sam.tenant_id = ${tenantId}
      )
      SELECT * FROM provenance_chain;
    `;

    if (!rows || rows.length === 0) {
      throw new Error(`[AGS_VIOLATION] UnitLoader: Unit ${unitId} not found for tenant ${tenantId}.`);
    }

    // 3. Hydrate Graph Top-Down
    // Reverse to process ROOT first so grantors exist when child validates
    const reversedRows = [...rows].reverse();
    const tempRegistry = new Map();
    let targetUnit = null;

    for (const row of reversedRows) {
      const config = row.config;
      
      const unitParams = {
        id: row.unit_id,
        scope: config.scope || {},
        delegation: config.delegation || {},
        termination: config.termination || {},
        provenance: {
          chain: config.provenance?.chain || [row.unit_id],
          verifiable: true,
          signature: row.signature
        }
      };

      const unit = new AuthorityUnit(unitParams, tempRegistry);
      tempRegistry.set(row.unit_id, unit);
      
      if (row.unit_id === unitId) {
        targetUnit = unit;
      }
    }

    // 4. Cache and Return
    this.cache.set(cacheKey, { timestamp: Date.now(), unit: targetUnit });
    return targetUnit;
  }
}

// Instantiate global singleton
const globalUnitLoader = new UnitLoader();

module.exports = {
  AuthorityUnit,
  UnitLoader,
  globalUnitLoader
};
