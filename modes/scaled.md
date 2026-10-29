# Scaled Mode (FILE_BUDGET×2+1 to FILE_BUDGET×3 files) — state-driven sequential

This mode handles large targets requiring 3+ chunks with full resume state.
All phases are dispatched using the `AGENT_BACKEND` selected during SKILL preflight.

---

## Triage Integration

Before any phase, check for `.bug-hunter/triage.json` (written by `SKILL.md › Deterministic triage before model work`). If present:
- Use `triage.riskMap` as the risk map — skip Recon's file classification.
- Use `triage.scanOrder` as the chunk-building source (files already priority-ordered).
- Use `triage.fileBudget` as FILE_BUDGET and chunk size cap.
- Use `triage.domains` for service-aware partitioning if available.
- Recon becomes an enrichment pass: identify tech stack and trust boundary patterns only.

---

## Run Recon

Under `--loop`, reuse validated `.bug-hunter/recon.json` while triage-listed
source hashes match the baseline; skip this phase after the first iteration
as required by `modes/loop.md`.

Dispatch Recon using the standard dispatch pattern (see `dispatch.md`, role=`recon`).

Recon enriches triage with technology and trust-boundary patterns. Pass its
canonical output to each Hunter. Without triage, run deterministic triage first.

---

## Run Chunked Hunters with Resume State

### 5a. Build chunks and initialize state

Partition `triage.scanOrder` within domains when available, preserving risk
order. Bound each chunk by FILE_BUDGET and SOURCE_TOKEN_BUDGET (caller value or
48000). Write that order to `.bug-hunter/source-files.json`. Initialize once:
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init ".bug-hunter/state.json" "scaled" ".bug-hunter/source-files.json" "$FILE_BUDGET" "$SOURCE_TOKEN_BUDGET" true
```

### 5b. Execute chunks with hash-based skip filtering

Before each chunk, apply skip filtering to avoid re-scanning files already processed (handles resume after interruption):
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" hash-filter ".bug-hunter/state.json" ".bug-hunter/chunk-<id>-files.json"
```

For each next chunk, dispatch Hunter with a fresh output path and validate
before recording findings and completion:

```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" next-chunk .bug-hunter/state.json
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk .bug-hunter/state.json "<chunk-id>" in_progress
node "$SKILL_DIR/scripts/schema-validate.cjs" findings ".bug-hunter/chunk-<id>-findings.json"
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" record-findings .bug-hunter/state.json ".bug-hunter/chunk-<id>-findings.json" scaled
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk .bug-hunter/state.json "<chunk-id>" done
```

A failed source-hash or artifact check fails the chunk closed; never mark it
done. Resume retains the original baseline and does not reinitialize state.

### 5c. Cross-chunk consistency

After all chunks complete:
1. Merge findings from state into `.bug-hunter/hunter-findings.json`.
2. Run consistency check: look for duplicate BUG-IDs across chunks and conflicting claims on the same file/line.
3. Resolve conflicts: keep the finding with the stronger evidence.

If TOTAL FINDINGS: 0, skip Skeptic and Referee. Go to `SKILL.md › Join and present the scan result`.

---

## Run Skeptic(s)

Dispatch 1-2 Skeptics by directory using the standard dispatch pattern (see `dispatch.md`, role=`skeptic`).

Split bugs by directory/service for focused scope. Merge results.

---

## Run Referee

Dispatch Referee using the standard dispatch pattern (see `dispatch.md`, role=`referee`).

Pass merged Hunter findings + Skeptic challenges.

---

## Return to the scan report

Proceed to `SKILL.md › Join and present the scan result`.

If `--loop` was specified and coverage is incomplete, the shared loop contract will iterate to cover the remaining queued files until the queue is exhausted or the user interrupts.
