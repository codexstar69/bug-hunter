# Small Mode (2–10 files)

This mode handles small scan targets where all files fit in a single pass.
All phases are dispatched using the `AGENT_BACKEND` selected during SKILL preflight.

---

## Triage Integration

Before any phase, check for `.bug-hunter/triage.json` (written by Step 1). If present:
- Use `triage.riskMap` as the risk map — skip Recon's file classification.
- Use `triage.scanOrder` as the Hunter's file order.
- Recon becomes an enrichment pass: identify tech stack and trust boundary patterns only.

---

## Step 4: Run Recon

Dispatch Recon using the standard dispatch pattern (see `dispatch.md`, role=`recon`).

**If triage data exists**, tell Recon to use the triage risk map and only identify tech stack + patterns. Pass the triage JSON path as phase-specific context.

**If no triage data**, Recon does full file discovery and classification.

After Recon completes, read `.bug-hunter/recon.json` to extract the risk map and tech stack.

Report architecture summary to user.

---

## Step 5: Run Hunter

Dispatch Hunter using the standard dispatch pattern (see `dispatch.md`, role=`hunter`).

Pass to the Hunter:
- File list in risk-map order (CRITICAL → HIGH → MEDIUM → LOW). If triage exists, use `triage.scanOrder`.
- Risk map from Recon (or triage).
- Tech stack from Recon.
- `skills/doc-lookup/SKILL.md` contents as phase-specific context.

After completion, read `.bug-hunter/hunter-findings.json`.

If TOTAL FINDINGS: 0, skip Skeptic and Referee. Go to Step 7 (Final Report) in SKILL.md.

---

## Step 5-verify: Gap-fill check

Compare the Hunter's FILES SCANNED list against the risk map.

If any queued scannable files appear in FILES SKIPPED:

**local-sequential:** Read the missed files yourself now in priority order (CRITICAL → HIGH → MEDIUM → LOW) and scan them for bugs. Append new findings to `.bug-hunter/hunter-findings.json`.

**subagent/teams:** Launch a second Hunter on ONLY the missed files using the standard dispatch pattern. Merge gap findings into `.bug-hunter/hunter-findings.json`.

---

## Step 6: Run Skeptic

Dispatch Skeptic using the standard dispatch pattern (see `dispatch.md`, role=`skeptic`).

Pass to the Skeptic:
- Hunter findings from `.bug-hunter/hunter-findings.json`.
- Tech stack from Recon.
- `skills/doc-lookup/SKILL.md` contents as phase-specific context.

After completion, read `.bug-hunter/skeptic.json`.

---

## Step 7: Run Referee

Dispatch Referee using the standard dispatch pattern (see `dispatch.md`, role=`referee`).

Pass to the Referee:
- Hunter findings from `.bug-hunter/hunter-findings.json`.
- Skeptic challenges from `.bug-hunter/skeptic.json`.

After completion, read `.bug-hunter/referee.json`.

---

## After Step 7

Proceed to **Step 7** (Final Report) in SKILL.md. The Referee output in `.bug-hunter/referee.json` plus the rendered `.bug-hunter/report.md` provide the confirmed bugs table, dismissed findings, and coverage stats needed for the final report.
