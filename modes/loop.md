# Loop contract (`--loop`, every backend)

Loop mode requests complete queued coverage, without granting mutation or
commit authority. Load this contract once alongside the selected size mode.
Use a self-driven loop unless the runtime supplies the Ralph tools below.

## Setup once

From triage, set SCANNABLE_FILES to the queued source count and FILE_BUDGET to
its file budget. Compute the same cap for the driver and experiment session:

```text
MAX_LOOP_ITERATIONS = max(12, min(200, ceil(SCANNABLE_FILES / max(FILE_BUDGET, 1)) + 8))
```

An explicit caller cap takes precedence. Initialize only a new run; reusing
`init` on resume would reset the segment counter and defeat the cap.

```bash
node "$SKILL_DIR/scripts/experiment-loop.cjs" init \
  .bug-hunter/experiment.jsonl "bug-hunt-$(date +%Y%m%d)" \
  bugs_confirmed higher count --max-iterations "$MAX_LOOP_ITERATIONS"
```

The helper also calculates this formula when given `--scannable-files` and
`--file-budget` instead of an explicit cap; without queue inputs it uses the
formula's lower bound of 12. Keep the original source-hash baseline in state.

## Check continue, run, log, coverage

Before **every** iteration (including resumed runs):

```bash
node "$SKILL_DIR/scripts/experiment-loop.cjs" check-continue \
  .bug-hunter/experiment.jsonl --stop-file .bug-hunter/experiment.stop
```

If `continue` is false, stop and report its reason and incomplete coverage via
`SKILL.md › Join and present the scan result`. Never override a stop file,
iteration cap, three consecutive crashes, or resume cooldown.

1. Read and validate coverage/state. On invalid artifacts, preserve them and
   fail closed; never reset completion evidence to silently start over.
2. Select the next pending chunk/domain in triage risk order. Do not reinitialize
   state or rescan done files. Failed chunks retry only within configured limits.
3. On the first iteration, run Recon once (except single-file mode). From
   iteration 2 onward, **reuse `.bug-hunter/recon.json` and skip Recon** while
   hashes of triage-listed files match the original baseline. Revalidate the
   artifact before reuse. Changed hashes invalidate context: stop the current
   run for source-integrity failure and start a new triage/baseline/Recon run;
   never silently rebaseline an interrupted audit.
4. Run the selected mode's Hunter, then Skeptic and Referee only for nonempty
   findings, with the reused Recon context. A composition runner must receive
   a real `--worker-cmd` that writes canonical artifacts.
5. Log each iteration, including clean coverage and crashes. Use actual counts;
   a clean iteration with new coverage is `keep`, not a reason to stop:

   ```bash
   node "$SKILL_DIR/scripts/experiment-loop.cjs" log \
     .bug-hunter/experiment.jsonl keep "<confirmed-count>" \
     --description "Iteration N: scanned X files" --auto-commit false
   ```

   Use `crash` for a failed iteration and `discard` for no new coverage. Keep
   secondary metric keys consistent within a segment.
6. Update schema-valid `.bug-hunter/coverage.json` from per-file evidence and
   render `.bug-hunter/coverage.md`. Preserve cumulative findings and verdicts.
   Completion requires terminal queued coverage and resolved required review;
   failed files remain visible and cannot support a clean/full-coverage claim.
7. If work remains, return to check-continue; otherwise join the final report.
   A cap or blocker ends with an honest partial result.

## If your runtime has ralph_start/ralph_done

Call `ralph_start` once with `maxIterations: MAX_LOOP_ITERATIONS`, name
`bug-hunter-audit`, and taskContent containing the numbered workflow above plus
these tasks: pending CRITICAL, HIGH, MEDIUM, LOW coverage; adversarial review;
canonical coverage update; final joined report. The experiment cap and Ralph
cap must agree. Ralph then drives iterations; do not also start a manual loop.

Each callback still checks continue before work and logs the outcome. Call
`ralph_done` only when more work is permitted and remains. Emit
`<promise>COMPLETE</promise>` only after the completion gate above passes. If a
guardrail stops the session, terminate the driver without a completion promise.

## Stop and resume

Interrupts or the stop file end work. Resume uses check-continue first, then
`record-resume` after the cooldown passes; do not call init again. Clear a user
stop only following a new request to resume. Read `docs/usage-guide.md` for
experiment metrics, append-only JSONL, and diagnostic commands when needed.
