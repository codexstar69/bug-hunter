# Local-Sequential Mode (no subagents — default fallback)

Run all pipeline phases in the main agent's own context window. This is the **most common execution mode** — most agent runtimes will land here because subagent dispatch requires specific tooling that isn't always available.

This is NOT a degraded mode. The skill is designed to work fully here.

## How It Works

You (the orchestrating agent) play each role yourself, sequentially. Between
phases you write canonical JSON artifacts so later phases can reference them
without holding everything in working memory. Markdown reports are derived from
those JSON files when humans need them.

All state files go in `.bug-hunter/` relative to the working directory.

## Phase A: Recon (map the codebase)

**Check for triage data first.** The orchestrator runs `triage.cjs` in Step 1 and writes `.bug-hunter/triage.json`. If this file exists, triage has already:
- Discovered and classified all source files (domains + riskMap)
- Computed FILE_BUDGET from actual file sizes
- Built a priority-ordered scanOrder for Hunters
- Determined the execution strategy

1. Read `SKILL_DIR/skills/recon/SKILL.md` — do NOT act from memory.

2. **If `.bug-hunter/triage.json` exists:**
   - Read it. Use `triage.riskMap` as the initial risk map (skip file discovery + classification).
   - Use `triage.fileBudget` as FILE_BUDGET (skip computation).
   - Use `triage.scanOrder` as the file order for Phase B.
   - Recon's remaining job: read 3-5 key files from CRITICAL domains to identify **tech stack** (framework, auth mechanism, database, key dependencies) and **trust boundary patterns** (how routes are defined, how auth middleware is applied, etc.).
   - If git is available, check recently changed files with `git log`.
   - Write your Recon output to `.bug-hunter/recon.json` if structured output is
     requested; otherwise keep `.bug-hunter/recon.md` as a temporary fallback
     until the Recon prompt is migrated.

3. **If `.bug-hunter/triage.json` does NOT exist** (fallback — Recon called directly):
   - Execute the full Recon instructions: discover files, classify, compute FILE_BUDGET.
   - Use search tools (`rg`, `grep`, or manual Read) to find trust boundaries.
   - Measure file sizes to compute FILE_BUDGET (default: 40 if measurement fails).
   - Write complete output to `.bug-hunter/recon.md`.

4. Parse your output: extract the risk map, FILE_BUDGET, tech stack, and scan order. You will use these in all subsequent phases.

**If Recon fails or you cannot complete it:** Skip Recon. Set FILE_BUDGET=40. Use triage's scanOrder if available, otherwise use a flat file list ordered by directory depth. Continue to Phase B.

## Phase B: Hunter (deep scan for bugs)

1. Read `SKILL_DIR/skills/hunter/SKILL.md`.
2. Read `SKILL_DIR/skills/doc-lookup/SKILL.md`.
3. **Switch mindset**: you are now a Bug Hunter. Your ONLY job is to find behavioral bugs.
4. Execute the Hunter instructions yourself:
   - Read files in risk-map order: CRITICAL → HIGH → MEDIUM → LOW.
   - For each file, read the file directly. Do NOT rely on memory from earlier phases.
   - Apply the mandatory security checklist sweep (Phase 3 in hunter.md) on every CRITICAL and HIGH file.
   - Track which files you actually read — be honest about coverage.
   - For each bug found, record it in the exact BUG-N format specified in hunter.md.
5. Write your complete findings to `.bug-hunter/findings.json`.
6. Validate the artifact immediately:
   ```bash
   node "$SKILL_DIR/scripts/schema-validate.cjs" findings ".bug-hunter/findings.json"
   ```

**Context management:** If you notice earlier files becoming hazy in your memory:
- STOP expanding to new files.
- Record your honest coverage in FILES SCANNED / FILES SKIPPED.
- Complete the current file thoroughly rather than skimming more files.
- The pipeline will handle partial coverage via gap-fill or `--loop` mode.

**Chunked execution (when files > FILE_BUDGET):**

If the Recon risk map contains more files than FILE_BUDGET, do NOT try to read them all in one pass. Instead:

1. Initialize state:
   ```bash
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init ".bug-hunter/state.json" "local-sequential" ".bug-hunter/source-files.json" 30
   ```
2. For each chunk:
   a. Get next chunk:
      ```bash
      node "$SKILL_DIR/scripts/bug-hunter-state.cjs" next-chunk ".bug-hunter/state.json"
      ```
   b. Mark in-progress:
      ```bash
      node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".bug-hunter/state.json" "<chunk-id>" in_progress
      ```
   c. Run the Hunter scan on this chunk's files only.
   d. Write chunk findings to `.bug-hunter/chunk-<id>-findings.json`.
   e. Record findings in state:
      ```bash
      node "$SKILL_DIR/scripts/bug-hunter-state.cjs" record-findings ".bug-hunter/state.json" ".bug-hunter/chunk-<id>-findings.json" "local-sequential"
      ```
   f. Mark done:
      ```bash
      node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".bug-hunter/state.json" "<chunk-id>" done
      ```
