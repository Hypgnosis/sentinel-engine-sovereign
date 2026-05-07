/**
 * SENTINEL ENGINE — MarineTraffic API Adapter (Live Feed)
 * ═══════════════════════════════════════════════════════════
 * Pulls live port congestion and chokepoint data from
 * the MarineTraffic API.
 *
 * STATUS: PRODUCTION — API key fetched from Secret Manager.
 * The key is injected into process.env by the ETL orchestrator
 * AFTER fetching from Secret Manager at runtime.
 *
 * Implements:
 *   getPortCongestion() → Array<PortCongestion>
 *   getChokepoints()    → Array<Chokepoint>
 * ═══════════════════════════════════════════════════════════
 */

import axios from 'axios';

const MT_API_URL = 'https://services.marinetraffic.com/api';

/**
 * Check if the MarineTraffic API key is available.
 * Called AFTER Secret Manager injection in the ETL orchestrator.
 * Uses runtime process.env — NOT import-time capture.
 */
export const isAvailable = () => !!process.env.MARINETRAFFIC_API_KEY;

export async function getPortCongestion() {
  const apiKey = process.env.MARINETRAFFIC_API_KEY;
  if (!apiKey) {
    throw new Error('[MarineTraffic] API key not configured. Ensure MARINETRAFFIC_API_KEY is in Secret Manager.');
  }

  const response = await axios.get(
    `${MT_API_URL}/portcongestion/${apiKey}/protocol:jsono`,
    {
      headers: { 'Accept': 'application/json' },
      timeout: 20000, // 20s — MarineTraffic can be slow
      validateStatus: (status) => status >= 200 && status < 300,
    },
  );

  const data = response.data;

  return (data || []).map(p => ({
    source: 'MarineTraffic',
    port_name: p.portName || p.PORT_NAME,
    vessels_at_anchor: parseInt(p.vesselsAtAnchor || p.VESSELS_AT_ANCHOR, 10) || 0,
    avg_wait_days: parseFloat(p.avgWaitDays || p.AVG_WAIT_DAYS) || 0,
    severity_level: classifySeverity(parseInt(p.vesselsAtAnchor || p.VESSELS_AT_ANCHOR, 10)),
    narrative_context: `${p.portName || p.PORT_NAME}: ${p.vesselsAtAnchor || p.VESSELS_AT_ANCHOR} vessels at anchor, ${p.avgWaitDays || p.AVG_WAIT_DAYS}-day average wait.`,
  }));
}

export async function getChokepoints() {
  const apiKey = process.env.MARINETRAFFIC_API_KEY;
  if (!apiKey) {
    throw new Error('[MarineTraffic] API key not configured. Ensure MARINETRAFFIC_API_KEY is in Secret Manager.');
  }

  const response = await axios.get(
    `${MT_API_URL}/chokepoints/${apiKey}/protocol:jsono`,
    {
      headers: { 'Accept': 'application/json' },
      timeout: 20000,
      validateStatus: (status) => status >= 200 && status < 300,
    },
  );

  const data = response.data;

  return (data || []).map(c => ({
    source: 'MarineTraffic',
    chokepoint_name: c.name,
    status: c.status || 'NORMAL',
    vessel_queue: parseInt(c.vesselQueue, 10) || null,
    transit_delay_hours: parseFloat(c.transitDelayHours) || null,
    narrative_context: `${c.name}: Status ${c.status}. ${c.detail || ''}`,
  }));
}

function classifySeverity(vesselCount) {
  if (vesselCount >= 100) return 'HIGH';
  if (vesselCount >= 40)  return 'MODERATE';
  return 'LOW';
}
