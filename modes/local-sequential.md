# Local-Sequential Mode (no subagents — default fallback)

Run all pipeline phases in the main agent's own context window. This is the **most common execution mode** — most agent runtimes will land here because subagent dispatch requires specific tooling that isn't always available.

This is NOT a degraded mode. The skill is designed to work fully here.

## How It Works

You (the orchestrating agent) play each role yourself, sequentially. Between phases you **write outputs to files** so later phases can reference them without holding everything in working memory.

All state files go in `.claude/` relative to the working directory.

## Phase A: Recon (map the codebase)

1. Read `SKILL_DIR/prompts/recon.md` with the Read tool — do NOT act from memory.
2. Execute the Recon instructions yourself:
   - Use file discovery tools available in your runtime (`fd`, `find`, Glob tool, or `ls -R`) to discover all source files under the scan target.
   - Apply the skip rules from SKILL.md (filter out docs, config, assets, vendor dirs).
   - Use search tools (`rg`, `grep`, Grep tool, or manual Read) to find trust boundaries (route handlers, auth checks, DB queries, etc.).
   - Measure file sizes: `wc -l <files> | tail -1` to compute average lines per file.
   - Classify every file into CRITICAL / HIGH / MEDIUM / CONTEXT-ONLY.
   - Compute FILE_BUDGET: `floor(150000 / (avg_lines × 4))`, capped at 60, floored at 10.
   - If git is available, check recently changed files with `git log`.
3. Write your complete Recon output to `.claude/bug-hunter-recon.md` in the format specified by `recon.md`.
4. Parse your own output: extract the risk map, FILE_BUDGET, and tech stack. You will use these in all subsequent phases.

**If Recon fails or you cannot complete it:** Skip Recon. Set FILE_BUDGET=40. Use a flat file list ordered by directory depth (deeper = more likely to be application logic). Continue to Phase B.

## Phase B: Hunter (deep scan for bugs)

1. Read `SKILL_DIR/prompts/hunter.md` with the Read tool.
2. Read `SKILL_DIR/prompts/doc-lookup.md` with the Read tool.
3. **Switch mindset**: you are now a Bug Hunter. Your ONLY job is to find behavioral bugs.
4. Execute the Hunter instructions yourself:
   - Read files in risk-map order: CRITICAL → HIGH → MEDIUM.
   - For each file, use the Read tool. Do NOT rely on memory from earlier phases.
   - Apply the mandatory security checklist sweep (Phase 3 in hunter.md) on every CRITICAL and HIGH file.
   - Track which files you actually read — be honest about coverage.
   - For each bug found, record it in the exact BUG-N format specified in hunter.md.
5. Write your complete findings to `.claude/bug-hunter-findings.md`.

**Context management:** If you notice earlier files becoming hazy in your memory:
- STOP expanding to new files.
- Record your honest coverage in FILES SCANNED / FILES SKIPPED.
- Complete the current file thoroughly rather than skimming more files.
- The pipeline will handle partial coverage via gap-fill or `--loop` mode.

**Chunked execution (when files > FILE_BUDGET):**

If the Recon risk map contains more files than FILE_BUDGET, do NOT try to read them all in one pass. Instead:

1. Initialize state:
   ```bash
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init ".claude/bug-hunter-state.json" "local-sequential" ".claude/source-files.json" 30
   ```
2. For each chunk:
   a. Get next chunk:
      ```bash
      node "$SKILL_DIR/scripts/bug-hunter-state.cjs" next-chunk ".claude/bug-hunter-state.json"
      ```
   b. Mark in-progress:
      ```bash
      node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".claude/bug-hunter-state.json" "<chunk-id>" in_progress
      ```
   c. Run the Hunter scan on this chunk's files only.
   d. Write chunk findings to `.claude/chunk-<id>-findings.json`.
   e. Record findings in state:
      ```bash
      node "$SKILL_DIR/scripts/bug-hunter-state.cjs" record-findings ".claude/bug-hunter-state.json" ".claude/chunk-<id>-findings.json" "local-sequential"
      ```
   f. Mark done:
      ```bash
      node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".claude/bug-hunter-state.json" "<chunk-id>" done
      ```
