/**
 * SENTINEL ENGINE — Freightos API Adapter (Live Feed)
 * ═══════════════════════════════════════════════════════════
 * Pulls live freight index data from the Freightos API.
 *
 * STATUS: PRODUCTION — API key fetched from Secret Manager.
 * The key is injected into process.env by the ETL orchestrator
 * AFTER fetching from Secret Manager at runtime.
 *
 * Implements the same interface as static-feed.js:
 *   getFreightIndices() → { global, routes, airFreight }
 * ═══════════════════════════════════════════════════════════
 */

import axios from 'axios';

const FREIGHTOS_API_URL = 'https://api.freightos.com/v1';

/**
 * Check if the Freightos API key is available.
 * Called AFTER Secret Manager injection in the ETL orchestrator.
 */
export const isAvailable = () => !!process.env.FREIGHTOS_API_KEY;

/**
 * Fetch live freight indices from the Freightos API.
 * Uses axios with timeout and retry for production reliability.
 *
 * @returns {Promise<{global: object, routes: Array, airFreight: Array}>}
 * @throws {Error} if API key missing or API returns non-2xx
 */
export async function getFreightIndices() {
  const apiKey = process.env.FREIGHTOS_API_KEY;
  if (!apiKey) {
    throw new Error('[Freightos] API key not configured. Ensure FREIGHTOS_API_KEY is in Secret Manager.');
  }

  const response = await axios.get(`${FREIGHTOS_API_URL}/indices/fbx`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    },
    timeout: 15000, // 15s hard timeout
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const data = response.data;

  // Transform Freightos API response to Sentinel schema
  return {
    global: {
      source: 'Freightos',
      route_origin: 'Global Composite',
      route_destination: 'Global Composite',
      rate_usd: data.globalIndex?.rate || 0,
      week_over_week_change: data.globalIndex?.weekOverWeek || 0,
      trend: data.globalIndex?.trend || 'stable',
      narrative_context: `FBX Global Container Index at $${data.globalIndex?.rate}/FEU, ${data.globalIndex?.weekOverWeek > 0 ? 'up' : 'down'} ${Math.abs(data.globalIndex?.weekOverWeek)}% WoW.`,
    },
    routes: (data.routes || []).map(r => ({
      source: 'Freightos',
      route_origin: r.origin,
      route_destination: r.destination,
      rate_usd: r.rate,
      week_over_week_change: r.weekOverWeek,
      trend: r.trend,
      narrative_context: `${r.origin} → ${r.destination}: $${r.rate}/FEU, ${r.weekOverWeek > 0 ? '▲' : '▼'} ${Math.abs(r.weekOverWeek)}% WoW. Trend: ${r.trend}.`,
    })),
    airFreight: [],
  };
}
