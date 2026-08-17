# Task: precision-first Bug Hunter optimization

Improve Bug Hunter so it catches real behavioral and security bugs with less wasted context, faster deterministic scoping, and stricter evidence validation.

## Done criterion

The task is done only when the sealed `.loop/check.sh` exits 0 after all of the following are true:

1. Source-language discovery is centralized so triage and code-index cannot silently drift.
2. Risk-prioritized input order survives state initialization and delta expansion.
3. Worker chunk sizing adapts to a bounded source-token budget unless the caller explicitly overrides it.
4. Missing files fail the scan closed instead of being reported as completed coverage.
5. Security findings require concrete STRIDE/CWE evidence and non-empty cross-references.
6. Skeptic guidance no longer auto-dismisses exploitable authentication or abuse-rate-limit failures.
7. Calibration examples load only when useful instead of on every chunk.
8. Regression tests, generated validators, preflight, and package inventory all pass.

## Sealed check

SHA-256: `6076d770c0ef7af821af66ac0a9559225fd4bea4bec9442cbf6352cd11091f0a`

This file and `.loop/check.sh` are immutable after setup.
