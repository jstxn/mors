/**
 * Auth module barrel exports.
 *
 * Re-exports session, native auth, and guard primitives for the mors auth lifecycle.
 */
export { saveSession, loadSession, clearSession, markAuthEnabled, isAuthEnabled, saveSigningKey, loadSigningKey, saveProfile, loadProfile, type AuthSession, type AccountProfileLocal, } from './session.js';
export { validateInviteToken, generateInviteToken, generateSessionToken, verifySessionToken, generateSigningKey, InvalidInviteTokenError, DeviceKeyNotBootstrappedError, NativeAuthPrerequisiteError, type InviteValidationResult, type SessionTokenOptions, type SessionTokenPayload, } from './native.js';
export { requireAuth, verifyTokenLiveness, NotAuthenticatedError, TokenLivenessError, type TokenLivenessOptions, type TokenLivenessResult, } from './guards.js';
//# sourceMappingURL=index.d.ts.map