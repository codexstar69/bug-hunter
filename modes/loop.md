# Ralph-Loop Mode (`--loop`)

When `--loop` is present, the bug-hunter wraps itself in a ralph-loop that keeps iterating until the audit achieves full queued coverage. This is for thorough, autonomous audits where you want every queued scannable source file examined unless the user interrupts.

## CRITICAL: Starting the ralph-loop

**You MUST call the `ralph_start` tool to begin the loop.** Without this call, the loop will not iterate.

When `LOOP_MODE=true` is set (from `--loop` flag), before running the first pipeline iteration:

1. Build the task content from the TODO.md template below.
2. Call the `ralph_start` tool:

```
MAX_LOOP_ITERATIONS = max(12, min(200, ceil(SCANNABLE_FILES / max(FILE_BUDGET, 1)) + 8))

ralph_start({
  name: "bug-hunter-audit",
  taskContent: <the TODO.md content below>,
  maxIterations: MAX_LOOP_ITERATIONS
})
```

3. The ralph-loop system will then drive iteration. Each iteration:
   - You receive the task prompt with the current checklist state.
   - You execute one iteration of the bug-hunt pipeline (steps below).
   - You update `.bug-hunter/coverage.json` with results and render `.bug-hunter/coverage.md` from it.
   - If ALL queued scannable source files are DONE → output `<promise>COMPLETE</promise>` to end the loop.
   - Otherwise → call `ralph_done` to proceed to the next iteration.

**Do NOT manually loop or re-invoke yourself.** The ralph-loop system handles iteration automatically after you call `ralph_start`.

## How it works

1. **First iteration**: Run the normal pipeline (Recon → Hunters → Skeptics →
   Referee). At the end, write canonical coverage state to
   `.bug-hunter/coverage.json` and render `.bug-hunter/coverage.md` from it.

2. **Coverage check**: After each iteration, evaluate:
   - If ALL queued scannable source files show status DONE → output `<promise>COMPLETE</promise>` → loop ends
   - If any queued scannable source files are SKIPPED or PARTIAL → call `ralph_done` → loop continues
   - Do NOT stop just because the current prioritized tier is clean; continue descending through MEDIUM and LOW files automatically

3. **Subsequent iterations**: Each new iteration reads
   `.bug-hunter/coverage.json` to see what's already been done, then runs the
   pipeline ONLY on uncovered files. New findings are appended to the
   cumulative bug list.

## Coverage file format (canonical)

**`.bug-hunter/coverage.json`:**
```json
{
  "schemaVersion": 1,
  "iteration": 1,
  "status": "IN_PROGRESS",
  "files": [
    { "path": "src/auth/login.ts", "status": "done" },
    { "path": "src/api/payments.ts", "status": "pending" }
  ],
  "bugs": [
    { "bugId": "BUG-3", "severity": "Critical", "file": "src/auth/login.ts", "claim": "JWT token not validated before use" }
  ],
  "fixes": [
    { "bugId": "BUG-3", "status": "MANUAL_REVIEW" }
  ]
}
```

**`.bug-hunter/coverage.md`** is derived from the JSON artifact for humans.

## TODO.md task content for ralph_start

Use this as the `taskContent` parameter when calling `ralph_start`:

**For `--loop` (scan only):**
```markdown
# Bug Hunt Audit

## Coverage Tasks
- [ ] All CRITICAL files scanned
- [ ] All HIGH files scanned
- [ ] All MEDIUM files scanned
- [ ] All LOW files scanned
- [ ] Findings verified through Skeptic+Referee pipeline

## Completion
- [ ] ALL_TASKS_COMPLETE

## Instructions
1. Read .bug-hunter/coverage.json for previous iteration state
2. Parse the `files` array — collect all entries where `status` is not `done`
3. Run bug-hunter pipeline on those files only
4. Update coverage JSON: change file status to `done`, append bug summaries, and render coverage.md
5. Output <promise>COMPLETE</promise> only when all queued source files are DONE
6. Otherwise call ralph_done to continue to the next iteration
```

## Coverage file validation

At the start of each iteration, validate the coverage file:
1. Validate `.bug-hunter/coverage.json` against the local coverage schema.
2. If validation fails, rename the bad file to `.bug-hunter/coverage.json.bak`
   and start fresh. Warn the user.
3. Always regenerate `.bug-hunter/coverage.md` from the JSON artifact after a
   successful write.

## Iteration behavior

