# Phase 2: Fix Pipeline (default; also via `--fix`/`--autonomous`)

This phase takes the Referee's confirmed bug report and implements fixes. It runs when `FIX_MODE=true` and the Referee confirmed at least one real bug.
All Fixer launches in this file must use `AGENT_BACKEND` selected during SKILL preflight.

**If `DRY_RUN_MODE=true`:** execute Steps 8a–8d only (no git branch, no edits, no lock). The Fixer reads code and outputs planned changes as unified diff previews without calling the Edit tool. Skip to Step 12 after producing the dry-run report.

### Step 8: Prepare for fixing (single-writer model)

**8a. Git safety + baseline refs**

Before touching code:
1. Run `git rev-parse --is-inside-work-tree`:
   - If not a git repo, warn and continue without rollback features.
2. If in git (skip branching and stash if `DRY_RUN_MODE=true`):
   - Capture `ORIGINAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)`
   - Capture `FIX_BASE_COMMIT=$(git rev-parse HEAD)` (used later for exact post-fix diff)
   - Run `git status --porcelain`
   - If dirty working tree, run `git stash push -m "bug-hunter-pre-fix-$(date +%s)"` and record `STASH_CREATED=true`
   - Create fix branch: `git checkout -b bug-hunter-fix-$(date +%Y%m%d-%H%M%S)`
   - Record `FIX_BRANCH` = the branch name

Report:
- Fix branch name
- Base commit hash (`FIX_BASE_COMMIT`)
- Whether stash was created

**8a-wt. Worktree isolation setup (subagent/teams backends only)**

If `AGENT_BACKEND` is `subagent` or `teams` and `worktree-harvest.cjs` exists:
1. Clean up any stale worktrees from previous failed runs:
   ```
   node "$SKILL_DIR/scripts/worktree-harvest.cjs" cleanup-all ".bug-hunter/worktrees"
   ```
2. Set `WORKTREE_MODE=true`.

If `AGENT_BACKEND` is `local-sequential` or `interactive_shell`, or `worktree-harvest.cjs` is missing:
- Set `WORKTREE_MODE=false`. No worktree setup needed — Fixer edits directly.

**IMPORTANT:** Do NOT use the Agent tool's built-in `isolation: "worktree"` parameter for Fixer dispatch. That creates an ephemeral branch and auto-cleans on exit, losing commits. We manage our own worktrees via `worktree-harvest.cjs` which keeps the Fixer on the same fix branch.

Acquire single-writer lock before edits (skip if `DRY_RUN_MODE=true`):

Compute dynamic TTL based on the number of eligible bugs:
```
ELIGIBLE_COUNT = <number of bugs with Referee confidence >= 75%>
DYNAMIC_TTL = max(1800, ELIGIBLE_COUNT * 600)   # 10 min per bug, minimum 30 min
```

```
node "$SKILL_DIR/scripts/fix-lock.cjs" acquire ".bug-hunter/fix.lock" $DYNAMIC_TTL
```
Record `LOCK_OWNER_TOKEN` from the returned JSON (`lock.ownerToken`).
If lock cannot be acquired, stop Phase 2 to avoid concurrent mutation.

**Owner token:** `acquire` returns `lock.ownerToken`; renew/release now require that token. Persist it for the entire Phase 2 run as `LOCK_OWNER_TOKEN`.

**Lock renewal:** During Step 9 execution, renew the lock after each bug fix to prevent TTL expiry on long runs:
```
node "$SKILL_DIR/scripts/fix-lock.cjs" renew ".bug-hunter/fix.lock" "$LOCK_OWNER_TOKEN"
```

**8b. Detect verification commands**

Detect and store:
- `TEST_COMMAND`
- `TYPECHECK_COMMAND`
- `BUILD_COMMAND`

Use the same detection order as before. Missing commands should be stored as `null`.

**8c. Capture pre-fix baseline (flaky test detection)**

If `TEST_COMMAND` is not null:
1. Run it once (timeout 5 minutes). Record pass/fail counts and failure identifiers.
2. Run it a **second time** (timeout 5 minutes). Record pass/fail counts and failure identifiers.
3. Compare the two runs:
   - Tests that **failed in both** runs → `BASELINE_FAILURES` (stable failures, pre-existing)
   - Tests that **failed in only one** run → `FLAKY_TESTS` (non-deterministic)
   - Tests that **passed in both** runs → reliable tests
4. Store both `BASELINE_FAILURES` and `FLAKY_TESTS` as separate sets.

**Flaky test rule (applies in Steps 10a, 10b, 10c):** When checking for new failures after a fix, a test failure that matches `FLAKY_TESTS` does NOT count as a new failure. Only failures on tests NOT in `FLAKY_TESTS` and NOT in `BASELINE_FAILURES` trigger revert decisions.

