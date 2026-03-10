# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- GitHub Actions npm publish workflow on release publish or manual dispatch, with version/tag verification before `npm publish`

## [3.0.4] — 2026-03-11

### Added
- `schemas/*.schema.json` versioned contracts for recon, findings, skeptic, referee, coverage, fix-report, plus shared definitions and example findings fixtures
- `scripts/schema-runtime.cjs` lightweight schema runtime and `scripts/schema-validate.cjs` CLI for local artifact checks
- `scripts/render-report.cjs` Markdown renderer for report, coverage, skeptic, referee, and fix-report views from canonical JSON artifacts
- canonical `coverage.json` output with derived `coverage.md`
- `run-bug-hunter.cjs phase` command for schema-validated Skeptic, Referee, and Fixer phase execution with retry support
- runner tests for invalid Skeptic, Referee, and Fixer artifacts plus Markdown companion rendering

### Changed
- Hunter, Skeptic, Referee, and Fixer prompts now describe JSON-first canonical artifacts
- `payload-guard.cjs` now emits real schema refs instead of placeholder format/version objects
- `bug-hunter-state.cjs` now rejects malformed findings and stores canonical `confidenceScore`, `category`, `evidence`, `runtimeTrigger`, and `crossReferences`
- `run-bug-hunter.cjs` now treats missing or invalid `findings.json` as a retriable chunk failure, validates phase artifacts, and checks all shipped schema assets during preflight
- loop, fix-loop, local-sequential, and major mode docs now point at `*.json` phase artifacts and `coverage.json`
- README, SKILL docs, evals, and the subagent wrapper now describe rendered Markdown as a companion to canonical JSON
- preflight now checks all shipped structured-output schemas, not just findings
- structured-output migration now enforces orchestrated outbound validation beyond the local/manual path

## [3.0.1] — 2026-03-11

### Changed
- Loop and fix-loop completion now require full queued source-file coverage, not just CRITICAL/HIGH coverage
- Autonomous runs now continue through remaining MEDIUM and LOW files after prioritized chunks finish unless the user interrupts
- Loop iteration guidance now scales `maxIterations` from queue size so large audits do not stop early
- Large-codebase mode now treats LOW domains as part of the default autonomous queue instead of optional skipped work

## [3.0.0] — 2026-03-10

### Added
- `package.json` with `@codexstar/bug-hunter` package name
- `bin/bug-hunter` CLI entry point with `install`, `doctor`, and `info` commands
- `bug-hunter install` auto-detects Claude Code, Codex, Cursor, Kiro, and generic agents directories
- `bug-hunter doctor` checks environment readiness (Node.js, Context Hub, Context7, git)
- Install via: `npm install -g @codexstar/bug-hunter && bug-hunter install`
- Compatible with `npx skills add codexstar69/bug-hunter` for Cursor, Windsurf, Copilot, Kiro, and Claude Code
- `scripts/worktree-harvest.cjs` — manages git worktrees for safe, isolated Fixer execution (6 subcommands: `prepare`, `harvest`, `checkout-fix`, `cleanup`, `cleanup-all`, `status`)
- 13 new tests in `scripts/tests/worktree-harvest.test.cjs` (full suite: 25/25 passing)
- 5 new error rows in SKILL.md for worktree failures: prepare, harvest dirty, harvest no-manifest, cleanup, and checkout-fix errors

### Changed
- `modes/fix-pipeline.md` updated with dual-path dispatch: worktree path (prepare → dispatch → harvest → cleanup) and direct path
- `modes/_dispatch.md` updated with Fixer worktree lifecycle diagram and CRITICAL warning about Agent tool's built-in `isolation: "worktree"`
- `templates/subagent-wrapper.md` updated with `{WORKTREE_RULES}` variable for Fixer isolation rules
- SKILL.md Step 5b now shows a visible `⚠️` warning when `chub` is not installed (previously a silent suggestion)

## [2.4.1] — 2026-03-10

### Fixed
- `scripts/triage.cjs`: LOW-only repositories promoted into `scanOrder` so script-heavy codebases do not collapse to zero scannable files
- `scripts/run-bug-hunter.cjs`: `teams` backend name aligned with the documented dispatch mode
- `scripts/run-bug-hunter.cjs`: `code-index.cjs` treated as optional during preflight and gated only when index-backed flows are requested
- `scripts/run-bug-hunter.cjs`: low-confidence delta expansion now reuses the caller's configured `--delta-hops` value

### Added
- `scripts/tests/run-bug-hunter.test.cjs`: regressions for LOW-only triage, optional `code-index`, `teams` backend selection, and delta-hop expansion

## [2.4.0] — 2026-03-10

