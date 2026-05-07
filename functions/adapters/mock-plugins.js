const { AdapterRegistry } = require('./adapter-registry');

/**
 * SENTINEL ENGINE — Mock Plugins (V5.3 Contract Protocol)
 * ═══════════════════════════════════════════════════════════
 * Registers test plugins using the AdapterRegistry Contract Protocol.
 * Every adapter exports:
 *   1. isSignalAware: true
 *   2. fetch(query, domain, signal)    — data retrieval with native signal binding
 *   3. healthCheck(signal)             — runtime proof of signal cancellation
 *
 * The healthCheck creates a real timer and binds the abort listener.
 * If the Boot Guard fires abort, the healthCheck MUST reject with AbortError.
 * This is not a declaration — it is a runtime test.
 * ═══════════════════════════════════════════════════════════
 */

// ── Helper: Standard healthCheck factory ──
// Every adapter needs the same pattern: start a timer, bind abort, prove cancellation.
function createHealthCheck(delayMs = 150) {
  return function healthCheck(signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('AbortError'));
      const timer = setTimeout(() => resolve('healthy'), delayMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('AbortError: healthCheck cancelled by signal'));
      });
    });
  };
}

// 1. MarineTraffic (Logistics)
AdapterRegistry.register('marinetraffic', {
  isSignalAware: true,
  fetch: function(query, domain, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('AbortError'));
      const timer = setTimeout(() => {
        resolve(`[MARINETRAFFIC] Port congestion LOW. Transit delays nominal.`);
      }, 200);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('AbortError'));
      });
    });
  },
  healthCheck: createHealthCheck(150),
});

// 2. Xeneta (Logistics)
AdapterRegistry.register('xeneta', {
  isSignalAware: true,
  fetch: function(query, domain, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('AbortError'));
      const timer = setTimeout(() => {
        resolve(`[Xeneta] Short-term market rate index: +5.2% WoW.`);
      }, 800);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('AbortError'));
      });
    });
  },
  healthCheck: createHealthCheck(150),
});

// 3. Freightos (Logistics - Simulates a hang that MUST be aborted)
AdapterRegistry.register('freightos', {
  isSignalAware: true,
  fetch: function(query, domain, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('AbortError'));
      const timer = setTimeout(() => {
        resolve(`[FREIGHTOS] Capacity severely constrained index.`);
      }, 10000);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('AbortError: Freightos timed out'));
      });
    });
  },
  healthCheck: createHealthCheck(150),
});

// 4. Grid-CFE (Energy)
AdapterRegistry.register('grid-cfe', {
  isSignalAware: true,
  fetch: function(query, domain, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('AbortError'));
      const timer = setTimeout(() => {
        resolve(`[Grid-CFE] Step-2 Alert active on Northern intertie.`);
      }, 100);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('AbortError'));
      });
    });
  },
  healthCheck: createHealthCheck(100),
});
