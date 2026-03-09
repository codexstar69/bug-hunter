# Extended Mode (FILE_BUDGET+1 to FILE_BUDGET×2 files) — chunked sequential

This mode handles medium-large codebases where one deep scan would overflow context. Files are split into chunks and scanned sequentially with state persistence between chunks.

All phases use the `AGENT_BACKEND` selected during SKILL preflight.

---

## Step 4e: Run Recon

Same as Parallel mode (Step 4p). Use the backend-specific dispatch pattern to run Recon and capture the risk map + service boundaries + tech stack.

Write output to `.claude/bug-hunter-recon.md`.

---

## Step 5e: Build chunk plan

Create sequential chunks with these rules:
- Target chunk size: 20–40 source files.
- Preserve service boundaries when possible (don't split a single service across chunks).
- Order chunks by risk: CRITICAL-heavy first, then HIGH, then MEDIUM.
- Keep test files context-only and include only when needed.

Initialize state file:

1. Write the source file list to `.claude/source-files.json` (JSON array of file paths, ordered by risk).
2. Initialize state:
   ```bash
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init ".claude/bug-hunter-state.json" "extended" ".claude/source-files.json" 30
   ```

This creates `.claude/bug-hunter-state.json` with:
- `chunks[]` — each with `id`, `files`, `status` (pending → in_progress → done)
- `findings[]` — ledger that accumulates across chunks
- `lastUpdated` — timestamp

---

## Step 5e-run: Process chunks one-by-one

For each pending chunk, repeat:

### 1. Get next chunk
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" next-chunk ".claude/bug-hunter-state.json"
```
This returns the next pending chunk's ID and file list. If no pending chunks remain, skip to Step 5e-merge.

### 2. Mark in-progress
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".claude/bug-hunter-state.json" "<chunk-id>" in_progress
```

### 3. Hash cache filter (skip unchanged files)
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" hash-filter ".claude/bug-hunter-state.json" ".claude/chunk-<id>-files.json"
```
This returns a subset of files that changed since the last scan. Scan ONLY the returned `scan` files.

### 4. Run Hunter on this chunk

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/hunter.md` and `SKILL_DIR/prompts/doc-lookup.md`.
2. Execute Hunter on this chunk's files only.
3. Write chunk findings to `.claude/chunk-<id>-findings.json`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

1. Read prompts + `SKILL_DIR/templates/subagent-wrapper.md`.
2. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate hunter ".claude/payloads/hunter-chunk-<id>.json"
   ```
3. Fill: `skillDir`, `targetFiles` (this chunk's files only), `riskMap`, `techStack`.
4. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate hunter ".claude/payloads/hunter-chunk-<id>.json"
   ```
5. Fill subagent-wrapper template. In `{PHASE_SPECIFIC_CONTEXT}`, include:
   - This chunk's file list and their risk classifications
   - Any triage hints (if dual-lens triage was run)
   - "You are scanning chunk {chunk-id} of {total-chunks}."
6. Dispatch: `subagent({ agent: "hunter-chunk-<id>", task: "<filled template>", output: ".claude/chunk-<id>-findings.json" })`
7. Wait for completion.

### 5. Gap-fill for this chunk
Compare chunk Hunter's FILES SCANNED against chunk's file list. If any CRITICAL/HIGH files were skipped, scan them now (local-sequential) or dispatch a gap-fill Hunter (subagent).

### 6. Record findings in state
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" record-findings ".claude/bug-hunter-state.json" ".claude/chunk-<id>-findings.json" "extended"
```

### 7. Update hash cache
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" hash-update ".claude/bug-hunter-state.json" ".claude/chunk-<id>-scanned-files.json" scanned
```

### 8. Mark chunk done
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".claude/bug-hunter-state.json" "<chunk-id>" done
```

### Resume handling
If the process is interrupted, re-read `.claude/bug-hunter-state.json`. It contains chunk statuses. Skip chunks with status `done`. Resume from the first `pending` or `in_progress` chunk.

---

## Step 5e-merge: Merge findings across chunks

After all chunks are complete:
1. Read all findings from `.claude/bug-hunter-state.json` (the `findings` ledger).
2. Deduplicate by file + line + claim overlap (same file, overlapping line range, similar claim = duplicate).
3. Renumber BUG-IDs sequentially: BUG-1, BUG-2, etc.
4. Build a file-to-bugs index for Skeptic clustering.
5. Write merged findings to `.claude/bug-hunter-findings.md`.

---

## Step 6e: Skeptic pass

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/skeptic.md` and `SKILL_DIR/prompts/doc-lookup.md`.
2. **Switch mindset**: adversarial Skeptic.
3. Read `.claude/bug-hunter-findings.md` (merged findings).
4. For each finding: re-read actual code, check framework protections, apply risk calculation.
5. Write output to `.claude/bug-hunter-skeptic.md`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

Group bugs by directory cluster:
- If total bugs ≤ 8: dispatch ONE Skeptic on all bugs.
- If total bugs > 8: split into two cluster sets. Dispatch Skeptic-A on set 1, WAIT, then dispatch Skeptic-B on set 2 (sequential — not parallel).

For each Skeptic:
1. Read prompts + template.
2. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate skeptic ".claude/payloads/skeptic-<id>.json"
   ```
3. Fill `bugs` array with ONLY the bugs assigned to this Skeptic. Fill `techStack`.
4. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate skeptic ".claude/payloads/skeptic-<id>.json"
   ```
5. Fill template and dispatch. Wait for completion before dispatching next Skeptic.

Merge Skeptic output while preserving BUG-IDs. Write to `.claude/bug-hunter-skeptic.md`.

---

## Step 7e: Run Referee

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/referee.md`.
2. **Switch mindset**: impartial Referee.
3. Read `.claude/bug-hunter-findings.md` and `.claude/bug-hunter-skeptic.md`.
4. For Tier 1 findings: re-read actual code a THIRD time.
5. Make final verdicts. Write to `.claude/bug-hunter-referee.md`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

1. Read `SKILL_DIR/prompts/referee.md` and template.
2. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate referee ".claude/payloads/referee-extended.json"
   ```
3. Fill: `findings` from merged Hunter, `skepticResults` from merged Skeptic.
4. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate referee ".claude/payloads/referee-extended.json"
   ```
5. Dispatch. Wait for completion.

**Fallback:** If Referee fails or times out, use Skeptic-accepted bugs as the final result. Mark as `REFEREE_UNAVAILABLE` in the report.

---

## After Step 7e

Proceed to **Step 7** (Final Report) in SKILL.md. Use `.claude/bug-hunter-referee.md` for confirmed bugs.
