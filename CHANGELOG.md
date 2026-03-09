# Changelog

## 2026-03-10

### Fixed — Pipeline Execution Overhaul
- **Concrete backend-to-tool mapping**: SKILL.md Step 0.6 now has explicit instructions for each dispatch mechanism (`subagent`, `teams`, `interactive_shell`, `local-sequential`) with tool invocation syntax, not vague "launch subagent" directives
- **`local-sequential` mode created**: New `modes/local-sequential.md` (7.8KB) with full phase-by-phase instructions for running Recon → Hunter → Skeptic → Referee in the main agent's own context — the most common execution path
- **All mode files rewritten**: `small.md`, `parallel.md`, `extended.md`, `scaled.md` now have backend-specific dispatch instructions with complete payload generation, validation, and subagent invocation examples for every phase
- **Subagent wrapper template**: New `templates/subagent-wrapper.md` — standardized template with `{VARIABLES}` for every subagent dispatch, ensuring consistent system prompt, scope boundaries, kill-switch rules, and output contracts
- **Inline tool-call examples**: SKILL.md Step 2 now has concrete examples for both `local-sequential` (execute yourself) and `subagent` (dispatch via tool) backends — not just "read prompt and launch"
- **Coverage enforcement**: New SKILL.md Section 7b makes coverage mandatory — agents cannot claim "audit complete" with CRITICAL/HIGH files unscanned; partial coverage produces explicit warnings with `--loop` recommendation
- **Step 3 backend override**: Added explicit rule that `local-sequential` backend reads `modes/local-sequential.md` instead of size-based mode files
- **Payload `generate` command**: `payload-guard.cjs` now has a `generate <role> [path]` command that scaffolds valid payload JSON for any role, eliminating the chicken-and-egg problem of constructing payloads without a template
- **Payload templates constant**: Added `TEMPLATES` object to `payload-guard.cjs` with complete schemas for all 6 roles (recon, triage-hunter, hunter, skeptic, referee, fixer) including realistic example values
- **`plan` command**: `run-bug-hunter.cjs` now supports `plan --files-json <path>` to generate a chunk plan as JSON without executing — LLM agents can read this plan and process chunks via their own dispatch
- **Prompt output headers**: All 5 prompt files (recon, hunter, skeptic, referee, fixer) now have "Output Destination" and "Scope Rules" sections at the top, telling subagents where to write output and what their boundaries are

### Added — Large Codebase Strategy
- **Domain-scoped auditing**: New `modes/large-codebase.md` replaces flat chunking for huge codebases (>FILE_BUDGET×3 files) with a 3-tier strategic approach:
  - Tier 0: Rapid recon classifies domains (not individual files) by risk using directory structure heuristics
  - Tier 1: Full pipeline (Recon → Hunter → Skeptic → Referee) runs independently per domain, preserving domain coherence
  - Tier 2: Cross-domain boundary audit targets service interaction points where the most dangerous bugs hide
  - Tier 3: Merge, deduplicate, and report with per-domain breakdown
- **Domain-aware state**: state file tracks domain completion status so interrupted runs resume at the domain level
- **Boundary pair detection**: cross-domain imports are identified to audit trust boundary violations, contract mismatches, and auth gaps between services
- **Skip LOW domains**: `--exhaustive` flag controls whether low-risk domains (UI components, test utils) are audited
- **Delta-first repeat scans**: `--delta` maps changed files to their domains and re-audits only affected domains

## 2026-03-08

