#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "node is required"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for native module builds"
  exit 1
fi

if ! command -v sqlcipher >/dev/null 2>&1; then
  echo "sqlcipher is required. Install with: brew install sqlcipher"
  exit 1
fi

if [ -f package.json ]; then
  npm install
fi