Each iteration after the first:
1. Read `.bug-hunter/coverage.json`
2. Collect all file entries where `status != "done"`
3. If none remain → output `<promise>COMPLETE</promise>` (this ends the ralph-loop)
4. Otherwise, run the pipeline on remaining files only (use small/parallel mode based on count)
5. Update `coverage.json`, then render `coverage.md`
6. Increment ITERATION counter
7. Call `ralph_done` to proceed to the next iteration

## Safety

- Max iterations should scale with the queue size so autonomous runs do not stop early
- Each iteration only scans NEW files — no re-scanning already-DONE files
- User can stop anytime with ESC, `/ralph-stop`, or `experiment-loop.cjs stop`
- Canonical state is in `.bug-hunter/coverage.json`; `coverage.md` is derived
  and fully resumable from that JSON

---

## Experiment Tracking (autoresearch integration)

When `LOOP_MODE=true`, each loop iteration is automatically tracked as an **experiment** using the append-only JSONL experiment log. This is active by default — no extra flags needed. It provides metric-driven optimization with baseline comparison, auto-resume, and user-interruptible stop files.

### Setup (first iteration only)

Before the first pipeline iteration, initialize the experiment session:

```bash
node scripts/experiment-loop.cjs init \
  .bug-hunter/experiment.jsonl \
  "bug-hunt-$(date +%Y%m%d)" \
  bugs_confirmed \
  higher \
  count \
  --max-iterations 10
```

The `--max-iterations` flag sets the **hard iteration cap** for the session (default: 10). The loop will automatically stop when this cap is reached — no runaway loops. Each subsequent `init` call starts a **new segment** with its own baseline and counter reset.

### Per-iteration workflow

Each iteration follows the **check-continue → run → log** pattern:

1. **Check continue** — the single gateway before every iteration:
   ```bash
   node scripts/experiment-loop.cjs check-continue \
     .bug-hunter/experiment.jsonl \
     --stop-file .bug-hunter/experiment.stop
   ```

   This checks ALL conditions in one call and returns a clear yes/no:
   - `{ "continue": true, "iteration": 3, "remaining": 7 }` — safe to proceed
   - `{ "continue": false, "reason": "user-stopped" }` — user requested stop
   - `{ "continue": false, "reason": "max-iterations-reached" }` — hit the cap
   - `{ "continue": false, "reason": "consecutive-crashes" }` — 3 crashes in a row
   - `{ "continue": false, "reason": "resume-cooldown" }` — auto-resume too soon

   **If `continue` is false, the loop MUST stop.** Do not override.

2. **Run experiment** — execute the pipeline and measure:
   ```bash
   node scripts/experiment-loop.cjs run \
     .bug-hunter/experiment.jsonl \
     "node scripts/run-bug-hunter.cjs run --files-json .bug-hunter/triage-files.json" \
     --stop-file .bug-hunter/experiment.stop \
     --checks-script .bug-hunter/experiment.checks.sh
   ```

   The run command:
   - Checks the stop file before executing (GUARDRAIL)
   - Times wall-clock duration
   - Captures stdout/stderr
   - Parses `METRIC name=value` lines from stdout
   - Runs the optional checks script if the command passes (backpressure GUARDRAIL)

3. **Log result** — record the outcome:
   ```bash
   node scripts/experiment-loop.cjs log \
     .bug-hunter/experiment.jsonl \
     keep \          # or: discard, crash, checks_failed
     12 \            # primary metric value (e.g., bugs confirmed)
     --description "Iteration 3: scanned auth + payments modules" \
     --secondary '{"false_positives":2,"files_scanned":15,"fix_success_rate":85}'
   ```

   The log command:
   - Validates secondary metric consistency (GUARDRAIL — rejects missing/new metrics unless `--force true`)
   - Auto-commits on `keep` status (configurable via `--auto-commit false`)
   - Computes delta from baseline (% improvement)
   - Returns whether this is the new best result

4. **Check status** — see cumulative progress:
   ```bash
   node scripts/experiment-loop.cjs status .bug-hunter/experiment.jsonl
   ```

### Stopping the loop

#### User-initiated stop (easy, immediate)

The user can cancel the loop at any time. These are all equivalent:

| Method | How | When it takes effect |
|--------|-----|---------------------|
| **ESC key** | Press ESC in the terminal | Immediate — kills current iteration |
| **Ctrl+C** | Terminal interrupt | Immediate |
| **`/ralph-stop`** | Type in the CLI | End of current iteration |
| **Stop file** | `node scripts/experiment-loop.cjs stop` | Before next iteration |
| **Touch file** | `touch .bug-hunter/experiment.stop` | Before next iteration |

