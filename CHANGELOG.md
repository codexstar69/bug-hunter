# Changelog

## 3.0.0 — 2026-03-10

### npm package, worktree-isolated Fixer, and cross-IDE installation

**npm global install and CLI:**
- New `package.json` with `@codexstar/bug-hunter` package name
- New `bin/bug-hunter` CLI entry point with `install`, `doctor`, and `info` commands
- `bug-hunter install` auto-detects Claude Code, Codex, Cursor, Kiro, and generic agents directories
- `bug-hunter doctor` checks environment readiness (Node.js, Context Hub, Context7, git)
- Install via: `npm install -g @codexstar/bug-hunter && bug-hunter install`

**Cross-IDE installation via skills.sh:**
- Compatible with `npx skills add codexstar69/bug-hunter` for Cursor, Windsurf, Copilot, Kiro, and Claude Code
- No publish step required — auto-discovered from public GitHub repo with valid SKILL.md

**Worktree-isolated Fixer dispatch (subagent/teams backends):**
- New `scripts/worktree-harvest.cjs` — manages git worktrees for safe, isolated Fixer execution
  - 6 subcommands: `prepare`, `harvest`, `checkout-fix`, `cleanup`, `cleanup-all`, `status`
  - Fixer edits happen in an isolated worktree; commits land on the fix branch without touching the user's working tree
  - Crash recovery via `cleanup-all` with automatic stash preservation
  - Meta-file filtering prevents `.worktree-manifest.json` and `.harvest-result.json` from polluting dirty detection
- `modes/fix-pipeline.md` updated with dual-path dispatch: worktree path (prepare → dispatch → harvest → cleanup) and direct path
- `modes/_dispatch.md` updated with Fixer worktree lifecycle diagram and CRITICAL warning about Agent tool's built-in `isolation: "worktree"`
- `templates/subagent-wrapper.md` updated with `{WORKTREE_RULES}` variable for Fixer isolation rules
- 13 new tests in `scripts/tests/worktree-harvest.test.cjs` (full suite: 25/25 passing)

**Context Hub preflight warning:**
- SKILL.md Step 5b now shows a visible `⚠️` warning when `chub` is not installed, with install command
- Previously was a silent suggestion — now impossible to miss

**SKILL.md error table:**
- 5 new error rows for worktree failures: prepare, harvest dirty, harvest no-manifest, cleanup, and checkout-fix errors

---

## 2026-03-10 13:26

- `scripts/triage.cjs`: LOW-only repositories promoted into `scanOrder` so script-heavy codebases do not collapse to zero scannable files
- `scripts/run-bug-hunter.cjs`: `teams` backend name aligned with the documented dispatch mode
- `scripts/run-bug-hunter.cjs`: `code-index.cjs` treated as optional during preflight and gated only when index-backed flows are requested
- `scripts/run-bug-hunter.cjs`: low-confidence delta expansion now reuses the caller's configured `--delta-hops` value
- `scripts/tests/run-bug-hunter.test.cjs`: regressions for LOW-only triage, optional `code-index`, `teams` backend selection, and delta-hop expansion

## 2.4.0 — 2026-03-10

### Context Hub integration — curated docs with Context7 fallback

