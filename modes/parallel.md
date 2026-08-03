# Parallel Mode (11–FILE_BUDGET files) — sequential-first hybrid

This mode handles medium-sized scan targets. The deep Hunter scans all files sequentially.
An optional read-only dual-lens **scout pass** can run in parallel to provide hints.
All phases are dispatched using the `AGENT_BACKEND` selected during SKILL preflight.

---

## Triage Integration

Before any phase, check for `.bug-hunter/triage.json` (written by Step 1). If present:
- Use `triage.riskMap` as the risk map — skip Recon's file classification.
- Use `triage.scanOrder` as the Hunter's file order.
- Use `triage.fileBudget` as FILE_BUDGET.
- Recon becomes an enrichment pass: identify tech stack and trust boundary patterns only.

---

## Step 4: Run Recon

Dispatch Recon using the standard dispatch pattern (see `dispatch.md`, role=`recon`).

**If triage data exists**, tell Recon to use the triage risk map and only identify tech stack + patterns. Pass the triage JSON path as phase-specific context.

**If no triage data**, Recon does full file discovery and classification.

After Recon completes, read `.bug-hunter/recon.json` to extract the risk map, tech stack, and FILE_BUDGET.

Report architecture summary to user.

---

## Step 5: Optional read-only dual-lens scout pass (safe parallel)

**This step is optional** — skip it if the codebase is straightforward or if `AGENT_BACKEND = "local-sequential"`.

Launch two scout Hunters in parallel on CRITICAL+HIGH files only:

1. Generate payloads:
   ```
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate triage-hunter ".bug-hunter/payloads/scout-hunter-a.json"
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate triage-hunter ".bug-hunter/payloads/scout-hunter-b.json"
   ```
2. Fill payloads: Scout-A = security lens, Scout-B = logic lens. Both scan the same CRITICAL+HIGH files.
3. Validate both payloads.
4. Dispatch in parallel:
   ```
   subagent({ tasks: [
       { agent: "scout-hunter-security", task: "<security scout template>", output: ".bug-hunter/scout-a.md" },
       { agent: "scout-hunter-logic", task: "<logic scout template>", output: ".bug-hunter/scout-b.md" }
   ]})
   ```
5. Wait for both. Merge scout shortlists into hints for the deep Hunter.

**Scout pass rules:**
- Scouts are READ-ONLY — they never modify files or state.
- If either scout dispatch fails, disable scout pass and continue to Step 5-deep without hints.
- Scout findings alone are NOT the final result — they only inform the deep scan.

---

## Step 5-deep: Run Deep Hunter

Dispatch Hunter using the standard dispatch pattern (see `dispatch.md`, role=`hunter`).

Pass to the Hunter:
- File list in risk-map order. If triage exists, use `triage.scanOrder`.
- Risk map from Recon (or triage).
- Tech stack from Recon.
- If scout hints exist (from Step 5), use them to prioritize certain code sections, but scan all files regardless.
- `skills/doc-lookup/SKILL.md` contents as phase-specific context.

After completion, read `.bug-hunter/hunter-findings.json`.

**Merge scout + deep findings:** If scout pass ran, compare scout findings with deep Hunter findings. Promote any scout-only findings (bugs the deep Hunter missed) into the findings list for Skeptic review.

If TOTAL FINDINGS: 0, skip Skeptic and Referee. Go to Step 7 (Final Report) in SKILL.md.

---

## Step 5-verify: Gap-fill check

Same as small mode: compare FILES SCANNED vs risk map, then re-scan any missed queued scannable files in priority order.

---

## Step 6: Run Skeptic

Dispatch Skeptic using the standard dispatch pattern (see `dispatch.md`, role=`skeptic`).

For parallel mode, you may split into two Skeptics by directory if findings span multiple services:
- Skeptic-A: bugs in service/directory A
- Skeptic-B: bugs in service/directory B

Pass to each Skeptic only the bugs in their assigned scope. After completion, merge results.

If only one service/directory: use a single Skeptic.

---

## Step 7: Run Referee

Dispatch Referee using the standard dispatch pattern (see `dispatch.md`, role=`referee`).

Pass the merged Hunter findings + Skeptic challenges.

After completion, read `.bug-hunter/referee.json`, then render `.bug-hunter/report.md` from the JSON artifacts.

---

## After Step 7

Proceed to **Step 7** (Final Report) in SKILL.md.
