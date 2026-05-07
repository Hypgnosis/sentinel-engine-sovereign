/**
 * SENTINEL ENGINE V4.5 — Data Ingestion Schemas (Zod)
 * ═══════════════════════════════════════════════════════════
 * Enforces strict data contracts for the "Pristine Reservoir".
 */

import { z } from 'zod';

// Freight Index Schema (Freightos)
export const FreightIndexSchema = z.object({
  source: z.literal('Freightos'),
  route_origin: z.string().min(1),
  route_destination: z.string().min(1),
  rate_usd: z.number().nonnegative(),
  week_over_week_change: z.number(),
  trend: z.enum(['rising', 'stable', 'falling', 'stabilizing', 'declining']),
  narrative_context: z.string().min(10),
});

// Spot vs Contract Spread Schema (Xeneta)
export const XenetaSpreadSchema = z.object({
  source: z.literal('Xeneta'),
  route_origin: z.string().min(1),
  route_destination: z.string().min(1),
  rate_usd: z.number().nonnegative(), // Usually spot rate
  week_over_week_change: z.number().default(0),
  trend: z.enum(['rising', 'stable', 'falling', 'stabilizing', 'declining']),
  narrative_context: z.string().min(10),
});

// Port Congestion Schema (MarineTraffic)
export const PortCongestionSchema = z.object({
  source: z.literal('MarineTraffic'),
  port_name: z.string().min(1),
  vessels_at_anchor: z.number().int().nonnegative(),
  avg_wait_days: z.number().nonnegative(),
  severity_level: z.enum(['LOW', 'MODERATE', 'MODERATE-HIGH', 'HIGH', 'CRITICAL']),
  narrative_context: z.string().min(10),
});

// Chokepoint Schema (MarineTraffic)
export const ChokepointSchema = z.object({
  source: z.literal('MarineTraffic'),
  chokepoint_name: z.string().min(1),
  status: z.string().min(1),
  vessel_queue: z.number().int().nonnegative().nullable(),
  transit_delay_hours: z.number().nonnegative().nullable(),
  narrative_context: z.string().min(10),
});

// Risk Matrix Schema (Internal)
export const RiskMatrixSchema = z.object({
  source: z.string(),
  risk_factor: z.string().min(1),
  severity: z.string(),
  probability: z.string(),
  impact_window: z.string(),
  narrative_context: z.string().min(10),
});

/**
 * Validates raw data from an adapter against its schema.
 * Throws a detailed error if validation fails.
 */
export function validate(schema, data, adapterName) {
  try {
    return schema.parse(data);
  } catch (err) {
    console.error(`[VALIDATION_FAILURE] ${adapterName}:`, err.errors);
    throw new Error(`Data contract violation in ${adapterName} adapter.`);
  }
}
