/**
 * SENTINEL ENGINE — Static Feed Adapter (Development)
 * ═══════════════════════════════════════════════════════════
 * Mirrors the production data structure from the original
 * seed-firestore.js. This is the development adapter used
 * until live API keys are provisioned for Freightos, Xeneta,
 * and MarineTraffic.
 *
 * Implements the FeedAdapter interface:
 *   { freightIndices, portCongestion, chokepoints, riskMatrix }
 * ═══════════════════════════════════════════════════════════
 */

export function getFreightIndices() {
  return {
    global: {
      source: 'Freightos',
      route_origin: 'Global Composite',
      route_destination: 'Global Composite',
      rate_usd: 1847,
      week_over_week_change: 3.2,
      trend: 'rising',
      narrative_context: 'FBX Global Container Index at $1,847/FEU, up 3.2% WoW. Trans-Pacific Eastbound stabilizing after Q1 frontloading surge. Asia-Europe corridor showing sustained demand driven by EU restocking cycle.',
    },
    routes: [
      {
        source: 'Freightos',
        route_origin: 'China/East Asia',
        route_destination: 'N. America West Coast',
        rate_usd: 1520,
        week_over_week_change: -2.1,
        trend: 'stabilizing',
        narrative_context: 'Trans-Pacific Westbound USWC rate at $1,520/FEU, declining 2.1% WoW as Q1 frontloading surge subsides. Carrier blank sailings expected to support rate floors.',
      },
      {
        source: 'Freightos',
        route_origin: 'China/East Asia',
        route_destination: 'N. America East Coast',
        rate_usd: 2680,
        week_over_week_change: 4.7,
        trend: 'rising',
        narrative_context: 'USEC rates spiking 4.7% WoW to $2,680/FEU due to pre-tariff frontloading on East Coast corridor. Shippers accelerating shipments ahead of Q2 tariff escalation window.',
      },
      {
        source: 'Freightos',
        route_origin: 'China/East Asia',
        route_destination: 'N. Europe',
        rate_usd: 2340,
        week_over_week_change: 3.2,
        trend: 'rising',
        narrative_context: 'Asia-Europe rates at $2,340/FEU rising 3.2% WoW. EU restocking cycle driving sustained demand. Red Sea diversions adding 10-14 days to transit times.',
      },
      {
        source: 'Freightos',
        route_origin: 'China/East Asia',
        route_destination: 'Mediterranean',
        rate_usd: 2890,
        week_over_week_change: -1.8,
        trend: 'declining',
        narrative_context: 'Mediterranean corridor rates declining 1.8% WoW to $2,890/FEU. Seasonal adjustment in play. However, rates remain elevated vs historical averages due to Red Sea rerouting.',
      },
      {
        source: 'Freightos',
        route_origin: 'N. Europe',
        route_destination: 'N. America East Coast',
        rate_usd: 1150,
        week_over_week_change: 0.5,
        trend: 'stable',
        narrative_context: 'Transatlantic USEC rate stable at $1,150/FEU. Low volatility corridor with adequate capacity balance.',
      },
    ],
    spotContractSpreads: [
      {
        source: 'Xeneta',
        route_origin: 'Far East',
        route_destination: 'N. Europe',
        rate_usd: 2340,          // spot
        week_over_week_change: 0,
        trend: 'rising',
        narrative_context: 'Far East → N. Europe spot at $2,340 vs contract $1,890 (spread: $450). Spot-contract spread widening indicates rising market volatility.',
      },
      {
        source: 'Xeneta',
        route_origin: 'Far East',
        route_destination: 'US West Coast',
        rate_usd: 1520,
        week_over_week_change: 0,
        trend: 'stabilizing',
        narrative_context: 'Far East → USWC spot at $1,520 vs contract $1,340 (spread: $180). Relatively tight spread signals market stabilization.',
      },
      {
        source: 'Xeneta',
        route_origin: 'Far East',
        route_destination: 'US East Coast',
        rate_usd: 2680,
        week_over_week_change: 0,
        trend: 'rising',
        narrative_context: 'Far East → USEC spot at $2,680 vs contract $2,150 (spread: $530). Widest spread across all corridors. Shippers with expiring Q1 contracts face 15-22% renewal premium.',
      },
    ],
    airFreight: [
      {
        source: 'Freightos',
        route_origin: 'Hong Kong',
        route_destination: 'North America',
        rate_usd: 3.42,  // per kg
        week_over_week_change: 5.1,
        trend: 'rising',
        narrative_context: 'Air freight HKG→NAM at $3.42/kg, up 5.1% WoW. Q2 capacity tightening on TACA as e-commerce volumes accelerate.',
      },
      {
        source: 'Freightos',
        route_origin: 'Hong Kong',
        route_destination: 'Europe',
        rate_usd: 3.18,
        week_over_week_change: 2.3,
        trend: 'rising',
        narrative_context: 'Air freight HKG→EUR at $3.18/kg, up 2.3% WoW. Belly cargo recovering but still 8% below pre-COVID capacity.',
      },
    ],
  };
}

