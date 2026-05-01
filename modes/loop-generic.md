# Generic Loop Mode (non-ralph agents)

> **Cross-harness note:** This file describes the self-driven loop for agents
> that do NOT have `ralph_start`/`ralph_done` tools. If your runtime has ralph
> (Claude Code), use `modes/loop.md` instead.

When `LOOP_MODE=true` and `ralph_start` is not available, the agent drives
iteration itself using `experiment-loop.cjs` for state tracking, stop-file
safety, and iteration caps.

## How it works

You loop yourself: run one pipeline iteration on uncovered files, log the
result, check whether to continue, and repeat. The experiment-loop scripts
handle all guardrails (max iterations, consecutive crash detection, stop file,
resume cooldown).

## Setup (once, before the first iteration)

```bash
node "$SKILL_DIR/scripts/experiment-loop.cjs" init \
  .bug-hunter/experiment.jsonl \
  "bug-hunt-$(date +%Y%m%d)" \
  bugs_confirmed \
  higher \
  count \
  --max-iterations "$MAX_LOOP_ITERATIONS"
```

Default `MAX_LOOP_ITERATIONS` = 10 unless the user specifies otherwise.

## Iteration pattern

For each iteration:

### 1. Check whether to continue

```bash
node "$SKILL_DIR/scripts/experiment-loop.cjs" check-continue \
  .bug-hunter/experiment.jsonl \
  --stop-file .bug-hunter/experiment.stop
```

If `continue` is `false`, stop the loop immediately. Report the reason to
the user and proceed to Step 7 (Final Report).

### 2. Determine which files remain

Read `.bug-hunter/state.json` (if it exists) to find files with status
`pending` or `failed`. If no state file exists, this is the first iteration
- run the full pipeline from Step 1.

### 3. Run one pipeline iteration

Execute the standard pipeline (Recon -> Hunter -> Skeptic -> Referee) on
the next chunk of uncovered files. Follow the mode file for the current
strategy (parallel, extended, scaled, etc.).

### 4. Log the iteration result

```bash
node "$SKILL_DIR/scripts/experiment-loop.cjs" log \
  .bug-hunter/experiment.jsonl \
  keep \
  <bugs_confirmed_count> \
  --description "Iteration N: scanned X files, confirmed Y bugs" \
  --auto-commit false
```

Use `keep` if the iteration found bugs or achieved coverage.
Use `discard` if nothing new was found.
Use `crash` if the iteration failed.

### 5. Check coverage

If ALL queued scannable source files show status DONE in state.json:
- The loop is complete. Proceed to Step 7 (Final Report).

If files remain:
- Go back to step 1 (check-continue).

## Stop mechanisms

Users can halt the loop at any time:

| Method | How | Takes Effect |
|--------|-----|-------------|
| **Stop file** | `touch .bug-hunter/experiment.stop` | Before next iteration |
| **Interrupt** | ESC / Ctrl+C | Immediately |
| **Max iterations** | Automatic | After N iterations |
| **Consecutive crashes** | 3 crashes in a row | Automatic halt |

## Resuming after interruption

If the loop was interrupted and the agent restarts:

```bash
node "$SKILL_DIR/scripts/experiment-loop.cjs" can-resume .bug-hunter/experiment.jsonl
```

If `canResume` is true:
```bash
node "$SKILL_DIR/scripts/experiment-loop.cjs" record-resume .bug-hunter/experiment.jsonl
```
Then continue the iteration pattern from step 1.

If `canResume` is false (cooldown active), wait or ask the user.
