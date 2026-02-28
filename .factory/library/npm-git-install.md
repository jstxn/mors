# npm Git-Install Behavior

## Problem: `npm i -g github:user/repo` and devDependencies

When installing from a GitHub shortcut (`npm i -g github:jstxn/mors`), npm **does** run the `prepare` lifecycle script, but it installs `devDependencies` only transiently. The `prepare` script runs **after** `devDependencies` are installed, but in certain npm versions there is unreliable behavior around whether `devDependencies` binaries (like `tsc`) are available in the prepare step.

Related: [npm CLI issue #8440](https://github.com/npm/cli/issues/8440)

## Current Solution

1. **Pre-built dist committed to repo**: The `dist/` directory is checked into version control so that global GitHub installs can use the pre-built artifacts directly.
2. **Conditional prepare script with explicit tsc path**: `"prepare": "if test -x node_modules/.bin/tsc; then node_modules/.bin/tsc -p tsconfig.build.json; fi"` — skips build when `tsc` is unavailable (GitHub install path) and runs build with full error propagation when it is available (local dev path). Real build failures are NOT swallowed.

### Why explicit path instead of `npm run build`?

In nested npm global git-dependency contexts (`npm i -g github:jstxn/mors`), npm clones the repo to a temp dir and runs `npm install --include=dev` + `prepare`. Even though `node_modules/.bin/tsc` exists after devDep install, the shell `PATH` during the prepare script does NOT reliably include `node_modules/.bin/`. Using `npm run build` (which invokes bare `tsc`) fails with `sh: tsc: command not found` (exit 127). By invoking `node_modules/.bin/tsc` directly, we bypass the broken PATH resolution in the nested npm context.
