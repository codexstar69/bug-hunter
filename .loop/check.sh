#!/usr/bin/env bash
set -euo pipefail

required_files=(
  scripts/source-config.cjs
  scripts/tests/precision-protocol.test.cjs
  docs/precision-protocol.md
)

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "ASSERTION FAILED: required precision-protocol file is missing: $file" >&2
    exit 1
  fi
done

pnpm check:generated
pnpm test
node scripts/run-bug-hunter.cjs preflight --skill-dir .
pnpm verify:package

echo "LOOP CHECK PASSED: precision protocol, generated assets, tests, preflight, and package inventory are valid."
