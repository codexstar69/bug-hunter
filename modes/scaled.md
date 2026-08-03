# Scaled Mode (FILE_BUDGET×2+1 to FILE_BUDGET×3 files) — state-driven sequential

This mode handles large targets requiring 3+ chunks with full resume state.
All phases are dispatched using the `AGENT_BACKEND` selected during SKILL preflight.

---

## Triage Integration

Before any phase, check for `.bug-hunter/triage.json` (written by Step 1). If present:
- Use `triage.riskMap` as the risk map — skip Recon's file classification.
- Use `triage.scanOrder` as the chunk-building source (files already priority-ordered).
- Use `triage.fileBudget` as FILE_BUDGET and chunk size cap.
- Use `triage.domains` for service-aware partitioning if available.
- Recon becomes an enrichment pass: identify tech stack and trust boundary patterns only.

---

## Step 4: Run Recon

Dispatch Recon using the standard dispatch pattern (see `dispatch.md`, role=`recon`).

Same as Extended mode: Recon enriches triage data with tech stack and patterns. If no triage, Recon does full discovery.

---

## Step 5: Run Chunked Hunters with Resume State

### 5a. Build chunks and initialize state

Same as Extended mode. Partition from `triage.scanOrder` or risk map. Initialize state:
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init ".bug-hunter/state.json" "scaled" ".bug-hunter/source-files.json" 30
```

### 5b. Execute chunks with hash-based skip filtering

Before each chunk, apply skip filtering to avoid re-scanning files already processed (handles resume after interruption):
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" hash-filter ".bug-hunter/state.json" ".bug-hunter/chunk-<id>-files.json"
```

For each chunk: dispatch Hunter, record findings, mark done — same pattern as Extended mode.

### 5c. Cross-chunk consistency

After all chunks complete:
1. Merge findings from state into `.bug-hunter/hunter-findings.json`.
2. Run consistency check: look for duplicate BUG-IDs across chunks and conflicting claims on the same file/line.
3. Resolve conflicts: keep the finding with the stronger evidence.

If TOTAL FINDINGS: 0, skip Skeptic and Referee. Go to Step 7 (Final Report) in SKILL.md.

---

## Step 6: Run Skeptic(s)

Dispatch 1-2 Skeptics by directory using the standard dispatch pattern (see `dispatch.md`, role=`skeptic`).

Split bugs by directory/service for focused scope. Merge results.

---

## Step 7: Run Referee

Dispatch Referee using the standard dispatch pattern (see `dispatch.md`, role=`referee`).

Pass merged Hunter findings + Skeptic challenges.

---

## After Step 7

Proceed to **Step 7** (Final Report) in SKILL.md.

If `--loop` was specified and coverage is incomplete, the ralph-loop will iterate to cover the remaining queued files until the queue is exhausted or the user interrupts.
