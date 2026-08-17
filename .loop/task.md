# Task: measurable world-class Bug Hunter protocol

Implement the complete next-stage Bug Hunter architecture so quality claims are backed by repeatable evidence rather than opinion. The implementation must measure real bug yield, false positives, stability, severity calibration, token cost, latency, coverage, and verification outcomes while preserving the precision-first fail-closed guarantees already completed.

## Done criterion

The task is done only when the sealed `.loop/check.sh` exits 0 after all of the following are true:

1. A hidden-label benchmark harness computes per-run and aggregate precision, recall, F1, severity-weighted recall, calibration, stability, token efficiency, latency, coverage, and false positives per KLOC.
2. Public benchmark metadata is mechanically checked for label leakage and cryptographically bound to private labels.
3. Adaptive fast, balanced, and assurance profiles convert triage and historical benchmark evidence into bounded budgets, reviewer depth, early stopping, verification, and reasoning policies.
4. Hybrid verification executes compiler, test, static-analysis, build, or fuzz checks through inert argv arrays with repository containment, time and output budgets, and required-check fail-closed behavior.
5. Content-addressed evidence caching reuses facts only for an exact protocol, hypothesis, option, and source-content identity.
6. Symbol- and dependency-aware retrieval planning prioritizes named hypotheses under a hard context budget.
7. The core runner accepts adaptive plans, hybrid verification plans, evidence-cache configuration, and emits validated artifacts without weakening default compatibility.
8. Canonical schemas, package inventory, documentation, tests, deterministic benchmark fixtures, generated validators, preflight, and CI all pass.
9. The existing precision-first loop state is preserved unchanged under `.loop-history/precision-first-2026-08-17/`.

## Sealed check

SHA-256: `51f16f795feecfbe7896d51da3684c7da09777984b1c81c2323136fb14ca18ee`

This file and `.loop/check.sh` are immutable after setup.
