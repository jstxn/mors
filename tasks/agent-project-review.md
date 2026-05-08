# Agent Project Review

Date: 2026-05-08

## Scope

This review evaluates `mors` as an agent-facing communication project. It covers the local CLI, hosted relay, local encrypted store, E2EE flow, realtime watch, Maildir-style spool bridge, A2A discovery surface, tests, packaging, and deployment scaffolding.

The review is based on the current repository shape after the latest pushed fixes on `main`.

## Executive Summary

`mors` is unusually well-suited to autonomous and sandboxed agents for a beta project. The strongest pieces are deterministic CLI output, explicit `MORS_CONFIG_DIR` isolation, fail-closed encrypted local storage, relay identity derived from auth context, a host-owned spool bridge, and a large regression suite around auth, relay, E2EE, streaming, install paths, and spool behavior.

The main weaknesses are operational maturity rather than missing core intent. Several important files are too large and carry too many responsibilities, the relay persistence layer is a single JSON snapshot rather than a production datastore, the spool bridge still needs quotas and host policy controls, and the project depends on native SQLCipher bindings that can slow adoption in fresh agent environments.

The project is a strong fit for local engineering-session coordination, sandboxed agent message exchange, and low-volume hosted relay usage. It is not yet a strong fit for high-volume multi-tenant production relay hosting, regulated secret-heavy messaging through local spools, or full A2A task execution beyond Agent Card discovery.

## Strengths For Agents

### Deterministic CLI Contract

The README explicitly supports autonomous agents through `npx`, direct `node dist/index.js`, or global install without shell RC setup. It recommends `MORS_CONFIG_DIR` per agent and `--json` for deterministic output.

Relevant paths:

- `README.md`
- `src/cli.ts`
- `test/help-ux.test.ts`
- `test/readme-install-flow.test.ts`
- `test/install-agent-path.test.ts`

This matters because agents need copy-pasteable commands, predictable stdout, meaningful exit codes, and isolated config state. `mors` has those affordances in the first-use path rather than as afterthoughts.

### Local State Isolation

`MORS_CONFIG_DIR` gives each agent its own identity, database, session, offline queue, and E2EE key material. `mors init` bootstraps identity, SQLCipher storage, and device keys with explicit preflight checks and cleanup behavior.

Relevant paths:

- `src/init.ts`
- `src/identity.ts`
- `src/store.ts`
- `src/e2ee/device-keys.ts`
- `test/init.test.ts`
- `test/security.test.ts`

The local store fails closed when the SQLCipher key is missing or wrong, and the code does not fall back to plaintext storage. That is the right default for agent workspaces where transcripts and tool output may contain sensitive context.

### Strong Message Semantics

The message contract separates read state from ack state, supports threads and replies, validates prefixed IDs, and uses dedupe keys for idempotent send and reply flows.

Relevant paths:

- `src/contract/envelope.ts`
- `src/contract/ids.ts`
- `src/contract/states.ts`
- `src/message.ts`
- `src/relay/message-store.ts`
- `test/message.test.ts`
- `test/thread.test.ts`
- `test/relay/thread-dedupe.test.ts`

This is agent-friendly because read and acknowledgement are not the same action. An agent can inspect a task, defer it, then later ack completion without losing the original lifecycle signal.

### Relay Identity Is Server-Derived

The relay derives sender identity from authenticated principals instead of trusting client payload authority fields. The spool bridge similarly rejects sender authority fields in JSON files.

Relevant paths:

- `src/relay/auth-middleware.ts`
- `src/relay/server.ts`
- `src/relay/message-store.ts`
- `src/spool/bridge.ts`
- `test/relay/spoof-prevention.test.ts`
- `test/auth/relay-guards.test.ts`
- `test/spool/bridge.test.ts`

This closes the most obvious agent spoofing failure mode: a sandboxed worker cannot claim to be another actor by editing the message body.

### Host-Owned Spool Boundary