export function getPortCongestion() {
  return [
    { source: 'MarineTraffic', port_name: 'Shanghai',         vessels_at_anchor: 147, avg_wait_days: 3.2, severity_level: 'HIGH',          narrative_context: 'Shanghai congestion at 147 vessels — highest since October 2024. Cascading delays expected on Asia-Europe services within 10-14 days.' },
    { source: 'MarineTraffic', port_name: 'Singapore',         vessels_at_anchor: 42,  avg_wait_days: 1.1, severity_level: 'MODERATE',       narrative_context: 'Singapore vessel anchorage at 42, moderate congestion. Standard transshipment hub operations.' },
    { source: 'MarineTraffic', port_name: 'Rotterdam',         vessels_at_anchor: 18,  avg_wait_days: 0.8, severity_level: 'LOW',            narrative_context: 'Rotterdam operating at optimal efficiency. 18 vessels at anchor with 0.8-day average wait time.' },
    { source: 'MarineTraffic', port_name: 'Long Beach',        vessels_at_anchor: 67,  avg_wait_days: 2.8, severity_level: 'HIGH',           narrative_context: 'Long Beach stabilized but remains HIGH due to chassis shortages. 67 vessels at anchor, 2.8-day average wait.' },
    { source: 'MarineTraffic', port_name: 'Los Angeles',       vessels_at_anchor: 54,  avg_wait_days: 2.4, severity_level: 'MODERATE-HIGH',  narrative_context: 'LA port congestion improving. Vessel count down to 54, wait times decreasing to 2.4 days.' },
    { source: 'MarineTraffic', port_name: 'Savannah',          vessels_at_anchor: 23,  avg_wait_days: 1.4, severity_level: 'MODERATE',       narrative_context: 'Savannah port moderate congestion at 23 vessels, 1.4-day wait. Steady throughput.' },
    { source: 'MarineTraffic', port_name: 'Hamburg',           vessels_at_anchor: 12,  avg_wait_days: 0.6, severity_level: 'LOW',            narrative_context: 'Hamburg low congestion — 12 vessels, 0.6-day wait. Northern Europe corridor operating smoothly.' },
    { source: 'MarineTraffic', port_name: 'Busan',             vessels_at_anchor: 31,  avg_wait_days: 1.7, severity_level: 'MODERATE',       narrative_context: 'Busan congestion worsening to 31 vessels. Transshipment overflow from Shanghai delays.' },
    { source: 'MarineTraffic', port_name: 'Jebel Ali (Dubai)', vessels_at_anchor: 8,   avg_wait_days: 0.4, severity_level: 'LOW',            narrative_context: 'Jebel Ali operating at minimal congestion. 8 vessels, 0.4-day wait.' },
    { source: 'MarineTraffic', port_name: 'Santos (Brazil)',   vessels_at_anchor: 28,  avg_wait_days: 2.1, severity_level: 'MODERATE',       narrative_context: 'Santos congestion worsening — 28 vessels at anchor, 2.1-day average wait. Brazil grain export season pressure.' },
  ];
}