3. After all chunks: merge findings from `.bug-hunter/state.json` into
   `.bug-hunter/findings.json`.

**Gap-fill:** After scanning, compare FILES SCANNED against the risk map. If any queued scannable files are in FILES SKIPPED, read them now in priority order (CRITICAL → HIGH → MEDIUM → LOW) and append any new findings. If you truly cannot read them (context exhaustion), leave them in FILES SKIPPED so loop mode can resume them next.

If TOTAL FINDINGS: 0, skip Phases C and D. Go directly to Step 7 (Final Report) in SKILL.md.

## Phase C: Skeptic (challenge your own findings)

1. Read `SKILL_DIR/skills/skeptic/SKILL.md`.
2. Read `SKILL_DIR/skills/doc-lookup/SKILL.md`.
3. **Switch mindset completely**: you are now the Skeptic. Your job is to DISPROVE false positives. Forget the pride of finding them — you want to kill weak claims.
4. Read `.bug-hunter/findings.json` to get the findings list.
5. For EACH finding:
   - Re-read the actual code at the reported file and line directly. This is MANDATORY — do not evaluate from memory.
   - Read all cross-referenced files.
   - Mentally trace the runtime trigger: does the code actually behave the way the Hunter claimed?
   - Check framework/middleware protections the Hunter may have missed.
   - Apply the risk calculation: `EV = (confidence% × points) - ((100 - confidence%) × 2 × points)`. Only DISPROVE when EV is positive (confidence > 67%).
   - For Critical bugs: need >67% confidence AND all cross-references read.
6. Write your complete Skeptic output to `.bug-hunter/skeptic.json` in the
   format from skeptic.md.
7. Validate it immediately:
   ```bash
   node "$SKILL_DIR/scripts/schema-validate.cjs" skeptic ".bug-hunter/skeptic.json"
   ```

**Important:** When switching from Hunter to Skeptic, genuinely try to disprove your own findings. The point of this phase is adversarial review. If you cannot genuinely argue against a finding, ACCEPT it and move on — do not waste time rubber-stamping.

## Phase D: Referee (final verdicts)

1. Read `SKILL_DIR/skills/referee/SKILL.md`.
2. **Switch mindset**: you are the impartial Referee. You trust neither the Hunter nor the Skeptic.
3. Read both `.bug-hunter/findings.json` and `.bug-hunter/skeptic.json`.
4. For each finding:
   - **Tier 1 (all Critical + top 15 by severity):** Re-read the actual code yourself a THIRD time by reading the file. Construct the runtime trigger independently. Make your own judgment.
   - **Tier 2 (remaining):** Evaluate evidence quality. Whose code quotes are more specific? Whose runtime trigger is more concrete?
5. Make final REAL BUG / NOT A BUG verdicts with severity calibration.
6. Write the final Referee verdicts to `.bug-hunter/referee.json`.
7. Validate them immediately:
   ```bash
   node "$SKILL_DIR/scripts/schema-validate.cjs" referee ".bug-hunter/referee.json"
   ```
8. Render `.bug-hunter/report.md` from the JSON artifacts:
   ```bash
   node "$SKILL_DIR/scripts/render-report.cjs" report ".bug-hunter/findings.json" ".bug-hunter/referee.json" > ".bug-hunter/report.md"
   ```
9. Proceed to Step 7 (Final Report) in SKILL.md.

## State Files Summary

After a complete local-sequential run, these files should exist:

| File | Phase | Content |
|------|-------|---------|
| `.bug-hunter/recon.json` | A | Recon artifact when structured output is used |
| `.bug-hunter/findings.json` | B | All Hunter findings in canonical JSON |
| `.bug-hunter/skeptic.json` | C | Skeptic challenges in canonical JSON |
| `.bug-hunter/referee.json` | D | Final verdicts in canonical JSON |
| `.bug-hunter/report.md` | D | Human-readable report rendered from JSON |
| `.bug-hunter/state.json` | B (chunked) | Chunk progress, findings ledger |
| `.bug-hunter/source-files.json` | A | Source file list (for state init) |

## Coverage Enforcement

After Phase D, check coverage:

- If all queued scannable source files were scanned: proceed to Final Report.
- If any queued scannable files were skipped:
  - If `--loop` mode: the ralph-loop must iterate and cover the remaining queue next.
  - If not `--loop`: include a coverage WARNING in the Final Report and recommend loop mode.
- Do NOT claim "full coverage" or "audit complete" unless every queued scannable source file was actually read directly and has status DONE.
