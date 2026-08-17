#!/usr/bin/env bash
set -euo pipefail

required_files=(
  scripts/benchmark-suite.cjs
  scripts/adaptive-policy.cjs
  scripts/hybrid-verifier.cjs
  scripts/evidence-cache.cjs
  scripts/retrieval-planner.cjs
  scripts/tests/world-class-protocol.test.cjs
  docs/world-class-protocol.md
  schemas/benchmark-report.schema.json
  schemas/adaptive-plan.schema.json
  schemas/verification-report.schema.json
  schemas/retrieval-plan.schema.json
  evals/benchmark/public-manifest.json
  evals/benchmark/private-labels.json
  evals/benchmark/golden-runs.json
  evals/benchmark/triage-sample.json
  evals/benchmark/verification-plan.json
  evals/benchmark/index-sample.json
  evals/benchmark/hypotheses-sample.json
)

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "ASSERTION FAILED: required world-class protocol file is missing: $file" >&2
    exit 1
  fi
done

pnpm check:generated
pnpm test

rm -rf .bug-hunter/world-class-check
mkdir -p .bug-hunter/world-class-check

node scripts/benchmark-suite.cjs validate-public \
  --manifest evals/benchmark/public-manifest.json
node scripts/benchmark-suite.cjs score \
  --manifest evals/benchmark/public-manifest.json \
  --labels evals/benchmark/private-labels.json \
  --runs evals/benchmark/golden-runs.json \
  --output .bug-hunter/world-class-check/benchmark-report.json
node scripts/schema-validate.cjs benchmark-report \
  .bug-hunter/world-class-check/benchmark-report.json

node scripts/adaptive-policy.cjs plan \
  --triage evals/benchmark/triage-sample.json \
  --benchmark .bug-hunter/world-class-check/benchmark-report.json \
  --profile auto \
  --security true \
  --output .bug-hunter/world-class-check/adaptive-plan.json
node scripts/schema-validate.cjs adaptive-plan \
  .bug-hunter/world-class-check/adaptive-plan.json

node scripts/hybrid-verifier.cjs run \
  --repo-root . \
  --plan evals/benchmark/verification-plan.json \
  --output .bug-hunter/world-class-check/verification-report.json
node scripts/schema-validate.cjs verification-report \
  .bug-hunter/world-class-check/verification-report.json

node scripts/retrieval-planner.cjs plan \
  --index evals/benchmark/index-sample.json \
  --hypotheses evals/benchmark/hypotheses-sample.json \
  --max-tokens 12000 \
  --max-files 5 \
  --output .bug-hunter/world-class-check/retrieval-plan.json
node scripts/schema-validate.cjs retrieval-plan \
  .bug-hunter/world-class-check/retrieval-plan.json

node scripts/run-bug-hunter.cjs preflight --skill-dir .
pnpm verify:package

echo "LOOP CHECK PASSED: benchmark quality, adaptive policy, hybrid verification, content-addressed evidence reuse, retrieval planning, schemas, tests, preflight, and package inventory are valid."