export function getChokepoints() {
  return [
    { source: 'MarineTraffic', chokepoint_name: 'Suez Canal',          status: 'RESTRICTED',        vessel_queue: 34,   transit_delay_hours: 12,  narrative_context: 'Suez Canal northbound flow restricted due to maintenance dredging. 34-vessel queue, 12-hour average transit delay.' },
    { source: 'MarineTraffic', chokepoint_name: 'Panama Canal',        status: 'NORMAL',            vessel_queue: 18,   transit_delay_hours: 8,   narrative_context: 'Panama Canal draft restrictions lifted after rainfall recovery. Slot auction premiums declining. 18-vessel queue.' },
    { source: 'MarineTraffic', chokepoint_name: 'Strait of Malacca',   status: 'NORMAL',            vessel_queue: 12,   transit_delay_hours: 2,   narrative_context: 'Strait of Malacca standard traffic flow. 12-vessel queue, 2-hour transit delay.' },
    { source: 'MarineTraffic', chokepoint_name: 'Strait of Hormuz',    status: 'ELEVATED RISK',     vessel_queue: 8,    transit_delay_hours: 4,   narrative_context: 'Strait of Hormuz under elevated geopolitical tension. Insurance premiums elevated for transiting vessels.' },
    { source: 'MarineTraffic', chokepoint_name: 'Cape of Good Hope',   status: 'ACTIVE DIVERSIONS', vessel_queue: null, transit_delay_hours: null, narrative_context: '15% of Asia-Europe services rerouted via Cape of Good Hope for Houthi risk mitigation. Adds 10-14 days to transit.' },
  ];
}

export function getRiskMatrix() {
  return [
    { source: 'High ArchyTech Models', risk_factor: 'Red Sea / Houthi Disruption',   severity: 'HIGH',     probability: 'ONGOING',   impact_window: 'Indefinite',  narrative_context: 'Red Sea / Houthi disruption remains ongoing. Indefinite timeline. 15% of Asia-Europe services diverted via Cape of Good Hope. Insurance premiums 200-300% above baseline.' },
    { source: 'High ArchyTech Models', risk_factor: 'US-China Tariff Escalation',     severity: 'CRITICAL', probability: 'HIGH',      impact_window: 'Q2-Q3 2025', narrative_context: 'US-China tariff escalation probability HIGH for Q2-Q3 2025. Pre-tariff frontloading driving USEC rate spikes. Supply chain reconfiguration toward Vietnam, India accelerating.' },
    { source: 'High ArchyTech Models', risk_factor: 'Panama Canal Drought',           severity: 'LOW',      probability: 'RESOLVED',  impact_window: 'N/A',        narrative_context: 'Panama Canal drought resolved after sustained rainfall recovery. Draft restrictions lifted. Slot auction premiums normalizing.' },
    { source: 'High ArchyTech Models', risk_factor: 'Shanghai Port Congestion',       severity: 'HIGH',     probability: 'CONFIRMED', impact_window: '2-4 weeks',   narrative_context: 'Shanghai port congestion confirmed at 147 vessels — highest since Oct 2024. Cascading delays expected on Asia-Europe services. Impact window: 2-4 weeks.' },
    { source: 'High ArchyTech Models', risk_factor: 'EU Carbon Border Tax (CBAM)',    severity: 'MODERATE', probability: 'CERTAIN',   impact_window: 'Oct 2025',   narrative_context: 'EU CBAM implementation certain for October 2025. Will add compliance costs to carbon-intensive shipping routes. Moderate severity — manageable with advance planning.' },
    { source: 'High ArchyTech Models', risk_factor: 'IMO 2025 Fuel Regulations',      severity: 'MODERATE', probability: 'CERTAIN',   impact_window: 'Jan 2026',   narrative_context: 'IMO 2025 fuel regulations certain for January 2026. Moderate severity — fuel surcharges expected to increase 3-5%. Carriers already adjusting fleet mix.' },
  ];
}