- New `scripts/doc-lookup.cjs`: hybrid documentation lookup that tries [Context Hub](https://github.com/andrewyng/context-hub) (chub) first for curated, versioned, annotatable docs, then falls back to Context7 API when chub doesn't have the library
- All agent prompts (hunter, skeptic, fixer, doc-lookup) updated to use `doc-lookup.cjs` as primary with `context7-api.cjs` as explicit fallback
- Preflight smoke test now checks `doc-lookup.cjs` first, falls back to `context7-api.cjs`
- `run-bug-hunter.cjs` validates both scripts exist at startup
- Requires `@aisuite/chub` installed globally (`npm install -g @aisuite/chub`) — optional but recommended; pipeline works without it via Context7 fallback

## 2.3.0 — 2026-03-10

### Loop mode is now on by default

- `LOOP_MODE=true` is the new default — every `/bug-hunter` invocation iterates until full CRITICAL/HIGH coverage
- Added `--no-loop` flag to opt out and get single-pass behavior
- `--loop` flag still accepted for backwards compatibility (no-op)
- Updated triage warnings, coverage enforcement, and all documentation to reflect the new default
- `/bug-hunter src/` now finds bugs, fixes them, AND loops until full coverage — zero flags needed

## 2.2.1 — 2026-03-10

### Fix: `--loop` mode now actually loops

The `--loop` flag was broken — loop mode files described a "ralph-loop" system but never called `ralph_start`, so the pipeline ran once and stopped. Fixed:

- **`modes/loop.md`**: added explicit `ralph_start` call instructions with correct `taskContent` and `maxIterations` parameters
- **`modes/fix-loop.md`**: same fix for `--loop --fix` combined mode, plus removed manual state file creation (handled by `ralph_start`)
- **`SKILL.md`**: added CRITICAL integration note requiring `ralph_start` call when `LOOP_MODE=true`
- Changed completion signal from `<promise>DONE</promise>` to `<promise>COMPLETE</promise>` (correct ralph-loop API)
- Each iteration now calls `ralph_done` to proceed instead of relying on a non-existent hook

## 2.2.0 — 2026-03-10

### Fix pipeline hardening — 12 reliability and safety optimizations

- **Rollback timeout guard**: `git revert` calls now timeout after 60 seconds; conflicts abort cleanly instead of hanging the pipeline indefinitely
- **Dynamic lock TTL**: single-writer lock TTL scales with queue size (`max(1800, bugs * 600)`), preventing expiry on large fix runs
- **Lock heartbeat renewal**: new `renew` command in `fix-lock.cjs` — fixer renews the lock after each bug fix to prevent mid-run TTL expiry
- **Fixer context budget**: `MAX_BUGS_PER_FIXER = 5` — large fix queues are split into sequential batches to prevent context window overflow and hallucinated patches
- **Cross-file dependency ordering**: when `code-index.cjs` is available, fixes are ordered by import graph (fix dependencies before dependents)
- **Flaky test detection**: baseline tests run twice; tests that fail non-deterministically are excluded from revert decisions
- **Per-bug revert granularity**: clarified one-commit-per-bug as mandatory; reverts target individual bugs, not clusters
- **Dynamic canary sizing**: `max(1, min(3, ceil(eligible * 0.2)))` — canary group scales with queue size instead of hardcoded 1–3
- **Post-fix re-scan severity floor**: fixer-introduced bugs below MEDIUM severity are logged but don't trigger `FIXER_BUG` status
- **Dry-run mode** (`--dry-run`): preview planned fixes without editing files — Fixer reads code and outputs unified diff previews, no git commits
- **Machine-readable fix report**: `.bug-hunter/fix-report.json` written alongside markdown report for CI/CD gating, dashboards, and ticket automation
- **Circuit breaker**: if >50% of fix attempts fail/revert (min 3 attempts), remaining fixes are halted to prevent token waste on unstable codebases
- **Global Phase 2 timeout**: 30-minute deadline for the entire fix execution phase; unprocessed bugs are marked SKIPPED

## 2.1.0 — 2026-03-10

### v3 security pipeline + dependency scanner reliability

- STRIDE/CWE fields in Hunter findings format, with CWE quick-reference mapping for security categories
- Skeptic hard-exclusion fast path (15 false-positive classes) before deep review
- Referee security enrichment: reachability, exploitability, CVSS 3.1, and PoC blocks for critical/high security bugs
- Threat model support: `--threat-model` flag, `prompts/threat-model.md`, Recon/Hunter threat-context wiring
- Dependency scan support: `--deps` flag and `scripts/dep-scan.cjs` output to `.bug-hunter/dep-findings.json`
- JSON report contract: `.bug-hunter/findings.json` plus canonical `.bug-hunter/report.md`
- Few-shot calibration examples for Hunter and Skeptic in `prompts/examples/`
- `dep-scan.cjs` lockfile-aware audits (`npm`, `pnpm`, `yarn`, `bun`) and non-zero audit exit handling so vulnerability exits are not misreported as scanner failures

## 2.0.0 — 2026-03-10

### Structural overhaul — triage pipeline + 36% token reduction

**Pipeline restructure:**
- Triage moved to Step 1 (after arg parse) — was running before target resolved
- All mode files consume triage JSON — riskMap, scanOrder, fileBudget flow downstream
- Recon demoted to enrichment — no longer does file classification when triage exists
- Step 7.0 re-audit gate removed — duplicated Referee's work

**Deduplication:**
- `modes/_dispatch.md` — shared dispatch patterns (18 references across modes)
- Mode files compressed: small 7.3→2.9KB, parallel 7.9→4.2KB, extended 7.1→3.3KB, scaled 7.3→2.7KB
- Skip-file patterns consolidated — single authoritative list in SKILL.md
- Error handling table updated with correct step references

**Dead weight removed:**
- FIX-PLAN.md deleted (26KB dead planning doc)
- README.md compressed from 8.5KB to 3.7KB
- code-index.cjs marked optional

**Prompt compression:**
- hunter.md: scope rules and security checklist compressed
- recon.md: output format template and "What to map" sections compressed
- referee.md: tiering rules, re-check section, output format compressed
- skeptic.md: false-positive patterns compressed to inline format

**Logic gaps fixed:**
- Branch-diff/staged optimization note in Step 3
- single-file.md: local-sequential backend support added

**Size:** 187,964 → 119,825 bytes (36% reduction, ~30K tokens)

## 1.0.0 — 2026-03-10

### Zero-token pre-recon triage (`triage.cjs`)
- `scripts/triage.cjs` runs before any LLM agent — 0 tokens, <2s for 2,000+ files
- FILE_BUDGET, strategy, and domain map decided by triage, not Recon
- Writes `.bug-hunter/triage.json` with strategy, fileBudget, domains, riskMap, scanOrder
- `local-sequential.md` with full phase-by-phase instructions
- Subagent wrapper template in `templates/subagent-wrapper.md`
- Coverage enforcement — partial audits produce explicit warnings
- Large codebase strategy with domain-first tiered scanning
