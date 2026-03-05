---
name: bug-hunter
description: "Run adversarial bug hunting on your codebase with optional auto-fix. Uses parallel agent teams (Recon, Hunters, Skeptics, Referee) to find and verify real bugs, then optionally fixes them with parallel Fixer agents and test verification. Invoke with /bug-hunter, /bug-hunter --fix, /bug-hunter [path], /bug-hunter -b <branch>, or /bug-hunter --staged."
argument-hint: "[path | -b <branch> [--base <base-branch>] | --staged | --fix | --loop]"
disable-model-invocation: true
---

# Bug Hunt - Adversarial Bug Finding

Run a parallel adversarial bug hunt on your codebase. Agents run in isolated teams for speed and fidelity.

**Phase 1 — Find & Verify:**
```
                    +-- Hunter-A (Security lens) --+       +-- Skeptic-A (file cluster 1) --+
Recon (map) ------->|                              |-- merge ->|                               |-- merge --> Referee (arbitrate)
                    +-- Hunter-B (Logic lens)    --+       +-- Skeptic-B (file cluster 2) --+
```

**Phase 2 — Fix & Verify (with `--fix`):**
```
                  +-- Fixer-A (worktree 1) --+
Baseline --> Git branch -->|                            |-- merge --> Test diff --> Report
                  +-- Fixer-B (worktree 2) --+        ^                          |
                                                      +---- ralph-loop <---------+
```

For small scans (1-10 source files): runs single Hunter + single Skeptic (no parallelism overhead).
For large scans (51+ source files): Hunters are partitioned by file scope to stay within context budget.

## Usage

```
/bug-hunter                              # Scan entire project
/bug-hunter src/                         # Scan specific directory
/bug-hunter lib/auth.ts                  # Scan specific file
/bug-hunter -b feature-xyz              # Scan files changed in feature-xyz vs main
/bug-hunter -b feature-xyz --base dev   # Scan files changed in feature-xyz vs dev
/bug-hunter --staged                    # Scan staged files (pre-commit check)
/bug-hunter --fix src/                   # Find bugs AND auto-fix them
/bug-hunter --fix -b feature-xyz        # Find + fix on branch diff
/bug-hunter --loop src/                  # Ralph-loop mode: audit until 100% coverage
/bug-hunter --loop --fix src/            # Loop mode: find + fix until clean
```

## Target

The raw arguments are: $ARGUMENTS

**Parse the arguments as follows:**

0. If arguments contain `--loop`: strip it from the arguments and set `LOOP_MODE=true`. The remaining arguments are parsed normally below.

0b. If arguments contain `--fix`: strip it from the arguments and set `FIX_MODE=true`. The remaining arguments are parsed normally below.

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
| 11 to FILE_BUDGET | Parallel mode | 2 (security + logic), all files | 1-2 by directory |
| FILE_BUDGET+1 to FILE_BUDGET*2 | Extended mode | 4 (2 security + 2 logic), files partitioned | 2 by directory |
| FILE_BUDGET*2+1 to FILE_BUDGET*3 | Scaled mode | 6 (3 security + 3 logic), files partitioned | 2-3 by directory |
| > FILE_BUDGET*3 | Loop mode recommended | Cap at 8 Hunters | 2-4 by directory |

If Recon did not produce a FILE_BUDGET (e.g., Recon was skipped), use the default of 40.

**File partitioning rules (Extended/Scaled modes):**
- **Service-aware partitioning (preferred)**: If Recon detected multiple service boundaries (monorepo), partition by service.
- **Risk-tier partitioning (fallback)**: CRITICAL files in ALL partitions. HIGH/MEDIUM split evenly.
- Each Hunter pair (security + logic) covers the SAME file partition — they differ by lens, not scope.
- Test files (CONTEXT-ONLY) are included in all partitions for reference.

If the codebase exceeds FILE_BUDGET * 3 and `--loop` was not specified, warn the user: "This codebase has [N] source files (FILE_BUDGET: [B]). For thorough coverage, consider using `--loop` mode."

## Execution Steps

### Step 0: Preflight checks

Before doing anything else, verify the environment:

1. **Resolve skill directory**: Run `echo $HOME/.claude/skills/bug-hunter` via Bash. Store the output as `SKILL_DIR` (the absolute path to this skill). Use this path for ALL subsequent Read tool calls and Bash commands referencing skill files. Example: on macOS it resolves to `/Users/<username>/.claude/skills/bug-hunter`.

