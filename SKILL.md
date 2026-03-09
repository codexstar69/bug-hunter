---
name: bug-hunter
description: "Adversarial bug hunting with a sequential-first pipeline (Recon, Hunter, Skeptic, Referee) that can optionally use safe read-only parallel triage. Finds, verifies, and auto-fixes real bugs by default (with --scan-only opt-out) using checkpointed verification and resume state for large codebases. Use this skill whenever the user wants bug finding, security audits, regression checks, or code review focused on runtime behavior."
argument-hint: "[path | -b <branch> [--base <base-branch>] | --staged | --scan-only | --fix | --autonomous | --loop | --approve]"
disable-model-invocation: true
---

# Bug Hunt - Adversarial Bug Finding

Run a sequential-first adversarial bug hunt on your codebase. Use parallelism only for read-only triage and independent verification tasks.

## Table of Contents
- [Usage](#usage)
- [Target](#target)
- [Context Budget](#context-budget)
- [Execution Steps](#execution-steps)
- [Step 7: Present the Final Report](#step-7-present-the-final-report)
- [Self-Test Mode](#self-test-mode)
- [Error handling](#error-handling)

**Phase 1 — Find & Verify:**
```
Recon (map) --> Hunter (deep scan) --> Skeptic (challenge) --> Referee (final verdict)
                    ^                 (optional read-only dual-lens triage can run here)
                    |
             state + chunk checkpoints
```

**Phase 2 — Fix & Verify (default when bugs are confirmed):**
```
Baseline --> Git branch --> sequential Fixer (single writer) --> targeted verify --> full verify --> report
                    ^                                                              |
                    +------------------------ checkpoint commits + auto-revert -----+
```

For small scans (1-10 source files): runs single Hunter + single Skeptic (no parallelism overhead).
For large scans: process chunks sequentially with persistent state to avoid compaction drift.

## Usage

```
/bug-hunter                              # Scan entire project
/bug-hunter src/                         # Scan specific directory
/bug-hunter lib/auth.ts                  # Scan specific file
/bug-hunter -b feature-xyz              # Scan files changed in feature-xyz vs main
/bug-hunter -b feature-xyz --base dev   # Scan files changed in feature-xyz vs dev
/bug-hunter --staged                    # Scan staged files (pre-commit check)
/bug-hunter --scan-only src/            # Scan only, no code changes
/bug-hunter --fix src/                   # Find bugs AND auto-fix them
/bug-hunter --autonomous src/            # Alias for no-intervention auto-fix run
/bug-hunter --fix -b feature-xyz        # Find + fix on branch diff
/bug-hunter --fix --approve src/        # Find + fix, but ask before each fix
/bug-hunter --loop src/                  # Ralph-loop mode: audit until 100% coverage
/bug-hunter --loop --fix src/            # Loop mode: find + fix until clean
```

## Target

The raw arguments are: $ARGUMENTS

**Parse the arguments as follows:**

0. If arguments contain `--loop`: strip it from the arguments and set `LOOP_MODE=true`. The remaining arguments are parsed normally below.

0b. Default `FIX_MODE=true`.
0c. If arguments contain `--scan-only`: strip it from the arguments and set `FIX_MODE=false`.
0d. If arguments contain `--fix`: strip it from the arguments and set `FIX_MODE=true`. The remaining arguments are parsed normally below.
0e. If arguments contain `--autonomous`: strip it from the arguments, set `AUTONOMOUS_MODE=true`, and force `FIX_MODE=true` (canary-first + confidence-gated).
0f. If arguments contain `--approve`: strip it from the arguments and set `APPROVE_MODE=true`. When this flag is set, Fixer agents run in `mode: "default"` (user reviews and approves each edit). When not set, `APPROVE_MODE=false` and Fixers run autonomously.

1. If arguments contain `--staged`: this is **staged file mode**.
   - Run `git diff --cached --name-only` using the Bash tool to get the list of staged files.
   - If the command fails, report the error to the user and stop.
   - If no files are staged, tell the user there are no staged changes to scan and stop.
   - The scan target is the list of staged files (scan their full contents, not just the diff).

2. If arguments contain `-b <branch>`: this is **branch diff mode**.
   - Extract the branch name after `-b`.
   - If `--base <base-branch>` is also present, use that as the base branch. Otherwise default to `main`.
   - Run `git diff --name-only <base>...<branch>` using the Bash tool to get the list of changed files.
   - If the command fails (e.g. branch not found), report the error to the user and stop.
   - If no files changed, tell the user there are no changes to scan and stop.
   - The scan target is the list of changed files (scan their full contents, not just the diff).

3. If arguments do NOT contain `-b` or `--staged`: treat the entire argument string as a **path target** (file or directory). If empty, scan the current working directory.

**After resolving the file list (for modes 1 and 2), filter out non-source files:**

Remove any files matching these patterns — they are not scannable source code:
- `*.md`, `*.txt`, `*.rst`, `*.adoc`
- `*.json`, `*.yaml`, `*.yml`, `*.toml`, `*.ini`, `*.cfg`
- `*.lock`, `*.sum`
- `*.min.js`, `*.min.css`, `*.map`
- `*.svg`, `*.png`, `*.jpg`, `*.gif`, `*.ico`, `*.woff*`, `*.ttf`, `*.eot`
- `.env*`, `.gitignore`, `.editorconfig`, `.prettierrc*`, `.eslintrc*`, `tsconfig.json`
- `jest.config.*`, `vitest.config.*`, `webpack.config.*`, `vite.config.*`, `next.config.*`, `tailwind.config.*`
- `LICENSE`, `CHANGELOG*`, `CONTRIBUTING*`, `CODE_OF_CONDUCT*`
- `Makefile`, `Dockerfile`, `docker-compose*`, `Procfile`
- Files inside `node_modules/`, `vendor/`, `dist/`, `build/`, `.next/`, `__pycache__/`, `.venv/`

If after filtering there are zero source files left, tell the user: "No scannable source files found — only config/docs/assets were changed." and stop.

## Context Budget

Each subagent has a limited context window. The number of files an agent can reliably process depends on file sizes.

**After Recon completes, read its Context Budget section to get the dynamic FILE_BUDGET.** Recon computes this as:
```
avg_tokens_per_file = average_lines_per_file * 4
FILE_BUDGET = floor(150000 / avg_tokens_per_file)   # capped at 60, floored at 10
```

Then determine partitioning:

| Total source files | Strategy | Hunters | Skeptics |
|--------------------|----------|---------|----------|
| 1 | Single-file mode | 1 general | 1 |
| 2-10 | Small mode | 1 general | 1 |
| 11 to FILE_BUDGET | Parallel mode (hybrid) | 1 deep Hunter (+ optional 2 read-only triage Hunters) | 1-2 by directory |
| FILE_BUDGET+1 to FILE_BUDGET*2 | Extended mode | Sequential chunked Hunters | 1-2 by directory |
| FILE_BUDGET*2+1 to FILE_BUDGET*3 | Scaled mode | Sequential chunked Hunters with resume state | 1-2 by directory |
| > FILE_BUDGET*3 | Loop mode required | Sequential chunk pipeline across iterations | 1-2 by directory |

If Recon did not produce a FILE_BUDGET (e.g., Recon was skipped), use the default of 40.

**File partitioning rules (Extended/Scaled modes):**
- **Service-aware partitioning (preferred)**: If Recon detected multiple service boundaries (monorepo), partition by service.
- **Risk-tier partitioning (fallback)**: process CRITICAL then HIGH then MEDIUM.
- Keep chunk size small (recommended 20-40 files) to avoid context compaction issues.
- Persist chunk progress in `.claude/bug-hunter-state.json` so restarts do not re-scan done chunks.
- Test files (CONTEXT-ONLY) are included only when needed for intent.

If the codebase exceeds FILE_BUDGET * 3 and `--loop` was not specified, warn the user: "This codebase has [N] source files (FILE_BUDGET: [B]). For thorough coverage, consider using `--loop` mode."

## Execution Steps

### Step 0: Preflight checks

Before doing anything else, verify the environment:

1. **Resolve skill directory**: Determine `SKILL_DIR` dynamically.
   - Preferred: derive it from the absolute path of the current `SKILL.md` (`dirname` of this file).
   - Fallback probe order: `$HOME/.agents/skills/bug-hunter`, `$HOME/.claude/skills/bug-hunter`.
   - Use this path for ALL Read tool calls and shell commands.

2. **Verify skill files exist**: Run `ls "$SKILL_DIR/prompts/hunter.md"` via Bash. If this fails, stop and tell the user: "Bug Hunter skill files not found. Reinstall the skill and retry."

3. **Node.js available**: Run `node --version` via Bash. If it fails, stop and tell the user: "Node.js is required for doc verification. Please install Node.js to continue."

4. **Context7 availability (optional, non-blocking)**: Run a quick smoke test:
   ```
   node "$SKILL_DIR/scripts/context7-api.cjs" search "express" "middleware"
   ```
   - If it returns results, set `DOC_LOOKUP_AVAILABLE=true`.
   - If it fails, warn the user and set `DOC_LOOKUP_AVAILABLE=false`.
   - Missing `CONTEXT7_API_KEY` must NOT block execution; anonymous lookups may still work.

5. **Verify helper scripts exist**:
   ```
   ls "$SKILL_DIR/scripts/run-bug-hunter.cjs" "$SKILL_DIR/scripts/bug-hunter-state.cjs" "$SKILL_DIR/scripts/code-index.cjs" "$SKILL_DIR/scripts/delta-mode.cjs" "$SKILL_DIR/scripts/payload-guard.cjs" "$SKILL_DIR/scripts/fix-lock.cjs"
   ```
   If missing, stop and tell the user to update/reinstall the skill.

6. **Select orchestration backend (cross-CLI portability)**:

   Detect which dispatch tools are available in your runtime. Use the FIRST that works:

   **Option A — `subagent` tool (Pi agent, preferred for parallel):**
   - Test: call `subagent({ action: "list" })`. If it returns without error, this backend works.
   - Set `AGENT_BACKEND = "subagent"`
   - Dispatch pattern for each phase:
     ```
     subagent({
       agent: "<role>-agent",
       task: "<filled subagent-wrapper template with prompt content + assignment>",
       output: ".claude/bug-hunter-<phase>-output.md"
     })
     ```
   - Read the output file after the subagent completes.

   **Option B — `teams` tool (Pi agent teams):**
   - Test: does the `teams` tool exist in your available tools?
   - Set `AGENT_BACKEND = "teams"`
   - Dispatch pattern:
     ```
     teams({
       tasks: [{ text: "<filled subagent-wrapper template>" }],
       maxTeammates: 1
     })
     ```

   **Option C — `interactive_shell` (Claude Code, Codex, other CLI agents):**
   - Set `AGENT_BACKEND = "interactive_shell"`
   - Dispatch pattern:
     ```
     interactive_shell({
       command: 'pi "<task prompt>"',
       mode: "dispatch"
     })
     ```

   **Option D — `local-sequential` (default — always works):**
   - Set `AGENT_BACKEND = "local-sequential"`
   - Read `SKILL_DIR/modes/local-sequential.md` for full instructions.
   - You run all phases (Recon, Hunter, Skeptic, Referee) yourself,
     sequentially, within your own context window.
   - Write phase outputs to `.claude/` files between phases.

   **IMPORTANT**: `local-sequential` is NOT a degraded mode. It is the expected
   default for most environments and the skill works fully in this mode. Subagent
   dispatch is an optimization for large codebases, not a requirement.

   Rules:
   - Use exactly ONE backend for the whole run.
   - If a remote backend launch fails, fall back to the next option.
   - If all remote backends fail, use `local-sequential` and continue.

### Step 1: Parse arguments and resolve target

Follow the rules in the **Target** section above. If in branch diff or staged mode, run the appropriate git command now, collect the file list, and apply the filter.

Report to the user:
- Mode (full project / directory / file / branch diff / staged)
- Number of source files to scan (after filtering)
- Number of files filtered out

### Step 2: Read prompt files on demand (context efficiency)

**MANDATORY**: You MUST read prompt files using the Read tool before passing them to subagents or executing them yourself. Do NOT skip this or act from memory. Use the absolute SKILL_DIR path resolved in Step 0.

**Load only what you need for each phase — do NOT read all files upfront:**

| Phase | Read These Files |
|-------|-----------------|
| Recon (Step 4) | `prompts/recon.md` (skip for single-file mode) |
| Hunters (Step 5) | `prompts/hunter.md` + `prompts/doc-lookup.md` |
| Skeptics (Step 6) | `prompts/skeptic.md` + `prompts/doc-lookup.md` |
| Referee (Step 7) | `prompts/referee.md` |
| Fixers (Phase 2) | `prompts/fixer.md` + `prompts/doc-lookup.md` (only if FIX_MODE=true) |

**Concrete examples for each backend:**

#### Example A: local-sequential (most common)

```
# Phase B — launching Hunter yourself
# 1. Read the prompt file:
read({ path: "$SKILL_DIR/prompts/hunter.md" })

# 2. You now have the Hunter's full instructions. Execute them yourself:
#    - Read each file in risk-map order using the Read tool
#    - Apply the security checklist sweep
#    - Write each finding in BUG-N format

# 3. Write your findings to disk:
write({ path: ".claude/bug-hunter-findings.md", content: "<your findings>" })
```

#### Example B: subagent dispatch

```
# Phase B — launching Hunter via subagent
# 1. Read the prompt:
read({ path: "$SKILL_DIR/prompts/hunter.md" })
# 2. Read the wrapper template:
read({ path: "$SKILL_DIR/templates/subagent-wrapper.md" })
# 3. Fill the template with:
#    - {ROLE_NAME} = "hunter"
#    - {ROLE_DESCRIPTION} = "Bug Hunter — find behavioral bugs in source code"
#    - {PROMPT_CONTENT} = <full contents of hunter.md>
#    - {TARGET_DESCRIPTION} = "FindCoffee monorepo backend services"
#    - {FILE_LIST} = <files from Recon risk map, CRITICAL first>
#    - {RISK_MAP} = <risk map from .claude/bug-hunter-recon.md>
#    - {TECH_STACK} = <framework, auth, DB from Recon>
#    - {PHASE_SPECIFIC_CONTEXT} = <doc-lookup instructions from doc-lookup.md>
#    - {OUTPUT_FILE_PATH} = ".claude/bug-hunter-findings.md"
#    - {SKILL_DIR} = <absolute path>
# 4. Dispatch:
subagent({
  agent: "hunter-agent",
  task: "<the filled template>",
  output: ".claude/bug-hunter-findings.md"
})
# 5. Read the output:
read({ path: ".claude/bug-hunter-findings.md" })
```

When launching subagents, always pass `SKILL_DIR` explicitly in the task context so prompt commands like `node "$SKILL_DIR/scripts/context7-api.cjs"` resolve correctly.

Before every subagent launch, validate payload shape with:
```
node "$SKILL_DIR/scripts/payload-guard.cjs" validate "<role>" "<payload-json-path>"
```
If validation fails, do NOT launch the subagent. Fix the payload first.

Any mode step that says "launch subagent" means "dispatch an agent task using `AGENT_BACKEND`". For `local-sequential`, "launch" means "execute that phase's instructions yourself."

After reading each prompt, extract the key instructions and pass the content to subagents via their system prompts. You do not need to keep the full text in working memory.

**Context pruning for subagents:** When passing bug lists to Skeptics, Fixers, or the Referee, only include the bugs assigned to that agent — not the full merged list. For each bug, include: BUG-ID, severity, file, lines, claim, evidence, runtime trigger, cross-references. Omit: the Hunter's internal reasoning, scan coverage stats, and any "FILES SCANNED/SKIPPED" metadata. This keeps subagent prompts lean.

### Step 3: Determine execution mode

Based on the scan target size, choose the execution mode per the **Context Budget** table.

Read the corresponding mode file:
- 1 file: `SKILL_DIR/modes/single-file.md`
- 2-10 files: `SKILL_DIR/modes/small.md`
- 11 to FILE_BUDGET: `SKILL_DIR/modes/parallel.md`
- FILE_BUDGET+1 to FILE_BUDGET*2: `SKILL_DIR/modes/extended.md`
- FILE_BUDGET*2+1 to FILE_BUDGET*3: `SKILL_DIR/modes/scaled.md`
- > FILE_BUDGET*3: force `LOOP_MODE=true` and read `SKILL_DIR/modes/loop.md`

**Backend override for local-sequential:** If `AGENT_BACKEND = "local-sequential"`, read `SKILL_DIR/modes/local-sequential.md` instead of the size-based mode file. The local-sequential mode handles all sizes internally with its own chunking logic.

If LOOP_MODE=true, also read:
- `SKILL_DIR/modes/fix-loop.md` when FIX_MODE=true
- `SKILL_DIR/modes/loop.md` otherwise

Report the chosen mode to the user.

**Then follow the steps in the loaded mode file.** Each mode file contains the specific steps for running Hunters, Skeptics, and Referee for that mode. Execute them in order.

For `extended` and `scaled` modes, initialize state before chunk execution:
```
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init ".claude/bug-hunter-state.json" "<mode>" "<files-json-path>" 30
```
Then apply hash-based skip filtering before each chunk:
```
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" hash-filter ".claude/bug-hunter-state.json" "<chunk-files-json-path>"
```

For full autonomous chunk orchestration (timeouts + retries + journal), prefer:
```
node "$SKILL_DIR/scripts/run-bug-hunter.cjs" run --skill-dir "$SKILL_DIR" --files-json "<files-json-path>" --changed-files-json "<changed-files-json-path>" --mode "<mode>" --use-index true --delta-mode true --delta-hops 2 --expand-on-low-confidence true --canary-size 3 --timeout-ms 120000 --max-retries 1 --backoff-ms 1000
```
This writes:
- Run journal: `.claude/bug-hunter-run.log`
- Persistent index: `.claude/bug-hunter-index.json`
- Chunk facts: `.claude/bug-hunter-facts.json`
- Consistency report: `.claude/bug-hunter-consistency.json`
- Canary-first fix plan: `.claude/bug-hunter-fix-plan.json`

---

## Step 7: Present the Final Report

After the mode-specific steps complete, display the final report:

### 0. Verification re-audit gate (before final counts)
Run one rejection pass before locking final findings:
- Re-audit all `Critical` findings and all findings missing strong runtime trigger evidence.
- Re-audit at least 30% sample of remaining Medium/Low findings.
- Any finding that fails reproducibility or is contradicted by Skeptic/Referee in this pass must be marked `REJECTED_FALSE_POSITIVE` and excluded from confirmed totals.
- Report both counts: `raw_findings` and `confirmed_findings_after_reaudit`.

### 1. Scan metadata
- Mode (single-file / small / parallel-hybrid / extended / scaled / loop)
- Files scanned: N source files (N filtered out)
- Architecture: [summary from Recon]
- Tech stack: [framework, auth, DB from Recon]

### 2. Pipeline summary
```
Recon:     mapped N files -> CRITICAL: X | HIGH: Y | MEDIUM: Z | Tests: T | FILE_BUDGET: B
Hunters:   [deep scan findings: W | optional triage findings: T | merged: U unique]
Gap-fill:  [N files re-scanned, M additional findings] (or "not needed")
Skeptics:  [challenged X | disproved: D, accepted: A]
Referee:   confirmed N real bugs -> Critical: X | Medium: Y | Low: Z
```

### 3. Confirmed bugs table
(sorted by severity — from Referee output)

### 4. Low-confidence items
Flagged for manual review.
- Include an **Auto-fix eligibility** field per bug:
  - `ELIGIBLE`: Referee confidence >= 75%
  - `MANUAL_REVIEW`: confidence < 75% or missing confidence
- If low-confidence items exist, expand scan scope from delta mode using trust-boundary overlays before finalizing report.

### 5. Dismissed findings
In a collapsed `<details>` section (for transparency).

### 6. Agent accuracy stats
- Deep Hunter accuracy: X/Y confirmed (Z%)
- Optional triage value: N triage-only findings promoted to deep scan
- Skeptic accuracy: X/Y correct challenges (Z%)

### 7. Coverage assessment
- If ALL CRITICAL/HIGH files scanned: "Full coverage achieved."
- If any missed: list them with note about `--loop` mode.

### 7b. Coverage enforcement (mandatory)

If the coverage assessment shows ANY CRITICAL or HIGH files were not scanned, the pipeline is NOT complete:

1. If `--loop` was specified: the ralph-loop will automatically continue to the next iteration covering missed files. Do NOT output `<promise>DONE</promise>` until all CRITICAL/HIGH files show DONE.

2. If `--loop` was NOT specified AND missed files exist:
   - If total files ≤ FILE_BUDGET × 3: Output the report with a WARNING:
     ```
     ⚠️ PARTIAL COVERAGE: [N] CRITICAL/HIGH files were not scanned.
     Run `/bug-hunter --loop [path]` for complete coverage.
     Unscanned files: [list them]
     ```
   - If total files > FILE_BUDGET × 3: The report MUST include:
     ```
     🚨 LARGE CODEBASE: [N] source files (FILE_BUDGET: [B]).
     Single-pass audit covered [X]% of CRITICAL/HIGH files.
     Use `/bug-hunter --loop [path]` for full coverage.
     ```

3. Do NOT claim "audit complete" or "full coverage achieved" unless ALL CRITICAL and HIGH files have status DONE. A partial audit is still valuable — report what you found honestly.

If zero bugs were confirmed, say so clearly — a clean report is a good result.

**Routing after report:**
- If confirmed bugs > 0 AND `FIX_MODE=true`:
  - Auto-fix only `ELIGIBLE` bugs.
  - Apply canary-first rollout: fix top critical eligible subset first, verify, then continue remaining eligible fixes.
  - Keep `MANUAL_REVIEW` bugs in report only (do not auto-edit).
  - Run final global consistency pass over merged findings before applying fixes.
  - Read `SKILL_DIR/modes/fix-pipeline.md` and execute Phase 2 on eligible subset.
- If confirmed bugs > 0 AND `FIX_MODE=false`: stop after report (scan-only mode).
- If zero bugs confirmed: stop here. The report is the final output.

---

## Self-Test Mode

To validate the pipeline works end-to-end, run `/bug-hunter SKILL_DIR/test-fixture/` on the included test fixture. This directory contains a small Express app with 6 intentionally planted bugs (2 Critical, 3 Medium, 1 Low). Expected results:
- Recon should classify 3 files as CRITICAL, 1 as HIGH
- Hunters should find all 6 bugs (possibly more false positives)
- Skeptic should challenge at least 1 false positive
- Referee should confirm all 6 planted bugs

If the pipeline finds fewer than 5 of the 6 planted bugs, the prompts need tuning. If it reports more than 3 false positives that survive to the Referee, the Skeptic prompt needs tightening.

The test fixture source files ship with the skill. If using `--fix` mode on the fixture, initialize its git repo first: `bash SKILL_DIR/scripts/init-test-fixture.sh`

---

## Error handling

| Step | Failure | Fallback |
|------|---------|----------|
| Recon | timeout/error | Skip Recon, Hunters use Glob-based discovery |
| Optional triage Hunter | timeout/error | Disable triage, continue with deep Hunter |
| Deep Hunter | timeout/error | Retry once on narrowed chunk, otherwise report partial coverage |
| Orchestration backend | launch failure | Fall back to next backend (`spawn_agent -> subagent -> team -> local-sequential`) |
| Gap-fill Hunter | timeout/error | Note missed files, continue |
| Payload guard | validation fails | Do not launch subagent; fix payload and retry |
| Orchestrator phase timeout | timeout/error | Retry with exponential backoff (`max-retries`), then mark chunk failed |
| Skeptic-A | timeout/error | Run single Skeptic on all bugs |
| Skeptic-B | timeout/error | Use Skeptic-A's results, mark rest "unverified" |
| Referee | timeout/error | Use Skeptic's accepted list as final result |
| Git safety (Step 8a) | not a git repo | Warn user, skip branching |
| Git safety (Step 8a) | stash/branch fails | Warn, continue without safety net |
| Fix lock acquire | lock held | Stop Phase 2, report concurrent fixer run |
| Test baseline (Step 8c) | timeout >5min | Set BASELINE=null, cannot attribute failures |
| Test baseline (Step 8c) | command not found | Set TEST_COMMAND=null, skip test verification |
| Any single Fixer | timeout/error | Mark unfixed bugs as SKIPPED |
| Post-fix tests (Step 10a) | timeout >5min | Report "manual verification needed" |
| Post-fix tests (Step 10a) | new failures | Auto-revert failed fix commit, mark FIX_REVERTED |
| Auto-revert (Step 10b) | revert conflicts | Mark as FIX_FAILED (can't cleanly undo) |
| Post-fix re-scan (Step 10c) | timeout/error | Skip re-scan, note "fixer output not re-verified" |
| Fix lock release | release fails | Warn user to clear `.claude/bug-hunter-fix.lock` manually |
