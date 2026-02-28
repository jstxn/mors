/**
 * Auth module barrel exports.
 *
 * Re-exports session, device-flow, and guard primitives for the mors auth lifecycle.
 */
export { saveSession, loadSession, clearSession, markAuthEnabled, isAuthEnabled, } from './session.js';
export { requestDeviceCode, pollForToken, fetchGitHubUser, validateAuthConfig, authConfigFromEnv, DeviceFlowError, AuthConfigError, TokenExpiredError, } from './device-flow.js';
export { requireAuth, verifyTokenLiveness, NotAuthenticatedError, TokenLivenessError, } from './guards.js';
//# sourceMappingURL=index.js.map