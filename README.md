<p align="center">
  <img src="assets/pipeline-diagram.png" alt="Bug Hunter pipeline" width="100%" />
</p>

<h1 align="center">/bug-hunter</h1>

<p align="center">
  <strong>Find real runtime bugs and fix them automatically, with guardrails.</strong><br/>
  Built for coding agents that need high-signal bug detection, not noisy lint-style output.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" /></a>
</p>

---

## What Problem This Solves

Most AI code reviews have two common failures:

1. They **over-report** bugs.
2. They then **agree with themselves** during verification.

Bug Hunter solves this with an adversarial pipeline where different agents have opposite incentives. Findings must survive challenge and re-audit before they are treated as real.

---

## Why People Use It

### 1) Better signal than single-agent review

You get fewer "looks suspicious" findings and more reproducible issues.

### 2) Faster path from bug to fix

By default, Bug Hunter does not stop at reporting. It can move from:

- finding ->
- verification ->
- canary fixes ->
- targeted/full verification ->
- safe final diff

### 3) Safe autonomous editing

It fixes on a dedicated branch with checkpoint commits and rollback behavior.

### 4) Works on big repos

Hybrid index + delta + chunk strategy avoids full-repo rereads and reduces context drift.

---

## Installation

```bash
git clone https://github.com/codexstar69/bug-hunter.git ~/.agents/skills/bug-hunter
```

## Quick Start (2 Minutes)

### First run (recommended)

```bash
/bug-hunter -b your-feature-branch
```

This scans changed code first and auto-fixes eligible bugs by default.

### Report-only run

```bash
/bug-hunter --scan-only src/
```

---

## Default Behavior

Bug Hunter is now **fix-by-default**.

- If confirmed eligible bugs exist, fix phase starts automatically.
- If no confirmed bugs exist, it ends after report.
- `--scan-only` disables all code edits.

All autonomous edits happen on `bug-hunter-fix-<timestamp>`.

---

## Command Guide

```bash
/bug-hunter                               # full project, default auto-fix
/bug-hunter src/                          # target directory
/bug-hunter lib/auth.ts                   # target file
/bug-hunter -b feature-xyz                # branch diff vs main
/bug-hunter -b feature-xyz --base dev     # branch diff vs custom base
/bug-hunter --staged                      # staged files
/bug-hunter --scan-only src/              # report-only mode (no edits)
/bug-hunter --fix src/                    # explicit auto-fix (same as default)
/bug-hunter --autonomous src/             # explicit no-intervention auto-fix
/bug-hunter --fix --approve src/          # prompt before each fix
/bug-hunter --loop src/                   # iterative coverage mode
/bug-hunter --loop --fix src/             # iterative find+fix mode
```

---

## How The Process Works

## Phase 1: Find and Verify

```
Recon -> Deep Hunter -> Skeptic -> Referee -> Re-audit gate
```

### Recon

- maps architecture
- identifies trust boundaries
- sets context budget and chunk strategy

### Deep Hunter

- performs the main runtime-focused scan
- prioritizes critical paths (auth, API boundaries, state transitions)

### Skeptic

- tries to disprove each finding
- checks framework/library behavior (Context7 when available)

### Referee

- makes final verdict on each finding
- standardizes severity and confidence

### Re-audit gate (important)

Before final confirmed count:

- all critical findings are re-audited
- weakly evidenced findings are re-audited
- sampled medium/low findings are re-checked
- contradicted/non-reproducible items are rejected

This is one of the main reasons false-positive rate is lower.

## Phase 2: Fix and Verify

```
Fix branch -> canary subset -> targeted checks -> rollout -> full checks -> post-fix re-scan
```

### Canary-first rollout

High-priority eligible bugs are fixed first in a small subset.

### Verification flow

- run targeted checks after each checkpoint
- run full checks at end
- auto-revert regression-causing commits
- re-scan changed hunks for fixer-introduced issues

---

## Guardrails

Bug Hunter is designed so autonomous mode is useful without being reckless.

## Code safety guardrails

- dedicated fix branch per run
- single-writer lock (`.claude/bug-hunter-fix.lock`)
- checkpoint commit per bug/cluster
- automatic revert for regression-causing fixes
- dirty-tree stash and restore attempt

## False-positive guardrails

