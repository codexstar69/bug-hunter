# Fix Loop Mode (`--loop --fix`)

When both `--loop` and `--fix` are set, the ralph-loop wraps the ENTIRE pipeline (find + fix). Each iteration:

1. **Phase 1**: Find bugs (or read from previous coverage file for remaining bugs)
2. **Phase 2**: Fix confirmed bugs
3. **Verify**: Run tests with baseline diff
4. **Evaluate**: Update coverage file with fix status

## Coverage file extension for fix mode

The `.claude/bug-hunter-coverage.md` file gains additional sections:

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
     e. Continue loop
  4. If all bugs FIXED and all CRITICAL/HIGH files DONE:
     -> Run final test suite one more time
     -> If no new failures:
        Mark [x] ALL_TASKS_COMPLETE in TODO.md
        Output <promise>DONE</promise>
     -> If pre-existing failures only:
        Note "pre-existing test failures — not caused by bug fixes"
        Mark [x] ALL_TASKS_COMPLETE
        Output <promise>DONE</promise>
```

## TODO.md for fix loop

When `--loop --fix` is active, the TODO.md includes fix tasks:

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
```

## Ralph-loop state file for fix mode

When `--loop --fix`, the `.claude/ralph-loop.local.md` is:

```markdown
---
active: true
iteration: 0
max_iterations: 15
completion_promise: null
---

# Bug Hunt + Fix Audit Loop

## Objective
Find all bugs in the codebase, fix them, and verify fixes pass tests.

## Completion Criteria
Complete when TODO.md shows [x] ALL_TASKS_COMPLETE

## Verification
Check .claude/bug-hunter-coverage.md:
- All CRITICAL/HIGH files must show DONE in Files section
- All bugs must show FIXED (latest entry) in Fixes section
- Latest Test Results line must show 0 new failures

## Instructions
1. Read .claude/bug-hunter-coverage.md for previous iteration state
2. Parse Files table — collect unscanned CRITICAL/HIGH files
3. Parse Fixes table — collect unfixed bugs (latest entry: FIX_REVERTED, FIX_FAILED, FIX_CONFLICT, SKIPPED, FIXER_BUG)
4. If unscanned files exist: run Phase 1 (find pipeline) on them
5. If unfixed bugs exist: run Phase 2 (fix pipeline) on them
6. Update coverage file with results
7. Mark ALL_TASKS_COMPLETE only when all bugs are FIXED and no new test failures
```
