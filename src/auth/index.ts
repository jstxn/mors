/**
 * Auth module barrel exports.
 *
 * Re-exports session, device-flow, and guard primitives for the mors auth lifecycle.
 */

export {
  saveSession,
  loadSession,
  clearSession,
  markAuthEnabled,
  isAuthEnabled,
  type AuthSession,
} from './session.js';

export {
  requestDeviceCode,
  pollForToken,
  fetchGitHubUser,
  validateAuthConfig,
  authConfigFromEnv,
  DeviceFlowError,
  AuthConfigError,
  TokenExpiredError,
  type AuthConfig,
  type DeviceCodeResponse,
  type TokenResponse,
  type GitHubUser,
  type AuthConfigValidation,
  type PollOptions,
  type FetchUserOptions,
} from './device-flow.js';

export {
  requireAuth,
  verifyTokenLiveness,
  NotAuthenticatedError,
  TokenLivenessError,
  type TokenLivenessOptions,
  type TokenLivenessResult,
} from './guards.js';
