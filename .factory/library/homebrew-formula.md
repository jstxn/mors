# Homebrew Formula Notes

## Audit Caveat: License Exception

The `Formula/mors.rb` formula uses `license :cannot_represent` because the project is `UNLICENSED` in `package.json`. When running Homebrew audit commands, the `--except=license` flag is required to avoid false failures:

```bash
brew audit --new --except=license Formula/mors.rb
```

This is expected behavior for pre-release/private packages without a standard OSS license identifier.

## Runtime Validation Path

The install-matrix tests (`test/install-matrix.test.ts`) are split into two categories:

### Static formula validation
Regex/string checks on `Formula/mors.rb` file content. These verify formula structure (class name, dependencies, install stanza, metadata) but do NOT prove that `brew install` produces a runnable binary. These are grouped under the `"Homebrew static formula validation"` describe block.

### Runtime executable proof
Actual execution-based tests that verify `mors --version` succeeds, `brew` can parse the formula, and the full post-install flow (init → inbox) works. These are grouped under the `"Homebrew runtime executable proof"` describe block.

### Manual runtime verification steps

To reproduce the Homebrew runtime proof locally:

```bash
# 1. Verify brew can parse the formula
brew ruby -e "require '$(pwd)/Formula/mors.rb'; puts Mors.name"
# Expected: "Mors"

# 2. Verify mors --version (same command formula test stanza runs)
node dist/index.js --version
# Expected: "mors 0.1.0"

# 3. Verify end-to-end first-run flow in isolated config dir
TESTDIR=$(mktemp -d)/mors-brew-proof
MORS_CONFIG_DIR="$TESTDIR" node dist/index.js init --json
MORS_CONFIG_DIR="$TESTDIR" node dist/index.js inbox --json
rm -rf "$TESTDIR"
```

The `brew ruby` command confirms Homebrew can load and parse the formula Ruby class. The CLI execution commands confirm the binary the formula installs (via `bin.install_symlink`) would be functional.
