# Ralph-Loop Mode (`--loop`)

When `--loop` is present, the bug-hunter wraps itself in a ralph-loop that keeps iterating until the audit achieves full coverage. This is for thorough, autonomous audits where you want every file examined.

## CRITICAL: Starting the ralph-loop

**You MUST call the `ralph_start` tool to begin the loop.** Without this call, the loop will not iterate.

When `LOOP_MODE=true` is set (from `--loop` flag), before running the first pipeline iteration:

1. Build the task content from the TODO.md template below.
2. Call the `ralph_start` tool:

```
ralph_start({
  name: "bug-hunter-audit",
  taskContent: <the TODO.md content below>,
  maxIterations: 10
})
```

3. The ralph-loop system will then drive iteration. Each iteration:
   - You receive the task prompt with the current checklist state.
   - You execute one iteration of the bug-hunt pipeline (steps below).
   - You update `.bug-hunter/coverage.md` with results.
   - If ALL CRITICAL/HIGH files are DONE → output `<promise>COMPLETE</promise>` to end the loop.
   - Otherwise → call `ralph_done` to proceed to the next iteration.

**Do NOT manually loop or re-invoke yourself.** The ralph-loop system handles iteration automatically after you call `ralph_start`.

## How it works

1. **First iteration**: Run the normal pipeline (Recon → Hunters → Skeptics → Referee). At the end, write a coverage report to `.bug-hunter/coverage.md` using the machine-parseable format below.

2. **Coverage check**: After each iteration, evaluate:
   - If ALL CRITICAL and HIGH files show status DONE → output `<promise>COMPLETE</promise>` → loop ends
   - If any CRITICAL/HIGH files are SKIPPED or PARTIAL → call `ralph_done` → loop continues
   - If only MEDIUM files remain uncovered → output `<promise>COMPLETE</promise>` (MEDIUM gaps are acceptable)

3. **Subsequent iterations**: Each new iteration reads `.bug-hunter/coverage.md` to see what's already been done, then runs the pipeline ONLY on uncovered files. New findings are appended to the cumulative bug list.

## Coverage file format (machine-parseable)

**`.bug-hunter/coverage.md`:**
```markdown
# Bug Hunt Coverage
SCHEMA_VERSION: 2

## Meta
ITERATION: [N]
STATUS: [IN_PROGRESS | COMPLETE]
TOTAL_BUGS_FOUND: [N]
TIMESTAMP: [ISO 8601]
CHECKSUM: [line_count of Files section]|[line_count of Bugs section]

## Files
<!-- One line per file. Format: TIER|PATH|STATUS|ITERATION_SCANNED|BUGS_FOUND -->
<!-- STATUS: DONE | PARTIAL | SKIPPED -->
<!-- BUGS_FOUND: comma-separated BUG-IDs, or NONE -->
CRITICAL|src/auth/login.ts|DONE|1|BUG-3,BUG-7
CRITICAL|src/auth/middleware.ts|DONE|1|NONE
HIGH|src/api/users.ts|DONE|1|BUG-12
HIGH|src/api/payments.ts|SKIPPED|0|
MEDIUM|src/utils/format.ts|SKIPPED|0|
TEST|src/auth/login.test.ts|CONTEXT|1|

## Bugs
<!-- One line per confirmed bug. Format: BUG-ID|SEVERITY|FILE|LINES|ONE_LINE_DESCRIPTION -->
BUG-3|Critical|src/auth/login.ts|45-52|JWT token not validated before use
BUG-7|Medium|src/auth/login.ts|89|Password comparison uses timing-unsafe equality
BUG-12|Low|src/api/users.ts|120-125|Missing null check on optional profile field
```

## TODO.md task content for ralph_start

Use this as the `taskContent` parameter when calling `ralph_start`:

**For `--loop` (scan only):**
```markdown
# Bug Hunt Audit

## Coverage Tasks
- [ ] All CRITICAL files scanned
- [ ] All HIGH files scanned
- [ ] Findings verified through Skeptic+Referee pipeline

## Completion
- [ ] ALL_TASKS_COMPLETE

## Instructions
1. Read .bug-hunter/coverage.md for previous iteration state
2. Parse the Files table — collect all lines where STATUS is not DONE and TIER is CRITICAL or HIGH
3. Run bug-hunter pipeline on those files only
4. Update coverage file: change STATUS to DONE, add BUG-IDs
5. Output <promise>COMPLETE</promise> when all CRITICAL/HIGH files are DONE
6. Otherwise call ralph_done to continue to the next iteration
```

## Coverage file validation

At the start of each iteration, validate the coverage file:
1. Check `SCHEMA_VERSION: 2` exists on line 2 — if missing, this is a v1 file; migrate by adding the header
2. Parse the CHECKSUM field: `[file_lines]|[bug_lines]` — count actual lines in Files and Bugs sections
3. If counts don't match the checksum, the file may be corrupted. Warn: "Coverage file checksum mismatch (expected X|Y, got A|B). Re-scanning affected files." Then set any files with mismatched data to STATUS=PARTIAL for re-scan.
4. If the file fails to parse entirely (malformed lines, missing sections), rename it to `.bug-hunter/coverage.md.bak` and start fresh. Warn user.

Update the CHECKSUM every time you write to the coverage file.

## Iteration behavior

Each iteration after the first:
1. Read `.bug-hunter/coverage.md` — parse the Files table
2. Collect all lines where STATUS != DONE and TIER is CRITICAL or HIGH
3. If none remain → output `<promise>COMPLETE</promise>` (this ends the ralph-loop)
4. Otherwise, run the pipeline on remaining files only (use small/parallel mode based on count)
5. Update the coverage file: set STATUS to DONE for scanned files, append new bugs to the Bugs section
6. Increment ITERATION counter
7. Call `ralph_done` to proceed to the next iteration

## Safety

- Max 10 iterations by default (set via `ralph_start({ maxIterations: 10 })`)
- Each iteration only scans NEW files — no re-scanning already-DONE files
- User can stop anytime with ESC or `/ralph-stop`
- All state is in `.bug-hunter/coverage.md` — fully resumable, machine-parseable
