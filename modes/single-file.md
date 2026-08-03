# Single-File Mode (1 file)

All phases are dispatched using `AGENT_BACKEND` selected during SKILL preflight.
Recon is skipped — a single file doesn't need codebase mapping.

---

## Step 4: Run Hunter

Dispatch Hunter using the standard dispatch pattern (see `dispatch.md`, role=`hunter`).

Pass the single file path as the file list. No risk map needed — the file is implicitly CRITICAL.

For `local-sequential`: read the prompt file and scan the single file yourself.

After completion, read `.bug-hunter/hunter-findings.json`.

If TOTAL FINDINGS: 0, go to Step 7 (Final Report) in SKILL.md.

---

## Step 5: Run Skeptic

Dispatch Skeptic using the standard dispatch pattern (see `dispatch.md`, role=`skeptic`).

Inject the Hunter's findings.

After completion, read `.bug-hunter/skeptic.json`.

---

## Step 6: Run Referee

Dispatch Referee using the standard dispatch pattern (see `dispatch.md`, role=`referee`).

Inject Hunter + Skeptic reports.

After completion, read `.bug-hunter/referee.json`, render `.bug-hunter/report.md`, and go to Step 7 (Final Report) in SKILL.md.
