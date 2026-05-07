/**
 * SENTINEL ENGINE V5.5 — Integrity Supervisor Dashboard (HITL)
 * ═══════════════════════════════════════════════════════════════════
 * The "Cockpit" for Tier 1 leadership. Provides:
 *   - Real-time escalation queue with Evidence Locker Fragments
 *   - Force-Release override (WebAuthn/FIDO2 gated)
 *   - Coaching Loop annotations for model drift prevention
 *   - Evidence-Led Rollback trigger (WebAuthn gated)
 *   - Authority Matrix visualization
 *   - Evidence chain integrity verification
 *
 * Design: Dark obsidian theme with glassmorphism, consistent with
 * the existing Sentinel UI. Subtle pulse on pending escalations.
 * ═══════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { Float, Environment, MeshDistortMaterial } from '@react-three/drei';
import { WebAuthnClient, sendEscalationAction, ESCALATION_ENDPOINT } from '../WebAuthnClient';
import * as THREE from 'three';
import './SupervisorDashboard.css';

// ─────────────────────────────────────────────────────
//  3D STATUS ORB (R3F)
// ─────────────────────────────────────────────────────

const STATUS_COLORS = {
  green: new THREE.Color(0.1, 0.9, 0.3),
  amber: new THREE.Color(1.0, 0.7, 0.1),
  red: new THREE.Color(1.0, 0.15, 0.15),
};

function StatusOrb({ status }) {
  const meshRef = useRef();
  const targetColor = useRef(STATUS_COLORS.green);

  useEffect(() => {
    if (status === 'critical') targetColor.current = STATUS_COLORS.red;
    else if (status === 'warning') targetColor.current = STATUS_COLORS.amber;
    else targetColor.current = STATUS_COLORS.green;
  }, [status]);

  return (
    <Float speed={2} rotationIntensity={0.3} floatIntensity={0.8}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.5, 64, 64]} />
        <MeshDistortMaterial
          color={targetColor.current}
          emissive={targetColor.current}
          emissiveIntensity={0.6}
          roughness={0.2}
          metalness={0.3}
          clearcoat={1.0}
          clearcoatRoughness={0.1}
          distort={status === 'critical' ? 0.3 : 0.1}
          speed={status === 'critical' ? 4 : 1.5}
        />
      </mesh>
    </Float>
  );
}

// ─────────────────────────────────────────────────────
//  HELPER — TIME FORMATTING
// ─────────────────────────────────────────────────────

function formatTimeRemaining(ttlExpiresAt) {
  const remaining = new Date(ttlExpiresAt) - new Date();
  if (remaining <= 0) return 'EXPIRED';
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ─────────────────────────────────────────────────────
//  BADGE COMPONENT
// ─────────────────────────────────────────────────────

function Badge({ type, children }) {
  return <span className={`sv-badge sv-badge--${type}`}>{children}</span>;
}

// ─────────────────────────────────────────────────────
//  ESCALATION CARD
// ─────────────────────────────────────────────────────

function EscalationCard({ escalation, onResolve, isResolving }) {
  const [coachingText, setCoachingText] = useState('');
  const [showEvidence, setShowEvidence] = useState(false);
  const ttl = formatTimeRemaining(escalation.ttlExpiresAt);
  const isExpired = ttl === 'EXPIRED';

  return (
    <div className={`sv-card sv-card--escalation ${isExpired ? 'sv-card--expired' : 'sv-card--pending'}`}>
      <div className="sv-card__header">
        <div className="sv-card__id">{escalation.escalationId}</div>
        <div className="sv-card__badges">
          <Badge type={escalation.impactLevel === 'HIGH_IMPACT' ? 'danger' : 'warning'}>
            {escalation.impactLevel}
          </Badge>
          <Badge type="info">{escalation.blastRadius}</Badge>
          <Badge type={isExpired ? 'danger' : 'warning'}>
            TTL: {ttl}
          </Badge>
        </div>
      </div>

      <div className="sv-card__meta">
        <span>Request: <code>{escalation.requestId}</code></span>
        <span>Authority: <strong>{escalation.authorityName || escalation.authorityId}</strong> ({escalation.authorityRole})</span>
        <span>Created: {formatDate(escalation.createdAt)}</span>
      </div>

      <button
        className="sv-btn sv-btn--ghost"
        onClick={() => setShowEvidence(!showEvidence)}
      >
        {showEvidence ? '▼ Hide Evidence Fragment' : '▶ Show Evidence Fragment'}
      </button>

      {showEvidence && escalation.evidenceFragment && (
        <div className="sv-card__evidence">
          <div className="sv-evidence-section">
            <label>AI Intent (Narrative)</label>
            <pre>{escalation.evidenceFragment.aiIntent?.substring(0, 500) || 'N/A'}</pre>
          </div>
          <div className="sv-evidence-section">
            <label>Pristine Data Context</label>
            <pre>{escalation.evidenceFragment.pristineData?.substring(0, 500) || 'N/A'}</pre>
          </div>
          <div className="sv-evidence-section">
            <label>Prosecutor Logic</label>
            <pre>{JSON.stringify(escalation.evidenceFragment.prosecutorLogic, null, 2)?.substring(0, 500) || 'N/A'}</pre>
          </div>
        </div>
      )}

      {!isExpired && (
        <div className="sv-card__actions">
          <div className="sv-coaching">
            <textarea
              className="sv-textarea"
              placeholder="Coaching annotation (optional) — feedback for model drift prevention..."
              value={coachingText}
              onChange={e => setCoachingText(e.target.value)}
              rows={2}
            />
          </div>
          <div className="sv-btn-group">
            <button
              className="sv-btn sv-btn--release"
              disabled={isResolving}
              onClick={() => onResolve(escalation.escalationId, 'OVERRIDE_RELEASE', escalation.authorityId, coachingText)}
            >
              {isResolving ? '⏳ Signing...' : '🔓 Force-Release (FIDO2)'}
            </button>
            <button
              className="sv-btn sv-btn--block"
              disabled={isResolving}
              onClick={() => onResolve(escalation.escalationId, 'CONFIRM_BLOCK', escalation.authorityId, coachingText)}
            >
              {isResolving ? '⏳ Signing...' : '🔒 Confirm Block (FIDO2)'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────
//  HISTORY TABLE
// ─────────────────────────────────────────────────────

function HistoryTable({ history }) {
  if (!history || history.length === 0) return <p className="sv-empty">No escalation history.</p>;

  const statusClass = (s) => {
    if (s === 'OVERRIDE_RELEASED') return 'sv-status--released';
    if (s === 'TTL_EXPIRED') return 'sv-status--expired';
    return 'sv-status--blocked';
  };

  return (
    <div className="sv-table-wrap">
      <table className="sv-table">
        <thead>
          <tr>
            <th>Escalation</th>
            <th>Status</th>
            <th>Impact</th>
            <th>Authority</th>
            <th>Created</th>
            <th>Resolved</th>
          </tr>
        </thead>
        <tbody>
          {history.map(h => (
            <tr key={h.escalationId}>
              <td><code>{h.escalationId}</code></td>
              <td><span className={`sv-status ${statusClass(h.status)}`}>{h.status}</span></td>
              <td><Badge type={h.impactLevel === 'HIGH_IMPACT' ? 'danger' : 'default'}>{h.impactLevel}</Badge></td>
              <td>{h.authorityName || h.resolvedBy || '-'}</td>
              <td>{formatDate(h.createdAt)}</td>
              <td>{formatDate(h.resolvedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────
//  AUTHORITY LIST
// ─────────────────────────────────────────────────────

function AuthorityList({ authorities }) {
  if (!authorities || authorities.length === 0) return <p className="sv-empty">No authorities configured.</p>;

  return (
    <div className="sv-authority-grid">
      {authorities.map(a => (
        <div key={a.authorityId} className="sv-authority-card">
          <div className="sv-authority-card__name">{a.name}</div>
          <div className="sv-authority-card__meta">
            <Badge type="info">{a.role}</Badge>
            <Badge type="default">Tier {a.escalationTier}</Badge>
            <Badge type="default">{a.blastRadius}</Badge>
          </div>
          <div className="sv-authority-card__channel">
            {a.webhookUrl ? '🔔 Webhook configured' : '📋 Dashboard-only'}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────
//  ACTIVE GOVERNANCE FEED (SSE)
// ─────────────────────────────────────────────────────

function ActiveGovernanceFeed({ feed }) {
  if (!feed || feed.length === 0) return <p className="sv-empty">Listening for real-time governance events...</p>;

  return (
    <div className="sv-feed-list">
      {feed.map(event => {
        let typeClass = '';
        let label = '';
        if (event.type === 'escalation_resolved') {
          typeClass = 'sv-feed-item--permit';
          label = 'Permit Event';
        } else if (event.type === 'escalation_created') {
          typeClass = 'sv-feed-item--escalation';
          label = 'Escalation Alert (JIT)';
        } else if (event.type === 'monotonic_reduction') {
          typeClass = 'sv-feed-item--reduction';
          label = 'Reduction Warning';
        }

        return (
          <div key={event.id} className={`sv-feed-item ${typeClass}`}>
            <div className="sv-feed-item__header">
              <span className="sv-feed-item__label">{label}</span>
              <span className="sv-feed-item__time">{formatDate(event.timestamp)}</span>
            </div>
            <div className="sv-feed-item__body">
              {event.type === 'escalation_resolved' && (
                <>
                  <p>Authority Unit <strong>{event.data.authority_unit || event.data.authorityId || '-'}</strong> sanctioned action for <code>{event.data.escalationId}</code>.</p>
                  <p>Decision: <strong>{event.data.decision}</strong></p>
                </>
              )}
              {event.type === 'escalation_created' && (
                <>
                  <p>Escalation <code>{event.data.escalationId}</code> created.</p>
                  <p>Impact Level: <strong>{event.data.impactLevel}</strong></p>
                </>
              )}
              {event.type === 'monotonic_reduction' && (
                <>
                  <p>Protocol Triggered on <code>{event.data.escalationId}</code>.</p>
                  <p>Reason: {event.data.reason || 'Supervisor TTL Expired'}</p>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────
//  MAIN DASHBOARD COMPONENT
// ─────────────────────────────────────────────────────

export default function SupervisorDashboard({ authToken }) {
  const [activeTab, setActiveTab] = useState('queue');
  const [escalations, setEscalations] = useState([]);
  const [history, setHistory] = useState([]);
  const [activeGovernanceFeed, setActiveGovernanceFeed] = useState([]);
  const [authorities, setAuthorities] = useState([]);
  const [chainStatus, setChainStatus] = useState(null);
  const [rollbackAvail, setRollbackAvail] = useState(null);
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const webauthn = useRef(null);

  useEffect(() => {
    webauthn.current = new WebAuthnClient(authToken);
  }, [authToken]);

  // ─── SSE Stream ───
  useEffect(() => {
    const es = new EventSource(`${ESCALATION_ENDPOINT}?stream=true`);
    
    const handleEvent = (type) => (e) => {
      try {
        const data = JSON.parse(e.data);
        setActiveGovernanceFeed(prev => [{ id: Date.now() + Math.random(), type, data, timestamp: new Date() }, ...prev].slice(0, 100));
      } catch (err) {
        console.error("Failed to parse SSE data", err);
      }
    };

    es.addEventListener('escalation_created', handleEvent('escalation_created'));
    es.addEventListener('escalation_resolved', handleEvent('escalation_resolved'));
    es.addEventListener('monotonic_reduction', handleEvent('monotonic_reduction'));

    return () => es.close();
  }, []);

  // ─── Polling ───
  const fetchQueue = useCallback(async () => {
    try {
      const res = await sendEscalationAction('list', {}, authToken);
      setEscalations(res.escalations || []);
      setLastRefresh(new Date());
      setError(null);
    } catch (err) {
      setError(`Queue fetch failed: ${err.message}`);
    }
  }, [authToken]);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 5000); // 5s polling
    return () => clearInterval(interval);
  }, [fetchQueue]);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await sendEscalationAction('history', { limit: 50 }, authToken);
      setHistory(res.history || []);
    } catch (err) { setError(`History fetch failed: ${err.message}`); }
  }, [authToken]);

  const fetchAuthorities = useCallback(async () => {
    try {
      const res = await sendEscalationAction('authorities', {}, authToken);
      setAuthorities(res.authorities || []);
    } catch (err) { setError(`Authorities fetch failed: ${err.message}`); }
  }, [authToken]);

  const fetchChainStatus = useCallback(async () => {
    try {
      const res = await sendEscalationAction('chain_verify', {}, authToken);
      setChainStatus(res.chain);
    } catch (err) { setError(`Chain verification failed: ${err.message}`); }
  }, [authToken]);

  const fetchRollbackStatus = useCallback(async () => {
    try {
      const res = await sendEscalationAction('rollback_status', {}, authToken);
      setRollbackAvail(res);
    } catch (err) { setError(`Rollback status failed: ${err.message}`); }
  }, [authToken]);

  useEffect(() => {
    if (activeTab === 'history') fetchHistory();
    if (activeTab === 'authorities') fetchAuthorities();
    if (activeTab === 'chain') fetchChainStatus();
    if (activeTab === 'rollback') fetchRollbackStatus();
  }, [activeTab, fetchHistory, fetchAuthorities, fetchChainStatus, fetchRollbackStatus]);

  // ─── Resolve Escalation ───
  const handleResolve = useCallback(async (escalationId, decision, authorityId, coachingAnnotation) => {
    setIsResolving(true);
    setError(null);

    try {
      if (!WebAuthnClient.isSupported()) {
        throw new Error('WebAuthn not supported. A FIDO2 hardware key is REQUIRED for overrides.');
      }

      // FIDO2 ceremony — hardware key touch
      const assertion = await webauthn.current.authenticate(authorityId);

      await sendEscalationAction('resolve', {
        escalationId,
        decision,
        authorityId,
        coachingAnnotation: coachingAnnotation || null,
        webauthnAssertion: assertion,
      }, authToken);

      // Refresh queue
      await fetchQueue();
    } catch (err) {
      setError(`Resolution failed: ${err.message}`);
    } finally {
      setIsResolving(false);
    }
  }, [authToken, fetchQueue]);

  // ─── Rollback Trigger ───
  const handleRollback = useCallback(async (authorityId, reason) => {
    setIsResolving(true);
    setError(null);

    try {
      if (!WebAuthnClient.isSupported()) {
        throw new Error('WebAuthn not supported. A FIDO2 hardware key is REQUIRED for rollbacks.');
      }

      const assertion = await webauthn.current.authenticate(authorityId);

      await sendEscalationAction('rollback', {
        authorityId,
        reason,
        webauthnAssertion: assertion,
      }, authToken);

      await fetchRollbackStatus();
    } catch (err) {
      setError(`Rollback failed: ${err.message}`);
    } finally {
      setIsResolving(false);
    }
  }, [authToken, fetchRollbackStatus]);

  // ─── Derived State ───
  const orbStatus = escalations.length > 0 ? 'critical' : (chainStatus && !chainStatus.valid ? 'warning' : 'green');

  return (
    <div className="sv-dashboard">
      {/* ─── Header ─── */}
      <header className="sv-header">
        <div className="sv-header__left">
          <div className="sv-orb-container">
            <Canvas
              camera={{ position: [0, 0, 2.5], fov: 45 }}
              style={{ width: 60, height: 60 }}
              gl={{ antialias: true }}
            >
              <Environment preset="city" />
              <StatusOrb status={orbStatus} />
            </Canvas>
          </div>
          <div>
            <h1 className="sv-header__title">Integrity Supervisor</h1>
            <p className="sv-header__subtitle">
              Sentinel V5.4 — Governed Escalation Pipeline
              {lastRefresh && <span className="sv-header__refresh"> · Refreshed {lastRefresh.toLocaleTimeString()}</span>}
            </p>
          </div>
        </div>
        <div className="sv-header__right">
          {escalations.length > 0 && (
            <div className="sv-pulse-badge">
              <span className="sv-pulse-dot" />
              {escalations.length} PENDING
            </div>
          )}
        </div>
      </header>

      {/* ─── Error Banner ─── */}
      {error && (
        <div className="sv-error-banner">
          <span>⚠ {error}</span>
          <button onClick={() => setError(null)} className="sv-btn sv-btn--ghost sv-btn--sm">✕</button>
        </div>
      )}

      {/* ─── Tab Navigation ─── */}
      <nav className="sv-tabs">
        {[
          { key: 'queue', label: `Escalation Queue${escalations.length > 0 ? ` (${escalations.length})` : ''}` },
          { key: 'stream', label: 'Active Governance Feed' },
          { key: 'history', label: 'History' },
          { key: 'authorities', label: 'Authority Matrix' },
          { key: 'chain', label: 'Evidence Chain' },
          { key: 'rollback', label: 'Rollback' },
        ].map(tab => (
          <button
            key={tab.key}
            className={`sv-tab ${activeTab === tab.key ? 'sv-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* ─── Tab Content ─── */}
      <main className="sv-main">
        {activeTab === 'queue' && (
          <div className="sv-panel">
            {escalations.length === 0 ? (
              <div className="sv-empty-state">
                <div className="sv-empty-state__icon">✓</div>
                <h3>No Pending Escalations</h3>
                <p>All systems operating within governed parameters.</p>
              </div>
            ) : (
              <div className="sv-escalation-list">
                {escalations.map(e => (
                  <EscalationCard
                    key={e.escalationId}
                    escalation={e}
                    onResolve={handleResolve}
                    isResolving={isResolving}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'stream' && (
          <div className="sv-panel">
            <h2 className="sv-panel__title">Active Governance Feed</h2>
            <p className="sv-panel__desc">Zero-latency event stream directly from the Authority Graph.</p>
            <ActiveGovernanceFeed feed={activeGovernanceFeed} />
          </div>
        )}

        {activeTab === 'history' && (
          <div className="sv-panel">
            <h2 className="sv-panel__title">Escalation History</h2>
            <HistoryTable history={history} />
          </div>
        )}

        {activeTab === 'authorities' && (
          <div className="sv-panel">
            <h2 className="sv-panel__title">Standing Authority Matrix</h2>
            <p className="sv-panel__desc">Named Human Approvers mapped by blast radius and escalation tier.</p>
            <AuthorityList authorities={authorities} />
          </div>
        )}

        {activeTab === 'chain' && (
          <div className="sv-panel">
            <h2 className="sv-panel__title">Evidence Chain Integrity</h2>
            {chainStatus ? (
              <div className={`sv-chain-status ${chainStatus.valid ? 'sv-chain--valid' : 'sv-chain--broken'}`}>
                <div className="sv-chain-status__icon">{chainStatus.valid ? '🔗' : '⛓️‍💥'}</div>
                <div>
                  <strong>{chainStatus.valid ? 'CHAIN INTACT' : 'CHAIN BROKEN'}</strong>
                  <p>{chainStatus.entryCount} entries verified.</p>
                  {chainStatus.brokenAt && <p className="sv-chain-broken-at">Broken at: <code>{chainStatus.brokenAt}</code></p>}
                </div>
              </div>
            ) : (
              <p className="sv-empty">Loading chain verification...</p>
            )}
            <button
              className="sv-btn sv-btn--ghost"
              onClick={fetchChainStatus}
              style={{ marginTop: '1rem' }}
            >
              Re-verify Chain
            </button>
          </div>
        )}

        {activeTab === 'rollback' && (
          <div className="sv-panel">
            <h2 className="sv-panel__title">Evidence-Led Rollback</h2>
            <p className="sv-panel__desc">
              Restore tenant data to the last Verified-Pristine checkpoint. This operation is irreversible and requires FIDO2 authentication.
            </p>
            {rollbackAvail ? (
              <div className="sv-rollback-info">
                <div className={`sv-rollback-status ${rollbackAvail.available ? 'sv-rollback--available' : 'sv-rollback--unavailable'}`}>
                  <strong>{rollbackAvail.available ? '✅ Rollback Available' : '❌ No Checkpoint Available'}</strong>
                  {rollbackAvail.lastCheckpoint && (
                    <div className="sv-rollback-checkpoint">
                      <p>Last Checkpoint: <code>{rollbackAvail.lastCheckpoint.lockerId}</code></p>
                      <p>Date: {formatDate(rollbackAvail.lastCheckpoint.checkpointedAt)}</p>
                      <p>Rows: {rollbackAvail.lastCheckpoint.totalRows?.toLocaleString()}</p>
                    </div>
                  )}
                </div>
                {rollbackAvail.available && authorities.length > 0 && (
                  <button
                    className="sv-btn sv-btn--danger"
                    disabled={isResolving}
                    onClick={() => {
                      const reason = prompt('Enter rollback reason:');
                      if (reason) handleRollback(authorities[0].authorityId, reason);
                    }}
                  >
                    {isResolving ? '⏳ Authenticating...' : '⚠️ Initiate Rollback (FIDO2)'}
                  </button>
                )}
              </div>
            ) : (
              <p className="sv-empty">Loading rollback status...</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
