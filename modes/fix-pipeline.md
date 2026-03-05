# Phase 2: Fix Pipeline (`--fix`)

This phase takes the Referee's confirmed bug report and implements fixes. It only runs when `FIX_MODE=true` and the Referee confirmed at least one real bug.

### Step 8: Prepare for Fixing

**8a. Git safety checkpoint**

Before touching any code:
1. Run `git status --porcelain` — check for uncommitted changes
2. If dirty working tree: run `git stash push -m "bug-hunter-pre-fix-$(date +%s)"` to save user's work
3. Create a fix branch: `git checkout -b bug-hunter-fix-$(date +%Y%m%d-%H%M%S)`
4. Report: "Created branch `bug-hunter-fix-XXXX` from `[current-branch]`. User changes stashed."

If not in a git repo: warn "Not a git repo — fixes will modify files in place with no rollback. Proceed?" and skip branching.

**8b. Detect test infrastructure**

Use the Recon output (tech stack, framework) plus quick filesystem checks:

```
Detect test runner by checking (in order, stop at first match):
1. package.json -> scripts.test / scripts.test:unit / scripts.test:integration
2. Makefile / justfile -> test target
3. pytest.ini / pyproject.toml [tool.pytest] -> pytest
4. go.mod exists -> go test ./...
5. Cargo.toml exists -> cargo test
6. If none found -> set TEST_COMMAND=null (tests will be skipped)
```

Also detect:
- Typecheck command: `tsc --noEmit`, `mypy`, `cargo check`, etc.
- Build command: from package.json scripts, Makefile, etc.

Store these as `TEST_COMMAND`, `TYPECHECK_COMMAND`, `BUILD_COMMAND`. Any that aren't found are set to null.

**8c. Capture test baseline**

If TEST_COMMAND is not null:
1. Run `TEST_COMMAND` using the Bash tool (with a 5-minute timeout) BEFORE any fixes
2. Capture: total tests, passed, failed, error messages
3. Store as `BASELINE_TESTS_PASSED`, `BASELINE_TESTS_FAILED`, `BASELINE_FAILURES` (list of test names/descriptions)
4. Report: "Test baseline: [N] passed, [M] failed (pre-existing)"

If TEST_COMMAND is null or test run times out, set `BASELINE=null`. Post-fix test failures cannot be attributed.

**8d. Cluster bugs for fixers**

Group bugs for parallel execution using directory-based clustering:
1. For each bug, extract the directory of its primary file
2. Group by top-level (or second-level) directory
3. **Same-file rule**: all bugs in the same file MUST go to the same fixer (this is the only reliable dependency we can detect pre-fix)
4. Split into clusters by directory

| Confirmed bugs | Strategy |
|----------------|----------|
| 1-3 | Single fixer (no parallelism overhead) |
| 4-10 | 2 fixers by directory |
| 11+ | 3 fixers by directory |

Report: "Fix plan: [N] bugs in [G] directory clusters."

### Step 9: Execute Fixes (isolated Fixer agents)

**9a. Launch Fixer agents in worktrees**

Each Fixer runs in its own git worktree to prevent edit races:

Launch Fixer agents **in parallel** with `isolation: "worktree"`. Each Fixer receives:
- The fixer prompt (from `prompts/fixer.md`)
- Its assigned bug subset (with full Referee details: file, lines, severity, description, suggested fix)
- The tech stack context from Recon
- The note: "Fix bugs in severity order (Critical first). Your bugs are grouped by directory. All bugs in the same file are yours — handle ordering yourself."

Permission mode for Fixers:
- If `LOOP_MODE=true`: use `mode: "auto"` — autonomous execution, no user prompts
- If `LOOP_MODE=false`: use `mode: "default"` — user reviews each edit

Wait for ALL Fixers to complete.

**9b. Merge worktree changes (with checkpoint commits)**

After all Fixers complete:
1. For each Fixer that made changes, its worktree has a branch with commits
2. Cherry-pick or merge each Fixer's commits onto the fix branch, **one bug at a time as separate commits**
   - Commit message format: `fix(bug-hunter): BUG-N — [one-line description]`
   - This creates individual checkpoint commits that can be reverted independently
3. If a merge conflict occurs (two Fixers touched related code): stop and report the conflict — do NOT auto-resolve. Mark the conflicting bugs as FIX_CONFLICT.

If only ONE Fixer was used (1-3 bugs), the worktree merge is trivial — just fast-forward.

Report to user:
```
Fix execution:
- Bugs assigned: [N]
- Bugs fixed: [N] (high confidence: [H], medium: [M], low: [L])
- Bugs requiring larger refactor: [N] (minimal patches applied)
- Files modified: [list]
- Merge conflicts: [N] (manual resolution needed)
```

### Step 10: Verify Fixes

**10a. Run test suite (with baseline diff)**

