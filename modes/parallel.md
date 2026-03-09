# Parallel Mode (11–FILE_BUDGET files) — sequential-first hybrid

Use this mode when files fit in one deep pass but the target is too large for "small mode".
Keep one writer/decision-maker flow. Parallel work is read-only and optional.

All phases use the `AGENT_BACKEND` selected during SKILL preflight.

---

## Step 4p: Run Recon

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/recon.md`.
2. Execute Recon yourself (see `modes/local-sequential.md` Phase A for detailed steps).
3. Write output to `.claude/bug-hunter-recon.md`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

1. Read `SKILL_DIR/prompts/recon.md` and `SKILL_DIR/templates/subagent-wrapper.md`.
2. Generate payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate recon ".claude/payloads/recon-parallel.json"
   ```
3. Fill payload: `skillDir`, `targetFiles` (all source files).
4. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate recon ".claude/payloads/recon-parallel.json"
   ```
5. Fill subagent-wrapper template with recon prompt content.
6. Dispatch: `subagent({ agent: "recon-agent", task: "<filled template>", output: ".claude/bug-hunter-recon.md" })`
7. Wait for completion.

Capture from Recon output:
- Risk map (CRITICAL/HIGH/MEDIUM scan order)
- Service boundaries
- Tech stack
- FILE_BUDGET

Report architecture summary to user.

---

## Step 5p: Optional read-only dual-lens triage (safe parallel)

> This step is OPTIONAL. Only run when `AGENT_BACKEND` supports parallel dispatch (subagent or teams) AND `DOC_LOOKUP_AVAILABLE=true`. For local-sequential, SKIP to Step 5p-deep.

Launch two triage Hunters in parallel on CRITICAL+HIGH files only:

1. Generate payloads for each:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate triage-hunter ".claude/payloads/triage-hunter-a.json"
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate triage-hunter ".claude/payloads/triage-hunter-b.json"
   ```
2. Fill payloads: Hunter-A = security triage lens, Hunter-B = logic triage lens. Both scan the same CRITICAL+HIGH files.
3. Validate both payloads.
4. Dispatch in parallel (if backend supports it):
   ```
   subagent({
     tasks: [
       { agent: "triage-hunter-security", task: "<security triage template>", output: ".claude/triage-a.md" },
       { agent: "triage-hunter-logic", task: "<logic triage template>", output: ".claude/triage-b.md" }
     ]
   })
   ```
5. Wait for both. Merge triage shortlists into hints for the deep Hunter.

**Rules:**
- Triage is read-only and fast. It produces a shortlist of suspicious areas, NOT final bugs.
- If either triage dispatch fails, disable triage and continue to Step 5p-deep without hints.

---

## Step 5p-deep: Run one deep Hunter (authoritative)

This is the main Hunter pass — the source of truth for findings.

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/hunter.md` and `SKILL_DIR/prompts/doc-lookup.md`.
2. Execute Hunter yourself on ALL files in risk-map order (CRITICAL → HIGH → MEDIUM).
3. If triage hints exist (from Step 5p), use them to prioritize certain code sections, but scan all files regardless.
4. Write output to `.claude/bug-hunter-findings.md`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

1. Read `SKILL_DIR/prompts/hunter.md` and `SKILL_DIR/prompts/doc-lookup.md`.
2. Read `SKILL_DIR/templates/subagent-wrapper.md`.
3. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate hunter ".claude/payloads/hunter-deep.json"
   ```