### Added
- `scripts/doc-lookup.cjs`: hybrid documentation lookup that tries [Context Hub](https://github.com/andrewyng/context-hub) (chub) first for curated, versioned, annotatable docs, then falls back to Context7 API when chub doesn't have the library
- Requires `@aisuite/chub` installed globally (`npm install -g @aisuite/chub`) — optional but recommended; pipeline works without it via Context7 fallback

### Changed
- All agent prompts (hunter, skeptic, fixer, doc-lookup) updated to use `doc-lookup.cjs` as primary with `context7-api.cjs` as explicit fallback
- Preflight smoke test now checks `doc-lookup.cjs` first, falls back to `context7-api.cjs`
- `run-bug-hunter.cjs` validates both scripts exist at startup

## [2.3.0] — 2026-03-10

### Changed
- `LOOP_MODE=true` is the new default — every `/bug-hunter` invocation iterates until full CRITICAL/HIGH coverage
- `--loop` flag still accepted for backwards compatibility (no-op)
- Updated triage warnings, coverage enforcement, and all documentation to reflect the new default

### Added
- `--no-loop` flag to opt out and get single-pass behavior

## [2.2.1] — 2026-03-10

### Fixed
- `modes/loop.md`: added explicit `ralph_start` call instructions with correct `taskContent` and `maxIterations` parameters
- `modes/fix-loop.md`: same fix for `--loop --fix` combined mode, plus removed manual state file creation (handled by `ralph_start`)
- `SKILL.md`: added CRITICAL integration note requiring `ralph_start` call when `LOOP_MODE=true`
- Changed completion signal from `<promise>DONE</promise>` to `<promise>COMPLETE</promise>` (correct ralph-loop API)
- Each iteration now calls `ralph_done` to proceed instead of relying on a non-existent hook

## [2.2.0] — 2026-03-10

### Added
- Rollback timeout guard: `git revert` calls now timeout after 60 seconds; conflicts abort cleanly instead of hanging
- Dynamic lock TTL: single-writer lock TTL scales with queue size (`max(1800, bugs * 600)`)
- Lock heartbeat renewal: new `renew` command in `fix-lock.cjs`
- Fixer context budget: `MAX_BUGS_PER_FIXER = 5` — large fix queues split into sequential batches
- Cross-file dependency ordering: when `code-index.cjs` is available, fixes are ordered by import graph
- Flaky test detection: baseline tests run twice; non-deterministic failures excluded from revert decisions
- Dynamic canary sizing: `max(1, min(3, ceil(eligible * 0.2)))` — canary group scales with queue size
- Dry-run mode (`--dry-run`): preview planned fixes without editing files
- Machine-readable fix report: `.bug-hunter/fix-report.json` for CI/CD gating, dashboards, and ticket automation
- Circuit breaker: if >50% of fix attempts fail/revert (min 3 attempts), remaining fixes are halted
- Global Phase 2 timeout: 30-minute deadline for the entire fix execution phase

### Changed
- Per-bug revert granularity: clarified one-commit-per-bug as mandatory; reverts target individual bugs, not clusters
- Post-fix re-scan severity floor: fixer-introduced bugs below MEDIUM severity are logged but don't trigger `FIXER_BUG` status

## [2.1.0] — 2026-03-10

### Added
- STRIDE/CWE fields in Hunter findings format, with CWE quick-reference mapping for security categories
- Skeptic hard-exclusion fast path (15 false-positive classes) before deep review
- Referee security enrichment: reachability, exploitability, CVSS 3.1, and PoC blocks for critical/high security bugs
- Threat model support: `--threat-model` flag, `prompts/threat-model.md`, Recon/Hunter threat-context wiring
- Dependency scan support: `--deps` flag and `scripts/dep-scan.cjs` output to `.bug-hunter/dep-findings.json`
- JSON report contract: `.bug-hunter/findings.json` plus canonical `.bug-hunter/report.md`
- Few-shot calibration examples for Hunter and Skeptic in `prompts/examples/`

### Fixed
- `dep-scan.cjs` lockfile-aware audits (`npm`, `pnpm`, `yarn`, `bun`) and non-zero audit exit handling so vulnerability exits are not misreported as scanner failures

## [2.0.0] — 2026-03-10

### Changed
- Triage moved to Step 1 (after arg parse) — was running before target resolved
- All mode files consume triage JSON — riskMap, scanOrder, fileBudget flow downstream
- Recon demoted to enrichment — no longer does file classification when triage exists
- Mode files compressed: small 7.3→2.9KB, parallel 7.9→4.2KB, extended 7.1→3.3KB, scaled 7.3→2.7KB
- Skip-file patterns consolidated — single authoritative list in SKILL.md
- Error handling table updated with correct step references
- hunter.md: scope rules and security checklist compressed
- recon.md: output format template and "What to map" sections compressed
- referee.md: tiering rules, re-check section, output format compressed
- skeptic.md: false-positive patterns compressed to inline format
- Branch-diff/staged optimization note in Step 3
- single-file.md: local-sequential backend support added

### Added
- `modes/_dispatch.md` — shared dispatch patterns (18 references across modes)

### Removed
- Step 7.0 re-audit gate removed — duplicated Referee's work
- FIX-PLAN.md deleted (26KB dead planning doc)
- README.md compressed from 8.5KB to 3.7KB
- code-index.cjs marked optional

## [1.0.0] — 2026-03-10

### Added
- `scripts/triage.cjs` — zero-token pre-recon triage, runs before any LLM agent (<2s for 2,000+ files)
- FILE_BUDGET, strategy, and domain map decided by triage, not Recon
- Writes `.bug-hunter/triage.json` with strategy, fileBudget, domains, riskMap, scanOrder
- `local-sequential.md` with full phase-by-phase instructions
- Subagent wrapper template in `templates/subagent-wrapper.md`
- Coverage enforcement — partial audits produce explicit warnings
- Large codebase strategy with domain-first tiered scanning

[Unreleased]: https://github.com/codexstar69/bug-hunter/compare/v3.0.4...HEAD
[3.0.4]: https://github.com/codexstar69/bug-hunter/compare/v3.0.3...v3.0.4
[3.0.3]: https://github.com/codexstar69/bug-hunter/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/codexstar69/bug-hunter/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/codexstar69/bug-hunter/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/codexstar69/bug-hunter/compare/v2.4.1...v3.0.0
[2.4.1]: https://github.com/codexstar69/bug-hunter/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/codexstar69/bug-hunter/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/codexstar69/bug-hunter/compare/v2.2.1...v2.3.0
[2.2.1]: https://github.com/codexstar69/bug-hunter/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/codexstar69/bug-hunter/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/codexstar69/bug-hunter/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/codexstar69/bug-hunter/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/codexstar69/bug-hunter/releases/tag/v1.0.0
