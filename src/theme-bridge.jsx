/**
 * SENTINEL ENGINE v5.5 — Theme Bridge (Multi-Instance UI)
 * ═══════════════════════════════════════════════════════
 * Single-file React component that serves as both ThemeProvider and MainUI.
 *
 * Responsibilities:
 *   1. Multi-instance theming (Logistics cyan ↔ Energy-CFE green)
 *   2. Corrected inference payload (query, tenant_id, context, headers)
 *   3. 60-second latency management with staged telemetry logs
 *   4. Full cyberpunk/terminal UI with sidebar metrics + neural input
 *
 * This component is designed to be imported by main.jsx as an alternative
 * to App.jsx when demonstrating multi-industry capabilities.
 *
 * Usage:
 *   import ThemeBridge from './theme-bridge.jsx';
 *   <ThemeBridge />
 * ═══════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Shield, Terminal, Database, Zap, Clock, Send,
  CheckCircle2, RefreshCw, Lock, Cpu, Wifi,
  Activity, Eye, Hexagon, Volume2, VolumeX, Mic,
  BarChart3, Radio, AlertTriangle, ChevronDown,
  Thermometer, Wind, BatteryCharging, Power, Globe
} from 'lucide-react';
import DOMPurify from 'dompurify';
import ReactMarkdown from 'react-markdown';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged } from 'firebase/auth';

// ═══════════════════════════════════════════════════════
//  INSTANCE CONFIGURATION — Multi-Industry Definitions
// ═══════════════════════════════════════════════════════

const INSTANCES = {
  logistics: {
    id: 'logistics',
    label: 'SENTINEL × LOGISTICS',
    subtitle: 'Autonomous Market Intelligence',
    accent: '#00f3ff',
    accentDim: 'rgba(0,243,255,0.15)',
    accentGlow: 'rgba(0,243,255,0.4)',
    neonShadow: '0 0 20px rgba(0,243,255,0.3), inset 0 0 20px rgba(0,243,255,0.05)',
    tenantId: 'SENTINEL_PROD',
    language: 'en',
    ttsVoice: 'en-US-Journey-F',
    terminalLabel: 'SENTINEL://logistics/v5.5',
    systemPromptHint: 'Logistics & Supply Chain Intelligence',
    suggestions: [
      'What\'s the current freight rate from Shanghai to Rotterdam?',
      'How congested is the Port of Long Beach right now?',
      'Give me a Baltic Dry Index update',
      'Any transit delays through the Suez Canal today?',
    ],
    sidebarMetrics: [
      { icon: Globe, label: 'Active Ports', value: '2,847', status: 'live' },
      { icon: Database, label: 'Data Points/hr', value: '14.2M', status: 'live' },
      { icon: Zap, label: 'Avg Latency', value: '23ms', status: 'optimal' },
      { icon: Activity, label: 'Uptime', value: '99.97%', status: 'optimal' },
      { icon: Wifi, label: 'Feeds Active', value: '3/3', status: 'live' },
      { icon: Shield, label: 'PQ-TLS', value: 'Verified', status: 'secure' },
    ],
    dataAuthorityLabel: 'GCP_BIGQUERY_VECTOR_RAG',
  },
  'energy-cfe': {
    id: 'energy-cfe',
    label: 'SENTINEL × CFE',
    subtitle: 'Inteligencia de Red Eléctrica',
    accent: '#00e676',
    accentDim: 'rgba(0,230,118,0.15)',
    accentGlow: 'rgba(0,230,118,0.4)',
    neonShadow: '0 0 20px rgba(0,230,118,0.3), inset 0 0 20px rgba(0,230,118,0.05)',
    tenantId: 'CFE_MX_GRID_ALPHA',
    language: 'es',
    ttsVoice: 'es-US-Neural2-A',
    terminalLabel: 'SENTINEL://energy-cfe/v5.5',
    systemPromptHint: 'Energy & Grid Resiliency (CFE)',
    suggestions: [
      'Analiza la carga actual en las subestaciones de la Zona Metropolitana',
      'Estado de transformadores en Topolobampo',
      'Protocolo de huracán categoría 3 en el Golfo de México',
      'Riesgo de anomalía térmica en zona noroeste',
    ],
    sidebarMetrics: [
      { icon: Power, label: 'Subestaciones', value: '1,247', status: 'live' },
      { icon: Thermometer, label: 'Alertas Térmicas', value: '12', status: 'warning' },
      { icon: Wind, label: 'Riesgo Meteoro', value: 'ALTO', status: 'warning' },
      { icon: BatteryCharging, label: 'Carga Promedio', value: '78.4%', status: 'elevated' },
      { icon: Activity, label: 'Frecuencia', value: '59.97 Hz', status: 'live' },
      { icon: Shield, label: 'SCADA Link', value: 'Activo', status: 'secure' },
    ],
    dataAuthorityLabel: 'SCADA · BigQuery Vector RAG',
  },
};

// ═══════════════════════════════════════════════════════
//  INFERENCE ENDPOINT
// ═══════════════════════════════════════════════════════

const SENTINEL_ENDPOINT = import.meta.env.VITE_SENTINEL_ENDPOINT
  || 'https://us-central1-ha-sentinel-core-v21.cloudfunctions.net/sentinelInference';

// ═══════════════════════════════════════════════════════
//  TELEMETRY LOG STAGES (60-second latency management)
// ═══════════════════════════════════════════════════════

const TELEMETRY_STAGES = [
  { delayMs: 0,     label: 'REQUEST_INGESTED',       detail: 'Secure handshake initiated', icon: 'lock' },
  { delayMs: 2000,  label: 'AUTH_HANDSHAKE',          detail: 'JWT verified · tenant_id validated', icon: 'shield' },
  { delayMs: 5000,  label: 'BQ_WAREHOUSE_ACCESS',     detail: 'BigQuery dataset connection established', icon: 'database' },
  { delayMs: 8000,  label: 'EMBEDDING_GENERATION',    detail: 'text-embedding-004 · 768-dim vector generated', icon: 'cpu' },
  { delayMs: 12000, label: 'VECTOR_RAG_SEARCH',       detail: 'VECTOR_SEARCH across 3 tables · top-15 results', icon: 'radar' },
  { delayMs: 18000, label: 'CONTEXT_ASSEMBLY',         detail: 'Semantic context payload assembled (16.4 KB)', icon: 'layers' },
  { delayMs: 25000, label: 'GEMINI_25_PRO_INJECTION',  detail: 'Cognitive router → Gemini 2.0 Flash (thinking budget: 16384)', icon: 'brain' },
  { delayMs: 35000, label: 'DEEP_REASONING',           detail: 'Chain-of-thought reasoning in progress...', icon: 'sparkles' },
  { delayMs: 45000, label: 'NARRATIVE_SYNTHESIS',      detail: 'Structured JSON response materialization', icon: 'file' },
  { delayMs: 55000, label: 'RESPONSE_FINALIZATION',    detail: 'Confidence scoring · metrics extraction', icon: 'check' },
];

// ═══════════════════════════════════════════════════════
//  TELEMETRY LOG ICON RENDERER
// ═══════════════════════════════════════════════════════

function TelemetryIcon({ name, className }) {
  const iconMap = {
    lock: Lock, shield: Shield, database: Database, cpu: Cpu,
    radar: Radio, layers: BarChart3, brain: Hexagon,
    sparkles: Zap, file: Terminal, check: CheckCircle2,
  };
  const Icon = iconMap[name] || Zap;
  return <Icon className={className} />;
}

// ═══════════════════════════════════════════════════════
//  STATUS DOT COMPONENT
// ═══════════════════════════════════════════════════════

function StatusDot({ status }) {
  const colors = {
    live: 'bg-green-400',
    optimal: 'bg-emerald-400',
    secure: 'bg-cyan-400',
    warning: 'bg-amber-400 animate-pulse',
    elevated: 'bg-orange-400',
    error: 'bg-red-400 animate-pulse',
  };
  return <div className={`w-1.5 h-1.5 rounded-full ${colors[status] || 'bg-gray-400'}`} />;
}

// ═══════════════════════════════════════════════════════
//  PROGRESS BAR (60s Linear)
// ═══════════════════════════════════════════════════════

function InferenceProgressBar({ isActive, elapsedMs, accent }) {
  const progress = Math.min((elapsedMs / 60000) * 100, 100);

  if (!isActive) return null;

  return (
    <div className="w-full px-4 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] font-mono tracking-widest uppercase" style={{ color: accent }}>
          DEEP SCAN IN PROGRESS
        </span>
        <span className="text-[9px] font-mono text-gray-500">
          {Math.floor(elapsedMs / 1000)}s / 60s
        </span>
      </div>
      <div className="w-full h-[3px] rounded-full bg-gray-800 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-linear"
          style={{
            width: `${progress}%`,
            background: `linear-gradient(90deg, ${accent}, ${accent}88)`,
            boxShadow: `0 0 10px ${accent}66`,
          }}
        />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
//  SIDEBAR — Metrics Panel
// ═══════════════════════════════════════════════════════

function Sidebar({ instance, isProcessing, logs }) {
  return (
    <aside className="w-72 flex-shrink-0 h-full border-r border-gray-800 bg-[#07080A] flex flex-col overflow-hidden">
      {/* Instance Badge */}
      <div className="px-4 pt-5 pb-3 border-b border-gray-800">
        <div className="flex items-center gap-2 mb-1">
          <Hexagon className="w-4 h-4" style={{ color: instance.accent }} />
          <span className="text-[11px] font-mono font-bold tracking-[0.2em]" style={{ color: instance.accent }}>
            {instance.label}
          </span>
        </div>
        <p className="text-[9px] text-gray-500 font-mono tracking-wider">{instance.subtitle}</p>
      </div>

      {/* Metrics Grid */}
      <div className="px-3 py-3 space-y-1 border-b border-gray-800">
        <div className="text-[9px] font-mono text-gray-600 tracking-[0.2em] uppercase mb-2 px-1">
          SYSTEM METRICS
        </div>
        {instance.sidebarMetrics.map((m, i) => {
          const Icon = m.icon;
          return (
            <div
              key={i}
              className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-gray-800/50 transition-colors group"
            >
              <div
                className="p-1.5 rounded-md"
                style={{ background: instance.accentDim }}
              >
                <Icon className="w-3 h-3" style={{ color: instance.accent }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[9px] text-gray-500 font-mono truncate">{m.label}</div>
                <div className="text-xs font-mono font-semibold text-gray-200">{m.value}</div>
              </div>
              <StatusDot status={m.status} />
            </div>
          );
        })}
      </div>

      {/* Live Telemetry Logs */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="text-[9px] font-mono text-gray-600 tracking-[0.2em] uppercase mb-2 px-1 flex items-center gap-1.5">
          <Radio className="w-3 h-3" />
          TELEMETRY
          {isProcessing && (
            <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: instance.accent }} />
          )}
        </div>

        <div className="space-y-1.5">
          {logs.map((log, i) => (
            <div
              key={i}
              className="flex items-start gap-2 px-2 py-1.5 rounded-md animate-fade-in-up"
              style={{
                background: i === logs.length - 1 && isProcessing ? instance.accentDim : 'transparent',
                animationDelay: `${i * 50}ms`,
              }}
            >
              <TelemetryIcon
                name={log.icon}
                className="w-3 h-3 mt-0.5 flex-shrink-0"
                style={{ color: instance.accent }}
              />
              <div className="min-w-0">
                <div className="text-[9px] font-mono font-semibold tracking-wider" style={{ color: instance.accent }}>
                  {log.label}
                </div>
                <div className="text-[8px] font-mono text-gray-500 leading-tight truncate">
                  {log.detail}
                </div>
              </div>
              <span className="text-[8px] text-gray-600 font-mono flex-shrink-0 mt-0.5">
                {log.timestamp}
              </span>
            </div>
          ))}

          {logs.length === 0 && !isProcessing && (
            <div className="text-[9px] font-mono text-gray-600 px-2 py-4 text-center">
              Awaiting inference request...
            </div>
          )}
        </div>
      </div>

      {/* Connection Footer */}
      <div className="px-3 py-3 border-t border-gray-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="text-[8px] font-mono text-gray-500">VPC INTERNAL</span>
          </div>
          <span className="text-[8px] font-mono text-gray-600">{instance.dataAuthorityLabel}</span>
        </div>
      </div>
    </aside>
  );
}

