# Scaled Mode (FILE_BUDGET×2+1 to FILE_BUDGET×3 files) — state-driven sequential

Use this mode for large scans that still fit in one run but require strict state tracking and anti-compaction controls. All progress is checkpointed to `.claude/bug-hunter-state.json` so interrupted runs can resume.

All phases use the `AGENT_BACKEND` selected during SKILL preflight.

---

## Step 4s: Run Recon

Same as Extended mode (Step 4e). Use the backend-specific dispatch pattern to run Recon and capture risk map + service boundaries + tech stack.

Write output to `.claude/bug-hunter-recon.md`.

---

## Step 5s: Initialize durable run state

Create or load `.claude/bug-hunter-state.json`. If the file already exists (interrupted run), **resume from it** — do NOT restart.

**Initialize when missing:**

1. Write the source file list to `.claude/source-files.json` (JSON array of file paths, ordered by risk from Recon).
2. Initialize state:
   ```bash
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init ".claude/bug-hunter-state.json" "scaled" ".claude/source-files.json" 30
   ```

This creates a state file with:
- `runId` — unique identifier for this run
- `mode: "scaled"`
- `chunks[]` — each with `id`, `files`, `status` (pending → in_progress → done), `retries`
- `findings[]` — bug ledger with stable BUG-IDs
- `scanMetrics` — files_scanned, findings_count, timestamps
- `parallelDisabled` — flag, starts false

**Resume:** If `.claude/bug-hunter-state.json` already exists, read it and skip to Step 6s. Process only chunks with status `pending` or `in_progress`.

---

## Step 6s: Sequential chunk loop

Process ONE chunk at a time. After each chunk, persist findings to state before starting the next.

### For each pending chunk:

#### 1. Get next chunk
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" next-chunk ".claude/bug-hunter-state.json"
```
Returns the next pending chunk's ID and file list. If no pending chunks remain, skip to Step 7s.

#### 2. Mark in-progress
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".claude/bug-hunter-state.json" "<chunk-id>" in_progress
```

#### 3. Hash cache filter
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" hash-filter ".claude/bug-hunter-state.json" ".claude/chunk-<id>-files.json"
```
Returns a filtered file list. Scan ONLY the returned `scan` files (skips unchanged files from previous partial runs).

#### 4. Run Hunter on this chunk

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/hunter.md` and `SKILL_DIR/prompts/doc-lookup.md`.
2. Execute Hunter on this chunk's filtered files.
3. Track FILES SCANNED / FILES SKIPPED honestly.
4. Write findings to `.claude/chunk-<id>-findings.json`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

1. Read prompts + `SKILL_DIR/templates/subagent-wrapper.md`.
2. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate hunter ".claude/payloads/hunter-chunk-<id>.json"
   ```
3. Fill: `skillDir`, `targetFiles` (this chunk's filtered files), `riskMap`, `techStack`.
4. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate hunter ".claude/payloads/hunter-chunk-<id>.json"
   ```
5. Fill subagent-wrapper template. Include chunk context:
   - "You are scanning chunk {chunk-id} of {total-chunks}."
   - "Previous chunks found {N} bugs so far. Focus on NEW findings."
6. Dispatch and wait for completion.

**Parallel fallback:** If any parallel dispatch fails, set `parallelDisabled`:
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" set-parallel-disabled ".claude/bug-hunter-state.json" true
```
Continue fully sequential for all remaining chunks.

#### 5. Gap-fill for this chunk
Compare chunk's FILES SCANNED against chunk's file list. If any CRITICAL/HIGH files were skipped, scan them now.

#### 6. Record findings in state
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" record-findings ".claude/bug-hunter-state.json" ".claude/chunk-<id>-findings.json" "scaled"
```

#### 7. Update hash cache
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" hash-update ".claude/bug-hunter-state.json" ".claude/chunk-<id>-scanned-files.json" scanned
```

#### 8. Mark chunk done
```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".claude/bug-hunter-state.json" "<chunk-id>" done
```

Repeat from step 1 for the next pending chunk.

---

## Step 7s: Skeptic and Referee

After ALL chunks are `done`:

### Merge findings
1. Read all findings from `.claude/bug-hunter-state.json` ledger.
2. Deduplicate by file + line + claim overlap.
3. Renumber BUG-IDs sequentially.
4. Write merged findings to `.claude/bug-hunter-findings.md`.

### Skeptic pass

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/skeptic.md` and `SKILL_DIR/prompts/doc-lookup.md`.
2. **Switch mindset**: adversarial Skeptic.
3. Read `.claude/bug-hunter-findings.md`.
4. For each finding: re-read actual code, check framework protections, apply risk calculation.
5. Write output to `.claude/bug-hunter-skeptic.md`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

Run Skeptics sequentially by directory cluster:
- Total bugs ≤ 8: ONE Skeptic on all bugs.
- Total bugs > 8: split into cluster sets, dispatch sequentially.

For each Skeptic:
1. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate skeptic ".claude/payloads/skeptic-<id>.json"
   ```
2. Fill `bugs` with assigned bugs only. Fill `techStack`.
3. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate skeptic ".claude/payloads/skeptic-<id>.json"
   ```
4. Fill template and dispatch. Wait for completion before next Skeptic.

Merge Skeptic output. Write to `.claude/bug-hunter-skeptic.md`.

### Referee

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/referee.md`.
2. Read both findings and skeptic output.
3. For Tier 1: re-read code a THIRD time.
4. Make final verdicts. Write to `.claude/bug-hunter-referee.md`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

1. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate referee ".claude/payloads/referee-scaled.json"
   ```
2. Fill: `findings`, `skepticResults`.
3. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate referee ".claude/payloads/referee-scaled.json"
   ```
4. Dispatch. Wait for completion.

**Fallback:** If Referee fails, use Skeptic-accepted bugs. Mark as `REFEREE_UNAVAILABLE`.

---

## Step 8s: Completion rules

The Final Report (Step 7 in SKILL.md) MUST include:

1. **Chunk progress**: Completed chunks vs total (e.g., "8/8 chunks scanned").
2. **Files coverage**: Total files scanned vs total source files.
3. **Files skipped**: List any skipped files with reasons (context exhaustion, unchanged, etc.).
4. **Parallel status**: Whether `parallelDisabled` was triggered (and why).
5. **Resume info**: If the run was interrupted, include:
   ```
   To resume: The state file `.claude/bug-hunter-state.json` contains
   checkpoint data. Re-run `/bug-hunter` and it will resume from the
   last completed chunk.
   ```

---

## After Step 8s

Proceed to **Step 7** (Final Report) in SKILL.md with the coverage info from Step 8s.
