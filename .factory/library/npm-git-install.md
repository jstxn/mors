# npm Git-Install Behavior

## Problem: `npm i -g github:user/repo` and devDependencies

When installing from a GitHub shortcut (`npm i -g github:jstxn/mors`), npm **does** run the `prepare` lifecycle script, but it installs `devDependencies` only transiently. The `prepare` script runs **after** `devDependencies` are installed, but in certain npm versions there is unreliable behavior around whether `devDependencies` binaries (like `tsc`) are available in the prepare step.

Related: [npm CLI issue #8440](https://github.com/npm/cli/issues/8440)

## Current Workaround

1. **Pre-built dist committed to repo**: The `dist/` directory is checked into version control so that global GitHub installs can use the pre-built artifacts directly.
2. **Conditional prepare script**: `"prepare": "test -x node_modules/.bin/tsc && npm run build || true"` — skips build when `tsc` is unavailable (GitHub install path) and attempts build when it is available (local dev path).

## Known Limitation

The `|| true` in the prepare script also swallows real `npm run build` failures when `tsc` IS present. This means a broken build in a development environment could silently succeed at the prepare step. Mitigated by:
- `npm run typecheck` and `npm run build` as separate CI hard gates
- `npm run test` suite includes install validation tests