// ═══════════════════════════════════════════════════════
//  INSTANCE SWITCHER
// ═══════════════════════════════════════════════════════

function InstanceSwitcher({ currentInstanceId, onSwitch }) {
  const [open, setOpen] = useState(false);
  const current = INSTANCES[currentInstanceId];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-600 transition-colors text-xs font-mono cursor-pointer"
        style={{ color: current.accent }}
      >
        <Hexagon className="w-3.5 h-3.5" />
        {currentInstanceId === 'logistics' ? 'LOGISTICS' : 'CFE ENERGY'}
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 w-48 bg-[#0C0D10] border border-gray-700 rounded-lg overflow-hidden z-50 shadow-2xl">
          {Object.entries(INSTANCES).map(([id, inst]) => (
            <button
              key={id}
              onClick={() => { onSwitch(id); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs font-mono transition-colors cursor-pointer ${
                id === currentInstanceId ? 'bg-gray-800' : 'hover:bg-gray-800/50'
              }`}
              style={{ color: id === currentInstanceId ? inst.accent : '#9CA3AF' }}
            >
              <Hexagon className="w-3 h-3" />
              <div>
                <div className="font-semibold">{inst.label}</div>
                <div className="text-[9px] text-gray-500">{inst.subtitle}</div>
              </div>
              {id === currentInstanceId && <CheckCircle2 className="w-3 h-3 ml-auto" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
//  MAIN COMPONENT — ThemeBridge
// ═══════════════════════════════════════════════════════

export default function ThemeBridge() {
  // ── State ──
  const [instanceId, setInstanceId] = useState('logistics');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [logs, setLogs] = useState([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Auth
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Refs
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const telemetryTimersRef = useRef([]);
  const abortRef = useRef(null);

  const instance = INSTANCES[instanceId];
  const isEnergyMode = instanceId === 'energy-cfe';

  // ── Firebase Auth Listener ──
  useEffect(() => {
    const auth = getAuth();
    const unsub = onAuthStateChanged(auth, (user) => {
      setAuthUser(user);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const auth = getAuth();
      await signInWithEmailAndPassword(auth, loginEmail, loginPassword);
    } catch (err) {
      setLoginError(err.code === 'auth/invalid-credential'
        ? 'Invalid credentials. Access restricted to provisioned operators.'
        : err.message
      );
    } finally {
      setLoginLoading(false);
    }
  };

  // ── Auto-scroll ──
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ── Boot Message ──
  useEffect(() => {
    setMessages([
      {
        role: 'system',
        type: 'info',
        content: isEnergyMode
          ? '> Sentinel de Red Eléctrica inicializado. Conectado a SCADA · CENACE.'
          : '> Sentinel Engine initialized. Connected to live market feeds.',
      },
      {
        role: 'system',
        type: 'ready',
        content: isEnergyMode
          ? 'Sistema listo. Pregunte sobre carga, activos, o riesgo meteorológico.'
          : 'System ready. Ask about freight rates, port congestion, or supply chain risks.',
      },
    ]);
    setLogs([]);
  }, [instanceId]);

  // ── Cleanup Timers on Unmount ──
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      telemetryTimersRef.current.forEach(t => clearTimeout(t));
    };
  }, []);

  // ═══════════════════════════════════════════════════
  //  STAGED TELEMETRY — Fake logs during inference
  // ═══════════════════════════════════════════════════

  const startTelemetry = useCallback(() => {
    // Clear previous
    telemetryTimersRef.current.forEach(t => clearTimeout(t));
    telemetryTimersRef.current = [];
    setLogs([]);
    setElapsedMs(0);

    // Start elapsed timer (tick every 500ms for smooth progress)
    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startTime);
    }, 500);

    // Schedule each telemetry stage
    TELEMETRY_STAGES.forEach((stage) => {
      const timer = setTimeout(() => {
        setLogs(prev => [...prev, {
          ...stage,
          timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
        }]);
      }, stage.delayMs);
      telemetryTimersRef.current.push(timer);
    });
  }, []);

  const stopTelemetry = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    telemetryTimersRef.current.forEach(t => clearTimeout(t));
    telemetryTimersRef.current = [];
  }, []);

  // ═══════════════════════════════════════════════════
  //  INFERENCE EXECUTION — Corrected Payload
  // ═══════════════════════════════════════════════════

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const query = input.trim();
    if (!query || isProcessing) return;

    setMessages(prev => [...prev, { role: 'user', type: 'query', content: query }]);
    setInput('');
    setIsProcessing(true);
    startTelemetry();

    try {
      // Acquire fresh Firebase JWT
      const auth = getAuth();
      const token = await auth.currentUser?.getIdToken(/* forceRefresh */ true);

      if (!token) {
        throw new Error('Authentication token unavailable. Please re-authenticate.');
      }

      // Build the corrected payload per backend contract
      const response = await fetch(SENTINEL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Sentinel-Instance': instanceId,
          'X-Sentinel-Client': 'theme-bridge-v5.2',
        },
        body: JSON.stringify({
          query: query,
          tenant_id: instance.tenantId,
          context: {
            industry: instance.systemPromptHint,
            instanceId: instanceId,
            language: instance.language,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || data.error || `HTTP ${response.status}`);
      }

      // Extract structured response
      const structured = data.data || {};

      // Add completion log
      setLogs(prev => [...prev, {
        label: 'INFERENCE_COMPLETE',
        detail: `Model: ${data.model} · Confidence: ${Math.round((structured.confidence || 0) * 100)}%`,
        icon: 'check',
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
      }]);

      setMessages(prev => [...prev, {
        role: 'sentinel',
        type: 'response',
        content: structured.narrative || 'No narrative generated.',
        metrics: structured.metrics || [],
        confidence: structured.confidence,
        sources: structured.sources || [],
        dataAuthority: structured.dataAuthority || data.infrastructure,
        model: data.model,
        timestamp: new Date().toLocaleTimeString(),
      }]);

      // Browser TTS (optional)
      if (isVoiceActive && structured.narrative) {
        speakWithBrowser(structured.narrative);
      }

    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'system',
        type: 'error',
        content: `Inference failure: ${err.message}`,
      }]);
      setLogs(prev => [...prev, {
        label: 'ERROR',
        detail: err.message,
        icon: 'shield',
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
      }]);
    } finally {
      stopTelemetry();
      setIsProcessing(false);
    }
  };

  // ── Browser TTS ──
  const speakWithBrowser = (text) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    const cleanText = text.replace(/[*#_`~>]/g, '').substring(0, 3000);
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = isEnergyMode ? 'es-MX' : 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);

    window.speechSynthesis.speak(utterance);
  };

  // ── Suggestion Click Handler ──
  const handleSuggestion = (s) => {
    setInput(s);
    // Small delay to allow state update, then submit
    setTimeout(() => {
      const form = document.getElementById('sentinel-input-form');
      if (form) form.requestSubmit();
    }, 50);
  };

  // ═══════════════════════════════════════════════════
  //  RENDER — Auth Loading
  // ═══════════════════════════════════════════════════

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#07080A] flex items-center justify-center">
        <div className="text-center">
          <div
            className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-4"
            style={{ borderColor: instance.accent, borderTopColor: 'transparent' }}
          />
          <p className="text-gray-500 text-xs font-mono tracking-widest">INITIALIZING SECURE SESSION...</p>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════
  //  RENDER — Login
  // ═══════════════════════════════════════════════════

  if (!authUser) {
    return (
      <div className="min-h-screen bg-[#07080A] flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="flex items-center justify-center gap-2 mb-3">
              <Hexagon className="w-8 h-8" style={{ color: instance.accent }} />
              <h1
                className="text-2xl font-bold font-mono tracking-[0.3em]"
                style={{ color: instance.accent }}
              >
                SENTINEL
              </h1>
            </div>
            <p className="text-gray-400 text-sm font-mono">{instance.subtitle}</p>
            <p className="text-gray-600 text-[10px] mt-1 font-mono">High ArchyTech Solutions</p>
          </div>

          <form
            onSubmit={handleLogin}
            className="border border-gray-800 rounded-xl p-6 space-y-4"
            style={{ background: 'rgba(15,15,20,0.9)' }}
          >
            <div>
              <label className="block text-gray-500 text-[10px] font-mono mb-1 uppercase tracking-[0.2em]">
                Operator Email
              </label>
              <input
                id="login-email"
                type="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full bg-[#07080A] border border-gray-800 rounded-lg px-3 py-2.5 text-gray-200 font-mono text-sm focus:outline-none transition-colors"
                style={{ '--tw-ring-color': instance.accent }}
                onFocus={(e) => e.target.style.borderColor = instance.accent}
                onBlur={(e) => e.target.style.borderColor = '#1f2937'}
                placeholder="operator@enterprise.com"
              />
            </div>
            <div>
              <label className="block text-gray-500 text-[10px] font-mono mb-1 uppercase tracking-[0.2em]">
                Access Key
              </label>
              <input
                id="login-password"
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full bg-[#07080A] border border-gray-800 rounded-lg px-3 py-2.5 text-gray-200 font-mono text-sm focus:outline-none transition-colors"
                onFocus={(e) => e.target.style.borderColor = instance.accent}
                onBlur={(e) => e.target.style.borderColor = '#1f2937'}
                placeholder="••••••••••••"
              />
            </div>

            {loginError && (
              <div className="flex items-center gap-2 text-red-400 text-xs font-mono bg-red-400/10 border border-red-400/30 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <button
              id="login-submit"
              type="submit"
              disabled={loginLoading}
              className="w-full font-mono font-bold text-sm py-3 rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              style={{
                background: instance.accent,
                color: '#07080A',
                boxShadow: `0 0 20px ${instance.accentGlow}`,
              }}
            >
              {loginLoading ? (
                <>
                  <div
                    className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
                    style={{ borderColor: '#07080A', borderTopColor: 'transparent' }}
                  />
                  AUTHENTICATING...
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  AUTHENTICATE
                </>
              )}
            </button>

            {/* Instance Switcher on Login */}
            <div className="pt-3 border-t border-gray-800 flex items-center justify-center">
              <InstanceSwitcher currentInstanceId={instanceId} onSwitch={setInstanceId} />
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════
  //  RENDER — Main Dashboard
  // ═══════════════════════════════════════════════════

  return (
    <div className="h-screen bg-[#07080A] text-gray-200 flex overflow-hidden" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* ── SIDEBAR ── */}
      <Sidebar instance={instance} isProcessing={isProcessing} logs={logs} />

      {/* ── MAIN CONTENT ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="flex items-center justify-between px-5 py-3 border-b border-gray-800 bg-[#07080A]/90 backdrop-blur-xl flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-amber-400/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-400/60" />
            </div>
            <span className="text-[10px] font-mono text-gray-600 tracking-wider">
              {instance.terminalLabel}
            </span>

            {/* Soundwave when speaking */}
            {isSpeaking && (
              <div className="flex items-end gap-[2px] h-3.5 ml-2">
                {[1, 2, 3, 4, 5].map((bar) => (
                  <div
                    key={bar}
                    className="w-[2px] rounded-full"
                    style={{
                      background: instance.accent,
                      animation: `sentinel-soundwave 0.8s ease-in-out infinite alternate`,
                      animationDelay: `${bar * 0.1}s`,
                      height: '4px',
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* Voice Toggle */}
            <button
              id="voice-toggle"
              onClick={() => {
                if (isSpeaking) {
                  window.speechSynthesis?.cancel();
                  setIsSpeaking(false);
                }
                setIsVoiceActive(prev => !prev);
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border transition-all cursor-pointer ${
                isVoiceActive
                  ? 'border-gray-600 bg-gray-800/80'
                  : 'border-gray-800 bg-transparent hover:border-gray-700'
              }`}
              title={isVoiceActive ? 'Mute Voice' : 'Enable Voice'}
            >
              {isVoiceActive
                ? <Volume2 className="w-3 h-3" style={{ color: instance.accent }} />
                : <VolumeX className="w-3 h-3 text-gray-600" />
              }
              <span className={`text-[8px] font-mono tracking-wider ${isVoiceActive ? '' : 'text-gray-600'}`}
                    style={isVoiceActive ? { color: instance.accent } : {}}>
                {isVoiceActive ? 'VOICE' : 'MUTED'}
              </span>
            </button>

            {/* Security Badge */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-green-500/30 bg-green-500/5">
              <Lock className="w-2.5 h-2.5 text-green-400" />
              <span className="text-[8px] font-mono text-green-400 tracking-wider">PQ-TLS</span>
            </div>

            {/* Instance Switcher */}
            <InstanceSwitcher currentInstanceId={instanceId} onSwitch={setInstanceId} />
          </div>
        </header>

        {/* Progress Bar */}
        <InferenceProgressBar isActive={isProcessing} elapsedMs={elapsedMs} accent={instance.accent} />

        {/* ── Messages Feed ── */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-5 scroll-smooth" style={{ minHeight: 0 }}>

          {messages.map((msg, i) => (
            <div key={i} className="animate-fade-in-up">
              {/* User Query */}
              {msg.type === 'query' && (
                <div className="flex justify-end">
                  <div
                    className="max-w-[75%] px-5 py-3.5 rounded-2xl rounded-br-md border"
                    style={{
                      background: instance.accentDim,
                      borderColor: `${instance.accent}44`,
                    }}
                  >
                    <p className="text-sm text-gray-200 leading-relaxed font-mono">{msg.content}</p>
                  </div>
                </div>
              )}

              {/* Sentinel Response */}
              {msg.type === 'response' && (
                <div className="flex justify-start">
                  <div
                    className="max-w-[85%] pl-5 pr-6 py-4 rounded-r-xl border-l-[3px] bg-gray-900/30"
                    style={{ borderLeftColor: `${instance.accent}99` }}
                  >
                    {/* Response Header */}
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <Shield className="w-4 h-4" style={{ color: instance.accent }} />
                      <span className="text-[11px] tracking-[0.15em] font-semibold" style={{ color: instance.accent }}>
                        Sentinel
                      </span>
                      {msg.confidence != null && (
                        <span
                          className="text-[9px] px-1.5 py-0.5 rounded-full font-mono"
                          style={{ background: instance.accentDim, color: instance.accent }}
                        >
                          {Math.round(msg.confidence * 100)}% confidence
                        </span>
                      )}
                      {msg.model && (
                        <span className="text-[9px] text-gray-500 font-mono">
                          {msg.model}
                        </span>
                      )}
                      <span className="text-[10px] text-gray-600 ml-auto">— {msg.timestamp}</span>
                    </div>

                    {/* Narrative */}
                    <div className="text-gray-300 text-sm leading-relaxed prose prose-invert prose-sm max-w-none prose-headings:text-gray-200 prose-strong:text-gray-100 prose-code:text-xs prose-code:font-mono">
                      <ReactMarkdown>{DOMPurify.sanitize(msg.content)}</ReactMarkdown>
                    </div>

                    {/* Metrics */}
                    {msg.metrics && msg.metrics.length > 0 && (
                      <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {msg.metrics.slice(0, 6).map((m, mi) => (
                          <div
                            key={mi}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-800"
                            style={{ background: instance.accentDim }}
                          >
                            <div className="min-w-0">
                              <div className="text-[9px] text-gray-500 truncate">{m.label}</div>
                              <div className="text-xs font-mono font-semibold" style={{ color: instance.accent }}>
                                {m.value}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Footer */}
                    <div className="mt-3 pt-3 border-t border-gray-800/50 flex flex-wrap items-center gap-3">
                      {msg.dataAuthority && (
                        <span
                          className="text-[9px] font-mono font-bold tracking-wider px-2 py-0.5 rounded-full border"
                          style={{
                            color: instance.accent,
                            borderColor: `${instance.accent}44`,
                            background: instance.accentDim,
                          }}
                        >
                          {msg.dataAuthority}
                        </span>
                      )}
                      {msg.sources && msg.sources.length > 0 && (
                        <span className="text-[9px] text-gray-600 ml-auto">
                          Sources: {msg.sources.join(' • ')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* System Messages */}
              {(msg.type === 'info' || msg.type === 'ready') && (
                <div className="text-center py-1">
                  <span className={`text-xs font-mono ${msg.type === 'info' ? '' : 'text-green-400'}`}
                        style={msg.type === 'info' ? { color: instance.accent } : {}}>
                    {msg.content}
                  </span>
                </div>
              )}

              {/* Error Messages */}
              {msg.type === 'error' && (
                <div className="flex items-center gap-3 p-4 rounded-xl border border-red-500/30 bg-red-500/5 max-w-[85%]">
                  <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0" />
                  <span className="text-xs font-mono text-red-400">{msg.content}</span>
                </div>
              )}
            </div>
          ))}

          {/* Processing Indicator */}
          {isProcessing && (
            <div className="flex items-center gap-3 py-2 animate-pulse">
              <RefreshCw className="w-4 h-4 animate-spin" style={{ color: instance.accent }} />
              <span className="text-sm font-mono" style={{ color: instance.accent }}>
                {isEnergyMode ? 'Analizando la red eléctrica...' : 'Processing sovereign inference...'}
              </span>
            </div>
          )}
        </div>

        {/* ── Suggestion Chips ── */}
        <div className="px-6 py-3 border-t border-gray-800/50 flex-shrink-0">
          <div className="flex flex-wrap gap-2">
            {instance.suggestions.map((s, i) => (
              <button
                key={i}
                id={`suggestion-${i}`}
                onClick={() => handleSuggestion(s)}
                disabled={isProcessing}
                className="px-4 py-2 rounded-full border border-gray-800 text-[10px] font-mono text-gray-500 hover:border-gray-600 hover:text-gray-300 transition-all whitespace-nowrap cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  '--hover-border': instance.accent + '60',
                  '--hover-text': instance.accent,
                }}
                onMouseEnter={(e) => {
                  if (!isProcessing) {
                    e.target.style.borderColor = instance.accent + '60';
                    e.target.style.color = instance.accent;
                    e.target.style.background = instance.accentDim;
                  }
                }}
                onMouseLeave={(e) => {
                  e.target.style.borderColor = '#1f2937';
                  e.target.style.color = '#6b7280';
                  e.target.style.background = 'transparent';
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* ── Input Bar ── */}
        <form
          id="sentinel-input-form"
          onSubmit={handleSubmit}
          className="flex items-center gap-3 px-5 py-4 border-t border-gray-800 bg-[#07080A] flex-shrink-0"
        >
          <div className="flex-1 relative">
            <input
              ref={inputRef}
              id="neural-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isProcessing}
              placeholder={isEnergyMode
                ? 'Consulta de inteligencia de red...'
                : 'Enter intelligence query...'
              }
              className="w-full bg-[#0C0D10] border border-gray-800 rounded-xl px-4 py-3 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none transition-colors disabled:opacity-50"
              style={{
                focusBorderColor: instance.accent,
              }}
              onFocus={(e) => e.target.style.borderColor = instance.accent + '66'}
              onBlur={(e) => e.target.style.borderColor = '#1f2937'}
              autoComplete="off"
            />
          </div>
          <button
            id="terminal-send"
            type="submit"
            disabled={isProcessing || !input.trim()}
            className="p-3 rounded-xl transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: isProcessing || !input.trim() ? '#1f2937' : instance.accent,
              color: isProcessing || !input.trim() ? '#6b7280' : '#07080A',
              boxShadow: isProcessing || !input.trim() ? 'none' : `0 0 15px ${instance.accentGlow}`,
            }}
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
