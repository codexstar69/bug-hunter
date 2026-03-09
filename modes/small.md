# Small Mode (2–10 files)

This mode handles small scan targets where all files fit in a single pass.
All phases are dispatched using the `AGENT_BACKEND` selected during SKILL preflight.

---

## Step 4m: Run Recon

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/recon.md` with the Read tool.
2. Execute Recon yourself:
   - Discover source files using available tools (`fd`, `find`, `ls -R`, or Glob tool).
   - Classify into CRITICAL / HIGH / MEDIUM / CONTEXT-ONLY.
   - Compute FILE_BUDGET (should be ≥ file count for small mode).
   - Identify tech stack: framework, auth, database, key dependencies.
3. Write output to `.claude/bug-hunter-recon.md`.
4. Report architecture summary to user.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

1. Read `SKILL_DIR/prompts/recon.md` with the Read tool.
2. Read `SKILL_DIR/templates/subagent-wrapper.md` with the Read tool.
3. Generate payload template:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate recon ".claude/payloads/recon-small.json"
   ```
4. Edit `.claude/payloads/recon-small.json` — fill in actual `skillDir` and `targetFiles`.
5. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate recon ".claude/payloads/recon-small.json"
   ```
6. Fill the subagent-wrapper template:
   - `{ROLE_NAME}` = `recon`
   - `{ROLE_DESCRIPTION}` = "Reconnaissance agent — map the codebase and classify files by risk"
   - `{PROMPT_CONTENT}` = contents of `prompts/recon.md`
   - `{FILE_LIST}` = all source files in the scan target
   - `{OUTPUT_FILE_PATH}` = `.claude/bug-hunter-recon.md`
7. Dispatch:
   ```
   subagent({ agent: "recon-agent", task: "<filled template>", output: ".claude/bug-hunter-recon.md" })
   ```
8. Wait for completion. Read `.claude/bug-hunter-recon.md` to extract the risk map.

Report architecture summary to user.

---

## Step 5m: Run Hunter

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/hunter.md` and `SKILL_DIR/prompts/doc-lookup.md`.
2. Execute Hunter yourself:
   - Read files in risk-map order (CRITICAL → HIGH → MEDIUM) using the Read tool.
   - Apply the security checklist sweep on every CRITICAL and HIGH file.
   - Record findings in BUG-N format.
   - Track FILES SCANNED / FILES SKIPPED honestly.
3. Write output to `.claude/bug-hunter-findings.md`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

1. Read `SKILL_DIR/prompts/hunter.md` and `SKILL_DIR/prompts/doc-lookup.md`.
2. Read `SKILL_DIR/templates/subagent-wrapper.md`.
3. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate hunter ".claude/payloads/hunter-small.json"
   ```
4. Edit the payload: fill `skillDir`, `targetFiles` (from risk map), `riskMap`, `techStack`.
5. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate hunter ".claude/payloads/hunter-small.json"
   ```
6. Fill the subagent-wrapper template:
   - `{ROLE_NAME}` = `hunter`
   - `{ROLE_DESCRIPTION}` = "Bug Hunter — find behavioral bugs in source code"
   - `{PROMPT_CONTENT}` = contents of `prompts/hunter.md`
   - `{PHASE_SPECIFIC_CONTEXT}` = contents of `prompts/doc-lookup.md` + risk map + tech stack
   - `{OUTPUT_FILE_PATH}` = `.claude/bug-hunter-findings.md`
7. Dispatch:
   ```
   subagent({ agent: "hunter-agent", task: "<filled template>", output: ".claude/bug-hunter-findings.md" })
   ```
8. Wait for completion. Read `.claude/bug-hunter-findings.md`.

If TOTAL FINDINGS: 0, skip Skeptic and Referee. Go to Step 7 (Final Report) in SKILL.md.

---

## Step 5m-verify: Gap-fill check

Compare the Hunter's FILES SCANNED list against the risk map.

If any CRITICAL or HIGH files appear in FILES SKIPPED:

**local-sequential:** Read the missed files yourself now and scan them for bugs. Append new findings to `.claude/bug-hunter-findings.md`.

**subagent:** Launch a second Hunter on ONLY the missed files:

1. Generate payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate hunter ".claude/payloads/hunter-small-gap.json"
   ```
2. Fill payload with ONLY the missed files. Validate.
3. Dispatch with `output: ".claude/bug-hunter-gap-findings.md"`.
4. Merge gap findings into `.claude/bug-hunter-findings.md`.

---

## Step 6m: Run Skeptic

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/skeptic.md` and `SKILL_DIR/prompts/doc-lookup.md`.
2. **Switch mindset**: you are now the Skeptic. Try to DISPROVE your own findings.
3. Read `.claude/bug-hunter-findings.md` to get all findings.
4. For each finding:
   - Re-read the actual code with the Read tool (MANDATORY).
   - Check for framework protections.
   - Apply the risk calculation (only disprove when confidence > 67%).
5. Write output to `.claude/bug-hunter-skeptic.md`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

1. Read `SKILL_DIR/prompts/skeptic.md` and `SKILL_DIR/prompts/doc-lookup.md`.
2. Read `SKILL_DIR/templates/subagent-wrapper.md`.
3. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate skeptic ".claude/payloads/skeptic-small.json"
   ```
4. Fill payload `bugs` array from `.claude/bug-hunter-findings.md`. Set `techStack`.
5. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate skeptic ".claude/payloads/skeptic-small.json"
   ```
6. Fill template:
   - `{ROLE_NAME}` = `skeptic`
   - `{ROLE_DESCRIPTION}` = "Skeptic — adversarial review to disprove false positives"
   - `{PROMPT_CONTENT}` = contents of `prompts/skeptic.md`
   - `{PHASE_SPECIFIC_CONTEXT}` = Hunter findings (compact format: bugId, severity, file, lines, claim, evidence, runtimeTrigger)
   - `{OUTPUT_FILE_PATH}` = `.claude/bug-hunter-skeptic.md`
7. Dispatch. Wait for completion.

---

## Step 7m: Run Referee

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/referee.md`.
2. **Switch mindset**: you are the impartial Referee.
3. Read both `.claude/bug-hunter-findings.md` and `.claude/bug-hunter-skeptic.md`.
4. For each finding:
   - Re-read the actual code a THIRD time with the Read tool.
   - Evaluate Hunter vs Skeptic arguments independently.
   - Make REAL BUG / NOT A BUG verdict with severity + confidence.
5. Write output to `.claude/bug-hunter-referee.md`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

1. Read `SKILL_DIR/prompts/referee.md`.
2. Read `SKILL_DIR/templates/subagent-wrapper.md`.
3. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate referee ".claude/payloads/referee-small.json"
   ```
4. Fill payload `findings` from Hunter output, `skepticResults` from Skeptic output.
5. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate referee ".claude/payloads/referee-small.json"
   ```
6. Fill template:
   - `{ROLE_NAME}` = `referee`
   - `{ROLE_DESCRIPTION}` = "Referee — impartial final judge of all findings"
   - `{PROMPT_CONTENT}` = contents of `prompts/referee.md`
   - `{PHASE_SPECIFIC_CONTEXT}` = both Hunter findings AND Skeptic challenges
   - `{OUTPUT_FILE_PATH}` = `.claude/bug-hunter-referee.md`
7. Dispatch. Wait for completion.

---

## After Step 7m

Proceed to **Step 7** (Final Report) in SKILL.md. The Referee output in `.claude/bug-hunter-referee.md` provides the confirmed bugs table, dismissed findings, and coverage stats needed for the final report.