2. **Verify skill files exist**: Run `ls SKILL_DIR/prompts/hunter.md` via Bash (using the resolved path). If this fails, stop and tell the user: "Bug Hunter skill files not found. Please reinstall: `git clone https://github.com/codexstar69/bug-hunter.git ~/.claude/skills/bug-hunter`"

3. **Node.js available**: Run `node --version` via Bash. If it fails, stop and tell the user: "Node.js is required for doc verification. Please install Node.js to continue."

4. **Context7 API key**: Run `echo $CONTEXT7_API_KEY` via Bash. If empty/unset:
   - Tell the user: "CONTEXT7_API_KEY is not set. Doc verification is needed to reduce false positives. Get a free API key from https://context7.com and add `export CONTEXT7_API_KEY=\"your-key\"` to your shell profile (~/.zshrc or ~/.bashrc), then restart your terminal."
   - **Do NOT continue silently.** Ask the user: "Would you like to proceed without doc verification? (accuracy will be lower)"
   - If the user says yes, continue but set `DOC_LOOKUP_AVAILABLE=false` so Hunters/Skeptics/Fixers skip doc lookups instead of failing.
   - If the user says no, stop.

5. **Verify Context7 works**: If the key is set, run a quick smoke test:
   ```
   node SKILL_DIR/scripts/context7-api.cjs search "express" "middleware"
   ```
   (Replace `SKILL_DIR` with the resolved absolute path from step 1.)
   If it returns results, Context7 is working. If it errors, warn the user: "Context7 API returned an error — doc verification will be unavailable for this run." and set `DOC_LOOKUP_AVAILABLE=false`.

### Step 1: Parse arguments and resolve target

Follow the rules in the **Target** section above. If in branch diff or staged mode, run the appropriate git command now, collect the file list, and apply the filter.

Report to the user:
- Mode (full project / directory / file / branch diff / staged)
- Number of source files to scan (after filtering)
- Number of files filtered out

### Step 2: Read the prompt files and mode file

**MANDATORY**: You MUST read these files using the Read tool before proceeding. Do NOT skip this step or attempt to act from memory. Use the absolute SKILL_DIR path resolved in Step 0.
- `SKILL_DIR/prompts/recon.md` (skip for single-file mode)
- `SKILL_DIR/prompts/hunter.md`
- `SKILL_DIR/prompts/skeptic.md`
- `SKILL_DIR/prompts/referee.md`
- `SKILL_DIR/prompts/doc-lookup.md` (reference — included inline in hunter/skeptic/fixer prompts)

If FIX_MODE=true, also read:
- `SKILL_DIR/prompts/fixer.md`

Then read the mode-specific execution file (determined in Step 3):
- `SKILL_DIR/modes/<mode>.md`

If LOOP_MODE=true, also read:
- `SKILL_DIR/modes/loop.md` (or `fix-loop.md` if FIX_MODE is also true)

After reading, you do NOT need to keep the full prompt text in your working memory. Extract the key instructions, then pass the prompt content to subagents via their system prompts.

**Context pruning for subagents:** When passing bug lists to Skeptics, Fixers, or the Referee, only include the bugs assigned to that agent — not the full merged list. For each bug, include: BUG-ID, severity, file, lines, claim, evidence, runtime trigger, cross-references. Omit: the Hunter's internal reasoning, scan coverage stats, and any "FILES SCANNED/SKIPPED" metadata. This keeps subagent prompts lean.

### Step 3: Determine execution mode

Based on the scan target size, choose the execution mode per the **Context Budget** table.

Read the corresponding mode file:
- 1 file: `SKILL_DIR/modes/single-file.md`
- 2-10 files: `SKILL_DIR/modes/small.md`
- 11 to FILE_BUDGET: `SKILL_DIR/modes/parallel.md`
- FILE_BUDGET+1 to FILE_BUDGET*2: `SKILL_DIR/modes/extended.md`
- FILE_BUDGET*2+1 to FILE_BUDGET*3: `SKILL_DIR/modes/scaled.md`

Report the chosen mode to the user.

**Then follow the steps in the loaded mode file.** Each mode file contains the specific steps for running Hunters, Skeptics, and Referee for that mode. Execute them in order.

---

## Step 7: Present the Final Report

After the mode-specific steps complete, display the final report:

### 1. Scan metadata
- Mode (single-file / small / parallel / extended / scaled)
- Files scanned: N source files (N filtered out)
- Architecture: [summary from Recon]
- Tech stack: [framework, auth, DB from Recon]

