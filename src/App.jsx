import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Shield, ShieldAlert, ShieldCheck, XCircle,
  Lock, Eye, Fingerprint, Scan,
  Activity, Server, Database,
  Languages, Zap, Clock, Send,
  BarChart3, Globe, Radio, Crosshair,
  Terminal, Timer, MessageSquare,
  Wifi, WifiOff, Ban,
  Mic, Volume2, VolumeX
} from 'lucide-react';
import { SentinelClient } from './SentinelClient';

// ═══════════════════════════════════════════════════════════════════
//  SENTINEL GOVERNANCE DASHBOARD V5.5 — "Sovereign"
//  Built by High ArchyTech Solutions
//  Architecture: Hardened Security Appliance
//  Pattern: Glassmorphism / High Density / Motion-Reduced
// ═══════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────
//  TRANSLATIONS (EN / ES)
// ──────────────────────────────────────────────────────────────────
const translations = {
  en: {
    brand: 'SENTINEL ENGINE',
    version: 'V5.5.0 SOVEREIGN',

    metrics: {
      bhr: 'Blocked Hallucination Rate',
      bhrShort: 'BHR',
      piiScrub: 'PII Scrub Volume',
      sensorTrips: 'Sensor Trips',
      subZeroHits: 'Sub-Zero Window Hits',
    },
    status: {
      failClosed: 'FAIL-CLOSED ACTIVE',
      backbone: 'PRISTINE BACKBONE STABLE',
      hkdf: 'HKDF ENCRYPTED',
      nominal: 'NOMINAL',
      degraded: 'DEGRADED',
      critical: 'CRITICAL',
    },
    pillars: {
      prosecutor: {
        title: "Prosecutor's Gauge",
        subtitle: 'Live Factual Integrity',
        desc: 'Real-time stream of verified vs. blocked inferences',
        logTitle: 'Semantic Contradictions Caught',
        verified: 'Verified',
        blocked: 'Blocked',
        groundingMismatch: 'Grounding Source mismatch',
        factualDrift: 'Factual Drift Detected',
        temporalAnomaly: 'Temporal Anomaly',
        sourceConflict: 'Source Conflict',
        totalInferences: 'Total Inferences',
      },
      privacy: {
        title: 'Privacy Heatmap',
        subtitle: 'PII Tokenization Density',
        desc: 'SYSTEM_PEPPER HKDF irreversible tokenization',
        ssn: 'SSN Tokens',
        cc: 'CC Tokens',
        subjectId: 'Subject IDs',
        totalScrubbed: 'Total Scrubbed',
        method: 'HKDF-SHA256 + SYSTEM_PEPPER',
        irreversible: 'Irreversible',
        packetLegend: 'Packet Density Map',
      },
      failClosed: {
        title: 'Fail-Closed Resilience',
        subtitle: 'ICT Stress Monitor',
        desc: 'Shadow Classifier default-to-SENSITIVE on blackout',
        shadowClassifier: 'Shadow Classifier',
        active: 'ACTIVE',
        standby: 'STANDBY',
        sensorStatus: 'Sensor Array',
        online: 'ONLINE',
        blackout: 'BLACKOUT',
        failClosedEvents: 'Fail-Closed Events',
        defaultedSensitive: 'Defaulted → SENSITIVE',
        circuitBreaker: 'Circuit Breaker',
        closed: 'CLOSED',
        open: 'OPEN',
        nliProsecutor: 'NLI Prosecutor',
        resilienceMode: 'Resilience Mode',
        off: 'OFF',
        ictStress: 'ICT Stress Level',
      },
      subZero: {
        title: 'Sub-Zero Window',
        subtitle: 'Retrieval Sovereignty',
        desc: 'GCP Private Backbone retrieval within 40ms mandate',
        within40ms: 'Within 40ms',
        p50: 'P50 Latency',
        p99: 'P99 Latency',
        backbone: 'GCP Private Backbone',
        residency: 'Data Residency',
        region: 'us-west1 (Oregon)',
        mandate: '40ms Mandate Line',
        bucketLabel: 'Latency Distribution (ms)',
        retrievals: 'Total Retrievals',
      },
    },
    compliance: {
      title: 'Board-Ready Compliance Mapping',
      dora: { label: 'DORA', desc: 'Operational resilience via fail-closed behavior.' },
      euAiAct: { label: 'EU AI Act', desc: 'Synchronous factual verification evidence locker.' },
      nist: { label: 'NIST AI 600-1', desc: 'Generative AI risk measurement layer.' },
      gdpr: { label: 'GDPR / Privacy', desc: 'HKDF-peppered pseudonymization path.' },
    },
    actions: {
      simulateAttack: 'Simulate Attack',
      resetSystem: 'Reset System',
      attacking: 'Attack Active...',
    },
    auditLog: {
      title: 'Real-Time Governance Stream',
      subtitle: 'Real-Time Governance Telemetry',
      clear: 'Clear Stream',
      evidenceLocker: 'Evidence Locker ID',
      verified: 'Verified',
      arbitration: 'Arbitration Request',
      permit: 'Permit Issued',
      deny: 'Request Denied',
    },
    lang: 'EN',
    switchLang: 'ES',
    terminal: {
      title: 'Ask Sentinel',
      subtitle: 'Governance Intelligence Query — verified against live data',
      placeholder: 'Ask about regulatory exposure, risk posture, compliance gaps, operational resilience...',
      welcome: 'Sentinel Governance Terminal online. V5.5 Sovereign Core active. Gavel Logic initialized.',
      thinking: 'Verifying against live data sources...',
      error: 'PIPELINE STALL — Unable to reach inference layer.',
      partial: 'CAUTIONARY INSIGHT — DEGRADED RETRIEVAL',
      verified: 'GROUNDED INTEGRITY — VERIFIED',
      rejected: 'PROTECTIVE INTERVENTION — LOW SUBSTANCE',
      hallucination: 'VETOED: SEMANTIC HALLUCINATION',
      voiceOn: 'Voice enabled',
      voiceOff: 'Voice muted',
      listening: 'Listening...',
      suggestions: [
        'What is our current DORA compliance posture?',
        'Summarize EU AI Act obligations for our AI models',
        'Run a NIST AI 600-1 risk gap analysis',
        'Show PII exposure across active data pipelines',
      ],
    },
  },
  es: {
    brand: 'SENTINEL ENGINE',
    version: 'V5.5.0 SOBERANÍA',

    metrics: {
      bhr: 'Tasa de Alucinación Bloqueada',
      bhrShort: 'TAB',
      piiScrub: 'Volumen de Limpieza PII',
      sensorTrips: 'Activaciones de Sensor',
      subZeroHits: 'Aciertos Ventana Sub-Zero',
    },
    status: {
      failClosed: 'FALLO-CERRADO ACTIVO',
      backbone: 'COLUMNA PRISTINA ESTABLE',
      hkdf: 'CIFRADO HKDF',
      nominal: 'NOMINAL',
      degraded: 'DEGRADADO',
      critical: 'CRÍTICO',
    },
    pillars: {
      prosecutor: {
        title: 'Indicador del Fiscal',
        subtitle: 'Integridad Factual en Vivo',
        desc: 'Flujo en tiempo real de inferencias verificadas vs. bloqueadas',
        logTitle: 'Contradicciones Semánticas Capturadas',
        verified: 'Verificadas',
        blocked: 'Bloqueadas',
        groundingMismatch: 'Discrepancia de Fuente Base',
        factualDrift: 'Deriva Factual Detectada',
        temporalAnomaly: 'Anomalía Temporal',
        sourceConflict: 'Conflicto de Fuentes',
        totalInferences: 'Total Inferencias',
      },
      privacy: {
        title: 'Mapa de Calor de Privacidad',
        subtitle: 'Densidad de Tokenización PII',
        desc: 'Tokenización irreversible SYSTEM_PEPPER HKDF',
        ssn: 'Tokens SSN',
        cc: 'Tokens CC',
        subjectId: 'IDs de Sujeto',
        totalScrubbed: 'Total Limpiado',
        method: 'HKDF-SHA256 + SYSTEM_PEPPER',
        irreversible: 'Irreversible',
        packetLegend: 'Mapa de Densidad de Paquetes',
      },
      failClosed: {
        title: 'Resiliencia Fallo-Cerrado',
        subtitle: 'Monitor de Estrés ICT',
        desc: 'Clasificador Sombra predeterminado a SENSIBLE en apagón',
        shadowClassifier: 'Clasificador Sombra',
        active: 'ACTIVO',
        standby: 'EN ESPERA',
        sensorStatus: 'Array de Sensores',
        online: 'EN LÍNEA',
        blackout: 'APAGÓN',
        failClosedEvents: 'Eventos Fallo-Cerrado',
        defaultedSensitive: 'Predeterminado → SENSIBLE',
        circuitBreaker: 'Interruptor',
        closed: 'CERRADO',
        open: 'ABIERTO',
        nliProsecutor: 'Fiscal NLI',
        resilienceMode: 'Modo Resiliencia',
        off: 'APAGADO',
        ictStress: 'Nivel de Estrés ICT',
      },
      subZero: {
        title: 'Ventana Sub-Zero',
        subtitle: 'Soberanía de Recuperación',
        desc: 'Recuperación GCP dentro del mandato de 40ms',
        within40ms: 'Dentro de 40ms',
        p50: 'Latencia P50',
        p99: 'Latencia P99',
        backbone: 'Columna Privada GCP',
        residency: 'Residencia Datos',
        region: 'us-west1 (Oregon)',
        mandate: 'Línea Mandato 40ms',
        bucketLabel: 'Distribución de Latencia (ms)',
        retrievals: 'Total Recuperaciones',
      },
    },
    compliance: {
      title: 'Mapeo de Cumplimiento para Junta Directiva',
      dora: { label: 'DORA', desc: 'Resiliencia operativa vía comportamiento fallo-cerrado.' },
      euAiAct: { label: 'Ley IA UE', desc: 'Casillero de evidencia de verificación factual síncrona.' },
      nist: { label: 'NIST AI 600-1', desc: 'Capa de medición de riesgo de IA generativa.' },
      gdpr: { label: 'RGPD / Privacidad', desc: 'Ruta de pseudonimización con pepper HKDF.' },
    },
    actions: {
      simulateAttack: 'Simular Ataque',
      resetSystem: 'Restablecer',
      attacking: 'Ataque Activo...',
    },
    auditLog: {
      title: 'Flujo de Gobernanza en Tiempo Real',
      subtitle: 'Telemetría de Gobernanza en Vivo',
      clear: 'Limpiar Flujo',
      evidenceLocker: 'ID Casillero de Evidencia',
      verified: 'Verificado',
      arbitration: 'Solicitud de Arbitraje',
      permit: 'Permiso Emitido',
      deny: 'Solicitud Denegada',
    },
    lang: 'ES',
    switchLang: 'EN',
    terminal: {
      title: 'Pregúntale a Sentinel',
      subtitle: 'Consulta de Inteligencia de Gobernanza — verificada con datos en vivo',
      placeholder: 'Pregunta sobre exposición regulatoria, postura de riesgo, brechas de cumplimiento...',
      welcome: 'Terminal de Gobernanza Sentinel en línea. Núcleo V5.5 Soberanía activo. Lógica Gavel inicializada.',
      thinking: 'Verificando contra fuentes de datos en vivo...',
      error: 'FALLO EN PIPELINE — No se pudo alcanzar la capa de inferencia.',
      partial: 'INSIGHT DE PRECAUCIÓN — RECUPERACIÓN DEGRADADA',
      verified: 'INTEGRIDAD FUNDAMENTADA — VERIFICADO',
      rejected: 'INTERVENCIÓN PROTECTORA — BAJA SUSTANCIA',
      hallucination: 'VETO: ALUCINACIÓN SEMÁNTICA',
      voiceOn: 'Voz activada',
      voiceOff: 'Voz silenciada',
      listening: 'Escuchando...',
      suggestions: [
        '¿Cuál es nuestra postura actual de cumplimiento DORA?',
        'Resume las obligaciones del EU AI Act para nuestros modelos',
        'Ejecuta un análisis de brechas NIST AI 600-1',
        'Muestra exposición PII en pipelines de datos activos',
      ],
    },
  },
};

