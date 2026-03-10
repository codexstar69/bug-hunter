# Fix Loop Mode (`--loop --fix`)

When both `--loop` and `--fix` are set, the ralph-loop wraps the ENTIRE pipeline (find + fix). Each iteration:

1. **Phase 1**: Find bugs (or read from previous coverage file for remaining bugs)
2. **Phase 2**: Fix confirmed bugs
3. **Verify**: Run tests with baseline diff
4. **Evaluate**: Update coverage file with fix status

## CRITICAL: Starting the ralph-loop

**You MUST call the `ralph_start` tool to begin the loop.** Without this call, the loop will not iterate.

When `LOOP_MODE=true` AND `FIX_MODE=true`, before running the first pipeline iteration:

1. Build the task content from the TODO.md template below.
2. Call the `ralph_start` tool:

```
ralph_start({
  name: "bug-hunter-fix-audit",
  taskContent: <the TODO.md content below>,
  maxIterations: 15
})
```

3. The ralph-loop system will then drive iteration. Each iteration:
   - You receive the task prompt with the current checklist state.
   - You execute one iteration of find + fix.
   - You update `.bug-hunter/coverage.md` with results.
   - If all bugs are FIXED and all CRITICAL/HIGH files are DONE → output `<promise>COMPLETE</promise>`.
   - Otherwise → call `ralph_done` to proceed to the next iteration.

**Do NOT manually loop or re-invoke yourself.** The ralph-loop system handles iteration automatically.

## Coverage file extension for fix mode

The `.bug-hunter/coverage.md` file gains additional sections:

```markdown
## Fixes
<!-- One line per bug. LATEST entry per BUG-ID is current status. -->
<!-- Format: BUG-ID|STATUS|ITERATION_FIXED|FILES_MODIFIED -->
<!-- STATUS: FIXED | FIX_REVERTED | FIX_FAILED | PARTIAL | FIX_CONFLICT | SKIPPED | FIXER_BUG -->
BUG-3|FIXED|1|src/auth/login.ts
BUG-7|FIXED|1|src/auth/login.ts
BUG-12|FIXED|2|src/api/users.ts

## Test Results
<!-- One line per iteration. Format: ITERATION|PASSED|FAILED|NEW_FAILURES|RESOLVED -->
1|45|3|2|0
2|47|1|0|1
```

**Parsing rule:** For each BUG-ID, use the LAST entry in the Fixes section. Earlier entries for the same BUG-ID are history — only the latest matters.

## Loop iteration logic

```
For each iteration:
  1. Read coverage file
  2. Collect (using LAST entry per BUG-ID):
     - Unfixed bugs: latest STATUS in {FIX_REVERTED, FIX_FAILED, FIX_CONFLICT, SKIPPED, FIXER_BUG}
     - Unscanned files: STATUS != DONE in Files section (CRITICAL/HIGH only)
  3. If unfixed bugs exist OR unscanned files exist:
     a. If unscanned files -> run Phase 1 (find pipeline) on them -> get new confirmed bugs
     b. Combine: unfixed bugs + newly confirmed bugs
     c. Run Phase 2 (fix + verify) on combined list
     d. Update coverage file (append new entries to Fixes section)
     e. Call ralph_done to proceed to next iteration
  4. If all bugs FIXED and all CRITICAL/HIGH files DONE:
     -> Run final test suite one more time
     -> If no new failures:
        Output <promise>COMPLETE</promise>
     -> If pre-existing failures only:
        Note "pre-existing test failures — not caused by bug fixes"
        Output <promise>COMPLETE</promise>
```

## TODO.md task content for ralph_start

Use this as the `taskContent` parameter when calling `ralph_start`:

```markdown
# Bug Hunt + Fix Audit

## Discovery Tasks
- [ ] All CRITICAL files scanned
- [ ] All HIGH files scanned
- [ ] Findings verified through Skeptic+Referee pipeline

## Fix Tasks
- [ ] All Critical bugs fixed
- [ ] All Medium bugs fixed
- [ ] All Low bugs fixed (best effort)
- [ ] No new test failures introduced
- [ ] Build and typecheck pass

## Completion
- [ ] ALL_TASKS_COMPLETE

## Instructions
1. Read .bug-hunter/coverage.md for previous iteration state
2. Parse Files table — collect unscanned CRITICAL/HIGH files
3. Parse Fixes table — collect unfixed bugs (latest entry not FIXED)
4. If unscanned files exist: run Phase 1 (find pipeline) on them
5. If unfixed bugs exist: run Phase 2 (fix pipeline) on them
6. Update coverage file with results
7. Output <promise>COMPLETE</promise> when all bugs are FIXED and no new test failures
8. Otherwise call ralph_done to continue to the next iteration
```

## Ralph-loop state file for fix mode

When `--loop --fix`, the `.bug-hunter/ralph-loop.local.md` is created automatically by the `ralph_start` tool. You do NOT need to create this file manually — just call `ralph_start` with the correct parameters.
