/**
 * SENTINEL ENGINE v4.1 — Energy Grid Static Feed Adapter
 * ═══════════════════════════════════════════════════════
 * Provides realistic demo data for CFE (Comisión Federal de Electricidad).
 *
 * Three data domains:
 *   - Grid Telemetry    → Substation load, voltage, frequency
 *   - Asset Health      → Transformer status, thermal indices, maintenance
 *   - Weather Impact    → Regional meteorological risk alerts
 *
 * This adapter mirrors the pattern of static-feed.js in the logistics
 * vertical but provides energy-domain data with CFE-specific terminology.
 *
 * Usage:
 *   import { getGridTelemetry, getAssetHealth, getWeatherImpact } from './energy-grid.js';
 * ═══════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────
//  GRID TELEMETRY — Substation Load & Voltage Data
// ─────────────────────────────────────────────────────

export function getGridTelemetry() {
  return [
    {
      substation_id: 'SUB-ZMVM-001',
      substation_name: 'Subestación Naucalpan 230 kV',
      region: 'Zona Metropolitana Valle de México',
      load_pct: 87.4,
      voltage_kv: 226.8,
      voltage_status: 'MARGINAL',
      frequency_hz: 59.94,
      active_power_mw: 342.5,
      reactive_power_mvar: 118.2,
      source: 'SCADA · CENACE',
      narrative_context: 'Subestación Naucalpan opera al 87.4% de capacidad con voltaje marginal de 226.8 kV (nominal 230 kV). La frecuencia en 59.94 Hz indica estrés leve en el sistema. Potencia activa de 342.5 MW con factor de potencia aceptable. Se recomienda monitoreo cada 15 minutos y activación de plan de contingencia si supera el 90%.',
    },
    {
      substation_id: 'SUB-ZMVM-002',
      substation_name: 'Subestación Topilejo 400 kV',
      region: 'Zona Metropolitana Valle de México',
      load_pct: 72.1,
      voltage_kv: 398.5,
      voltage_status: 'NORMAL',
      frequency_hz: 60.01,
      active_power_mw: 580.3,
      reactive_power_mvar: 165.7,
      source: 'SCADA · CENACE',
      narrative_context: 'Subestación Topilejo opera dentro de parámetros normales al 72.1% de capacidad. Voltaje de 398.5 kV estable con frecuencia nominal de 60.01 Hz. Nodo crítico para respaldo de zona sur de la CDMX.',
    },
    {
      substation_id: 'SUB-NOR-015',
      substation_name: 'Subestación Topolobampo 230 kV',
      region: 'Zona Noroeste',
      load_pct: 94.2,
      voltage_kv: 221.3,
      voltage_status: 'CRITICAL',
      frequency_hz: 59.88,
      active_power_mw: 298.7,
      reactive_power_mvar: 142.1,
      source: 'SCADA · CENACE',
      narrative_context: 'ALERTA: Subestación Topolobampo en estado CRÍTICO al 94.2% de capacidad. Voltaje caído a 221.3 kV con frecuencia anómala de 59.88 Hz. Causa probable: demanda pico por ola de calor en Sinaloa (42°C). Se requiere despacho de emergencia y posible deslastre de carga.',
    },
    {
      substation_id: 'SUB-PEN-008',
      substation_name: 'Subestación Mérida Poniente 115 kV',
      region: 'Zona Peninsular',
      load_pct: 68.9,
      voltage_kv: 114.2,
      voltage_status: 'NORMAL',
      frequency_hz: 60.00,
      active_power_mw: 156.4,
      reactive_power_mvar: 45.8,
      source: 'SCADA · CENACE',
      narrative_context: 'Subestación Mérida Poniente opera normalmente al 68.9%. Voltaje estable en 114.2 kV. Sin alertas meteorológicas activas en la zona peninsular. Capacidad de respaldo disponible para temporada de huracanes.',
    },
    {
      substation_id: 'SUB-OCC-022',
      substation_name: 'Subestación Guadalajara Norte 230 kV',
      region: 'Zona Occidental',
      load_pct: 81.5,
      voltage_kv: 228.1,
      voltage_status: 'NORMAL',
      frequency_hz: 59.98,
      active_power_mw: 445.2,
      reactive_power_mvar: 132.6,
      source: 'SCADA · CENACE',
      narrative_context: 'Subestación Guadalajara Norte opera al 81.5% de capacidad, dentro del rango operativo pero acercándose al umbral de precaución (85%). Voltaje y frecuencia nominales. Demanda proyectada a incrementar 3.2% por temporada de calor.',
    },
    {
      substation_id: 'SUB-ORI-011',
      substation_name: 'Subestación Poza Rica 400 kV',
      region: 'Zona Oriental',
      load_pct: 56.3,
      voltage_kv: 401.2,
      voltage_status: 'NORMAL',
      frequency_hz: 60.02,
      active_power_mw: 712.8,
      reactive_power_mvar: 198.4,
      source: 'SCADA · CENACE',
      narrative_context: 'Subestación Poza Rica opera holgadamente al 56.3% de capacidad. Nodo estratégico de interconexión con generación de ciclo combinado. Voltaje excelente en 401.2 kV. Reserva disponible para respaldo de zonas adyacentes.',
    },
  ];
}

// ─────────────────────────────────────────────────────
//  ASSET HEALTH — Transformer & Equipment Status
// ─────────────────────────────────────────────────────

export function getAssetHealth() {
  return [
    {
      asset_id: 'TRF-ZMVM-001-A',
      asset_type: 'Transformador de Potencia 230/23 kV',
      substation_id: 'SUB-ZMVM-001',
      manufacturer: 'ABB',
      year_installed: 2008,
      last_maintenance: '2025-11-15',
      next_scheduled_maintenance: '2026-05-15',
      thermal_index: 78.4,
      thermal_status: 'ELEVATED',
      health_score: 0.72,
      oil_quality_index: 0.68,
      dissolved_gas_ppm: 342,
      criticality: 'HIGH',
      source: 'Predictivo CFE · Termografía IR',
      narrative_context: 'Transformador TRF-ZMVM-001-A presenta índice térmico elevado de 78.4°C (umbral: 85°C). Análisis de gases disueltos muestra 342 ppm (precaución a 500 ppm). Aceite con degradación parcial (índice 0.68). Mantenimiento preventivo programado para mayo 2026 — se recomienda adelantar inspección de radiadores y tratamiento termovacío del aceite.',
    },
    {
      asset_id: 'TRF-NOR-015-B',
      asset_type: 'Transformador de Potencia 230/115 kV',
      substation_id: 'SUB-NOR-015',
      manufacturer: 'Siemens',
      year_installed: 2001,
      last_maintenance: '2025-06-20',
      next_scheduled_maintenance: '2026-06-20',
      thermal_index: 91.2,
      thermal_status: 'CRITICAL',
      health_score: 0.48,
      oil_quality_index: 0.42,
      dissolved_gas_ppm: 687,
      criticality: 'CRITICAL',
      source: 'Predictivo CFE · Termografía IR',
      narrative_context: 'ALERTA CRÍTICA: Transformador TRF-NOR-015-B en Topolobampo tiene índice térmico de 91.2°C (EXCEDE umbral de 85°C). Gases disueltos en 687 ppm indican degradación activa del aceite. Score de salud 0.48 — por debajo del mínimo operativo (0.60). ACCIÓN INMEDIATA: Reducir carga al 70%, programar inspección de emergencia con equipo de termografía infrarroja y análisis cromatográfico de gases. Riesgo de falla catastrófica si no se interviene en 48 horas.',
    },
    {
      asset_id: 'INT-ZMVM-002-C1',
      asset_type: 'Interruptor de Potencia SF6 400 kV',
      substation_id: 'SUB-ZMVM-002',
      manufacturer: 'Mitsubishi Electric',
      year_installed: 2015,
      last_maintenance: '2025-12-01',
      next_scheduled_maintenance: '2026-12-01',
      thermal_index: 42.1,
      thermal_status: 'NORMAL',
      health_score: 0.94,
      oil_quality_index: null,
      dissolved_gas_ppm: null,
      criticality: 'MEDIUM',
      source: 'Predictivo CFE · SCADA',
      narrative_context: 'Interruptor SF6 INT-ZMVM-002-C1 en condiciones óptimas. Índice térmico nominal de 42.1°C. Score de salud 0.94. Último mantenimiento diciembre 2025, presión de SF6 dentro de especificaciones. Sin anomalías detectadas.',
    },
    {
      asset_id: 'TRF-PEN-008-A',
      asset_type: 'Transformador de Potencia 115/23 kV',
      substation_id: 'SUB-PEN-008',
      manufacturer: 'Prolec GE',
      year_installed: 2018,
      last_maintenance: '2026-01-10',
      next_scheduled_maintenance: '2027-01-10',
      thermal_index: 55.6,
      thermal_status: 'NORMAL',
      health_score: 0.89,
      oil_quality_index: 0.91,
      dissolved_gas_ppm: 128,
      criticality: 'LOW',
      source: 'Predictivo CFE · Termografía IR',
      narrative_context: 'Transformador TRF-PEN-008-A en excelente estado. Equipo relativamente nuevo (2018) con aceite en condiciones óptimas (índice 0.91). Gases disueltos bien controlados en 128 ppm. Sin intervención requerida hasta enero 2027.',
    },
    {
      asset_id: 'REL-OCC-022-P3',
      asset_type: 'Relé de Protección Diferencial',
      substation_id: 'SUB-OCC-022',
      manufacturer: 'SEL (Schweitzer)',
      year_installed: 2020,
      last_maintenance: '2026-02-28',
      next_scheduled_maintenance: '2027-02-28',
      thermal_index: 35.2,
      thermal_status: 'NORMAL',
      health_score: 0.97,
      oil_quality_index: null,
      dissolved_gas_ppm: null,
      criticality: 'HIGH',
      source: 'Predictivo CFE · SCADA',
      narrative_context: 'Relé de protección diferencial SEL en condiciones óptimas. Score de salud 0.97. Último test de funcionalidad febrero 2026 — todas las funciones de protección validadas. Firmware actualizado a v2024.12.',
    },
  ];
}

// ─────────────────────────────────────────────────────
//  WEATHER IMPACT — Meteorological Risk Matrix
// ─────────────────────────────────────────────────────

export function getWeatherImpact() {
  return [
    {
      region: 'Zona Noroeste',
      alert_type: 'Ola de Calor Extrema',
      wind_speed_kph: 12,
      temperature_c: 44.5,
      humidity_pct: 18,
      alert_level: 'RED',
      storm_category: null,
      affected_substations: ['SUB-NOR-015', 'SUB-NOR-016', 'SUB-NOR-017'],
      expected_load_increase_pct: 15.2,
      source: 'SMN · CONAGUA',
      narrative_context: 'ALERTA ROJA: Ola de calor extrema en zona noroeste con 44.5°C registrados en Sinaloa. Demanda eléctrica incrementará 15.2% estimado por aire acondicionado masivo. Subestaciones SUB-NOR-015 a SUB-NOR-017 en riesgo de sobrecarga. Protocolo de despacho de emergencia recomendado con activación de generación termoeléctrica de respaldo.',
    },
    {
      region: 'Zona Peninsular',
      alert_type: 'Huracán Categoría 3',
      wind_speed_kph: 185,
      temperature_c: 31.2,
      humidity_pct: 92,
      alert_level: 'RED',
      storm_category: 3,
      affected_substations: ['SUB-PEN-008', 'SUB-PEN-009', 'SUB-PEN-010'],
      expected_load_increase_pct: -40.0,
      source: 'SMN · CONAGUA · NHC',
      narrative_context: 'ALERTA ROJA: Huracán categoría 3 con vientos de 185 km/h se aproxima a la costa de Yucatán. Impacto estimado en 36-48 horas. Se recomienda activar protocolo de protección de líneas de transmisión: levantamiento de torres tipo celosía en corredor peninsular, desconexión controlada de circuitos expuestos, y pre-posicionamiento de brigadas de restauración. Demanda caerá 40% por evacuaciones pero riesgo de daño físico a infraestructura es ALTO.',
    },
    {
      region: 'Zona Metropolitana Valle de México',
      alert_type: 'Contaminación Atmosférica',
      wind_speed_kph: 5,
      temperature_c: 28.3,
      humidity_pct: 45,
      alert_level: 'YELLOW',
      storm_category: null,
      affected_substations: ['SUB-ZMVM-001', 'SUB-ZMVM-002'],
      expected_load_increase_pct: 4.8,
      source: 'SMN · CONAGUA · SEDEMA',
      narrative_context: 'Contingencia ambiental fase 1 en ZMVM. Baja velocidad de viento (5 km/h) dificulta dispersión de contaminantes. Impacto eléctrico moderado: incremento de 4.8% en demanda por sistemas de purificación y aire acondicionado en sector comercial. Subestaciones metropolitanas operan con margen suficiente.',
    },
    {
      region: 'Zona Oriental',
      alert_type: 'Tormenta Eléctrica Severa',
      wind_speed_kph: 75,
      temperature_c: 26.1,
      humidity_pct: 88,
      alert_level: 'ORANGE',
      storm_category: null,
      affected_substations: ['SUB-ORI-011', 'SUB-ORI-012'],
      expected_load_increase_pct: -5.0,
      source: 'SMN · CONAGUA',
      narrative_context: 'Tormenta eléctrica severa con descargas atmosféricas frecuentes en zona Veracruz-Tamaulipas. Riesgo de disparos de línea por rayos. Se recomienda activar reconexión automática en protecciones de línea y monitoreo intensivo de contadores de descarga en pararrayos de subestaciones afectadas.',
    },
    {
      region: 'Zona Occidental',
      alert_type: 'Condiciones Normales',
      wind_speed_kph: 22,
      temperature_c: 32.4,
      humidity_pct: 55,
      alert_level: 'GREEN',
      storm_category: null,
      affected_substations: ['SUB-OCC-022'],
      expected_load_increase_pct: 1.2,
      source: 'SMN · CONAGUA',
      narrative_context: 'Zona occidental sin alertas meteorológicas activas. Temperatura estival normal de 32.4°C en Guadalajara. Comportamiento de demanda estable con incremento marginal de 1.2%. Condiciones favorables para mantenimiento programado de líneas de transmisión.',
    },
  ];
}
