const { AdapterRegistry } = require('./adapter-registry');
const { packExternalContext } = require('./context-packer');

/**
 * SENTINEL ENGINE — External Intelligence Adapter (V5.3)
 * ═══════════════════════════════════════════════════════════
 * Fetches data from configured external plugins concurrently.
 * Uses AbortController for native task cancellation (SLA enforcement).
 * Uses ContextPacker for knowledge-aware truncation (no byte-slicing).
 * ═══════════════════════════════════════════════════════════
 */
class ExternalIntelligenceAdapter {
  static ADAPTER_TIMEOUT_MS = 1500;

  /**
   * Fetches data from configured external plugins concurrently.
   * Utilizes AbortController to natively cancel promises that exceed the SLA,
   * preventing Memory Exhaustion/OOM and Ghost Promise leaks.
   *
   * @param {string} query
   * @param {string} industryDomain - LOGISTICS, ENERGY, etc.
   * @param {string[]} activeAdapters - List of adapter ids
   * @returns {Promise<string|null>}
   */
  static async fetch(query, industryDomain, activeAdapters) {
    if (!activeAdapters || activeAdapters.length === 0) return null;

    console.log(`[EXTERNAL_ADAPTER] Dispatching to plugins for ${industryDomain}: ${activeAdapters.join(', ')}`);

    const abortController = new AbortController();
    const { signal } = abortController;

    // SLA timeout — fires AbortController to kill all hanging promises
    const timeoutId = setTimeout(() => {
      console.warn(`[EXTERNAL_ADAPTER] SLA limit (${this.ADAPTER_TIMEOUT_MS}ms) reached. Firing AbortController!`);
      abortController.abort(new Error(`AdapterTimeout: Exceeded ${this.ADAPTER_TIMEOUT_MS}ms SLA.`));
    }, this.ADAPTER_TIMEOUT_MS);

    // Dispatch all adapters concurrently
    const promises = [];
    for (const plugin of activeAdapters) {
      const adapterSpec = AdapterRegistry.get(plugin);
      const fetchMethod = adapterSpec?.fetch;
      if (typeof fetchMethod === 'function') {
        promises.push(
          fetchMethod(query, industryDomain, signal)
            .then(res => ({ status: 'fulfilled', plugin, data: res }))
            .catch(err => ({ status: 'rejected', plugin, error: err.message }))
        );
      } else {
        promises.push(
          Promise.resolve({ status: 'rejected', plugin, error: 'Adapter missing or malformed in registry' })
        );
      }
    }

    const results = await Promise.all(promises);
    clearTimeout(timeoutId);

    // Separate successes from failures
    const successResults = [];
    const failedResults = [];

    for (const res of results) {
      if (res.status === 'fulfilled') {
        successResults.push({ plugin: res.plugin, data: res.data });
      } else {
        console.error(`[EXTERNAL_ADAPTER_ERROR] Plugin isolation: ${res.plugin}: ${res.error}`);
        failedResults.push({ plugin: res.plugin, error: res.error });
      }
    }

    // Delegate to ContextPacker — row-aware, knowledge-preserving truncation
    return packExternalContext(successResults, failedResults);
  }
}

module.exports = { ExternalIntelligenceAdapter };
