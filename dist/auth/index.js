/**
 * Auth module barrel exports.
 *
 * Re-exports session, native auth, and guard primitives for the mors auth lifecycle.
 */
export { saveSession, loadSession, clearSession, markAuthEnabled, isAuthEnabled, saveSigningKey, loadSigningKey, saveProfile, loadProfile, } from './session.js';
export { validateInviteToken, generateInviteToken, generateSessionToken, verifySessionToken, generateSigningKey, InvalidInviteTokenError, DeviceKeyNotBootstrappedError, NativeAuthPrerequisiteError, } from './native.js';
export { requireAuth, verifyTokenLiveness, NotAuthenticatedError, TokenLivenessError, } from './guards.js';
//# sourceMappingURL=index.js.map