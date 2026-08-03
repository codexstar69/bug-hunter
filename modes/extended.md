# Extended Mode (FILE_BUDGET+1 to FILE_BUDGET×2 files) — chunked sequential

This mode handles larger targets that don't fit in a single Hunter pass.
Files are split into chunks processed sequentially with persistent state.
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

**If triage data exists**, tell Recon to use the triage risk map and only identify tech stack + patterns.

**If no triage data**, Recon does full file discovery and classification.

After Recon completes, read `.bug-hunter/recon.json` to extract the risk map and tech stack.

---

## Step 5: Run Chunked Hunters

### 5a. Build chunks

Partition files from `triage.scanOrder` (or the Recon risk map if no triage) into chunks:
- **Service-aware partitioning (preferred):** If triage detected multiple domains, partition by domain.
- **Risk-tier partitioning (fallback):** Process CRITICAL files first, then HIGH, then MEDIUM, then LOW.
- Chunk size: FILE_BUDGET ÷ 2 files per chunk (keep chunks small to avoid compaction).
- Keep same-directory files together when possible.

### 5b. Initialize state

```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init ".bug-hunter/state.json" "extended" ".bug-hunter/source-files.json" 30
```

### 5c. Execute chunks sequentially

For each chunk:

1. Get next chunk and mark in-progress:
   ```bash
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" next-chunk ".bug-hunter/state.json"
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".bug-hunter/state.json" "<chunk-id>" in_progress
   ```

2. Dispatch Hunter on this chunk's files using the standard dispatch pattern (see `dispatch.md`, role=`hunter`).

3. Record findings and mark done:
   ```bash
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" record-findings ".bug-hunter/state.json" ".bug-hunter/chunk-<id>-findings.json" "extended"
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".bug-hunter/state.json" "<chunk-id>" done
   ```

4. Continue to next chunk.

### 5d. Merge all findings

After all chunks complete, merge findings from state into `.bug-hunter/hunter-findings.json`.

If TOTAL FINDINGS: 0, skip Skeptic and Referee. Go to Step 7 (Final Report) in SKILL.md.

---

## Step 6: Run Skeptic(s)

Dispatch 1-2 Skeptics by directory using the standard dispatch pattern (see `dispatch.md`, role=`skeptic`).

Split bugs by directory/service so each Skeptic has a focused scope. Merge results after completion.

---

## Step 7: Run Referee

Dispatch Referee using the standard dispatch pattern (see `dispatch.md`, role=`referee`).

Pass merged Hunter findings + Skeptic challenges.

---

## After Step 7

Proceed to **Step 7** (Final Report) in SKILL.md.