3. After all chunks: merge findings from `.claude/bug-hunter-state.json` into `.claude/bug-hunter-findings.md`.

**Gap-fill:** After scanning, compare FILES SCANNED against the risk map. If any CRITICAL or HIGH files are in FILES SKIPPED, read them now and append any new findings. If you truly cannot read them (context exhaustion), leave them in FILES SKIPPED.

If TOTAL FINDINGS: 0, skip Phases C and D. Go directly to Step 7 (Final Report) in SKILL.md.

## Phase C: Skeptic (challenge your own findings)

1. Read `SKILL_DIR/prompts/skeptic.md` with the Read tool.
2. Read `SKILL_DIR/prompts/doc-lookup.md` with the Read tool.
3. **Switch mindset completely**: you are now the Skeptic. Your job is to DISPROVE false positives. Forget the pride of finding them — you want to kill weak claims.
4. Read `.claude/bug-hunter-findings.md` to get the findings list.
5. For EACH finding:
   - Re-read the actual code at the reported file and line with the Read tool. This is MANDATORY — do not evaluate from memory.
   - Read all cross-referenced files.
   - Mentally trace the runtime trigger: does the code actually behave the way the Hunter claimed?
   - Check framework/middleware protections the Hunter may have missed.
   - Apply the risk calculation: `EV = (confidence% × points) - ((100 - confidence%) × 2 × points)`. Only DISPROVE when EV is positive (confidence > 67%).
   - For Critical bugs: need >67% confidence AND all cross-references read.
6. Write your complete Skeptic output to `.claude/bug-hunter-skeptic.md` in the format from skeptic.md.

**Important:** When switching from Hunter to Skeptic, genuinely try to disprove your own findings. The point of this phase is adversarial review. If you cannot genuinely argue against a finding, ACCEPT it and move on — do not waste time rubber-stamping.

## Phase D: Referee (final verdicts)

1. Read `SKILL_DIR/prompts/referee.md` with the Read tool.
2. **Switch mindset**: you are the impartial Referee. You trust neither the Hunter nor the Skeptic.
3. Read both `.claude/bug-hunter-findings.md` and `.claude/bug-hunter-skeptic.md`.
4. For each finding:
   - **Tier 1 (all Critical + top 15 by severity):** Re-read the actual code yourself a THIRD time using the Read tool. Construct the runtime trigger independently. Make your own judgment.
   - **Tier 2 (remaining):** Evaluate evidence quality. Whose code quotes are more specific? Whose runtime trigger is more concrete?
5. Make final REAL BUG / NOT A BUG verdicts with severity calibration.
6. Write the final Referee report to `.claude/bug-hunter-referee.md`.
7. Proceed to Step 7 (Final Report) in SKILL.md.

## State Files Summary

After a complete local-sequential run, these files should exist:

| File | Phase | Content |
|------|-------|---------|
| `.claude/bug-hunter-recon.md` | A | Risk map, file metrics, tech stack |
| `.claude/bug-hunter-findings.md` | B | All Hunter findings in BUG-N format |
| `.claude/bug-hunter-skeptic.md` | C | Skeptic challenges and decisions |
| `.claude/bug-hunter-referee.md` | D | Final verdicts and confirmed bugs |
| `.claude/bug-hunter-state.json` | B (chunked) | Chunk progress, findings ledger |
| `.claude/source-files.json` | A | Source file list (for state init) |

## Coverage Enforcement

After Phase D, check coverage:

- If all CRITICAL and HIGH files were scanned: proceed to Final Report.
- If any CRITICAL/HIGH files were skipped:
  - If `--loop` mode: the ralph-loop will iterate and cover them next.
  - If not `--loop`: include a coverage WARNING in the Final Report and recommend `--loop`.
- Do NOT claim "full coverage" or "audit complete" unless every CRITICAL and HIGH file was actually read with the Read tool and has status DONE.
