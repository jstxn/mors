# Homebrew Formula Notes

## Audit Caveat: License Exception

The `Formula/mors.rb` formula uses `license :cannot_represent` because the project is `UNLICENSED` in `package.json`. When running Homebrew audit commands, the `--except=license` flag is required to avoid false failures:

```bash
brew audit --new --except=license Formula/mors.rb
```

This is expected behavior for pre-release/private packages without a standard OSS license identifier.
