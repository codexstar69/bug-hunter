#!/usr/bin/env bash
# Initialize git repo inside test-fixture for fix-mode testing.
# Run this before using --fix on the test fixture.
# The source files ship with the repo; this just creates the .git.

set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "$0")/../test-fixture" && pwd)"

if [ -d "$FIXTURE_DIR/.git" ]; then
  echo "test-fixture/.git already exists — skipping init"
  exit 0
fi

cd "$FIXTURE_DIR"
git init
git add -A
git commit -m "initial commit: test fixture with planted bugs"
echo "test-fixture git repo initialized at $FIXTURE_DIR"