### 2. Pipeline summary
```
Recon:     mapped N files -> CRITICAL: X | HIGH: Y | MEDIUM: Z | Tests: T | FILE_BUDGET: B
Hunters:   [Security found X, Logic found Y | dual-lens overlaps: D | merged: W unique]
Gap-fill:  [N files re-scanned, M additional findings] (or "not needed")
Reconcile: [N cross-refs: S supported, R refuted, I inconclusive] (or "not needed")
Skeptics:  [challenged X | disproved: D, accepted: A]
Referee:   confirmed N real bugs -> Critical: X | Medium: Y | Low: Z
```

### 3. Confirmed bugs table
(sorted by severity — from Referee output)

### 4. Low-confidence items
Flagged for manual review.

### 5. Dismissed findings
In a collapsed `<details>` section (for transparency).

### 6. Agent accuracy stats
- Security Hunter accuracy: X/Y confirmed (Z%)
- Logic Hunter accuracy: X/Y confirmed (Z%)
- Dual-lens findings: N — confirmation rate vs single-lens
- Skeptic accuracy: X/Y correct challenges (Z%)

### 7. Coverage assessment
- If ALL CRITICAL/HIGH files scanned: "Full coverage achieved."
- If any missed: list them with note about `--loop` mode.

If zero bugs were confirmed, say so clearly — a clean report is a good result.

**Routing after report:**
- If confirmed bugs > 0: Report "Found [N] confirmed bugs — proceeding to auto-fix.", then read `SKILL_DIR/modes/fix-pipeline.md` and execute Phase 2 automatically. Do NOT ask the user for permission — always fix confirmed bugs.
- If zero bugs confirmed: Stop here. The report is the final output.

---

## Self-Test Mode

To validate the pipeline works end-to-end, run `/bug-hunter SKILL_DIR/test-fixture/` on the included test fixture. This directory contains a small Express app with 5 intentionally planted bugs (2 Critical, 2 Medium, 1 Low). Expected results:
- Recon should classify 3 files as CRITICAL, 1 as HIGH
- Hunters should find all 5 bugs (possibly more false positives)
- Skeptic should challenge at least 1 false positive
- Referee should confirm all 5 planted bugs

If the pipeline finds fewer than 4 of the 5 planted bugs, the prompts need tuning. If it reports more than 3 false positives that survive to the Referee, the Skeptic prompt needs tightening.

The test fixture source files ship with the skill. If using `--fix` mode on the fixture, initialize its git repo first: `bash SKILL_DIR/scripts/init-test-fixture.sh`

---

## Error handling

| Step | Failure | Fallback |
|------|---------|----------|
| Recon | timeout/error | Skip Recon, Hunters use Glob-based discovery |
| Any single Hunter | timeout/error | Continue with other Hunters' findings |
| All Hunters | timeout/error | Report failure, ask user to retry with narrower scope |
| Gap-fill Hunter | timeout/error | Note missed files, continue |
| Reconciliation Agent | timeout/error | Skip, note "cross-refs unverified" |
| Skeptic-A | timeout/error | Run single Skeptic on all bugs |
| Skeptic-B | timeout/error | Use Skeptic-A's results, mark rest "unverified" |
| Referee | timeout/error | Use Skeptic's accepted list as final result |
| Git safety (Step 8a) | not a git repo | Warn user, skip branching |
| Git safety (Step 8a) | stash/branch fails | Warn, continue without safety net |
| Test baseline (Step 8c) | timeout >5min | Set BASELINE=null, cannot attribute failures |
| Test baseline (Step 8c) | command not found | Set TEST_COMMAND=null, skip test verification |
| Any single Fixer | timeout/error | Mark unfixed bugs as SKIPPED |
| All Fixers | timeout/error | Report failure, delete fix branch |
| Worktree merge (Step 9b) | merge conflict | Mark as FIX_CONFLICT, continue non-conflicting |
| Post-fix tests (Step 10a) | timeout >5min | Report "manual verification needed" |
| Post-fix tests (Step 10a) | new failures | Auto-revert failed fix commit, mark FIX_REVERTED |
| Auto-revert (Step 10b) | revert conflicts | Mark as FIX_FAILED (can't cleanly undo) |
| Post-fix re-scan (Step 10c) | timeout/error | Skip re-scan, note "fixer output not re-verified" |