4. Fill: `skillDir`, `targetFiles` (full risk map order), `riskMap`, `techStack`.
5. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate hunter ".claude/payloads/hunter-deep.json"
   ```
6. Fill template. In `{PHASE_SPECIFIC_CONTEXT}`, include:
   - Doc-lookup instructions
   - Triage hints (if available): "Triage flagged these areas for closer inspection: ..."
   - "This deep scan output is the SOURCE OF TRUTH. Triage hints are supplementary only."
7. Dispatch: `subagent({ agent: "hunter-deep", task: "<filled template>", output: ".claude/bug-hunter-findings.md" })`
8. Wait for completion.

---

## Step 5p-verify: Gap-fill check

Compare the deep Hunter's `FILES SCANNED` list against the risk map.

If any CRITICAL or HIGH files appear in FILES SKIPPED:

**local-sequential:** Read the missed files yourself now. Scan for bugs. Append to `.claude/bug-hunter-findings.md`.

**subagent:** Launch one gap-fill Hunter on ONLY the missed files:
1. Generate hunter payload with only missed files in `targetFiles`.
2. Validate. Dispatch with `output: ".claude/bug-hunter-gap-findings.md"`.
3. Merge gap findings into `.claude/bug-hunter-findings.md`. Renumber BUG-IDs sequentially.

Report coverage status to user.

If merged TOTAL FINDINGS: 0, skip Skeptic/Referee. Go to Step 7 (Final Report) in SKILL.md.

---

## Step 6p: Skeptic pass (sequential by cluster)

Group bugs by directory, then decide Skeptic count:
- If total bugs ≤ 5: run ONE Skeptic on all findings.
- If total bugs > 5: split into two cluster sets. Run Skeptic-A on set 1, THEN Skeptic-B on set 2 (sequentially, NOT in parallel).

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/skeptic.md` and `SKILL_DIR/prompts/doc-lookup.md`.
2. **Switch mindset**: you are the adversarial Skeptic.
3. Read `.claude/bug-hunter-findings.md`.
4. For each finding:
   - Re-read the actual code with the Read tool (MANDATORY).
   - Check for framework protections the Hunter may have missed.
   - Apply risk calculation: only disprove when confidence > 67%.
5. Write output to `.claude/bug-hunter-skeptic.md`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

For each Skeptic (one or two depending on bug count):
1. Read prompts + template.
2. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate skeptic ".claude/payloads/skeptic-<id>.json"
   ```
3. Fill `bugs` array with only the bugs assigned to this Skeptic. Fill `techStack`.
4. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate skeptic ".claude/payloads/skeptic-<id>.json"
   ```
5. Dispatch. Wait for completion.

Merge Skeptic output while preserving BUG-IDs. Write merged result to `.claude/bug-hunter-skeptic.md`.

---

## Step 7p: Run Referee

**If `AGENT_BACKEND = "local-sequential"`:**

1. Read `SKILL_DIR/prompts/referee.md`.
2. **Switch mindset**: impartial Referee.
3. Read `.claude/bug-hunter-findings.md` and `.claude/bug-hunter-skeptic.md`.
4. For each finding (Tier 1: re-read code a THIRD time):
   - Make REAL BUG / NOT A BUG verdict.
   - Calibrate severity and assign confidence %.
5. Write output to `.claude/bug-hunter-referee.md`.

**If `AGENT_BACKEND = "subagent"` or `"teams"`:**

1. Read `SKILL_DIR/prompts/referee.md` and `SKILL_DIR/templates/subagent-wrapper.md`.
2. Generate and fill payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate referee ".claude/payloads/referee-parallel.json"
   ```
3. Fill: `findings` from merged Hunter output, `skepticResults` from merged Skeptic output.
4. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate referee ".claude/payloads/referee-parallel.json"
   ```
5. Fill template with both Hunter findings AND Skeptic challenges in `{PHASE_SPECIFIC_CONTEXT}`.
6. Dispatch: `subagent({ agent: "referee-agent", task: "<filled template>", output: ".claude/bug-hunter-referee.md" })`
7. Wait for completion.

**Fallback:** If Referee dispatch fails or times out, fall back to Skeptic-accepted bugs. Mark the result as `REFEREE_UNAVAILABLE` in the final report and note which bugs were only Skeptic-reviewed.

---

## After Step 7p

Proceed to **Step 7** (Final Report) in SKILL.md. Use the Referee output from `.claude/bug-hunter-referee.md` for confirmed bugs.
