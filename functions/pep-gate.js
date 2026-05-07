/**
 * SENTINEL ENGINE V5.5 — Policy Enforcement Point (PEP Gate)
 * ═══════════════════════════════════════════════════════════════
 * Zero-Trust middleware: Strict JWT signature verification
 * using Google Firebase Admin SDK (Identity Provider).
 *
 * Context Injection:
 *   req.sentinelContext = { tenantId, userRole, authMethod, verifiedAt }
 * ═══════════════════════════════════════════════════════════════
 */

const admin = require('firebase-admin');

/**
 * Custom error class for PEP Gate failures.
 */
class PEPError extends Error {
  constructor(code, message, httpStatus = 401) {
    super(message);
    this.name = 'PEPError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Verification Layer: Firebase Admin SDK verification.
 *
 * @param {string} token - Raw JWT string
 * @returns {Promise<object>} Decoded Firebase token
 */
async function verifyWithFirebase(token) {
  try {
    const decodedToken = await admin.auth().verifyIdToken(token, true);
    return decodedToken;
  } catch (err) {
    throw new PEPError('PEP_FIREBASE_FAILURE', `Firebase verification failed: ${err.message}`);
  }
}

/**
 * Primary PEP Gate entry point.
 * Verifies via Firebase Auth.
 * Injects verified context into req.sentinelContext.
 *
 * @param {object} req - HTTP request object
 * @returns {Promise<{tenantId: string, userRole: string, authMethod: string, verifiedAt: string, sub: string}>}
 * @throws {PEPError} If verification fails
 */
async function verifyPEP(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    throw new PEPError('PEP_NO_TOKEN', 'Missing or malformed Authorization header.', 401);
  }

  const token = authHeader.split('Bearer ')[1];
  if (!token || token.length < 10) {
    throw new PEPError('PEP_EMPTY_TOKEN', 'Token is empty or too short.', 401);
  }

  let claims = null;
  const authMethod = 'FIREBASE_ADMIN';

  try {
    claims = await verifyWithFirebase(token);
    console.log(`[PEP_GATE] Firebase verification SUCCESS. uid=${claims.uid}`);
  } catch (fbErr) {
    console.error(`[PEP_GATE] Token verification FAILED. Firebase: ${fbErr.message}`);
    throw new PEPError(
      'PEP_AUTH_FAILURE',
      'Authentication failed. Firebase verification rejected the token.',
      401
    );
  }

  // ── Context Extraction ──
  // Firebase tokens: tenant_id in custom claims
  let tenantId = claims.tenant_id
    || claims.app_metadata?.tenant_id
    || claims.user_metadata?.tenant_id
    || null;

  // V5.5 Hardening: Removed anonymous 'rose_rocket' fallback. 
  // Strict tenant isolation enforced. No tenant_id claim = instant DENIED_UNAUTHORIZED.

  if (!tenantId) {
    throw new PEPError(
      'PEP_NO_TENANT',
      'Verified token does not contain a tenant_id claim. Access denied.',
      403
    );
  }

  const userRole = claims.role
    || claims.app_metadata?.role
    || claims.user_role
    || 'viewer';

  const context = {
    tenantId,
    userRole,
    authMethod,
    sub: claims.uid || 'unknown',
    verifiedAt: new Date().toISOString(),
  };

  // Inject into request for downstream consumption
  req.sentinelContext = context;
  return context;
}

module.exports = {
  verifyPEP,
  PEPError,
  // Exported for testing
  verifyWithFirebase,
};
