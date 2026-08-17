# Measurable world-class Bug Hunter protocol

Bug Hunter treats “world-class” as a measurable engineering target, not a permanent label. The protocol couples precision-first scanning with hidden-label evaluation, adaptive execution, deterministic retrieval, content-addressed evidence reuse, and bounded hybrid verification.

## Quality objective

The optimization target is verified bug yield under explicit cost and risk constraints. A benchmark report measures:

- precision, recall, F1, and severity-weighted recall;
- severity accuracy and mean severity error;
- Brier score and expected calibration error for confidence;
- repeated-run Jaccard stability;
- token and monetary cost per true positive;
- median and p95 latency;
- scanned-file coverage and false positives per KLOC;
- recall by category and severity.

The public corpus manifest contains only repository shape, language, category, and size metadata. Private labels contain the expected defects and are bound to the public manifest by SHA-256. `validate-public` rejects label-like keys, leaked paths or keywords, and digest mismatches.

```bash
node scripts/benchmark-suite.cjs validate-public \
  --manifest evals/benchmark/public-manifest.json

node scripts/benchmark-suite.cjs score \
  --manifest evals/benchmark/public-manifest.json \
  --labels evals/benchmark/private-labels.json \
  --runs evals/benchmark/golden-runs.json \
  --output .bug-hunter/benchmark-report.json
```

Private benchmark labels must not be published for a real hidden evaluation corpus. The repository fixture is deterministic calibration data for CI and demonstrates the contract, not an independent external ranking.

## Adaptive execution profiles

`adaptive-policy.cjs` converts deterministic triage and historical benchmark metrics into a canonical plan.

- **fast** prioritizes PR latency and low token cost, using narrow retrieval and one adversarial review layer.
- **balanced** is the default Pareto point, expanding uncertain areas and requiring targeted verification for high-impact findings.
- **assurance** maximizes recall and verification depth for release, security, or high-risk audits.
- **auto** selects among these profiles from risk density, repository size, security intent, precision, recall, calibration, and stability.

Explicit CLI settings still take precedence. Adaptive values are fallbacks and are persisted in `adaptive-plan.json` so a run can be reproduced.

```bash
node scripts/adaptive-policy.cjs plan \
  --triage .bug-hunter/triage.json \
  --benchmark .bug-hunter/benchmark-report.json \
  --profile auto \
  --security true \
  --output .bug-hunter/adaptive-plan.json
```

## Hypothesis-directed retrieval

`retrieval-planner.cjs` starts from named hypotheses, mandatory files, referenced symbols, trust boundaries, dependencies, and dependents. Direct evidence is selected first. Graph context is admitted only while hard file and source-token budgets remain available. Every selected item records why it was chosen and which symbol slices are relevant.

```bash
node scripts/retrieval-planner.cjs plan \
  --index .bug-hunter/index.json \
  --hypotheses .bug-hunter/hypotheses.json \
  --max-tokens 12000 \
  --max-files 8 \
  --output .bug-hunter/retrieval-plan.json
```

## Content-addressed evidence cache

Evidence cache keys include protocol version, role, hypothesis identity, effective options, exact source content hashes, and optional index identity. Cache entries are atomic, TTL-bounded, size-bounded, and never substitute for current source-integrity checks. A hit supplies reusable fact context; the worker result and source hashes are still validated before a chunk is committed.

## Hybrid verification

`hybrid-verifier.cjs` runs compiler, type-checker, test, static-analysis, build, reproduction, or fuzz commands as inert argument arrays with `shell: false`. Every command has repository containment, timeout, output, and total-budget limits. Missing or failing required checks make the verification report fail closed.

```bash
node scripts/hybrid-verifier.cjs run \
  --repo-root . \
  --plan .bug-hunter/verification-plan.json \
  --output .bug-hunter/verification-report.json
```

Findings may list verification check IDs. The report maps those checks back to each finding without treating tool success as proof of absence. A compiler can disprove a type claim; a passing unit suite cannot prove a security boundary safe.

## Runner integration

The core runner accepts:

```text
--triage-path <triage.json>
--benchmark-report <benchmark-report.json>
--adaptive-profile <auto|fast|balanced|assurance>
--adaptive-plan-path <adaptive-plan.json>
--verification-plan <verification-plan.json>
--verification-report <verification-report.json>
--verification-required <true|false>
--verification-total-budget-ms <milliseconds>
--evidence-cache <directory>
```

Adaptive settings never override explicit chunk, token, confidence, or expansion options. Verification runs after all chunks have current evidence and before fix authorization. Required verification failure prevents Fixer planning. Default invocations without these options retain the existing precision-first behavior.

## Operating discipline

A green regression suite proves implemented invariants. It does not prove global superiority. Use unseen repositories, blinded labels, repeated runs, and relevant baseline scanners for external claims. Publish the benchmark configuration, confidence intervals, corpus exclusions, model/runtime versions, and cost assumptions alongside any comparison.