- adversarial skeptic role
- referee final arbitration
- mandatory re-audit gate before final confirmed list
- confidence gating (default fix eligibility: confidence >= 75)

## Runtime reliability guardrails

- per-chunk timeout/retry/backoff
- append-only run journal
- fail-safe backend fallback (`spawn_agent -> subagent -> team -> local-sequential`)

## Scale guardrails

- hash cache skips unchanged files
- chunk checkpoints allow resume
- delta-first scope reduces unnecessary scanning
- fact cards reduce reread overhead in long runs

---

## Why It Works Well on Big Codebases

Bug Hunter uses a hybrid model, not brute-force full scan every time.

### Persistent code index

`code-index.cjs` builds `.claude/bug-hunter-index.json` with:

- symbols
- imports/dependencies
- lightweight call graph
- trust-boundary tags

### Delta mode first

`delta-mode.cjs` starts from changed files and expands by 1/2-hop dependencies.

### Expansion only when needed

If confidence is low, scope expands from low-confidence files plus critical overlays.

### Stateful chunk execution

`bug-hunter-state.cjs` tracks:

- chunk lifecycle
- retry state
- hash cache
- bug ledger + confidence
- fact cards
- consistency and fix-plan outputs

---

## Orchestrator (Recommended for Large/Flaky Runs)

```bash
node scripts/run-bug-hunter.cjs run \
  --skill-dir /absolute/path/to/bug-hunter \
  --files-json .claude/source-files.json \
  --changed-files-json .claude/changed-files.json \
  --mode extended \
  --use-index true \
  --delta-mode true \
  --delta-hops 2 \
  --expand-on-low-confidence true \
  --canary-size 3 \
  --timeout-ms 120000 \
  --max-retries 1 \
  --backoff-ms 1000
```

Primary artifacts:

- `.claude/bug-hunter-run.log`
- `.claude/bug-hunter-state.json`
- `.claude/bug-hunter-index.json`
- `.claude/bug-hunter-facts.json`
- `.claude/bug-hunter-consistency.json`
- `.claude/bug-hunter-fix-plan.json`

---

## Modes

| Mode | File count | Strategy |
|------|------------|----------|
| Single-file | 1 | Direct Hunter -> Skeptic -> Referee |
| Small | 2-10 | Recon + single deep pass |
| Parallel (hybrid) | 11-FILE_BUDGET | Deep scan + optional read-only triage |
| Extended | FILE_BUDGET+1 to FILE_BUDGET*2 | Sequential chunked scanning |
| Scaled | FILE_BUDGET*2+1 to FILE_BUDGET*3 | State-driven chunk pipeline |
| Loop | > FILE_BUDGET*3 | Iterative coverage loop |

---

## What It Catches

- security vulnerabilities
- logic and state-transition bugs
- runtime error-handling flaws
- race conditions
- API contract mismatches
- cross-file assumption mismatches
- data integrity issues

It is not a style/lint formatter tool.

---

## Languages

Tested across:

- TypeScript / JavaScript
- Python
- Go
- Rust
- Java / Kotlin
- Ruby
- PHP

---

## Context7 (Optional)

Context7 lookup is optional and non-blocking.

- if available: better framework-accurate verification
- if unavailable: run still continues

Optional setup:

```bash
export CONTEXT7_API_KEY="your-api-key"
```

---

## Self-Test

The included fixture has 6 planted bugs (2 Critical, 3 Medium, 1 Low).

```bash
/bug-hunter test-fixture/
```

Expected:

- all planted bugs should be confirmed
- at least one false positive should be challenged/dropped

---

## Who Should Try This First

Start with one of these:

1. pre-merge scan on a risky feature branch (`-b feature --base main`)
2. security-focused scan on auth/payments/API boundary directories
3. nightly autonomous run on changed services in a monorepo

---

## Repository Layout

```text
bug-hunter/
  SKILL.md
  prompts/
  modes/
  scripts/
    run-bug-hunter.cjs
    code-index.cjs
    delta-mode.cjs
    bug-hunter-state.cjs
    payload-guard.cjs
    fix-lock.cjs
    context7-api.cjs
    tests/
  test-fixture/
  assets/
```

---

## Update / Uninstall

```bash
# update
cd ~/.agents/skills/bug-hunter && git pull

# uninstall
rm -rf ~/.agents/skills/bug-hunter
```

---

## License

MIT — see [LICENSE](LICENSE)
