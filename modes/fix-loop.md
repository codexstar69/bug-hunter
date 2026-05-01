# Fix Loop Mode (`--loop --fix`)

> **Cross-harness note:** This file uses ralph-loop (Claude Code). If your
> runtime does not have `ralph_start`/`ralph_done`, use the generic loop
> pattern from `modes/loop-generic.md` and add the fix pipeline (Phase 2)
> to each iteration.

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
MAX_FIX_LOOP_ITERATIONS = max(
  15,
  min(250, ceil(SCANNABLE_FILES / max(FILE_BUDGET, 1)) + ELIGIBLE_BUG_COUNT + 8)
)

ralph_start({
  name: "bug-hunter-fix-audit",
  taskContent: <the TODO.md content below>,
  maxIterations: MAX_FIX_LOOP_ITERATIONS
})
```

3. The ralph-loop system will then drive iteration. Each iteration:
   - You receive the task prompt with the current checklist state.
   - You execute one iteration of find + fix.
   - You update `.bug-hunter/coverage.json` with results and render `.bug-hunter/coverage.md`.
   - If all bugs are FIXED and all queued scannable source files are DONE → output `<promise>COMPLETE</promise>`.
   - Otherwise → call `ralph_done` to proceed to the next iteration.

**Do NOT manually loop or re-invoke yourself.** The ralph-loop system handles iteration automatically.

## Coverage file extension for fix mode

The `.bug-hunter/coverage.json` file carries the same loop state, plus fix
entries:

```json
{
  "fixes": [
    { "bugId": "BUG-3", "status": "FIXED" },
    { "bugId": "BUG-12", "status": "FIX_FAILED" }
  ]
}
```

## Loop iteration logic

```
For each iteration:
  1. Read coverage.json
  2. Collect:
     - Unfixed bugs: latest fix status in {FIX_REVERTED, FIX_FAILED, FIX_CONFLICT, SKIPPED, FIXER_BUG, MANUAL_REVIEW}
     - Unscanned files: file status != done
  3. If unfixed bugs exist OR unscanned files exist:
     a. If unscanned files -> run Phase 1 (find pipeline) on them -> get new confirmed bugs
     b. Combine: unfixed bugs + newly confirmed bugs
     c. Run Phase 2 (fix + verify) on combined list
     d. Update coverage.json and re-render coverage.md
     e. Call ralph_done to proceed to next iteration
  4. If all bugs FIXED and all queued scannable source files are DONE:
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
- [ ] All MEDIUM files scanned
- [ ] All LOW files scanned
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
1. Read .bug-hunter/coverage.json for previous iteration state
2. Parse the `files` array — collect unscanned CRITICAL/HIGH/MEDIUM/LOW files
3. Parse the `fixes` array — collect unfixed bugs (latest entry not FIXED)
4. If unscanned files exist: run Phase 1 (find pipeline) on them
5. If unfixed bugs exist: run Phase 2 (fix pipeline) on them
6. Update coverage.json with results and render coverage.md
7. Output <promise>COMPLETE</promise> only when all queued files are DONE, all discovered bugs are FIXED, and no new test failures remain
8. Otherwise call ralph_done to continue to the next iteration
```

## Ralph-loop state file for fix mode

When `--loop --fix`, the `.bug-hunter/ralph-loop.local.md` is created automatically by the `ralph_start` tool. You do NOT need to create this file manually — just call `ralph_start` with the correct parameters.