If TEST_COMMAND is not null:
1. Run `TEST_COMMAND` using the Bash tool (with a 5-minute timeout)
2. Capture: total tests, passed, failed, error messages
3. **Diff against baseline**:
   - New failures = failures in post-fix run that are NOT in `BASELINE_FAILURES`
   - Resolved failures = failures in baseline that PASS now (fixes may have resolved pre-existing bugs)
   - Unchanged failures = failures in both baseline and post-fix (pre-existing, not our problem)
4. Map new failures back to modified files -> trace to which BUG-ID fix likely caused them

If TYPECHECK_COMMAND is not null:
5. Run typecheck — capture any new type errors

If BUILD_COMMAND is not null:
6. Run build — capture any build failures

Report:
```
Verification:
- Tests: [PASS/FAIL] ([N] passed, [M] failed)
  - New failures (caused by fixes): [X] — [list test names + likely BUG-ID]
  - Pre-existing failures (unchanged): [Y]
  - Resolved by fixes: [Z]
- Typecheck: [PASS/FAIL] ([N] new errors)
- Build: [PASS/FAIL]
```

**10b. Auto-revert failed fixes**

For each bug whose fix caused NEW test failures or type errors:
1. Identify the checkpoint commit for that BUG-ID (from Step 9b)
2. Run `git revert --no-edit <commit-hash>` to cleanly undo that specific fix
3. Re-run `TEST_COMMAND` to confirm the revert resolved the failure
4. Mark the bug as FIX_REVERTED (not FIX_FAILED) — the codebase is clean again
5. Report: "BUG-N fix caused [test name] to fail — auto-reverted commit [hash]."

If the revert itself causes a conflict (other fixes depend on it), skip the revert and mark as FIX_FAILED instead.

**10c. Post-fix targeted re-scan (catch fixer-introduced bugs)**

After all fixes are applied and verified, launch a single lightweight Hunter agent to scan ONLY the lines that were changed by fixers:

1. Run `git diff --unified=0 <base-branch>..HEAD` to get the exact changed line ranges
2. Build a list of `file:line_start-line_end` for every changed hunk
3. Launch one Hunter agent with this prompt:
   - "You are a post-fix verification scanner. You are given a list of code changes made by automated fixers. Your ONLY job is to check whether the fix itself introduced a new bug — wrong logic in the fix, missing edge case in new validation, broken callers from signature changes. Scan ONLY the changed lines and their immediate context (10 lines above and below). Do NOT re-report the original bugs that were being fixed. Report only NEW issues introduced by the fixes."
   - Pass the changed hunks list and the original bug descriptions (so it knows what was being fixed)
4. If the re-scan finds issues, append them to the fix report as "FIXER-INTRODUCED" findings

This is cheap (only reads changed lines) and catches the class of bugs where the cure is worse than the disease.

**10d. Determine fix status**

Classify each bug's fix status:

| Status | Criteria |
|--------|----------|
| FIXED | Fix applied, no new test failures traced to it, no fixer-introduced issues |
| FIX_REVERTED | Fix caused test failures, auto-reverted to clean state |
| FIX_FAILED | Fix caused test failures, revert not possible (other fixes depend on it) |
| PARTIAL | Minimal patch applied, Fixer noted "larger refactor needed" |
| FIX_CONFLICT | Merge conflict with another Fixer's changes |
| SKIPPED | Fixer couldn't implement (too complex, reported as skipped) |
| FIXER_BUG | Fix applied but re-scan found a new issue in the fix itself |

### Step 11: Present Fix Report

Display the fix results to the user:

```
## Fix Report

### Fix Summary
- Bugs targeted: [N]
- Fixed successfully: [N] (Critical: [C], Medium: [M], Low: [L])
- Fix reverted (caused test failures, cleanly undone): [N]
- Fix failed (caused test failures, could not revert): [N]
- Partial fixes (needs refactor): [N]
- Merge conflicts: [N]
- Skipped: [N]

### Test Results
- Test baseline (before fixes): [N] passed, [M] failed
- Test post-fix: [N] passed, [M] failed
- New failures: [X] | Resolved: [Z] | Unchanged: [Y]
- Typecheck: [PASS/FAIL]
- Build: [PASS/FAIL]

### Files Modified
[list of all files changed, with line counts]

### Fixer-Introduced Issues
[Any issues found by the post-fix re-scan — these are NEW bugs in the fix code itself, not the original bugs]

### Fix Details
[For each bug: BUG-ID, status, what was changed, confidence, notes]

### Git Info
- Fix branch: [branch name]
- Stashed user changes: [yes/no — stash ref if yes]
- Review: `git diff [base-branch]...[fix-branch]`
```

**If LOOP_MODE=true and any bugs have status FIX_FAILED or FIX_CONFLICT:**
Continue to the fix-loop iteration (see loop modes).

**If LOOP_MODE=false:**
Present the report and stop. Tell the user:
- If all fixes passed: "All [N] bugs fixed and verified on branch `[name]`. Review with `git diff`, merge when ready."
- If some failed: "Fixed [N]/[M] bugs on branch `[name]`. [K] caused test failures — review needed."
- If stash was created: "Your original changes are in `git stash list` — apply with `git stash pop` when done."
