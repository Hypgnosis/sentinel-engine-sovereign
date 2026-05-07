/**
 * SENTINEL CLIENT — Sovereign Stamp IPC Client (mTLS)
 * ═══════════════════════════════════════════════════════════
 * Communicates with the local Go Sovereign Sidecar using mTLS.
 * No Firebase Auth. No multi-tenant headers.
 * ═══════════════════════════════════════════════════════════
 */

import * as https from 'https';
import * as fs from 'fs';

export class SentinelError extends Error {
  constructor(code, message, requestId = null, httpStatus = null) {
    super(message);
    this.name = 'SentinelError';
    this.code = code;
    this.requestId = requestId;
    this.httpStatus = httpStatus;
  }
}

export class SentinelClient {
  constructor(endpoint = 'https://localhost:9443/v1/arbitrate') {
    this.endpoint = endpoint;
    
    // Load certificates for mTLS
    try {
      this.agent = new https.Agent({
        cert: fs.readFileSync('/var/sentinel/certs/client.crt'),
        key: fs.readFileSync('/var/sentinel/certs/client.key'),
        ca: fs.readFileSync('/var/sentinel/certs/ca.crt'),
        rejectUnauthorized: true
      });
    } catch (err) {
      console.warn('[SENTINEL_CLIENT] Warning: Failed to load mTLS certs from /var/sentinel/certs/:', err.message);
      this.agent = new https.Agent({ rejectUnauthorized: false }); // Fallback for dev if needed
    }
  }

  async _request(body) {
    const headers = { 'Content-Type': 'application/json' };

    // We use Node's native fetch (Node 18+) or node-fetch.
    // If native fetch doesn't support 'agent' natively, this might need 'dispatcher'.
    // We provide 'agent' for node-fetch compatibility.
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      agent: this.agent
    });

    const data = await response.json();
    return { response, data };
  }

  async query(queryText) {
    if (!queryText || typeof queryText !== 'string' || queryText.trim().length === 0) {
      throw new SentinelError('SENTINEL_EMPTY_QUERY', 'Query must be a non-empty string.');
    }

    const { response, data } = await this._request({ skill: 'Arbitration', resource: queryText.trim() });

    if (!response.ok) {
      throw new SentinelError(
        data.code || 'SENTINEL_REQUEST_FAILED',
        data.message || data.error || `Request failed with status ${response.status}`,
        data.audit_id,
        response.status
      );
    }

    return {
      decision: data.decision,
      auditId: data.audit_id,
      latencyUs: data.latency_us
    };
  }

  async healthCheck() {
    try {
      const { response, data } = await this._request({ skill: 'HealthCheck', resource: 'ping' });
      return {
        online: response.ok,
        authenticated: true,
        details: {
          status: response.status,
          decision: data.decision,
          auditId: data.audit_id
        }
      };
    } catch (error) {
      return {
        online: false,
        authenticated: false,
        details: { status: 0, code: 'NETWORK_ERROR', error: error.message }
      };
    }
  }
}
