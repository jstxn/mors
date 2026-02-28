# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** required env vars, SQLCipher/toolchain dependencies, local setup caveats.
**What does NOT belong here:** service ports/commands (use `.factory/services.yaml`).

---

## Current baseline

- Runtime: Node.js + npm
- Native build dependencies: `python3`, compiler toolchain (Xcode CLI tools on macOS)
- Encryption dependency: `sqlcipher` CLI/library must be installed and linkable
- Mission requires SQLCipher-first behavior (no plaintext fallback)