The `check-continue` and `run` commands both check the stop file, so the loop will halt gracefully at the next natural checkpoint.

> **Interaction with ralph-loop:** ESC and Ctrl+C kill the process immediately (ralph-loop handles cleanup). The stop file is a softer mechanism — it lets the current operation finish, then halts before the next iteration. Both work independently. If a stale stop file is left behind from a previous run, `check-continue` will detect it and refuse to proceed — so always clean up.

To resume after a user stop:

```bash
node scripts/experiment-loop.cjs clear-stop
```

#### Automatic stop (system-initiated)

The system will automatically stop the loop when ANY of these conditions are met — no user action required:

| Condition | Default | Why |
|-----------|---------|-----|
| **Iteration cap reached** | 10 iterations | Prevents runaway loops. Configurable via `--max-iterations`. |
| **3 consecutive crashes** | 3 in a row | Something is broken — don't waste tokens. Fix and re-init. |
| **Resume cooldown** | 5 minutes | Prevents rapid-fire auto-resumes when agent hits context limits. |

These are the same checks that `check-continue` evaluates. The agent MUST call `check-continue` before every iteration and obey the result.

### Auto-resume on agent context limit (pi-autoresearch pattern)

When the agent's context window fills up mid-loop, it dies. On restart:

1. The agent reads `.bug-hunter/experiment.jsonl` — all state is reconstructable from this file alone
2. It reads `.bug-hunter/coverage.json` — knows which files were already scanned
3. It calls `check-continue` — which verifies the 5-minute cooldown has passed
4. If `check-continue` returns `{ "continue": true }`, it calls `record-resume` and picks up where it left off
5. If the cooldown hasn't elapsed, it waits or asks the user

```bash
# Record a resume event (resets the cooldown timer) — call this after check-continue passes
node scripts/experiment-loop.cjs record-resume .bug-hunter/experiment.jsonl
```

> **Note:** `can-resume` and `record-resume` are low-level primitives. In normal operation, always use `check-continue` as the primary gateway — it already includes the resume cooldown check along with all other conditions. Use `can-resume` only for diagnostic purposes.

This is distinct from user-initiated stop: the agent auto-resumes after context limits, but respects user stop files.

### Metrics tracked

| Metric | Type | Description |
|--------|------|-------------|
| `bugs_confirmed` | Primary | Number of bugs surviving the full adversarial pipeline |
| `false_positives` | Secondary | Findings killed by Skeptic + Referee |
| `files_scanned` | Secondary | Files processed this iteration |
| `fix_success_rate` | Secondary | % of fixes that passed verification |

Secondary metrics are **locked after the first result** in a segment. All subsequent results must provide the same set of secondary metrics (or use `--force true` to change them). This prevents inconsistent tracking.

### JSONL file format

The experiment log at `.bug-hunter/experiment.jsonl` is append-only. Each line is one of:

**Config header** (segment boundary):
```json
{"type":"config","segment":0,"timestamp":1710000000000,"name":"bug-hunt-20260313","metric":{"name":"bugs_confirmed","unit":"count","direction":"higher"}}
```

**Result entry**:
```json
{"type":"result","segment":0,"timestamp":1710000060000,"value":12,"secondaryMetrics":{"false_positives":2,"files_scanned":15},"status":"keep","description":"Iteration 1","commit":"abc1234","durationMs":45000}
```

**Resume marker**:
```json
{"type":"resume","timestamp":1710000360000}
```

### Guardrails summary

| Guardrail | Source | Implementation |
|-----------|--------|----------------|
| Stop file checked before every run | pi-autoresearch | `run` command exits immediately if `.bug-hunter/experiment.stop` exists |
| JSONL is append-only | pi-autoresearch | Never modify existing entries; full state reconstructable from log |
| Secondary metric consistency | pi-autoresearch | Rejects missing/new metrics unless `--force` is used |
| Auto-resume rate limiting | pi-autoresearch | 5-minute cooldown between resume events |
| Backpressure checks | pi-autoresearch | Optional `experiment.checks.sh` must pass before `keep` |
| Segment boundaries | pi-autoresearch | Each `init` starts fresh baseline; old segments preserved |
| Output truncation | pi-autoresearch | stdout/stderr capped at 50KB to prevent memory bloat |
