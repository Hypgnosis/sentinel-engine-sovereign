/**
 * SENTINEL ENGINE V5.4 — WebAuthn / FIDO2 Provider
 * ═══════════════════════════════════════════════════════════════════
 * Server-side WebAuthn challenge generation and assertion verification.
 * Uses @simplewebauthn/server for standards-compliant FIDO2 operations.
 *
 * V5.4 MANDATE:
 *   - All privileged human actions (Override, Rollback, Authority
 *     Matrix modification) MUST be secured via Phishing-Resistant
 *     MFA using FIDO2/WebAuthn hardware keys.
 *   - No "bypass" mode exists. If FIDO2 verification fails, the
 *     action is DENIED. Period.
 *   - Credential storage uses the `webauthn_credentials` table in
 *     the Pristine Reservoir (Postgres).
 *
 * Relying Party (RP) Configuration:
 *   - RP ID: Derived from SENTINEL_RP_ID env var (e.g., "sentinel.high-archy.tech")
 *   - RP Name: "Sentinel Engine HITL"
 *   - Origin: Derived from SENTINEL_RP_ORIGIN env var
 * ═══════════════════════════════════════════════════════════════════
 */

const { getSql } = require('./db');

// ─────────────────────────────────────────────────────
//  DYNAMIC IMPORT WRAPPER
//  @simplewebauthn/server is ESM-only; we dynamically
//  import it at runtime to avoid breaking the CJS bundle.
// ─────────────────────────────────────────────────────

let _simpleWebAuthn = null;

async function getWebAuthn() {
  if (!_simpleWebAuthn) {
    try {
      _simpleWebAuthn = await import('@simplewebauthn/server');
    } catch (err) {
      console.error('[WEBAUTHN_PROVIDER] Failed to import @simplewebauthn/server:', err.message);
      throw new Error('WEBAUTHN_UNAVAILABLE: @simplewebauthn/server not installed.');
    }
  }
  return _simpleWebAuthn;
}

// ─────────────────────────────────────────────────────
//  RP CONFIGURATION
// ─────────────────────────────────────────────────────

const RP_ID = process.env.SENTINEL_RP_ID || 'localhost';
const RP_NAME = 'Sentinel Engine HITL';
const RP_ORIGIN = process.env.SENTINEL_RP_ORIGIN || 'http://localhost:5173';

// ─────────────────────────────────────────────────────
//  TABLE SETUP (idempotent)
// ─────────────────────────────────────────────────────

let _tableEnsured = false;

async function ensureWebAuthnTable() {
  if (_tableEnsured) return;
  const sql = getSql();
  if (!sql) return;

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        credential_id TEXT PRIMARY KEY,
        authority_id TEXT NOT NULL,
        public_key BYTEA NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT[],
        aaguid TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    _tableEnsured = true;
    console.log('[WEBAUTHN_PROVIDER] Table webauthn_credentials ensured.');
  } catch (err) {
    console.warn('[WEBAUTHN_PROVIDER] Table creation skipped:', err.message);
    _tableEnsured = true;
  }
}

// In-memory challenge store (per-session, short-lived)
// In production, this should be Redis-backed for multi-instance deployments.
const _challengeStore = new Map();

// ─────────────────────────────────────────────────────
//  WEBAUTHN PROVIDER
// ─────────────────────────────────────────────────────

class WebAuthnProvider {
  /**
   * Generate registration options for a new FIDO2 key enrollment.
   *
   * @param {string} authorityId - The authority enrolling the key
   * @param {string} authorityName - Display name for the credential
   * @returns {Promise<object>} Registration options to send to the browser
   */
  async generateRegistrationOptions(authorityId, authorityName) {
    const webauthn = await getWebAuthn();
    await ensureWebAuthnTable();

    // Fetch existing credentials to exclude (prevent re-registration)
    const existingCredentials = await this._getCredentials(authorityId);

    const options = await webauthn.generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: Buffer.from(authorityId, 'utf8'),
      userName: authorityName || authorityId,
      attestationType: 'none', // We don't need attestation verification
      excludeCredentials: existingCredentials.map(c => ({
        id: c.credentialId,
        type: 'public-key',
        transports: c.transports || [],
      })),
      authenticatorSelection: {
        authenticatorAttachment: 'cross-platform', // Hardware keys (YubiKey etc.)
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });

    // Store challenge for verification
    _challengeStore.set(authorityId, {
      challenge: options.challenge,
      type: 'registration',
      expiresAt: Date.now() + 120000, // 2 minute expiry
    });

    console.log(`[WEBAUTHN_PROVIDER] Registration challenge generated for ${authorityId}.`);
    return options;
  }

  /**
   * Verify a registration response and store the credential.
   *
   * @param {string} authorityId
   * @param {object} registrationResponse - Browser's registration response
   * @returns {Promise<{verified: boolean, credentialId: string|null}>}
   */
  async verifyRegistration(authorityId, registrationResponse) {
    const webauthn = await getWebAuthn();

    const stored = _challengeStore.get(authorityId);
    if (!stored || stored.type !== 'registration') {
      throw new Error('No pending registration challenge found.');
    }
    if (Date.now() > stored.expiresAt) {
      _challengeStore.delete(authorityId);
      throw new Error('Registration challenge expired.');
    }

    try {
      const verification = await webauthn.verifyRegistrationResponse({
        response: registrationResponse,
        expectedChallenge: stored.challenge,
        expectedOrigin: RP_ORIGIN,
        expectedRPID: RP_ID,
      });

      _challengeStore.delete(authorityId);

      if (!verification.verified || !verification.registrationInfo) {
        return { verified: false, credentialId: null };
      }

      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

      // Store credential in Postgres
      const sql = getSql();
      if (sql) {
        const credentialIdB64 = Buffer.from(credential.id).toString('base64url');
        await sql`
          INSERT INTO webauthn_credentials (
            credential_id, authority_id, public_key, counter, transports, aaguid
          ) VALUES (
            ${credentialIdB64},
            ${authorityId},
            ${Buffer.from(credential.publicKey)},
            ${credential.counter},
            ${registrationResponse.response?.transports || []},
            ${verification.registrationInfo.aaguid || null}
          )
          ON CONFLICT (credential_id) DO UPDATE SET
            counter = EXCLUDED.counter,
            public_key = EXCLUDED.public_key
        `;
      }

      console.log(JSON.stringify({
        severity: 'INFO',
        eventType: 'WEBAUTHN_REGISTERED',
        authorityId,
        credentialDeviceType,
        credentialBackedUp,
        message: `[WEBAUTHN_PROVIDER] FIDO2 credential registered for ${authorityId}.`,
      }));

      return {
        verified: true,
        credentialId: Buffer.from(credential.id).toString('base64url'),
      };
    } catch (err) {
      _challengeStore.delete(authorityId);
      console.error(`[WEBAUTHN_PROVIDER] Registration verification failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate authentication options for an override signing ceremony.
   *
   * @param {string} authorityId
   * @returns {Promise<object>} Authentication options to send to the browser
   */
  async generateAuthenticationOptions(authorityId) {
    const webauthn = await getWebAuthn();
    await ensureWebAuthnTable();

    const credentials = await this._getCredentials(authorityId);
    if (credentials.length === 0) {
      throw new Error(`No FIDO2 credentials registered for authority ${authorityId}. Enroll a hardware key first.`);
    }

    const options = await webauthn.generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: credentials.map(c => ({
        id: c.credentialId,
        type: 'public-key',
        transports: c.transports || [],
      })),
      userVerification: 'required',
    });

    _challengeStore.set(authorityId, {
      challenge: options.challenge,
      type: 'authentication',
      expiresAt: Date.now() + 120000,
    });

    console.log(`[WEBAUTHN_PROVIDER] Authentication challenge generated for ${authorityId}.`);
    return options;
  }

  /**
   * Verify an authentication response (FIDO2 assertion).
   *
   * @param {string} authorityId
   * @param {object} authenticationResponse - Browser's authentication response
   * @returns {Promise<boolean>} True if the hardware key signature is valid
   */
  async verifyAuthentication(authorityId, authenticationResponse) {
    const webauthn = await getWebAuthn();

    const stored = _challengeStore.get(authorityId);
    if (!stored || stored.type !== 'authentication') {
      throw new Error('No pending authentication challenge found.');
    }
    if (Date.now() > stored.expiresAt) {
      _challengeStore.delete(authorityId);
      throw new Error('Authentication challenge expired.');
    }

    const credentialIdB64 = authenticationResponse.id;
    const credential = await this._getCredentialById(credentialIdB64);
    if (!credential) {
      _challengeStore.delete(authorityId);
      throw new Error(`Credential ${credentialIdB64} not found.`);
    }

    try {
      const verification = await webauthn.verifyAuthenticationResponse({
        response: authenticationResponse,
        expectedChallenge: stored.challenge,
        expectedOrigin: RP_ORIGIN,
        expectedRPID: RP_ID,
        credential: {
          id: credential.credentialId,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports,
        },
      });

      _challengeStore.delete(authorityId);

      if (verification.verified) {
        // Update counter to prevent replay attacks
        const sql = getSql();
        if (sql) {
          await sql`
            UPDATE webauthn_credentials
            SET counter = ${verification.authenticationInfo.newCounter}
            WHERE credential_id = ${credentialIdB64}
          `;
        }

        console.log(JSON.stringify({
          severity: 'INFO',
          eventType: 'WEBAUTHN_AUTHENTICATED',
          authorityId,
          credentialId: credentialIdB64,
          message: `[WEBAUTHN_PROVIDER] FIDO2 assertion verified for ${authorityId}.`,
        }));
      }

      return verification.verified;
    } catch (err) {
      _challengeStore.delete(authorityId);
      console.error(`[WEBAUTHN_PROVIDER] Authentication verification failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Get all credentials for an authority.
   * @param {string} authorityId
   * @returns {Promise<object[]>}
   */
  async _getCredentials(authorityId) {
    const sql = getSql();
    if (!sql) return [];

    try {
      const rows = await sql`
        SELECT credential_id, public_key, counter, transports
        FROM webauthn_credentials
        WHERE authority_id = ${authorityId}
      `;
      return rows.map(r => ({
        credentialId: r.credential_id,
        publicKey: r.public_key,
        counter: r.counter,
        transports: r.transports || [],
      }));
    } catch (err) {
      console.error('[WEBAUTHN_PROVIDER] Credential fetch failed:', err.message);
      return [];
    }
  }

  /**
   * Get a specific credential by ID.
   * @param {string} credentialId
   * @returns {Promise<object|null>}
   */
  async _getCredentialById(credentialId) {
    const sql = getSql();
    if (!sql) return null;

    try {
      const [row] = await sql`
        SELECT credential_id, authority_id, public_key, counter, transports
        FROM webauthn_credentials
        WHERE credential_id = ${credentialId}
      `;
      if (!row) return null;
      return {
        credentialId: row.credential_id,
        authorityId: row.authority_id,
        publicKey: row.public_key,
        counter: row.counter,
        transports: row.transports || [],
      };
    } catch (err) {
      console.error('[WEBAUTHN_PROVIDER] Credential lookup failed:', err.message);
      return null;
    }
  }

  /**
   * Check if an authority has registered FIDO2 credentials.
   * @param {string} authorityId
   * @returns {Promise<boolean>}
   */
  async hasCredentials(authorityId) {
    const creds = await this._getCredentials(authorityId);
    return creds.length > 0;
  }
}

module.exports = { WebAuthnProvider, RP_ID, RP_NAME, RP_ORIGIN };
