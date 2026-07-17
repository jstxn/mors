# mors hardening pass — 2026-07-17

Refactor / upgrade / harden pass over a stale-but-healthy beta. Baseline was green
(1397 tests); after this pass the suite is green at 1372 (dead-code tests removed,
security/correlation tests added). Build, typecheck, and lint are clean.

## Upgrades & packaging

- Bumped `vitest` 4.0.18 → 4.1.10 (clears the critical Vitest UI advisory
  GHSA-5xrq-8626-4rwp), `eslint` → 10.7, `typescript-eslint` → 8.64,
  `@types/node` → ^25.9. `npm audit` now reports **0 vulnerabilities** (was 7).
- Upgraded `better-sqlite3-multiple-ciphers` 11.10 → 12.11 (maintained line, Node
  25/26 prebuilds). Native rebuild verified on Node 24; store/security tests pass.
- Held `typescript` at 5.9 (TS7 is a native rewrite; ts-eslint support is not settled).
- `package.json`: added `repository`, `bugs`, `homepage`, `author`, `keywords`,
  a sharper `description`, and a `test:coverage` script. Added `@vitest/coverage-v8`
  and a vitest coverage config (thresholds intentionally not enforced yet).
- Version is single-sourced from `package.json` via `src/version.ts` (was hardcoded
  as `0.1.0` in cli.ts, init.ts, and the Agent Card).
- Added GitHub Actions CI (`.github/workflows/ci.yml`): build + lint + typecheck +
  test on Node 20/22/24, plus a high/critical `npm audit` gate. There was no CI.
- **Homebrew formula was fetching an unrelated npm package.** `Formula/mors.rb`
  pointed `url` at `registry.npmjs.org/mors/-/mors-0.1.0.tgz`, but the npm name
  `mors` belongs to a different project — the README's `brew install` installed
  that stranger's package. Repointed to the GitHub source tarball + a `head`
  stanza; three tests that pinned the wrong URL were corrected.

## Security hardening

- **C1/C2 — E2EE key trust (relay MITM).** Ed25519 keys were published but never
  used, key exchange was unauthenticated, and any bundle key change silently
  re-keyed. `ensureSessionFromPeerBundle` now (a) verifies a bundle's fingerprint
  is an honest hash of its own keys and (b) pins the peer key on first use and
  **refuses a later key change** (`PeerIdentityChangedError`) unless an explicit
  `allowKeyChange` override is passed after out-of-band re-verification.
- **H1 — silent plaintext downgrade.** The `mors start` send path silently sent
  plaintext to contacts without a published bundle. It now surfaces an explicit
  "WITHOUT encryption" warning and catches identity-change errors instead of
  failing open silently. (The CLI `send --remote` path already fails closed.)
- **H2 — token expiry.** Session tokens had no expiry and logout never revoked.
  Tokens now carry `expiresAt` (default 30 days, configurable), enforced in
  `verifySessionToken` and therefore at the relay verifier.
- **M1 — request-body DoS.** `readJsonBody` now caps buffering at 1 MiB so an
  oversized POST to public `/auth/signup` cannot exhaust the relay heap.
- **M2 — rate limiting.** Public relay routes are rate-limited per client
  (fixed window, default 60/60s, configurable via `publicRateLimit`).
- **M4 — relay ran as root.** Added `USER node` to the relay Dockerfile.
- **L1 — timing safety.** Replaced hand-rolled HMAC byte comparisons with
  `crypto.timingSafeEqual`.

## Cleanup / correctness

- Removed dead subsystems: `src/adapters/*` (Phase-2 stub, no importer) and
  `src/auth/device-flow.ts` (unused GitHub OAuth device flow), plus the
  `createGitHubTokenVerifier` stub and stale GitHub config in `relay/config.ts`
  and `.env.example`. ~700 LOC removed. GitHub keys are retained in the deploy
  redaction denylist as defense-in-depth.
- Fixed the stale `relay/message-store.ts` header comment that claimed messages
  were not persisted (they are snapshotted via `persistence.ts`).
- `noImplicitOverride` enabled in tsconfig.

## Orchestrator enablement

- **`trace_id` now propagates end-to-end through the relay** (store, server,
  client, and CLI send/reply). It was parsed by the CLI and referenced in output
  but silently dropped at the relay boundary. An orchestrator can now tag a
  suggestion and correlate the worker's reply across the relay. See the
  "Message Correlation For Orchestration" section in docs/technical-overview.md.

## Deferred (recommended follow-ups)

- **C1-full / H3 — asymmetric auth.** The strongest fixes require the relay to
  sign device bundles / tokens with a private key that clients verify with a
  public key. Native self-hosted mode still shares one HMAC signing key across
  clients, so any key-holder can mint tokens for any account. Continuity pinning
  blocks the practical relay-MITM of an established peer; asymmetric tokens would
  close the self-hosted impersonation gap.
- **M3 — forward secrecy.** The X25519 shared secret is static (no ratchet) and
  stored in plaintext (0o600) alongside device private keys. A double-ratchet and
  OS-keychain-wrapped key storage are the next step.
- **Strictness:** `noUncheckedIndexedAccess` (~386 sites) and
  `exactOptionalPropertyTypes` (~76 sites) are high-churn; enable incrementally.
  `eslint strictTypeChecked` (`no-floating-promises`) would flag the intentional
  fire-and-forget `.then/.catch` dispatch in cli.ts.
- **File size:** cli.ts (3.7k), start.ts (1.7k), relay/server.ts (1.5k) remain
  large; split along the tested boundaries noted in agent-project-review.md.
- **Committed `dist/`:** the git-based install paths (`npx github:`, brew) depend
  on committed build artifacts + the `prepare` guard. Moving to release tarballs
  would remove 200+ tracked artifacts but requires a release process first.
