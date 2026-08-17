# Journal

## Iteration 0 — repository audit — complete

Reviewed the orchestration scripts, schemas, role skills, tests, CI, and package inventory. Confirmed four correctness defects and two efficiency/protocol gaps:

- `bug-hunter-state.cjs` alphabetically sorts caller-provided files, discarding triage risk order.
- `code-index.cjs` supports fewer source extensions than `triage.cjs`, weakening delta scope for supported languages.
- `chunk-scheduler.cjs` ignores missing files and can mark a chunk done without scanning its assigned scope.
- `findings.schema.json` does not enforce non-empty cross-references or security STRIDE/CWE evidence.
- `run-bug-hunter.cjs` uses a fixed default chunk count rather than a source-token budget.
- Skeptic hard-excludes every rate-limit finding while Hunter explicitly searches for exploitable auth-rate-limit failures.

## Iteration 1 — loop setup — expected failing gate

Created the sealed completion check. On the setup tree it must fail with the assertion that `scripts/source-config.cjs` is missing. The one-shot patch workflow verifies this expected failure before applying changes.

## Iteration 2 — schema generation — failed

The setup assertion failed exactly as expected and the complete patch payload applied cleanly. Ajv then rejected the generated findings schema in strict mode because the conditional CWE `pattern` did not repeat its string `type`. The payload was corrected to use `{ "type": "string", "pattern": "^CWE-[0-9]+$" }`; the sealed check remains unchanged.

## Iteration 3 — patch transport — failed

The corrected payload was uploaded as one long compressed Base64 line, but GitHub Actions detected a gzip CRC/length mismatch before executing it. No repository source changes were applied. The transport is being replaced with ordered 1.8 KB parts that are locally concatenated, decoded, decompressed, and byte-compared before publication.

## Iteration 4 — regression gate — failed

The chunked patch transport and SHA check passed, the patch applied, and generated assets were current. The actual sealed check failed with four regressions: a newline-escaping SyntaxError in the new test, two existing security fixtures missing newly required STRIDE/CWE fields, and one resume fixture emitting an empty cross-reference list. The workflow also lacked `pipefail`, so its step metadata incorrectly reported success. The next retry fixes all four fixtures and makes pipeline failure propagation explicit.

## Iteration 5 — precision protocol test — failed

The exact reconstructed patcher passed its SHA-256 and syntax checks. All production changes and all 175 pre-existing tests passed. The sole remaining failure was a malformed regular expression in the new protocol regression test: the slash in `OTP/reset` was not preserved through the patcher's template literal. The patcher now emits an escaped slash, and the sealed gate remains unchanged.

## Iteration 5 — precision protocol implementation — pending verification

Applied the centralized source catalog, order preservation, adaptive source-token chunks, fail-closed missing-scope handling, security evidence schema, progressive example loading, qualified rate-limit analysis, documentation, and regression tests. Generated artifacts and the sealed gate run next.

## Iteration 7 — sealed completion gate — passed

The sealed `.loop/check.sh` exited 0: generated assets were current, all 181 tests passed, preflight passed, and package inventory passed.

## Iteration 8 — draft PR validation — passed

Opened draft PR #2. The PR-triggered sealed precision gate passed, Node 22 CI passed, and Node 24 CI passed including package inventory verification.

## Iteration 9 — verification count correction — complete

Corrected the stale test-count note from 176 to the final executed total of 181. No production or test code changed.

## Iteration 10 — deep adversarial cross-check — in progress

Reopened the completed implementation for an end-to-end audit rather than relying on the green test suite. The new pass traces discovery, delta selection, chunk construction, hash evidence, retries/resume, Referee authorization, and Fixer scope. Candidate defects will be reproduced with focused regression tests before any production patch is accepted.

## Iteration 11 — nine deep defects reproduced — failed as expected

Added nine adversarial regression probes. The sealed check preserved all 181 prior passes and failed the nine new tests, confirming: code-index/delta order loss; mixed-size chunks exceeding the declared source-token budget; shebang/test/minified discovery drift; findings accepted outside assigned scope; worker-time source mutation reported as complete; weaker duplicate evidence overwriting stronger security evidence while STRIDE/CWE are dropped; non-cryptographic large-file cache keys; Fixer scope authorizing manual-review items; and symlink paths escaping the repository scope. Production patches must make these tests pass without editing the sealed check.

## Iteration 12 — deep precision hardening — passed

The nine adversarial regressions now pass. The sealed check exited 0 with all
190 tests passing, generated assets current, preflight successful, and package
inventory valid. Scope is realpath-contained, findings are chunk-bound, worker
source mutation fails closed, token budgets are enforced per concrete chunk,
evidence merges preserve security metadata, large files use SHA-256, and Fixer
authorization excludes manual-review and report-only findings.

## Iteration 13 — final PR-head verification — in progress

The verified hardening commit was created by GitHub Actions, whose workflow token cannot recursively trigger pull-request workflows. This ledger-only commit intentionally triggers the Node 22/24 CI matrix and the sealed precision gate on the exact hardened tree.

## Iteration 14 — final PR-head verification — passed

On head `8088a10928bea6e2257bff8f33fb51788eb89608`, the PR-triggered sealed precision gate passed, Node 22 CI passed, and Node 24 CI passed including package inventory, executable-bit, version, and help checks. This append-only entry records the verified result and triggers one final unchanged-code check on the completed loop ledger.

## Iteration 15 — post-hardening resume audit — in progress

A final static review found that a source mutation correctly fails the current chunk but can become the new baseline after `--resume` because the original pre-worker hash is overwritten or discarded on failure. The same review found that chunk status can still label a pending file as done in coverage, and the root-containment predicate rejects valid in-repository names beginning with `..`. Focused regressions will be added before patching these three edge cases.

## Iteration 16 — post-hardening regressions — failed as expected

The new tests preserved all 190 prior passes and failed exactly three assertions: a clean worker executed successfully after resuming source drift; a done chunk with a pending file produced `COMPLETE`; and `normalizeRunFiles` rejected an in-repository `..valid-source.js`. The test harness itself was corrected and rerun before accepting the coverage failure. Production changes now target only these confirmed behaviors.

## Iteration 17 — resume integrity hardening — passed

The three post-hardening regressions pass and the sealed check exited 0 with
all 193 tests passing. Per-run source baselines now survive failed attempts,
resumed drift is rejected before worker dispatch, coverage completion requires
per-file done evidence, and valid in-repository names beginning with `..` no
longer collide with the parent-directory escape check.

## Iteration 18 — final 193-test PR-head verification — in progress

The verified resume-hardening commit `0a293c4361ab46da24daaacd68bdda0432afedec` was created by GitHub Actions, so this append-only human-authored ledger commit triggers the pull-request Node 22/24 matrix and sealed precision gate on the exact 193-test hardened tree.

## Iteration 19 — final 193-test PR-head verification — passed

On head `4a767fecbea7bb2d43e477e08f5e4d774bd16231`, the PR-triggered sealed precision gate passed, Node 22 CI passed, and Node 24 CI passed including generated-asset checks, preflight, package inventory, executable-bit, version, and help verification. Every ledger item is complete; this atomic ledger-close commit changes no production or test code.
