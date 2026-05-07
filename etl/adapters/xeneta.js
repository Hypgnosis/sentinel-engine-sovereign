/**
 * SENTINEL ENGINE — Xeneta API Adapter (Live Feed)
 * ═══════════════════════════════════════════════════════════
 * Pulls live spot/contract rate data from the Xeneta API.
 *
 * STATUS: PRODUCTION — API key fetched from Secret Manager.
 * The key is injected into process.env by the ETL orchestrator
 * AFTER fetching from Secret Manager at runtime.
 *
 * Implements:
 *   getSpotContractSpreads() → Array<FreightIndex>
 * ═══════════════════════════════════════════════════════════
 */

import axios from 'axios';

const XENETA_API_URL = 'https://api.xeneta.com/v1';

/**
 * Check if the Xeneta API key is available.
 * Called AFTER Secret Manager injection in the ETL orchestrator.
 */
export const isAvailable = () => !!process.env.XENETA_API_KEY;

/**
 * Fetch live spot vs contract rate spreads from Xeneta.
 * Uses axios with timeout for production reliability.
 *
 * @returns {Promise<Array<{source, route_origin, route_destination, rate_usd, week_over_week_change, trend, narrative_context}>>}
 */
export async function getSpotContractSpreads() {
  const apiKey = process.env.XENETA_API_KEY;
  if (!apiKey) {
    throw new Error('[Xeneta] API key not configured. Ensure XENETA_API_KEY is in Secret Manager.');
  }

  const response = await axios.get(`${XENETA_API_URL}/rates/spot-contract`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    },
    timeout: 15000,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const data = response.data;

  return (data.corridors || []).map(c => ({
    source: 'Xeneta',
    route_origin: c.origin,
    route_destination: c.destination,
    rate_usd: c.spotRate,
    week_over_week_change: 0,
    trend: c.spotRate > c.contractRate ? 'rising' : 'stable',
    narrative_context: `${c.origin} → ${c.destination}: Spot $${c.spotRate} vs Contract $${c.contractRate} (spread: $${c.spotRate - c.contractRate}). ${c.analysis || ''}`,
  }));
}
