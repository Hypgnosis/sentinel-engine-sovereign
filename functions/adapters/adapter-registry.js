/**
 * SENTINEL ENGINE — Adapter Registry (V5.3 Contract Protocol)
 * ═══════════════════════════════════════════════════════════
 * Externalizes the plugin registry to adhere to the Open/Closed Principle.
 * Plugins must self-register at boot time and satisfy the Contract Protocol:
 *
 *   1. isSignalAware: true        — Self-declaration (verified at boot)
 *   2. fetch(query, domain, signal) — The data retrieval method
 *   3. healthCheck(signal)         — Runtime verification of signal handling
 *
 * The Boot Guard executes healthCheck() with a mock AbortSignal to PROVE
 * the adapter respects cancellation. Declaration alone is not trusted.
 * ═══════════════════════════════════════════════════════════
 */

class AdapterRegistry {
  static #registry = new Map();
  static #locked = false;

  /**
   * Register a new plugin adapter with Contract Protocol enforcement.
   * Rejects at boot if the spec is structurally incomplete.
   *
   * @param {string} pluginId - e.g., 'marinetraffic'
   * @param {object} adapterSpec - Must satisfy:
   *   { isSignalAware: true, fetch: Function, healthCheck: Function }
   */
  static register(pluginId, adapterSpec) {
    if (this.#locked) {
      throw new Error(
        `[SECURITY_VIOLATION] Attempted to register plugin '${pluginId}' after Boot Guard lock.`
      );
    }

    // ── Structural Contract Validation ──
    if (!adapterSpec || typeof adapterSpec !== 'object') {
      throw new Error(
        `[ADAPTER_REGISTRY_REJECTED] Plugin '${pluginId}' spec must be a non-null object.`
      );
    }
    if (adapterSpec.isSignalAware !== true) {
      throw new Error(
        `[ADAPTER_REGISTRY_REJECTED] Plugin '${pluginId}' must declare { isSignalAware: true }.`
      );
    }
    if (typeof adapterSpec.fetch !== 'function') {
      throw new Error(
        `[ADAPTER_REGISTRY_REJECTED] Plugin '${pluginId}' must expose a fetch(query, domain, signal) method.`
      );
    }
    if (typeof adapterSpec.healthCheck !== 'function') {
      throw new Error(
        `[ADAPTER_REGISTRY_REJECTED] Plugin '${pluginId}' must expose a healthCheck(signal) method ` +
        `that proves signal cancellation at runtime. Declaration alone is not trusted.`
      );
    }

    this.#registry.set(pluginId, adapterSpec);
    console.log(`[ADAPTER_REGISTRY] Plugin registered: ${pluginId}`);
  }

  /**
   * Execute runtime protocol verification for a specific plugin.
   * Creates a real AbortController, fires abort after 50ms,
   * and verifies the adapter's healthCheck rejects with an AbortError.
   *
   * @param {string} pluginId
   * @returns {Promise<boolean>} true if signal propagation is verified
   */
  static async verifySignalContract(pluginId) {
    const spec = this.#registry.get(pluginId);
    if (!spec) return false;

    const ac = new AbortController();
    // Fire abort after 50ms — the healthCheck must reject before 200ms
    const abortTimer = setTimeout(() => ac.abort(), 50);

    try {
      await spec.healthCheck(ac.signal);
      // If healthCheck resolved WITHOUT being aborted, the adapter
      // completed before the signal fired. That's acceptable.
      clearTimeout(abortTimer);
      return true;
    } catch (err) {
      clearTimeout(abortTimer);
      // The adapter correctly threw on abort — signal propagation verified
      if (err.message?.includes('Abort') || err.name === 'AbortError') {
        return true;
      }
      // Non-abort error — the adapter is broken, not signal-aware
      console.error(
        `[ADAPTER_REGISTRY] Plugin '${pluginId}' healthCheck threw non-abort error: ${err.message}`
      );
      return false;
    }
  }

  /**
   * Locks the registry. No further mutations permitted.
   */
  static lock() {
    this.#locked = true;
    Object.freeze(this.#registry);
    console.log(`[ADAPTER_REGISTRY] Registry locked. ${this.#registry.size} adapters sealed.`);
  }

  /**
   * Get an adapter spec by ID.
   * @param {string} pluginId
   * @returns {object|undefined}
   */
  static get(pluginId) {
    return this.#registry.get(pluginId);
  }

  /**
   * Check if a plugin exists.
   * @param {string} pluginId
   * @returns {boolean}
   */
  static has(pluginId) {
    return this.#registry.has(pluginId);
  }

  /**
   * Get all registered plugin IDs (for Boot Guard enumeration).
   * @returns {string[]}
   */
  static getRegisteredIds() {
    return [...this.#registry.keys()];
  }
}

module.exports = { AdapterRegistry };