If baseline cannot run, set `BASELINE=null` and `FLAKY_TESTS={}` and continue with manual-verification warning.

**8d. Build fix strategy + sequential fix plan**

Before deciding what to patch, write `.bug-hunter/fix-strategy.json` and `.bug-hunter/fix-strategy.md`.
The strategy artifact must classify each confirmed bug into one of:
- `safe-autofix`
- `manual-review`
- `larger-refactor`
- `architectural-remediation`

If `PLAN_ONLY_MODE=true`, stop after the strategy artifact and fix-plan preview are written.

Prepare bug queue:
1. Apply confidence gate:
   - `ELIGIBLE` for auto-fix when Referee confidence >= 75%.
   - `MANUAL_REVIEW` when confidence < 75% or missing confidence.
2. Run global consistency pass on merged findings:
   - Detect reused BUG-ID collisions.
   - Detect conflicting claims on the same file/line range.
   - Resolve conflicts before edits.
3. Auto-fix queue contains `ELIGIBLE` bugs only.
4. Sort by severity: Critical → High → Medium → Low.
5. **Cross-file dependency ordering** (when `code-index.cjs` is available):
   - Build import graph from `.bug-hunter/index.json` (or run `code-index.cjs build` if index doesn't exist).
   - For each bug pair (A, B): if A's file imports B's file, B must be fixed before A (fix dependencies first).
   - Within the same dependency level, maintain severity order.
   - Fallback: if no index is available, keep severity-only ordering.
6. **Dynamic canary sizing:**
   ```
   CANARY_SIZE = max(1, min(3, ceil(ELIGIBLE_COUNT * 0.2)))
   ```
   - 1–5 eligible bugs → canary 1
   - 6–10 eligible bugs → canary 2
   - 11+ eligible bugs → canary 3
   - Build canary subset from the top `CANARY_SIZE` highest-severity eligible bugs.
7. Keep same-file bugs adjacent.
8. **Fixer batch sizing:**
   ```
   MAX_BUGS_PER_FIXER = 5
   ```
   - If a cluster or rollout batch exceeds 5 bugs, split into sequential fixer dispatches of at most 5 bugs each.
   - Each batch gets its own dispatch → verify → checkpoint cycle.
   - State persists between batches via the fix ledger.
9. Group into small clusters (max 3 bugs per cluster) for checkpoint commits.

Report: `Fix plan: [N] eligible bugs, canary=[K], rollout=[R], manual-review=[M], fixer-batches=[B].`

### Step 9: Execute fixes (sequential fixer)

Single writer rule: run one Fixer at a time. No parallel worktrees by default.

**Global Phase 2 timeout:** Set `PHASE2_DEADLINE` to 30 minutes from the start of Step 9. If the deadline is reached, halt remaining fixes, mark all unprocessed bugs as `SKIPPED` with reason "phase-2-timeout", and proceed to Step 10.

**Circuit breaker:** After each fix attempt (success or failure), check:
```
FAILURE_RATE = (count of FIX_REVERTED + FIX_FAILED) / total_attempted
```
If `FAILURE_RATE > 0.5` AND `total_attempted >= 3`:
- Halt remaining fixes immediately.
- Mark all remaining bugs as `SKIPPED` with reason "circuit-breaker-tripped".
- Report: `⚠️ Circuit breaker tripped — [X]/[Y] fixes failed. Codebase may be too unstable for auto-fix.`
- Proceed to Step 10.

Execution order:
1. Canary batches first.
2. Verify canary results.
3. Continue rollout batches only if canary verification passes.

For each batch in order:
1. Check Phase 2 timeout and circuit breaker before launching.
2. Validate Fixer payload before launch:
   ```
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate fixer ".bug-hunter/payloads/fixer-batch-<id>.json"
   ```
3. Permission mode:
   - `APPROVE_MODE=true` → `mode: "default"`
   - `APPROVE_MODE=false` → `mode: "auto"`
   - `DRY_RUN_MODE=true` → Fixer reads code and outputs planned diff only, no Edit tool calls

**Path A — Worktree mode (`WORKTREE_MODE=true`):**

4a. Prepare isolated worktree:
   ```
   node "$SKILL_DIR/scripts/worktree-harvest.cjs" prepare "$FIX_BRANCH" ".bug-hunter/worktrees/fixer-batch-<id>"
   ```
   Record `PRE_HARVEST_HEAD` from the output.

5a. Dispatch Fixer subagent with worktree CWD:
   - Compute `WORKTREE_ABS` (absolute path of the worktree directory).
   - In the Fixer task instructions, include:
     - `"Your working directory is: $WORKTREE_ABS"`
     - `"You MUST git add + git commit each fix: fix(bug-hunter): BUG-N — [description]"`
     - `"Do NOT use EnterWorktree/ExitWorktree — you are already in an isolated worktree"`
     - `"Do NOT switch branches or run git checkout"`
   - Do NOT set `isolation: "worktree"` on the Agent tool — we manage worktrees ourselves.
   - Launch one Fixer with: `prompts/fixer.md`, batch bug subset, recon tech stack context.

6a. After Fixer completes (or crashes), harvest commits:
   ```
   node "$SKILL_DIR/scripts/worktree-harvest.cjs" harvest ".bug-hunter/worktrees/fixer-batch-<id>"
   ```
   Read harvest result:
   - If `harvestedCount > 0`: record commit hashes per BUG-ID in fix ledger.
   - If `uncommittedStashed: true`: mark those bugs as `FIX_FAILED` with reason "fixer-did-not-commit".
   - If `branchSwitched: true`: mark all bugs in batch as `FIX_FAILED` with reason "branch-switched".
   - If `noChanges: true`: mark all bugs in batch as `SKIPPED`.

7a. Clean up worktree:
   ```
   node "$SKILL_DIR/scripts/worktree-harvest.cjs" cleanup ".bug-hunter/worktrees/fixer-batch-<id>"
   ```

8a. Renew lock after each batch:
   ```
   node "$SKILL_DIR/scripts/fix-lock.cjs" renew ".bug-hunter/fix.lock" "$LOCK_OWNER_TOKEN"
   ```

**Path B — Direct mode (`WORKTREE_MODE=false`):**

4b. Launch one Fixer with:
   - `prompts/fixer.md`
   - Batch bug subset (max `MAX_BUGS_PER_FIXER` bugs)
   - Recon tech stack context
5b. Apply returned changes (skip if dry-run).
6b. Commit checkpoint — **one commit per bug** (mandatory):
   - `fix(bug-hunter): BUG-N — [short description]`
   - Exception: if two bugs touch the same lines and cannot be separated, combine into a single commit with both BUG-IDs.
7b. Record commit hash per BUG-ID in a fix ledger.
8b. **Renew lock** after each bug fix:
   ```
   node "$SKILL_DIR/scripts/fix-lock.cjs" renew ".bug-hunter/fix.lock" "$LOCK_OWNER_TOKEN"
   ```

If a bug cannot be fixed, mark `SKIPPED` and continue.

### Step 10: Verify and auto-revert

**10-pre. Rejoin fix branch (worktree mode only)**

If `WORKTREE_MODE=true`:
1. Ensure all worktrees are cleaned up:
   ```
   node "$SKILL_DIR/scripts/worktree-harvest.cjs" cleanup-all ".bug-hunter/worktrees"
   ```
2. Return main working tree to the fix branch:
   ```
   node "$SKILL_DIR/scripts/worktree-harvest.cjs" checkout-fix "$FIX_BRANCH"
   ```
3. The main working tree now has all Fixer commits. Proceed with verification.

**10a. Fast checks after each checkpoint**

After each bug commit:
- Run nearest/impacted checks first (targeted tests or module typecheck).
- If targeted checks fail with **new failures** (excluding `FLAKY_TESTS` and `BASELINE_FAILURES`), revert that bug commit immediately.

**10b. End-of-run full verification**

After all batches:
1. Run full `TEST_COMMAND` (if available).
2. Compare with baseline (applying flaky test exclusion):
   - **New failures**: failures not in `BASELINE_FAILURES` and not in `FLAKY_TESTS`
   - Unchanged pre-existing failures
   - Resolved failures
3. Run `TYPECHECK_COMMAND` and `BUILD_COMMAND` when available.

**10c. Auto-revert failing bug commits**

For each BUG-ID linked to new failures (excluding flaky tests):
1. Revert its checkpoint commit with a **60-second timeout**:
   ```
   timeout 60 git revert --no-edit <hash>
   ```
2. If the revert completes successfully:
   - Re-run the smallest relevant check.
   - If failures clear: mark `FIX_REVERTED`.
   - If failures persist: mark `FIX_FAILED`.
3. If the revert **times out or conflicts** (exit code ≠ 0):
   - Run `git revert --abort` to clean up.
   - Mark `FIX_FAILED`.
   - Continue to the next BUG-ID.

**10d. Post-fix targeted re-scan (severity-gated)**

Use exact fixed scope from the real base commit:
1. Run `git diff --unified=0 "$FIX_BASE_COMMIT"..HEAD`.
2. Build changed hunks list.
3. Run one lightweight Hunter on changed hunks only with a **severity floor of MEDIUM**:
   - Only report fixer-introduced bugs at MEDIUM severity or above.
   - LOW-severity issues from the fixer are logged in `.bug-hunter/fix-report.json`
     (and optional derived `.bug-hunter/fix-report.md`) as informational notes
     but do NOT trigger `FIXER_BUG` status.

This removes ambiguity from `<base-branch>` and works for path scans, staged scans, and branch scans.

### Step 11: Determine final bug status

| Status | Criteria |
|--------|----------|
| FIXED | Fix landed, checks pass, no fixer-introduced issue |
| FIX_REVERTED | Fix introduced regression and was cleanly reverted |
| FIX_FAILED | Regression introduced and could not be cleanly reverted |
| PARTIAL | Minimal patch landed, larger refactor still required |
| SKIPPED | Fix not implemented (or circuit-breaker/timeout halted) |
| FIXER_BUG | Post-fix re-scan found a MEDIUM+ bug introduced by the fix |

### Step 12: Restore user state and report

**12-pre. Worktree cleanup (safety net)**

If `WORKTREE_MODE=true`:
```
node "$SKILL_DIR/scripts/worktree-harvest.cjs" cleanup-all ".bug-hunter/worktrees"
```
If main tree is still detached, restore to fix branch:
```
node "$SKILL_DIR/scripts/worktree-harvest.cjs" checkout-fix "$FIX_BRANCH"
```
If checkout-fix fails, fall back to `ORIGINAL_BRANCH`:
```
git checkout "$ORIGINAL_BRANCH"
```

**12a. Stash restore**

If stash was created (not applicable in dry-run mode):
1. Attempt automatic restore (`git stash pop`).
2. If restore succeeds, report `stash_restored=true`.
3. If restore conflicts, stop and report clear conflict instructions; do not discard stash.

Always release single-writer lock at the end (success or failure path):
```
node "$SKILL_DIR/scripts/fix-lock.cjs" release ".bug-hunter/fix.lock" "$LOCK_OWNER_TOKEN"
```
If an earlier step aborts Phase 2, run the same release command AND worktree cleanup-all in best-effort cleanup before returning.

Present:
- Fix summary by status
- Verification summary (baseline vs final, including flaky test exclusions)
- Circuit breaker status (tripped or not)
- Files modified
- Fix details per BUG-ID
- Git info:
  - Fix branch
  - Base commit (`FIX_BASE_COMMIT`)
  - Review command: `git diff "$FIX_BASE_COMMIT"..HEAD`
  - Stash restore outcome

**12a. Write machine-readable fix report**

Write `.bug-hunter/fix-report.json` alongside the markdown report:

```json
{
  "version": "3.0.0",
  "fix_branch": "<branch name>",
  "base_commit": "<FIX_BASE_COMMIT>",
  "dry_run": false,
  "circuit_breaker_tripped": false,
  "phase2_timeout_hit": false,
  "fixes": [
    {
      "bugId": "BUG-1",
      "severity": "CRITICAL",
      "status": "FIXED",
      "files": ["src/api/users.ts"],
      "lines": "45-49",
      "commit": "<commit hash>",
      "description": "SQL injection via unsanitized query parameter"
    },
    {
      "bugId": "BUG-4",
      "severity": "MEDIUM",
      "status": "FIX_REVERTED",
      "files": ["src/queue.ts"],
      "lines": "112-118",
      "commit": "<reverted commit hash>",
      "reason": "test regression in queue.test.ts"
    }
  ],
  "verification": {
    "baseline_pass": 45,
    "baseline_fail": 3,
    "flaky_tests": 2,
    "final_pass": 47,
    "final_fail": 1,
    "new_failures": 0,
    "resolved_failures": 2,
    "typecheck_pass": true,
    "build_pass": true,
    "fixer_bugs_found": 0
  },
  "summary": {
    "total_confirmed": 10,
    "eligible": 7,
    "manual_review": 3,
    "fixed": 5,
    "fix_reverted": 1,
    "fix_failed": 0,
    "skipped": 1,
    "fixer_bug": 0,
    "partial": 0
  }
}
```

Validate it immediately:

```bash
node "$SKILL_DIR/scripts/schema-validate.cjs" fix-report ".bug-hunter/fix-report.json"
```

Render the Markdown companion when humans need it:

```bash
node "$SKILL_DIR/scripts/render-report.cjs" fix-report ".bug-hunter/fix-report.json" > ".bug-hunter/fix-report.md"
```

Rules:
- `dry_run: true` when `DRY_RUN_MODE=true` — the `fixes` array contains planned diffs instead of commit hashes.
- `circuit_breaker_tripped: true` when the circuit breaker halted the pipeline.
- `phase2_timeout_hit: true` when the 30-minute deadline was reached.
- This JSON enables CI/CD gating, dashboard ingestion, and automated ticket creation.

If `LOOP_MODE=true`, continue to fix-loop rules for unresolved bugs.