The Maildir-style spool bridge matches the investigation artifact in `tasks/maildir-perkeep-agent-communication.md`. Isolated agents write JSON commands into per-agent outbox or control folders, while a host-owned bridge holds relay credentials, validates entries, sends messages, and materializes inbound relay messages.

Relevant paths:

- `tasks/maildir-perkeep-agent-communication.md`
- `src/spool/maildir.ts`
- `src/spool/bridge.ts`
- `src/spool/cli.ts`
- `test/spool/maildir.test.ts`
- `test/spool/bridge.test.ts`

Useful safeguards are already present:

- owner-only directory and file modes for created spool paths
- filename validation that blocks path traversal and null bytes
- regular-file checks before JSON parsing
- maximum entry size checks
- invalid JSON and invalid schema files moved to failed state
- sender authority fields rejected
- read and ack modeled through `control`, not Maildir flags

This gives agents a simple filesystem protocol without handing each sandbox direct relay credentials.

### Realtime And Offline Behavior

The project supports local watch polling, remote SSE watch, cursor resume, degraded fallback, relay event logs, and a durable offline queue in the relay client.

Relevant paths:

- `src/watch.ts`
- `src/remote-watch.ts`
- `src/relay/client.ts`
- `src/relay/message-store.ts`
- `test/watch.test.ts`
- `test/stream/resume-dedupe.test.ts`
- `test/stream/auth-fallback.test.ts`
- `test/relay/offline-retry.test.ts`
- `test/relay/client-durability.test.ts`

Agents benefit from both polling-friendly and event-driven modes. The explicit fallback state is also useful because an agent can detect degraded realtime behavior instead of silently assuming a stream is live.

### E2EE Building Blocks

The E2EE flow has device bootstrap, X25519 key exchange, AES-256-GCM payload encryption, device bundle publication, automatic peer bundle session establishment, rekey rotation, and stale-key errors.

Relevant paths:

- `src/e2ee/device-keys.ts`
- `src/e2ee/key-exchange.ts`
- `src/e2ee/cipher.ts`
- `src/e2ee/auto-session.ts`
- `src/start.ts`
- `test/e2ee/cipher-runtime.test.ts`
- `test/e2ee/key-exchange.test.ts`
- `test/e2ee/auto-session.test.ts`
- `test/e2ee/rekey-rotation.test.ts`

The implementation rejects self-exchange, invalid X25519 key sizes, all-zero public keys, revoked devices, and group or channel E2EE attempts. That scope discipline is a strength.

### First-Contact Policy

Contacts separate delivery from autonomy. A message can arrive before a relationship is fully trusted, but autonomy is allowed only when a contact is approved.

Relevant paths:

- `src/relay/contact-store.ts`
- `src/relay/server.ts`
- `src/start.ts`
- `test/relay/first-contact-policy.test.ts`
- `test/relay/hosted-signup-contacts.test.ts`

That is a good model for agents because receiving an unsolicited message should not automatically authorize tool execution, follow-up actions, or elevated trust.

### Test Coverage Is Broad

The test tree covers auth, hosted setup, local messaging, relay semantics, stream behavior, spool validation, E2EE, deployment preflight, installation, and README flows.

Current local inventory:

- 49 TypeScript source files
- 65 `*.test.ts` files, plus helpers and global setup
- about 17,477 source lines
- about 35,594 test lines

Verification during this review pass:

- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npm run test -- --maxConcurrency=7`, 65 test files and 1360 tests passed
- `git diff --check`

This gives future agents a useful regression base before they refactor or extend behavior.

### Practical Packaging And Deployment Paths

The repo includes npm package metadata, a Homebrew formula, Dockerfile, Fly.io config, deploy preflight checks, and hosted relay bootstrap.

Relevant paths:

- `package.json`
- `Formula/mors.rb`
- `Dockerfile`
- `fly.toml`
- `src/deploy.ts`
- `src/relay/bootstrap.ts`
- `src/relay/persistence.ts`
- `test/deploy/fly.test.ts`
- `test/deploy/shell-injection-safety.test.ts`

The deploy preflight avoids shell injection by using argv-based `execFileSync`, redacts known secrets in output, and rejects placeholder config before attempting deploy.

## Weaknesses And Risks For Agents

### Native SQLCipher Dependency

Local use depends on `better-sqlite3-multiple-ciphers` and a working SQLCipher environment. The docs call this out, but native dependency setup can still be brittle in short-lived agent containers, CI sandboxes, and clean VMs.

Impact:

- first-use friction for agents in minimal images
- install failures can block local-only messaging
- rebuild behavior can vary by platform

Mitigation direction:

- keep the existing `doctor` guidance sharp
- maintain disposable install tests
- consider a documented container image for agent workers

### Large, Multi-Concern Files

Several source files are past the preferred 1000-line boundary:

- `src/cli.ts`: 3,690 lines
- `src/start.ts`: 1,669 lines
- `src/relay/server.ts`: 1,438 lines

These files contain many command handlers, UI flows, route handlers, validation branches, and formatting paths. They are heavily tested, but they are harder for future agents to modify safely because unrelated behavior is nearby.

Mitigation direction:

- split `src/cli.ts` by command group
- split `src/start.ts` into hosted setup, contact UI, inbox UI, and composer modules
- split `src/relay/server.ts` into route modules backed by shared request helpers
- move behavior only behind existing tests, not as a broad style cleanup

### Relay Persistence Is Not Production-Grade Storage

Relay state can persist through a JSON snapshot file, but it is still a single-process, file-backed snapshot model. It is useful for restart rehydration and small hosted deployments, but not enough for high-volume or multi-instance relay use.

Relevant paths:

- `src/relay/persistence.ts`
- `src/relay/bootstrap.ts`
- `fly.toml`
- `test/relay/persistence.test.ts`
- `test/relay/message-store-persistence.test.ts`

Risks:

- no database-level concurrency control
- no append-only durability log
- no retention or compaction policy beyond full snapshot rewrite
- no clear multi-machine coordination model

Also, `src/relay/message-store.ts` still has a header comment describing an in-memory phase and future persistence, while file-backed persistence now exists. That doc drift can mislead future agents.

### Spool Needs Quotas And Host Policy Controls

The spool bridge implements the V1 shape, but the investigation artifact explicitly says quotas are required and hook execution must remain a host policy decision. Those controls are not yet visible as full runtime policy features.

Relevant paths:

- `tasks/maildir-perkeep-agent-communication.md`
- `src/spool/maildir.ts`
- `src/spool/bridge.ts`
- `src/spool/types.ts`

Remaining risks:

- one agent can create many files until filesystem limits are hit
- plaintext spool bodies are sensitive on the host filesystem
- no persisted bridge state for retry schedule, dead-letter policy, or backpressure
- tool request fields are parsed, but there is no host allowlist or hook runner policy layer
- access control still depends on how the host mounts or exposes per-agent folders

Mitigation direction:

- add per-agent file count and byte quotas
- document spool mount permissions for common VM and sandbox modes
- add a host policy file for allowed tool names and max payload sizes
- keep tool execution outside the bridge until policy is explicit

### Hosted Relay Operations Are Still Young

The hosted path is convenient, but operations maturity is limited. The Fly config defaults to zero minimum machines and a local state file path unless a volume is mounted. The project has preflight checks, but not a complete runbook for state migration, backup, restore, or incident recovery.

Relevant paths:

- `fly.toml`
- `src/deploy.ts`
- `src/relay/bootstrap.ts`
- `src/relay/persistence.ts`
- `ONBOARDING.md`

Impact:

- agents may see cold-start latency
- state durability depends on correct deployment configuration
- operators need to know when JSON state is enough and when it is not

### E2EE Trust Is Better Than The UX Explains

The cryptographic building blocks are solid for the current scope, but the trust model is still subtle. Automatic session establishment from relay-published peer bundles is convenient, yet it is trust-on-first-use unless users or agents verify fingerprints through an independent channel.

Relevant paths:

- `src/e2ee/auto-session.ts`
- `src/e2ee/key-exchange.ts`
- `src/start.ts`
- `README.md`

Impact:

- agents can encrypt payloads, but may not understand what trust has been established
- fingerprint verification and device revocation deserve clearer agent-facing guidance
- group or channel E2EE is intentionally unsupported, which should stay explicit in CLI output

### A2A Support Is Discovery-Focused

The relay serves A2A Agent Cards, including handle-specific cards and a relay fallback card. That helps external systems discover agents, but the core project is still a messaging system, not a full A2A task execution runtime.

Relevant paths:

- `src/relay/server.ts`
- `test/relay/agent-card.test.ts`
- `README.md`

Impact:

- external systems can discover capabilities
- task execution, tool-result policy, and richer A2A flows still need product decisions
- the spool bridge is closer to the actual execution boundary than the Agent Card endpoint

### Observability Is Minimal

The project has trace IDs and clear CLI errors, but limited operational observability. There are no structured relay metrics, health detail endpoints, queue depth gauges, spool backlog metrics, or persistence save failure counters.

Relevant paths:

- `src/relay/server.ts`
- `src/relay/client.ts`
- `src/spool/bridge.ts`
- `src/deploy.ts`

Impact:

- agents can react to command errors
- operators have less visibility into relay health and spool pressure
- debugging production hosted issues may require logs and local reproduction

### Docs Are Good But Some Internal Comments Drifted

The public docs are practical and agent-aware. The weak spot is internal comment drift, especially in relay persistence comments that still describe future persistence even though JSON snapshot persistence exists.

Relevant paths:

- `src/relay/message-store.ts`
- `src/relay/bootstrap.ts`
- `src/relay/persistence.ts`

Impact:

- future agents may make incorrect assumptions from stale file headers
- comments should describe the current storage model, not the previous milestone

## Best Fit

`mors` is a strong fit for:

- local autonomous agent coordination
- sandboxed or VM-isolated engineering workers
- CLI-first async messaging
- human-agent messaging with explicit read and ack state
- low-volume hosted relay usage
- testing agent communication contracts before building heavier orchestration

## Poor Fit For Now

`mors` is not yet a strong fit for:

- high-volume multi-tenant relay hosting
- multi-region active-active relay deployment
- regulated data retention or archival requirements
- direct arbitrary tool execution from received messages
- secret-heavy local spool payloads without host filesystem controls
- full A2A task lifecycle orchestration beyond discovery

## Recommended Next Work

1. Add spool quotas and a host policy file before expanding tool request behavior.
2. Split `src/cli.ts`, `src/start.ts`, and `src/relay/server.ts` along existing tested boundaries.
3. Update relay persistence comments to match the current JSON snapshot implementation.
4. Add relay and spool operational metrics: queue depth, event backlog, persistence saves, failed spool entries, and SSE connection count.
5. Document a recommended container or VM image for agent workers with Node 20 and SQLCipher preinstalled.
6. Add a production relay storage plan before marketing hosted use beyond low-volume beta deployments.
7. Clarify E2EE trust guidance for agents, especially fingerprint verification, automatic peer bundles, and device revocation.

## Agent Modification Guidance

Future agents should treat these areas as protected behavior:

- read and ack remain separate lifecycle transitions
- sender identity must come from auth context, not payload fields
- local storage must fail closed when encryption setup fails
- spool entries must not gain authority over sender identity
- first-contact delivery must not imply autonomy approval
- E2EE group and channel behavior remains explicitly unsupported until designed

When modifying this project, start from the targeted tests for the touched subsystem, then run the full gates before publishing:

```sh
npm run build
npm run typecheck
npm run lint
npm run test -- --maxConcurrency=7
git diff --check
```