// ──────────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────────
const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const makeLogEntry = (type, msg, sev = 'info') => ({
  id: uid(), ts: ts(), type, msg, sev,
});

const GAUGE_R = 80;
const GAUGE_CIRC = 2 * Math.PI * GAUGE_R;

const makeLatencyBuckets = () =>
  Array.from({ length: 20 }, (_, i) => {
    const center = i * 5 + 2.5;
    const base = Math.max(3, 95 * Math.exp(-center / 14));
    return { label: `${i * 5}`, height: Math.min(100, base + Math.random() * 8) };
  });

const CONTRADICTION_TYPES_EN = ['Grounding Source mismatch', 'Factual Drift Detected', 'Temporal Anomaly', 'Source Conflict'];
const CONTRADICTION_TYPES_ES = ['Discrepancia de Fuente Base', 'Deriva Factual Detectada', 'Anomalía Temporal', 'Conflicto de Fuentes'];

// ──────────────────────────────────────────────────────────────────
//  SVG LOGOS
// ──────────────────────────────────────────────────────────────────
const SentinelShieldLogo = ({ size = 36, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
    <defs>
      <linearGradient id="shieldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#BC13FE" />
        <stop offset="100%" stopColor="#8B0FCE" />
      </linearGradient>
      <filter id="shieldGlow">
        <feGaussianBlur stdDeviation="2" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
    {/* Outer shield */}
    <path d="M24 4 L42 12 L42 28 Q42 40 24 46 Q6 40 6 28 L6 12 Z"
      fill="none" stroke="url(#shieldGrad)" strokeWidth="1.5" filter="url(#shieldGlow)" />
    {/* Inner shield */}
    <path d="M24 10 L36 16 L36 27 Q36 36 24 41 Q12 36 12 27 L12 16 Z"
      fill="rgba(188,19,254,0.08)" stroke="#BC13FE" strokeWidth="0.8" opacity="0.7" />
    {/* Lock icon inside */}
    <rect x="20" y="22" width="8" height="7" rx="1.5" fill="none" stroke="#FFD700" strokeWidth="1.2" />
    <path d="M22 22 V19 Q22 16 24 16 Q26 16 26 19 V22" fill="none" stroke="#FFD700" strokeWidth="1.2" />
    <circle cx="24" cy="26" r="1" fill="#FFD700" />
  </svg>
);

const HighArchyLogo = ({ className = '' }) => (
  <svg viewBox="0 0 220 20" className={className} xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="haGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stopColor="#BC13FE" />
        <stop offset="100%" stopColor="#FFD700" />
      </linearGradient>
    </defs>
    <text x="0" y="15" fontFamily="'JetBrains Mono', monospace" fontWeight="700" fontSize="11" fill="url(#haGrad)" letterSpacing="3">
      HIGH ARCHYTECH
    </text>
  </svg>
);

// ──────────────────────────────────────────────────────────────────
//  STATUS RIBBON
// ──────────────────────────────────────────────────────────────────
const StatusRibbon = ({ t, attackActive }) => {
  const statuses = [
    { label: t.status.failClosed, icon: ShieldCheck, ok: !attackActive, activeLabel: t.status.failClosed },
    { label: t.status.backbone, icon: Server, ok: !attackActive },
    { label: t.status.hkdf, icon: Lock, ok: true },
  ];

  return (
    <div className={`status-ribbon w-full border-b transition-all duration-700 ${
      attackActive
        ? 'bg-danger/[0.06] border-danger/30'
        : 'bg-obsidian-light/60 border-obsidian-border'
    }`}>
      <div className="max-w-[1600px] mx-auto px-4 flex items-center justify-between h-8">
        <div className="flex items-center gap-6">
          {statuses.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full animate-pulse-status ${
                s.ok ? 'bg-success' : 'bg-danger'
              }`} />
              <span className={`text-[9px] font-mono font-semibold tracking-[0.2em] ${
                s.ok ? 'text-success/80' : 'text-danger/80'
              }`}>
                {s.label}
              </span>
            </div>
          ))}
        </div>
        <div className="hidden sm:flex items-center gap-2">
          <Clock className="w-3 h-3 text-text-muted" />
          <span className="text-[9px] font-mono text-text-muted tracking-wider">{ts()}</span>
        </div>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────
//  NAVIGATION
// ──────────────────────────────────────────────────────────────────
const GovernanceNav = ({ t, lang, setLang, onAttack, onReset, attackActive, toggleSidebar, sidebarOpen }) => {
  return (
    <nav id="governance-nav" className="sticky top-0 z-50 bg-obsidian/80 backdrop-blur-xl border-b border-obsidian-border">
      <div className="max-w-[1600px] mx-auto px-4">
        <div className="flex items-center justify-between h-14">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <SentinelShieldLogo size={32} />
            <div className="flex flex-col">
              <span className="text-[11px] font-bold tracking-[0.3em] text-text-primary font-mono">{t.brand}</span>
              <span className="text-[8px] text-cyber-purple font-mono tracking-[0.2em]">{t.version}</span>
            </div>
          </div>

          {/* Controls — every button here is functional */}
          <div className="flex items-center gap-2">
            {/* Attack Button */}
            <button id="simulate-attack-btn"
              onClick={attackActive ? onReset : onAttack}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold tracking-wider transition-all duration-500 cursor-pointer ${
                attackActive
                  ? 'bg-danger/20 text-danger border border-danger/40 glow-danger'
                  : 'bg-obsidian-mid text-warning border border-warning/30 hover:border-warning/60 hover:bg-warning/10'
              }`}
            >
              {attackActive ? (
                <><XCircle className="w-3.5 h-3.5" />{t.actions.attacking}</>
              ) : (
                <><Zap className="w-3.5 h-3.5" />{t.actions.simulateAttack}</>
              )}
            </button>

            {/* Sidebar Toggle */}
            <button id="sidebar-toggle"
              onClick={toggleSidebar}
              className={`hidden xl:flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-mono cursor-pointer border transition-all ${
                sidebarOpen
                  ? 'text-cyber-purple border-cyber-purple/30 bg-cyber-purple-dim'
                  : 'text-text-muted border-obsidian-border hover:text-text-secondary'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
            </button>

            {/* Language */}
            <button id="lang-toggle"
              onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-obsidian-border hover:border-cyber-purple/40 text-[10px] font-mono text-text-secondary hover:text-cyber-purple transition-all cursor-pointer"
              title={`Switch to ${t.switchLang}`}
            >
              <Languages className="w-3.5 h-3.5" />
              {t.lang}
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
};

// ──────────────────────────────────────────────────────────────────
//  METRIC STRIP (Top Summary KPIs)
// ──────────────────────────────────────────────────────────────────
const MetricStrip = ({ t, bhr, piiTotal, sensorTrips, subZeroPercent, attackActive }) => {
  const items = [
    { label: t.metrics.bhr, value: `${bhr.toFixed(1)}%`, icon: Crosshair, accent: 'purple', critical: bhr > 99 },
    { label: t.metrics.piiScrub, value: piiTotal.toLocaleString(), icon: Fingerprint, accent: 'gold' },
    { label: t.metrics.sensorTrips, value: sensorTrips.toString(), icon: Radio, accent: attackActive ? 'danger' : 'purple' },
    { label: t.metrics.subZeroHits, value: `${subZeroPercent.toFixed(1)}%`, icon: Timer, accent: 'gold' },
  ];

  const accentMap = {
    purple: { bg: 'bg-cyber-purple-dim', text: 'text-cyber-purple', border: 'border-cyber-purple/20' },
    gold: { bg: 'bg-amber-gold-dim', text: 'text-amber-gold', border: 'border-amber-gold/20' },
    danger: { bg: 'bg-danger/10', text: 'text-danger', border: 'border-danger/20' },
  };

  return (
    <div className="border-b border-obsidian-border bg-obsidian-light/30">
      <div className="max-w-[1600px] mx-auto px-4 py-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {items.map((item, i) => {
            const a = accentMap[item.accent];
            return (
              <div key={i} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${a.border} ${a.bg} transition-all duration-500`}>
                <div className={`p-1.5 rounded-md ${a.bg}`}>
                  <item.icon className={`w-4 h-4 ${a.text}`} />
                </div>
                <div className="min-w-0">
                  <div className={`text-base font-bold font-mono ${a.text} ${item.critical ? 'text-glow-purple' : ''}`}>{item.value}</div>
                  <div className="text-[9px] font-mono text-text-muted tracking-wider uppercase truncate">{item.label}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────
//  PILLAR CARD WRAPPER
// ──────────────────────────────────────────────────────────────────
const PillarCard = ({ icon: Icon, title, subtitle, children, attackActive = false }) => (
  <div className={`glass-panel-elevated p-4 flex flex-col transition-all duration-500 ${
    attackActive ? 'border-danger/25' : ''
  }`}>
    <div className="flex items-center gap-3 mb-3 pb-3 border-b border-obsidian-border">
      <div className="p-2 rounded-lg bg-cyber-purple-dim">
        <Icon className="w-4 h-4 text-cyber-purple" />
      </div>
      <div className="min-w-0">
        <h3 className="text-xs font-bold font-mono text-text-primary tracking-wide">{title}</h3>
        <p className="text-[9px] font-mono text-text-muted uppercase tracking-[0.15em]">{subtitle}</p>
      </div>
    </div>
    <div className="flex-1">{children}</div>
  </div>
);

// ──────────────────────────────────────────────────────────────────
//  PILLAR 1: PROSECUTOR'S GAUGE
// ──────────────────────────────────────────────────────────────────
const ProsecutorGauge = ({ t, bhr, verified, blocked, contradictions, attackActive }) => {
  const dashOffset = GAUGE_CIRC - (GAUGE_CIRC * bhr / 100);

  return (
    <PillarCard icon={Crosshair} title={t.pillars.prosecutor.title} subtitle={t.pillars.prosecutor.subtitle} attackActive={attackActive}>
      {/* Gauge */}
      <div className="flex justify-center mb-4">
        <div className="relative w-40 h-40">
          <svg viewBox="0 0 200 200" className="w-full h-full">
            <circle cx="100" cy="100" r={GAUGE_R} fill="none" stroke="#2A2A2A" strokeWidth="5" />
            <circle cx="100" cy="100" r={GAUGE_R} fill="none"
              stroke={attackActive ? '#EF4444' : '#BC13FE'}
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={GAUGE_CIRC}
              strokeDashoffset={dashOffset}
              transform="rotate(-90, 100, 100)"
              style={{ transition: 'stroke-dashoffset 1.2s ease-in-out' }}
            />
            {/* Glow ring */}
            <circle cx="100" cy="100" r={GAUGE_R} fill="none"
              stroke={attackActive ? 'rgba(239,68,68,0.15)' : 'rgba(188,19,254,0.15)'}
              strokeWidth="14"
              strokeDasharray={GAUGE_CIRC}
              strokeDashoffset={dashOffset}
              transform="rotate(-90, 100, 100)"
              style={{ transition: 'stroke-dashoffset 1.2s ease-in-out' }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`text-2xl font-bold font-mono transition-colors duration-700 ${attackActive ? 'text-danger' : 'text-amber-gold'}`}>
              {bhr.toFixed(1)}%
            </span>
            <span className="text-[9px] font-mono text-text-muted uppercase tracking-[0.2em]">{t.metrics.bhrShort}</span>
          </div>
        </div>
      </div>

      {/* Verified / Blocked */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="text-center p-2 rounded-lg bg-success/[0.06] border border-success/15">
          <div className="text-sm font-bold font-mono text-success">{verified.toLocaleString()}</div>
          <div className="text-[9px] font-mono text-text-muted">{t.pillars.prosecutor.verified}</div>
        </div>
        <div className="text-center p-2 rounded-lg bg-danger/[0.06] border border-danger/15">
          <div className="text-sm font-bold font-mono text-danger">{blocked.toLocaleString()}</div>
          <div className="text-[9px] font-mono text-text-muted">{t.pillars.prosecutor.blocked}</div>
        </div>
      </div>

      {/* Total Inferences */}
      <div className="flex items-center justify-between px-2 py-1.5 mb-3 rounded bg-obsidian-light border border-obsidian-border">
        <span className="text-[9px] font-mono text-text-muted">{t.pillars.prosecutor.totalInferences}</span>
        <span className="text-[10px] font-mono font-bold text-text-primary">{(verified + blocked).toLocaleString()}</span>
      </div>

      {/* V5.5 Status Bar */}
      <div className="flex items-center justify-between mt-6 p-2.5 rounded-lg bg-obsidian/40 border border-obsidian-border">
        <div className="flex items-center gap-3">
          <div className="flex flex-col">
            <span className="text-[7px] font-mono text-text-muted uppercase tracking-wider">Arbitration</span>
            <span className="text-[10px] font-mono font-bold text-amber-gold">14 Active</span>
          </div>
          <div className="w-px h-6 bg-obsidian-border" />
          <div className="flex flex-col">
            <span className="text-[7px] font-mono text-text-muted uppercase tracking-wider">Permits</span>
            <span className="text-[10px] font-mono font-bold text-success">842</span>
          </div>
          <div className="w-px h-6 bg-obsidian-border" />
          <div className="flex flex-col">
            <span className="text-[7px] font-mono text-text-muted uppercase tracking-wider">Denials</span>
            <span className="text-[10px] font-mono font-bold text-danger">31</span>
          </div>
        </div>
        <div className="flex items-center gap-2 px-2 py-1 rounded bg-cyber-purple/10 border border-cyber-purple/20">
          <ShieldCheck className="w-3 h-3 text-cyber-purple" />
          <div className="flex flex-col">
            <span className="text-[6px] font-mono text-text-muted uppercase leading-none">Sig Layer</span>
            <span className="text-[8px] font-mono font-bold text-cyber-purple leading-tight">ECDSA P-256</span>
          </div>
        </div>
      </div>

      {/* Contradiction Log */}
      <div className="border-t border-obsidian-border pt-2">
        <h4 className="text-[9px] font-mono text-text-muted uppercase tracking-[0.15em] mb-2">{t.pillars.prosecutor.logTitle}</h4>
        <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
          {contradictions.length === 0 && (
            <div className="text-[10px] font-mono text-text-muted italic py-2 text-center">—</div>
          )}
          {contradictions.slice(0, 8).map(c => (
            <div key={c.id} className="flex items-center gap-2 text-[9px] font-mono p-1.5 rounded bg-obsidian-light/60 animate-fade-in">
              <span className="text-text-muted flex-shrink-0 w-16">{c.ts}</span>
              <span className="text-danger truncate flex-1">{c.type}</span>
              <span className="text-amber-gold flex-shrink-0">{c.conf}</span>
            </div>
          ))}
        </div>
      </div>
    </PillarCard>
  );
};

// ──────────────────────────────────────────────────────────────────
//  PILLAR 2: PRIVACY HEATMAP
// ──────────────────────────────────────────────────────────────────
const PrivacyHeatmap = ({ t, counters, attackActive }) => {
  const total = counters.ssn + counters.cc + counters.subjectId;

  // Generate deterministic heatmap grid based on counters
  const cells = useMemo(() => {
    const grid = [];
    for (let i = 0; i < 180; i++) {
      const hash = ((i * 17 + total * 3) % 137);
      if (hash < 30) grid.push('ssn');
      else if (hash < 48) grid.push('cc');
      else if (hash < 60) grid.push('subject');
      else if (hash < 78) grid.push('active');
      else grid.push('clean');
    }
    return grid;
  }, [total]);

  const cellColor = {
    ssn: 'bg-cyber-purple/70',
    cc: 'bg-amber-gold/60',
    subject: 'bg-cyan-400/50',
    active: 'bg-cyber-purple/30',
    clean: 'bg-obsidian-border-light/40',
  };

  return (
    <PillarCard icon={Fingerprint} title={t.pillars.privacy.title} subtitle={t.pillars.privacy.subtitle} attackActive={attackActive}>
      {/* HKDF Badge */}
      <div className="flex items-center gap-2 mb-3 px-2 py-1.5 rounded-lg bg-success/[0.06] border border-success/15">
        <Lock className="w-3 h-3 text-success" />
        <span className="text-[9px] font-mono font-bold text-success tracking-[0.15em]">{t.pillars.privacy.method}</span>
        <span className="ml-auto text-[8px] font-mono text-success/60">{t.pillars.privacy.irreversible}</span>
      </div>

      {/* Heatmap Grid */}
      <div className="mb-3">
        <div className="text-[8px] font-mono text-text-muted mb-1.5 tracking-wider uppercase">{t.pillars.privacy.packetLegend}</div>
        <div className="grid gap-[2px]" style={{ gridTemplateColumns: 'repeat(18, 1fr)' }}>
          {cells.map((type, i) => (
            <div key={i} className={`aspect-square rounded-[2px] ${cellColor[type]} transition-colors duration-700`} />
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mb-3 text-[8px] font-mono text-text-muted">
        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-[1px] bg-cyber-purple/70" />SSN</div>
        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-[1px] bg-amber-gold/60" />CC</div>
        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-[1px] bg-cyan-400/50" />ID</div>
        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-[1px] bg-cyber-purple/30" />Active</div>
      </div>

      {/* Counters */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { label: t.pillars.privacy.ssn, value: counters.ssn, color: 'text-cyber-purple' },
          { label: t.pillars.privacy.cc, value: counters.cc, color: 'text-amber-gold' },
          { label: t.pillars.privacy.subjectId, value: counters.subjectId, color: 'text-cyan-400' },
        ].map((c, i) => (
          <div key={i} className="text-center p-2 rounded-lg bg-obsidian-light border border-obsidian-border">
            <div className={`text-sm font-bold font-mono ${c.color}`}>{c.value.toLocaleString()}</div>
            <div className="text-[8px] font-mono text-text-muted tracking-wider">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Total */}
      <div className="flex items-center justify-between px-2 py-1.5 rounded bg-obsidian-light border border-obsidian-border">
        <span className="text-[9px] font-mono text-text-muted">{t.pillars.privacy.totalScrubbed}</span>
        <span className="text-sm font-mono font-bold text-amber-gold">{total.toLocaleString()}</span>
      </div>
    </PillarCard>
  );
};

// ──────────────────────────────────────────────────────────────────
//  PILLAR 3: FAIL-CLOSED RESILIENCE MONITOR
// ──────────────────────────────────────────────────────────────────
const FailClosedMonitor = ({ t, shadowActive, sensorBlackout, events, attackActive, ictStress }) => {
  const tp = t.pillars.failClosed;

  const statuses = [
    {
      label: tp.shadowClassifier,
      value: shadowActive ? tp.active : tp.standby,
      ok: !shadowActive,
      icon: Eye,
    },
    {
      label: tp.sensorStatus,
      value: sensorBlackout ? tp.blackout : tp.online,
      ok: !sensorBlackout,
      icon: sensorBlackout ? WifiOff : Wifi,
    },
    {
      label: tp.circuitBreaker,
      value: attackActive ? tp.open : tp.closed,
      ok: !attackActive,
      icon: Shield,
    },
    {
      label: tp.nliProsecutor,
      value: tp.active,
      ok: true,
      icon: Scan,
    },
    {
      label: tp.resilienceMode,
      value: attackActive ? tp.active : tp.off,
      ok: !attackActive,
      icon: Activity,
    },
  ];

  return (
    <PillarCard icon={ShieldAlert} title={tp.title} subtitle={tp.subtitle} attackActive={attackActive}>
      {/* ICT Stress Bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[9px] font-mono text-text-muted tracking-wider">{tp.ictStress}</span>
          <span className={`text-[9px] font-mono font-bold ${
            ictStress > 70 ? 'text-danger' : ictStress > 40 ? 'text-warning' : 'text-success'
          }`}>{Math.round(ictStress)}%</span>
        </div>
        <div className="h-2 rounded-full bg-obsidian-border overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${
              ictStress > 70 ? 'bg-gradient-to-r from-danger/80 to-danger' :
              ictStress > 40 ? 'bg-gradient-to-r from-warning/80 to-warning' :
              'bg-gradient-to-r from-success/80 to-success'
            }`}
            style={{ width: `${Math.round(ictStress)}%` }}
          />
        </div>
      </div>

      {/* Status Board */}
      <div className="space-y-1.5 mb-3">
        {statuses.map((s, i) => (
          <div key={i} className={`flex items-center justify-between p-2 rounded-lg border transition-all duration-500 ${
            s.ok
              ? 'bg-obsidian-light/40 border-obsidian-border'
              : 'bg-danger/[0.05] border-danger/20'
          }`}>
            <div className="flex items-center gap-2">
              <s.icon className={`w-3 h-3 ${s.ok ? 'text-text-muted' : 'text-danger'}`} />
              <span className="text-[10px] font-mono text-text-secondary">{s.label}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${s.ok ? 'bg-success' : 'bg-danger animate-pulse-status'}`} />
              <span className={`text-[9px] font-mono font-bold tracking-wider ${
                s.ok ? 'text-success' : 'text-danger'
              }`}>{s.value}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Fail-Closed Event Log */}
      <div className="border-t border-obsidian-border pt-2">
        <h4 className="text-[9px] font-mono text-text-muted uppercase tracking-[0.15em] mb-1.5">{tp.failClosedEvents}</h4>
        <div className="space-y-1 max-h-20 overflow-y-auto pr-1">
          {events.length === 0 && (
            <div className="text-[10px] font-mono text-text-muted italic py-1.5 text-center">—</div>
          )}
          {events.slice(0, 5).map(e => (
            <div key={e.id} className="flex items-center gap-2 text-[9px] font-mono p-1.5 rounded bg-danger/[0.04] border border-danger/10 animate-fade-in">
              <Ban className="w-3 h-3 text-danger flex-shrink-0" />
              <span className="text-text-muted flex-shrink-0 w-14">{e.ts}</span>
              <span className="text-danger/80 truncate">{e.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </PillarCard>
  );
};

// ──────────────────────────────────────────────────────────────────
//  PILLAR 4: SUB-ZERO WINDOW
// ──────────────────────────────────────────────────────────────────
const SubZeroWindow = ({ t, buckets, percent, p50, p99, totalRetrievals, attackActive }) => {
  const tp = t.pillars.subZero;
  // 40ms mandate line position: bucket index 8 (40ms / 5ms per bucket)
  const mandateIndex = 8;

  return (
    <PillarCard icon={Timer} title={tp.title} subtitle={tp.subtitle} attackActive={attackActive}>
      {/* Key Metrics */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="text-center p-2 rounded-lg bg-cyber-purple-dim border border-cyber-purple/15">
          <div className="text-sm font-bold font-mono text-cyber-purple">{percent.toFixed(1)}%</div>
          <div className="text-[8px] font-mono text-text-muted tracking-wider">{tp.within40ms}</div>
        </div>
        <div className="text-center p-2 rounded-lg bg-success/[0.06] border border-success/15">
          <div className="text-sm font-bold font-mono text-success">{p50}ms</div>
          <div className="text-[8px] font-mono text-text-muted tracking-wider">{tp.p50}</div>
        </div>
        <div className="text-center p-2 rounded-lg bg-amber-gold-dim border border-amber-gold/15">
          <div className="text-sm font-bold font-mono text-amber-gold">{p99}ms</div>
          <div className="text-[8px] font-mono text-text-muted tracking-wider">{tp.p99}</div>
        </div>
      </div>

      {/* Histogram */}
      <div className="mb-3">
        <div className="text-[8px] font-mono text-text-muted mb-1.5 tracking-wider uppercase">{tp.bucketLabel}</div>
        <div className="relative h-28 flex items-end gap-[2px] px-1 py-1 rounded-lg bg-obsidian-light/40 border border-obsidian-border">
          {/* 40ms mandate line */}
          <div
            className="absolute top-0 bottom-0 border-l border-dashed border-danger/50 z-10"
            style={{ left: `${((mandateIndex + 0.5) / buckets.length) * 100}%` }}
          >
            <span className="absolute -top-0.5 left-1 text-[7px] font-mono text-danger/60 whitespace-nowrap">{tp.mandate}</span>
          </div>
          {buckets.map((b, i) => (
            <div key={i} className="flex-1 flex flex-col items-center justify-end h-full">
              <div
                className={`w-full rounded-t-[2px] transition-all duration-700 ${
                  i < mandateIndex ? 'bg-gradient-to-t from-cyber-purple/60 to-cyber-purple' : 'bg-gradient-to-t from-danger/40 to-danger/70'
                }`}
                style={{ height: `${b.height}%` }}
              />
            </div>
          ))}
        </div>
        {/* X-axis labels */}
        <div className="flex justify-between px-1 mt-1">
          <span className="text-[7px] font-mono text-text-muted">0ms</span>
          <span className="text-[7px] font-mono text-text-muted">50ms</span>
          <span className="text-[7px] font-mono text-text-muted">100ms</span>
        </div>
      </div>

      {/* Backbone Status */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between p-2 rounded-lg bg-obsidian-light/40 border border-obsidian-border">
          <div className="flex items-center gap-2">
            <Server className="w-3 h-3 text-text-muted" />
            <span className="text-[10px] font-mono text-text-secondary">{tp.backbone}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-success" />
            <span className="text-[9px] font-mono font-bold text-success tracking-wider">STABLE</span>
          </div>
        </div>
        <div className="flex items-center justify-between p-2 rounded-lg bg-obsidian-light/40 border border-obsidian-border">
          <div className="flex items-center gap-2">
            <Globe className="w-3 h-3 text-text-muted" />
            <span className="text-[10px] font-mono text-text-secondary">{tp.residency}</span>
          </div>
          <span className="text-[9px] font-mono font-bold text-amber-gold tracking-wider">{tp.region}</span>
        </div>
        <div className="flex items-center justify-between p-2 rounded-lg bg-obsidian-light/40 border border-obsidian-border">
          <div className="flex items-center gap-2">
            <Database className="w-3 h-3 text-text-muted" />
            <span className="text-[10px] font-mono text-text-secondary">{tp.retrievals}</span>
          </div>
          <span className="text-[9px] font-mono font-bold text-text-primary">{totalRetrievals.toLocaleString()}</span>
        </div>
      </div>
    </PillarCard>
  );
};

// ──────────────────────────────────────────────────────────────────
//  COMPLIANCE MAPPING
// ──────────────────────────────────────────────────────────────────
const ComplianceMapping = ({ t }) => {
  const frameworks = [
    { ...t.compliance.dora, icon: ShieldCheck, color: 'bg-cyber-purple', accent: 'border-cyber-purple/25 bg-cyber-purple-dim' },
    { ...t.compliance.euAiAct, icon: Eye, color: 'bg-amber-gold', accent: 'border-amber-gold/25 bg-amber-gold-dim' },
    { ...t.compliance.nist, icon: BarChart3, color: 'bg-cyan-400', accent: 'border-cyan-400/25 bg-cyan-400/[0.06]' },
    { ...t.compliance.gdpr, icon: Lock, color: 'bg-success', accent: 'border-success/25 bg-success/[0.06]' },
  ];

  return (
    <div className="mt-4">
      <h3 className="text-[10px] font-mono text-text-muted uppercase tracking-[0.2em] mb-3 px-1">{t.compliance.title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {frameworks.map((fw, i) => (
          <div key={i} className={`glass-panel p-4 border ${fw.accent} hover:border-opacity-50 transition-all duration-300`}>
            <div className="flex items-center gap-2 mb-2.5">
              <div className={`w-2 h-2 rounded-full ${fw.color}`} />
              <fw.icon className="w-3.5 h-3.5 text-text-secondary" />
              <span className="text-[10px] font-mono font-bold text-amber-gold tracking-[0.15em]">{fw.label}</span>
            </div>
            <p className="text-[10px] font-mono text-text-secondary leading-relaxed">{fw.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────
//  AUDIT LOG PANEL (Sidebar)
// ──────────────────────────────────────────────────────────────────
const AuditLogPanel = ({ t, entries, onClear }) => {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [entries.length]);

  const sevColor = {
    info: 'text-text-secondary',
    warning: 'text-warning',
    critical: 'text-danger',
    success: 'text-success',
  };

  const typeColor = {
    SYSTEM: 'text-text-muted',
    INTEGRITY: 'text-cyber-purple',
    PRIVACY: 'text-cyan-400',
    SENSOR: 'text-amber-gold',
    BACKBONE: 'text-success',
    ATTACK: 'text-danger',
    FAILSAFE: 'text-danger',
    RECOVERY: 'text-success',
  };

  return (
    <div className="glass-panel-elevated flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-obsidian-border">
        <div>
          <h3 className="text-[10px] font-mono font-bold text-text-primary tracking-[0.15em]">{t.auditLog.title}</h3>
          <p className="text-[8px] font-mono text-text-muted tracking-wider">Synchronous Evidence Locker (P-256)</p>
        </div>
        <button onClick={onClear}
          className="text-[8px] font-mono text-text-muted hover:text-text-secondary px-2 py-1 rounded border border-obsidian-border hover:border-obsidian-border-light cursor-pointer transition-colors">
          {t.auditLog.clear}
        </button>
      </div>

      {/* Live indicator */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-obsidian-border bg-obsidian-light/30">
        <div className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse-status" />
        <span className="text-[8px] font-mono text-danger/80 tracking-[0.15em] font-semibold">LIVE</span>
        <span className="text-[8px] font-mono text-text-muted ml-auto">{entries.length} entries</span>
      </div>

      {/* Log entries */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-1">
        {entries.map(e => (
          <div key={e.id} className={`p-2 rounded-md animate-slide-in transition-colors ${
            e.sev === 'critical' ? 'bg-danger/[0.04] border border-danger/10' : 'bg-obsidian-light/30'
          }`}>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[8px] font-mono text-text-muted">{e.ts}</span>
              <span className={`text-[8px] font-mono font-bold tracking-wider ${typeColor[e.type] || 'text-text-muted'}`}>
                {e.type}
              </span>
            </div>
            <p className={`text-[9px] font-mono leading-snug ${sevColor[e.sev] || 'text-text-secondary'}`}>
              {e.msg}
            </p>
            {e.verified && (
              <div className="mt-1.5 flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-success/[0.08] border border-success/20 w-fit">
                <ShieldCheck className="w-2.5 h-2.5 text-success" />
                <span className="text-[7px] font-mono font-bold text-success tracking-wider uppercase">P-256 Verified</span>
                <span className="text-[7px] font-mono text-text-muted ml-2 opacity-60">ID: {e.lockerId}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────
//  QUERY TERMINAL — Live LLM Interface + Voice I/O
// ──────────────────────────────────────────────────────────────────
const QueryTerminal = ({ t, attackActive }) => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const clientRef = useRef(null);

  // Initialize SentinelClient
  useEffect(() => {
    const endpoint = import.meta.env.VITE_SENTINEL_ENDPOINT;
    if (endpoint) {
      clientRef.current = new SentinelClient(endpoint);
    }
  }, []);

  // Boot message
  useEffect(() => {
    setMessages([{ id: uid(), role: 'system', content: t.terminal.welcome, ts: ts() }]);
  }, [t]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) inputRef.current.focus();
  }, [isOpen]);

  // ── VOICE OUTPUT: Browser TTS (with Cloud TTS upgrade path) ──
  const speakResponse = useCallback((text, audioBase64 = null) => {
    if (!voiceEnabled) return;

    // Layer 1: Cloud TTS (if backend returns base64 audio)
    if (audioBase64) {
      try {
        window.speechSynthesis?.cancel();
        const audio = new Audio(`data:audio/mp3;base64,${audioBase64}`);
        audio.onplay = () => setIsSpeaking(true);
        audio.onended = () => setIsSpeaking(false);
        audio.onerror = () => { setIsSpeaking(false); speakWithBrowser(text); };
        audio.play();
        return;
      } catch { /* fall through */ }
    }

    // Layer 2: Browser Web Speech API
    speakWithBrowser(text);
  }, [voiceEnabled]);

  const speakWithBrowser = (text) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    const clean = text.replace(/[*#_`~]/g, '');
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const best = voices.find(v => v.name.includes('Google US English'))
              || voices.find(v => v.lang === 'en-US' && v.name.includes('Samantha'))
              || voices.find(v => v.lang.startsWith('en'));
    if (best) utterance.voice = best;

    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);

    window.speechSynthesis.speak(utterance);
  };

  // ── VOICE INPUT: Microphone via Web Speech API ──
  const startListening = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Voice input requires Chrome or Edge browser.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setInput(transcript);
    };
    recognition.onerror = (event) => {
      console.error('Microphone error:', event.error);
      setIsListening(false);
    };

    recognition.start();
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const query = input.trim();
    if (!query || isTyping) return;

    setMessages(prev => [...prev, { id: uid(), role: 'user', content: query, ts: ts() }]);
    setInput('');
    setIsTyping(true);

    try {
      if (!clientRef.current) throw new Error('Sentinel endpoint not configured');
      const result = await clientRef.current.query(query);

      setMessages(prev => [...prev, {
        id: uid(),
        role: 'sentinel',
        content: result.narrative,
        confidence: result.confidence,
        sources: result.sources,
        dataAuthority: result.dataAuthority,
        verificationStatus: result.verificationStatus,
        metrics: result.metrics,
        ts: ts(),
      }]);

      // Speak the response
      speakResponse(result.narrative, result.audioBase64);
    } catch (err) {
      const isIntegrityRejection = err.code === 'INTEGRITY_GATE_REJECTION';
      
      setMessages(prev => [...prev, {
        id: uid(),
        role: 'error',
        content: isIntegrityRejection 
          ? `[${t.terminal.rejected}] ${err.message}` 
          : `${t.terminal.error} ${err.message}`,
        ts: ts(),
      }]);
    }
    setIsTyping(false);
  };

  const handleSuggestion = (text) => {
    setInput(text);
    setTimeout(() => {
      const form = document.getElementById('sentinel-query-form');
      if (form) form.requestSubmit();
    }, 50);
  };

  return (
    <div className="mt-4">
      {/* Toggle Button */}
      {!isOpen && (
        <button
          id="open-query-terminal"
          onClick={() => setIsOpen(true)}
          className="w-full flex items-center justify-center gap-3 py-4 rounded-xl border border-cyber-purple/25 bg-cyber-purple-dim hover:border-cyber-purple/50 hover:bg-cyber-purple/10 transition-all duration-300 cursor-pointer group"
        >
          <MessageSquare className="w-5 h-5 text-cyber-purple group-hover:scale-110 transition-transform" />
          <span className="text-sm font-mono font-bold text-cyber-purple tracking-wider">{t.terminal.title}</span>
          <span className="text-[10px] font-mono text-text-muted">— {t.terminal.subtitle}</span>
        </button>
      )}

      {/* Terminal Panel */}
      {isOpen && (
        <div className={`glass-panel-elevated overflow-hidden animate-fade-in transition-all duration-500 ${
          attackActive ? 'border-danger/25' : 'border-cyber-purple/20'
        }`}>
          {/* Terminal Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-obsidian-border bg-obsidian/80">
            <div className="flex items-center gap-3">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-danger/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-warning/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-success/60" />
              </div>
              <span className="text-[10px] font-mono text-text-muted tracking-wider">SENTINEL://governance/v5.5-sovereign</span>

              {/* Soundwave Visualizer (active when speaking) */}
              {isSpeaking && (
                <div className="flex items-end gap-[3px] h-4 ml-1" aria-label="Voice active">
                  {[1, 2, 3, 4, 5].map((bar) => (
                    <div
                      key={bar}
                      className="w-[3px] rounded-full bg-cyber-purple"
                      style={{
                        animation: `sentinel-soundwave 0.8s ease-in-out infinite alternate`,
                        animationDelay: `${bar * 0.1}s`,
                        height: '4px',
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Voice Toggle */}
              <button
                id="voice-toggle"
                onClick={() => {
                  if (isSpeaking) { window.speechSynthesis?.cancel(); setIsSpeaking(false); }
                  setVoiceEnabled(prev => !prev);
                }}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-full border transition-all cursor-pointer ${
                  voiceEnabled
                    ? 'border-cyber-purple/30 bg-cyber-purple-dim hover:border-cyber-purple/50'
                    : 'border-obsidian-border bg-obsidian-mid/50 hover:border-text-muted'
                }`}
                title={voiceEnabled ? t.terminal.voiceOn : t.terminal.voiceOff}
              >
                {voiceEnabled
                  ? <Volume2 className="w-3 h-3 text-cyber-purple" />
                  : <VolumeX className="w-3 h-3 text-text-muted" />
                }
              </button>

              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full border border-success/20 bg-success/[0.05]">
                <div className="w-1.5 h-1.5 rounded-full bg-success animate-pulse-status" />
                <span className="text-[8px] font-mono text-success tracking-wider">LIVE</span>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="text-text-muted hover:text-text-primary text-xs font-mono px-2 py-1 rounded border border-obsidian-border hover:border-text-muted cursor-pointer transition-colors"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Messages Area */}
          <div ref={scrollRef} className="h-[340px] overflow-y-auto p-4 space-y-3">
            {messages.map(msg => (
              <div key={msg.id} className={`animate-fade-in ${
                msg.role === 'user' ? 'flex justify-end' : ''
              }`}>
                {msg.role === 'user' ? (
                  <div className="max-w-[80%] px-4 py-2.5 rounded-xl bg-cyber-purple/15 border border-cyber-purple/20">
                    <p className="text-xs font-mono text-text-primary">{msg.content}</p>
                    <span className="text-[8px] font-mono text-text-muted mt-1 block">{msg.ts}</span>
                  </div>
                ) : msg.role === 'error' ? (
                  <div className="max-w-[90%] px-4 py-2.5 rounded-xl bg-danger/[0.06] border border-danger/15">
                    <p className="text-xs font-mono text-danger">{msg.content}</p>
                    <span className="text-[8px] font-mono text-text-muted mt-1 block">{msg.ts}</span>
                  </div>
                ) : msg.role === 'system' ? (
                  <div className="px-4 py-2.5 rounded-xl bg-obsidian-light/40 border border-obsidian-border">
                    <div className="flex items-center gap-2 mb-1">
                      <Shield className="w-3 h-3 text-cyber-purple" />
                      <span className="text-[9px] font-mono font-bold text-cyber-purple tracking-wider">SENTINEL</span>
                    </div>
                    <p className="text-xs font-mono text-text-secondary">{msg.content}</p>
                  </div>
                ) : (
                  <div className="max-w-[90%]">
                    <div className="px-4 py-3 rounded-xl bg-obsidian-light/60 border border-obsidian-border">
                      <div className="flex items-center gap-2 mb-2">
                        <Shield className="w-3 h-3 text-cyber-purple" />
                        <span className="text-[9px] font-mono font-bold text-cyber-purple tracking-wider">SENTINEL</span>
                        {msg.confidence && (
                          <span className="text-[8px] font-mono text-amber-gold ml-auto">confidence: {msg.confidence}</span>
                        )}
                      </div>
                      <div className="text-xs font-mono text-text-primary leading-relaxed whitespace-pre-wrap">{msg.content}</div>
                      {msg.sources && msg.sources.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-obsidian-border flex flex-wrap gap-1.5">
                          {msg.sources.map((src, i) => (
                            <span key={i} className="text-[8px] font-mono text-text-muted px-1.5 py-0.5 rounded bg-obsidian-mid border border-obsidian-border">
                              {src}
                            </span>
                          ))}
                        </div>
                      )}
                      {msg.verificationStatus === 'PARTIAL' ? (
                        <div className="mt-2 flex items-center gap-1.5 px-2 py-1 rounded bg-warning/10 border border-warning/20">
                          <ShieldAlert className="w-3 h-3 text-warning" />
                          <span className="text-[8px] font-mono text-warning tracking-wider uppercase font-bold">
                            {t.terminal.partial} — C_{msg.confidence?.toFixed(2) || '0.50'}
                          </span>
                        </div>
                      ) : msg.verificationStatus === 'verified' || msg.verificationStatus === 'VERIFIED' ? (
                        <div className="mt-2 flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-success/10 border border-success/20">
                          <ShieldCheck className="w-3 h-3 text-success" />
                          <span className="text-[8px] font-mono text-success tracking-wider font-bold">
                            {t.terminal.verified} — {msg.dataAuthority || 'GCP_BIGQUERY'}
                          </span>
                        </div>
                      ) : msg.verificationStatus === 'HALLUCINATION_FLAGGED' && (
                        <div className="mt-2 flex items-center gap-1.5 px-2 py-1 rounded bg-danger/10 border border-danger/20">
                          <XCircle className="w-3 h-3 text-danger" />
                          <span className="text-[8px] font-mono text-danger tracking-wider uppercase font-bold">
                            {t.terminal.hallucination}
                          </span>
                        </div>
                      )}
                    </div>
                    <span className="text-[8px] font-mono text-text-muted mt-1 block pl-1">{msg.ts}</span>
                  </div>
                )}
              </div>
            ))}

            {/* Typing Indicator */}
            {isTyping && (
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-obsidian-light/40 border border-obsidian-border animate-fade-in max-w-[60%]">
                <div className="flex gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-cyber-purple animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-cyber-purple animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-cyber-purple animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-[10px] font-mono text-text-muted">{t.terminal.thinking}</span>
              </div>
            )}
          </div>

          {/* Suggestion Chips */}
          {messages.length <= 1 && (
            <div className="px-4 pb-2 flex flex-wrap gap-2">
              {t.terminal.suggestions.map((s, i) => (
                <button
                  key={i}
                  onClick={() => handleSuggestion(s)}
                  className="text-[10px] font-mono text-text-secondary px-3 py-1.5 rounded-full border border-obsidian-border hover:border-cyber-purple/40 hover:text-cyber-purple hover:bg-cyber-purple-dim transition-all cursor-pointer"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Input + Voice Controls */}
          <form id="sentinel-query-form" onSubmit={handleSubmit} className="flex items-center gap-2 px-4 py-3 border-t border-obsidian-border bg-obsidian/60">
            <input
              ref={inputRef}
              id="sentinel-query-input"
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={isListening ? t.terminal.listening : t.terminal.placeholder}
              disabled={isTyping}
              className="flex-1 bg-transparent text-xs font-mono text-text-primary placeholder:text-text-muted outline-none disabled:opacity-50"
            />

            {/* Microphone Button */}
            <button
              id="sentinel-mic-btn"
              type="button"
              onClick={startListening}
              disabled={isTyping || isListening}
              className={`p-2 rounded-lg border transition-all cursor-pointer ${
                isListening
                  ? 'bg-danger/15 border-danger/40 text-danger animate-pulse'
                  : 'bg-obsidian-mid border-obsidian-border text-text-muted hover:text-cyber-purple hover:border-cyber-purple/40'
              } disabled:opacity-30 disabled:cursor-not-allowed`}
              title="Voice input"
            >
              <Mic className="w-4 h-4" />
            </button>

            {/* Send Button */}
            <button
              id="sentinel-query-send"
              type="submit"
              disabled={!input.trim() || isTyping}
              className="p-2 rounded-lg bg-cyber-purple-dim border border-cyber-purple/25 text-cyber-purple hover:bg-cyber-purple/15 hover:border-cyber-purple/50 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-all"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────
//  FOOTER
// ──────────────────────────────────────────────────────────────────
const Footer = () => (
  <footer className="border-t border-obsidian-border bg-obsidian-light/20 mt-6">
    <div className="max-w-[1600px] mx-auto px-4 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <HighArchyLogo className="w-32 h-5 opacity-60" />
        <span className="text-[9px] font-mono text-text-muted">Sovereign Integrity Layer</span>
      </div>
      <span className="text-[8px] font-mono text-text-muted tracking-wider">
        high-archy.tech
      </span>
    </div>
  </footer>
);

// ══════════════════════════════════════════════════════════════════
//  MAIN APPLICATION
// ══════════════════════════════════════════════════════════════════
export default function App() {
  // ─── Language ───
  const [lang, setLang] = useState('en');
  const t = translations[lang];

  // ─── Layout ───
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // ─── Attack Simulation ───
  const [attackActive, setAttackActive] = useState(false);
  const attackTimerRef = useRef(null);

  // ─── Prosecutor's Gauge State ───
  const [bhr, setBhr] = useState(97.3);
  const [verified, setVerified] = useState(14287);
  const [blocked, setBlocked] = useState(412);
  const [contradictions, setContradictions] = useState([]);

  // ─── Privacy Heatmap State ───
  const [piiCounters, setPiiCounters] = useState({ ssn: 2847, cc: 1234, subjectId: 456 });

  // ─── Fail-Closed State ───
  const [shadowActive, setShadowActive] = useState(false);
  const [sensorBlackout, setSensorBlackout] = useState(false);
  const [failClosedEvents, setFailClosedEvents] = useState([]);
  const [ictStress, setIctStress] = useState(12);

  // ─── Sub-Zero Window State ───
  const [latencyBuckets, setLatencyBuckets] = useState(() => makeLatencyBuckets());
  const [subZeroPercent, setSubZeroPercent] = useState(98.7);
  const [p50, setP50] = useState(8);
  const [p99, setP99] = useState(34);
  const [totalRetrievals, setTotalRetrievals] = useState(847293);

  // ─── Sensor Trips ───
  const [sensorTrips, setSensorTrips] = useState(3);

  // ─── Audit Log ───
  const [auditLog, setAuditLog] = useState(() => [
    makeLogEntry('SYSTEM', 'Governance Dashboard V5.5 Sovereign initialized', 'info'),
    makeLogEntry('INTEGRITY', 'BHR baseline established — 97.3%', 'info'),
    makeLogEntry('PRIVACY', 'HKDF-SHA256 pepper loaded from Secret Manager', 'info'),
    makeLogEntry('BACKBONE', 'GCP us-west1 Private Backbone — STABLE', 'success'),
    makeLogEntry('SENSOR', 'All 12 sensors reporting NOMINAL', 'info'),
    { ...makeLogEntry('INTEGRITY', 'Evidence Locker P-256 handshake complete', 'success'), verified: true, lockerId: 'EL-0041-A' },
  ]);

  // ─── Derived ───
  const piiTotal = piiCounters.ssn + piiCounters.cc + piiCounters.subjectId;

  // ──────────────────────────────────────────
  //  SIMULATION LOOP
  // ──────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      // BHR fluctuation
      setBhr(prev => {
        if (attackActive) return prev; // Don't fluctuate during attack
        const delta = (Math.random() - 0.5) * 0.4;
        return Math.max(95.0, Math.min(99.5, prev + delta));
      });

      // Inference counts
      setVerified(prev => prev + Math.floor(Math.random() * 6) + 1);
      if (Math.random() > 0.6) {
        setBlocked(prev => prev + 1);
      }

      // PII tokenization
      setPiiCounters(prev => {
        const r = Math.random();
        if (r < 0.35) return { ...prev, ssn: prev.ssn + 1 };
        if (r < 0.6) return { ...prev, cc: prev.cc + 1 };
        if (r < 0.78) return { ...prev, subjectId: prev.subjectId + 1 };
        return prev;
      });

      // Retrieval stats
      setTotalRetrievals(prev => prev + Math.floor(Math.random() * 30) + 5);
      if (Math.random() > 0.85) {
        setLatencyBuckets(makeLatencyBuckets());
        setSubZeroPercent(prev => {
          const delta = (Math.random() - 0.5) * 0.5;
          return Math.max(96, Math.min(99.9, prev + delta));
        });
      }

      // ICT Stress
      setIctStress(prev => {
        if (attackActive) return prev;
        const delta = (Math.random() - 0.5) * 3;
        return Math.max(5, Math.min(30, prev + delta));
      });

      // Add contradiction (sometimes)
      if (Math.random() > 0.65) {
        const types = lang === 'en' ? CONTRADICTION_TYPES_EN : CONTRADICTION_TYPES_ES;
        setContradictions(prev => [{
          id: uid(),
          ts: ts(),
          type: types[Math.floor(Math.random() * types.length)],
          conf: (Math.random() * 0.3 + 0.7).toFixed(2),
        }, ...prev].slice(0, 20));
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [attackActive, lang]);

  // ─── AUDIT LOG FEED ───
  useEffect(() => {
    const interval = setInterval(() => {
      const entries = [
        makeLogEntry('INTEGRITY', `BHR check passed — ${bhr.toFixed(1)}% confidence`, 'info'),
        makeLogEntry('PRIVACY', `PII token generated — HKDF-SHA256 [${['SSN', 'CC', 'SubjectID'][Math.floor(Math.random() * 3)]}]`, 'info'),
        makeLogEntry('SENSOR', `${12 - (sensorBlackout ? 3 : 0)} of 12 sensors NOMINAL`, sensorBlackout ? 'warning' : 'info'),
        makeLogEntry('BACKBONE', `us-west1 latency: ${Math.floor(Math.random() * 15 + 5)}ms (PASS)`, 'success'),
        { ...makeLogEntry('INTEGRITY', `Factual proof signed: ${uid().slice(0, 8)}`, 'success'), verified: true, lockerId: `EL-${Math.floor(Math.random() * 9000 + 1000)}` },
        makeLogEntry('ARBITRATION', `Request ${uid().slice(0, 4).toUpperCase()}: ESCALATED to Governance Board`, 'warning'),
        makeLogEntry('ARBITRATION', `Request ${uid().slice(0, 4).toUpperCase()}: PERMIT ISSUED via Gavel Logic`, 'success'),
      ];
      const entry = entries[Math.floor(Math.random() * entries.length)];
      setAuditLog(prev => [entry, ...prev].slice(0, 80));
    }, 4000);

    return () => clearInterval(interval);
  }, [bhr, sensorBlackout]);

  // ──────────────────────────────────────────
  //  ATTACK SIMULATION
  // ──────────────────────────────────────────
  const triggerAttack = useCallback(() => {
    setAttackActive(true);
    setShadowActive(true);
    setSensorBlackout(true);
    setIctStress(87);
    setBhr(99.8);
    setSensorTrips(prev => prev + 4);

    // Flood audit log
    const attackEntries = [
      makeLogEntry('ATTACK', 'Adversarial input detected — NLI score 0.23', 'critical'),
      makeLogEntry('SENSOR', 'Sensor #7 BLACKOUT — defaulting SENSITIVE', 'critical'),
      makeLogEntry('FAILSAFE', 'Shadow Classifier ACTIVATED — all inferences SENSITIVE', 'critical'),
      makeLogEntry('INTEGRITY', 'BHR spiked to 99.8% — maximum blocking engaged', 'warning'),
      makeLogEntry('ATTACK', 'Circuit breaker OPEN — resilience mode engaged', 'critical'),
    ];
    setAuditLog(prev => [...attackEntries, ...prev].slice(0, 80));

    // Add fail-closed events
    setFailClosedEvents(prev => [
      { id: uid(), ts: ts(), msg: 'Defaulted → SENSITIVE — Sensor blackout detected' },
      { id: uid(), ts: ts(), msg: 'Shadow Classifier intercepted adversarial probe' },
      { id: uid(), ts: ts(), msg: 'Circuit breaker OPEN — stale cache served' },
      ...prev,
    ].slice(0, 15));

    // Auto-recovery after 12 seconds
    attackTimerRef.current = setTimeout(() => {
      resetSystem();
    }, 12000);
  }, []);

  const resetSystem = useCallback(() => {
    if (attackTimerRef.current) {
      clearTimeout(attackTimerRef.current);
      attackTimerRef.current = null;
    }
    setAttackActive(false);
    setShadowActive(false);
    setSensorBlackout(false);
    setIctStress(14);
    setBhr(97.5);

    const recoveryEntries = [
      makeLogEntry('RECOVERY', 'Attack simulation concluded — system recovered', 'success'),
      makeLogEntry('SENSOR', 'All 12 sensors back ONLINE', 'success'),
      makeLogEntry('FAILSAFE', 'Shadow Classifier returned to STANDBY', 'info'),
      makeLogEntry('BACKBONE', 'GCP backbone integrity verified — PRISTINE', 'success'),
    ];
    setAuditLog(prev => [...recoveryEntries, ...prev].slice(0, 80));
    setFailClosedEvents([]);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (attackTimerRef.current) clearTimeout(attackTimerRef.current);
    };
  }, []);

  // ──────────────────────────────────────────
  //  RENDER
  // ──────────────────────────────────────────
  return (
    <div className={`min-h-screen bg-obsidian ${attackActive ? 'attack-active' : ''}`}>
      {/* Status Ribbon */}
      <StatusRibbon t={t} attackActive={attackActive} />

      {/* Navigation */}
      <GovernanceNav
        t={t}
        lang={lang}
        setLang={setLang}
        onAttack={triggerAttack}
        onReset={resetSystem}
        attackActive={attackActive}
        toggleSidebar={() => setSidebarOpen(p => !p)}
        sidebarOpen={sidebarOpen}
      />

      {/* Metric Strip */}
      <MetricStrip
        t={t}
        bhr={bhr}
        piiTotal={piiTotal}
        sensorTrips={sensorTrips}
        subZeroPercent={subZeroPercent}
        attackActive={attackActive}
      />

      {/* Main Content */}
      <div className="max-w-[1600px] mx-auto px-4 py-5">
        <div className="flex gap-4">
          {/* Pillars Grid */}
          <div className="flex-1 min-w-0">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Pillar 1: Prosecutor's Gauge */}
              <ProsecutorGauge
                t={t}
                bhr={bhr}
                verified={verified}
                blocked={blocked}
                contradictions={contradictions}
                attackActive={attackActive}
              />

              {/* Pillar 2: Privacy Heatmap */}
              <PrivacyHeatmap
                t={t}
                counters={piiCounters}
                attackActive={attackActive}
              />

              {/* Pillar 3: Fail-Closed Monitor */}
              <FailClosedMonitor
                t={t}
                shadowActive={shadowActive}
                sensorBlackout={sensorBlackout}
                events={failClosedEvents}
                attackActive={attackActive}
                ictStress={ictStress}
              />

              {/* Pillar 4: Sub-Zero Window */}
              <SubZeroWindow
                t={t}
                buckets={latencyBuckets}
                percent={subZeroPercent}
                p50={p50}
                p99={p99}
                totalRetrievals={totalRetrievals}
                attackActive={attackActive}
              />
            </div>

            {/* Compliance Cards */}
            <ComplianceMapping t={t} />

            {/* Query Terminal */}
            <QueryTerminal t={t} attackActive={attackActive} />
          </div>

          {/* Audit Log Sidebar (Desktop) */}
          {sidebarOpen && (
            <div className="hidden xl:flex w-[280px] flex-shrink-0">
              <div className="w-full sticky top-[calc(3.5rem+2rem+3.5rem)] h-[calc(100vh-12rem)]">
                <AuditLogPanel
                  t={t}
                  entries={auditLog}
                  onClear={() => setAuditLog([])}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <Footer />
    </div>
  );
}
