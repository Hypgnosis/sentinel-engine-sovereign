/**
 * SENTINEL ENGINE V5.4 — WebAuthn Browser Client
 * ═══════════════════════════════════════════════════════════════════
 * Browser-side WebAuthn ceremony wrapper for the HITL Supervisor
 * Dashboard. Handles FIDO2 hardware key registration and 
 * authentication (override signing).
 *
 * Uses the Web Authentication API directly (navigator.credentials).
 * Base64URL encoding helpers included for portability.
 * ═══════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────
//  BASE64URL HELPERS
// ─────────────────────────────────────────────────────

function base64URLEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64URLDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ─────────────────────────────────────────────────────
//  ESCALATION API HELPER
// ─────────────────────────────────────────────────────

const ESCALATION_ENDPOINT = import.meta.env.VITE_ESCALATION_URL
  || 'https://sentinelescalation-ha-sentinel-core-v21.cloudfunctions.net';

async function sendEscalationAction(action, payload, token) {
  const res = await fetch(ESCALATION_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action, ...payload }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || err.message || `HTTP ${res.status}`);
  }

  return res.json();
}

// ─────────────────────────────────────────────────────
//  WEBAUTHN CLIENT
// ─────────────────────────────────────────────────────

export class WebAuthnClient {
  #authToken;

  constructor(authToken) {
    this.#authToken = authToken;
  }

  /**
   * Check if WebAuthn is supported in this browser.
   */
  static isSupported() {
    return !!(
      window.PublicKeyCredential &&
      navigator.credentials &&
      typeof navigator.credentials.create === 'function'
    );
  }

  /**
   * Register a new FIDO2 hardware key.
   * Two-step: server generates challenge → browser performs ceremony → server verifies.
   *
   * @param {string} authorityId - The authority enrolling the key
   * @param {string} authorityName - Display name
   * @returns {Promise<{verified: boolean, credentialId: string|null}>}
   */
  async register(authorityId, authorityName) {
    if (!WebAuthnClient.isSupported()) {
      throw new Error('WebAuthn is not supported in this browser.');
    }

    // Step 1: Get registration options from server
    const optionsRes = await sendEscalationAction('webauthn_register_options', {
      authorityId,
      authorityName,
    }, this.#authToken);

    const options = optionsRes.options;

    // Convert server options to browser format
    const publicKeyOptions = {
      ...options,
      challenge: base64URLDecode(options.challenge),
      user: {
        ...options.user,
        id: base64URLDecode(options.user.id),
      },
      excludeCredentials: (options.excludeCredentials || []).map(c => ({
        ...c,
        id: base64URLDecode(c.id),
      })),
    };

    // Step 2: Browser ceremony — hardware key interaction
    const credential = await navigator.credentials.create({
      publicKey: publicKeyOptions,
    });

    // Step 3: Encode response for server
    const registrationResponse = {
      id: credential.id,
      rawId: base64URLEncode(credential.rawId),
      type: credential.type,
      response: {
        attestationObject: base64URLEncode(credential.response.attestationObject),
        clientDataJSON: base64URLEncode(credential.response.clientDataJSON),
        transports: credential.response.getTransports?.() || [],
      },
    };

    // Step 4: Verify with server
    const verifyRes = await sendEscalationAction('webauthn_register_verify', {
      authorityId,
      registrationResponse,
    }, this.#authToken);

    return {
      verified: verifyRes.verified,
      credentialId: verifyRes.credentialId,
    };
  }

  /**
   * Authenticate with a registered FIDO2 key (for override/rollback signing).
   * Returns the assertion object to include in escalation resolution requests.
   *
   * @param {string} authorityId
   * @returns {Promise<object>} The WebAuthn assertion to send to the server
   */
  async authenticate(authorityId) {
    if (!WebAuthnClient.isSupported()) {
      throw new Error('WebAuthn is not supported in this browser.');
    }

    // Step 1: Get authentication options from server
    const optionsRes = await sendEscalationAction('webauthn_auth_options', {
      authorityId,
    }, this.#authToken);

    const options = optionsRes.options;

    // Convert server options to browser format
    const publicKeyOptions = {
      ...options,
      challenge: base64URLDecode(options.challenge),
      allowCredentials: (options.allowCredentials || []).map(c => ({
        ...c,
        id: base64URLDecode(c.id),
      })),
    };

    // Step 2: Browser ceremony — hardware key touch
    const assertion = await navigator.credentials.get({
      publicKey: publicKeyOptions,
    });

    // Step 3: Encode response for server
    const authenticationResponse = {
      id: assertion.id,
      rawId: base64URLEncode(assertion.rawId),
      type: assertion.type,
      response: {
        authenticatorData: base64URLEncode(assertion.response.authenticatorData),
        clientDataJSON: base64URLEncode(assertion.response.clientDataJSON),
        signature: base64URLEncode(assertion.response.signature),
        userHandle: assertion.response.userHandle
          ? base64URLEncode(assertion.response.userHandle)
          : null,
      },
    };

    return authenticationResponse;
  }
}

export { sendEscalationAction, ESCALATION_ENDPOINT };
