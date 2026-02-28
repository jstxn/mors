/**
 * Auth module barrel exports.
 *
 * Re-exports session and device-flow primitives for the mors auth lifecycle.
 */
export { saveSession, loadSession, clearSession, type AuthSession, } from './session.js';
export { requestDeviceCode, pollForToken, fetchGitHubUser, validateAuthConfig, authConfigFromEnv, DeviceFlowError, AuthConfigError, TokenExpiredError, type AuthConfig, type DeviceCodeResponse, type TokenResponse, type GitHubUser, type AuthConfigValidation, type PollOptions, type FetchUserOptions, } from './device-flow.js';
//# sourceMappingURL=index.d.ts.map