### Changed
- **Sequential-first orchestration**: Parallel mode now uses one authoritative deep Hunter with optional read-only triage; Extended/Scaled modes now run chunked sequential scans with resume state.
- **Fix behavior control**: Phase 2 now runs by default after confirmed findings, with `--scan-only` as explicit report-only opt-out.
- **Fix pipeline safety**: Single-writer sequential fixer flow, checkpoint commits per bug, targeted verify before full verify, explicit `FIX_BASE_COMMIT` for post-fix diff.
- **Preflight reliability**: Dynamic `SKILL_DIR` resolution and non-blocking Context7 availability checks (missing API key no longer blocks runs).
- **Portability**: Prompt doc-lookup commands now use `"$SKILL_DIR/scripts/context7-api.cjs"` instead of hardcoded home paths.
- **Fixture consistency**: Self-test expectations aligned to 6 planted bugs across SKILL docs and evals.
- **Stash handling clarity**: Docs and pipeline now describe automatic stash restore attempt with conflict reporting.
- **Context7 helper robustness**: Added request timeout handling in `scripts/context7-api.cjs`.
- **Operational scripts**: Added `scripts/bug-hunter-state.cjs`, `scripts/payload-guard.cjs`, and `scripts/fix-lock.cjs` for state/cache management, spawn payload validation, and single-writer locking.
- **Cross-CLI orchestration**: Added `AGENT_BACKEND` selection/fallback model (`spawn_agent -> subagent -> team -> local-sequential`) so runs adapt to different coding CLI capabilities.
- **Executable orchestrator**: Added `scripts/run-bug-hunter.cjs` to run chunk workflows with backend selection, per-phase timeout/retry/backoff, and append-only run journal (`.claude/bug-hunter-run.log`).
- **Confidence gating**: Auto-fix now explicitly targets only high-confidence bugs and leaves lower-confidence findings for manual review.
- **Failure-path coverage**: Expanded eval scenarios for resume flows, hash cache skips, lock contention, payload guard failures, and confidence-gated fixes.
- **Script reliability tests**: Added `scripts/tests/*` to validate `bug-hunter-state`, `payload-guard`, `fix-lock`, and `run-bug-hunter` behavior.
- **Persistent index upgrade**: `scripts/code-index.cjs` now captures symbols, relative-import dependency graph, lightweight call graph, trust-boundary tags, and bug-scoped query commands.
- **Delta-first scope**: Added `scripts/delta-mode.cjs` for changed-files + dependency-hop selection with critical overlay expansion candidates.
- **Runner wiring**: `scripts/run-bug-hunter.cjs` now supports `--use-index`, `--delta-mode`, low-confidence expansion, chunk fact-card capture, global consistency reporting, and canary-first fix-plan generation.
- **State schema v2**: `scripts/bug-hunter-state.cjs` now tracks confidence, low-confidence metrics, chunk fact cards, consistency payload, fix plan, and supports file-appending for expansion passes.
- **Hybrid pipeline tests**: Added coverage for code indexing, delta selection/expansion, delta-runner expansion flow, fact-card persistence, consistency output, and canary subset planning.
- **Autonomous trigger clarity**: Added `--autonomous` path in docs (forces fix mode with canary-first flow) to avoid "report-only then ask" behavior in unattended runs.
- **False-positive control**: Added mandatory verification re-audit gate in skill flow so contradicted/non-reproducible findings are rejected before final confirmed counts.
- **Default fix behavior**: Switched to fix-by-default workflow; `--scan-only` now explicitly disables Phase 2 and keeps report-only mode.
- **README refresh**: Rewrote README in a consistent pattern aligned to default-fix flow, hybrid index+delta pipeline, re-audit gate, and canary-first remediation.
- **README optimization**: Expanded onboarding clarity with explicit value proposition, process walk-through, benefits, guardrails, and adoption-first quickstart guidance.

## 2026-03-07

### Added
- **Auto-fix pipeline** (`--fix`): Parallel Fixers in isolated git worktrees, checkpoint commits, test verification, auto-revert on regression, post-fix re-scan
- **Loop mode** (`--loop`): Iterates until 100% coverage, tracks state in checksummed coverage files
- **Combined fix-loop** (`--loop --fix`): Find, fix, and verify until clean
- **Staged file mode** (`--staged`): Scan staged files as a pre-commit check
- **Recon agent**: Maps architecture, trust boundaries, and computes dynamic context budget
- **Dual-lens Hunters**: Security Hunter + Logic Hunter scan in parallel with different focuses
- **Security checklist sweep**: Mandatory per-file pass in Hunter for hardcoded secrets, JWT expiry, input validation, auth gaps, data exposure
- **Context7 doc verification**: Verifies library/framework behavior claims against real documentation
- **Modular architecture**: SKILL.md split into slim core + mode files loaded on demand
- **Preflight checks**: Validates Context7 API key and Node.js availability at startup
- **Self-test fixture**: Express app with 6 planted bugs for pipeline validation
- **Portability**: All paths use `~/.claude/skills/bug-hunter`, Context7 script bundled in `scripts/`

### Changed
- Extended and Scaled modes for larger codebases (41-80 and 81-120 files)
- Skeptic directory clustering for efficient file reads
- Referee re-check pass for high-severity Skeptic disproves
- Evidence anchoring: Hunter must quote exact code; Referee spot-checks quotes

## 2026-03-05

- Added branch diff mode: `/bug-hunter -b <branch> [--base <base>]`
## 2026-03-05 -- Initial Release

- 3-agent adversarial bug hunting (Hunter, Skeptic, Referee)
- Supports scanning full project, specific directories, or individual files
