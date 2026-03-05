# Ralph-Loop Mode (`--loop`)

When `--loop` is present, the bug-hunter wraps itself in a ralph-loop that keeps iterating until the audit achieves full coverage. This is for thorough, autonomous audits where you want every file examined.

## How it works

1. **First iteration**: Run the normal pipeline (Recon -> Hunters -> Skeptics -> Referee). At the end, write a coverage report to `.claude/bug-hunter-coverage.md` using the machine-parseable format below.

2. **Coverage check**: After each iteration, evaluate:
   - If ALL CRITICAL and HIGH files show status DONE -> mark `[x] ALL_TASKS_COMPLETE` in TODO.md -> loop ends
   - If any CRITICAL/HIGH files are SKIPPED or PARTIAL -> update TODO.md with remaining work -> loop continues
   - If only MEDIUM files remain uncovered -> mark complete (MEDIUM gaps are acceptable)

3. **Subsequent iterations**: Each new iteration reads `.claude/bug-hunter-coverage.md` to see what's already been done, then runs the pipeline ONLY on uncovered files. New findings are appended to the cumulative bug list.

## Coverage file format (machine-parseable)

**`.claude/bug-hunter-coverage.md`:**
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

## Setup (automatic)

When `--loop` is detected, before running Step 1, create these files:

**`.claude/ralph-loop.local.md`:**
```markdown
---
active: true
iteration: 0
max_iterations: 10
completion_promise: null
---

# Bug Hunt Audit Loop

## Objective
Complete adversarial bug audit with full coverage of all CRITICAL and HIGH risk files.

## Completion Criteria
Complete when TODO.md shows [x] ALL_TASKS_COMPLETE

## Verification
Check .claude/bug-hunter-coverage.md — all CRITICAL/HIGH files must show DONE.

## Instructions
1. Read .claude/bug-hunter-coverage.md for previous iteration state
2. Parse the Files table — collect all lines where STATUS is not DONE and TIER is CRITICAL or HIGH
3. Run bug-hunter pipeline on those files only
4. Update coverage file: change STATUS to DONE, add BUG-IDs
5. Mark ALL_TASKS_COMPLETE only when all CRITICAL/HIGH files are DONE
```

**`TODO.md`** (or append to existing):
```markdown
# Bug Hunt Audit

## Coverage Tasks
- [ ] All CRITICAL files scanned
- [ ] All HIGH files scanned
- [ ] Findings verified through Skeptic+Referee pipeline

## Completion
- [ ] ALL_TASKS_COMPLETE
```

## Coverage file validation

At the start of each iteration, validate the coverage file:
1. Check `SCHEMA_VERSION: 2` exists on line 2 — if missing, this is a v1 file; migrate by adding the header
2. Parse the CHECKSUM field: `[file_lines]|[bug_lines]` — count actual lines in Files and Bugs sections
3. If counts don't match the checksum, the file may be corrupted. Warn: "Coverage file checksum mismatch (expected X|Y, got A|B). Re-scanning affected files." Then set any files with mismatched data to STATUS=PARTIAL for re-scan.
4. If the file fails to parse entirely (malformed lines, missing sections), rename it to `.claude/bug-hunter-coverage.md.bak` and start fresh. Warn user.

Update the CHECKSUM every time you write to the coverage file.

## Iteration behavior

Each iteration after the first:
1. Read `.claude/bug-hunter-coverage.md` — parse the Files table
2. Collect all lines where STATUS != DONE and TIER is CRITICAL or HIGH
3. If none remain -> update TODO.md with `[x] ALL_TASKS_COMPLETE` -> output `<promise>DONE</promise>`
4. Otherwise, run the pipeline on remaining files only (use small/parallel mode based on count)
5. Update the coverage file: set STATUS to DONE for scanned files, append new bugs to the Bugs section
6. Increment ITERATION counter
7. The ralph-loop hook detects no completion promise -> feeds the prompt back -> next iteration starts

## Safety

- Max 10 iterations by default (adjustable in the state file)
- Each iteration only scans NEW files — no re-scanning already-DONE files
- User can stop anytime: `rm .claude/ralph-loop.local.md`
- All state is in `.claude/bug-hunter-coverage.md` — fully resumable, machine-parseable
