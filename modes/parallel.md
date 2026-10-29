# Parallel Mode (11–FILE_BUDGET files) — sequential-first hybrid

This mode handles medium-sized scan targets. The deep Hunter scans all files sequentially.
An optional read-only dual-lens **scout pass** can run in parallel to provide hints.
All phases are dispatched using the `AGENT_BACKEND` selected during SKILL preflight.

---

## Triage Integration

Before any phase, check for `.bug-hunter/triage.json` (written by `SKILL.md › Deterministic triage before model work`). If present:
- Use `triage.riskMap` as the risk map — skip Recon's file classification.
- Use `triage.scanOrder` as the Hunter's file order.
- Use `triage.fileBudget` as FILE_BUDGET.
- Recon becomes an enrichment pass: identify tech stack and trust boundary patterns only.

---

## Run Recon

Under `--loop`, reuse validated `.bug-hunter/recon.json` while triage-listed
source hashes match the baseline; skip this phase after the first iteration
as required by `modes/loop.md`.

Dispatch Recon using the standard dispatch pattern (see `dispatch.md`, role=`recon`).

**If triage data exists**, tell Recon to use the triage risk map and only identify tech stack + patterns. Pass the triage JSON path as phase-specific context.

**If no triage data**, Recon does full file discovery and classification.

After Recon completes, read `.bug-hunter/recon.json` to extract the risk map, tech stack, and FILE_BUDGET.

Report architecture summary to user.

---

## Optional read-only dual-lens scout pass (safe parallel)

**This step is optional** — skip it if the codebase is straightforward or if `AGENT_BACKEND = "local-sequential"`.

Launch two scout Hunters in parallel on CRITICAL+HIGH files only:

1. Generate payloads:
   ```
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate triage-hunter ".bug-hunter/payloads/scout-hunter-a.json"
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate triage-hunter ".bug-hunter/payloads/scout-hunter-b.json"
   ```
2. Fill payloads: Scout-A = security lens, Scout-B = logic lens. Both scan the same CRITICAL+HIGH files.
3. Validate both payloads.
4. Render both tasks through `dispatch.md`, using separate outputFilePath
   values for the scout findings artifacts. Dispatch in parallel with
   `Read <abs scout task path> and follow it`; never inline role instructions.
5. Wait for both. Merge scout shortlists into hints for the deep Hunter.

**Scout pass rules:**
- Scouts are READ-ONLY — they never modify files or state.
- If either scout dispatch fails, disable scout pass and continue to Run Deep Hunter without hints.
- Scout findings alone are NOT the final result — they only inform the deep scan.

---

## Run Deep Hunter

Dispatch Hunter using the standard dispatch pattern (see `dispatch.md`, role=`hunter`).

Pass to the Hunter:
- File list in risk-map order. If triage exists, use `triage.scanOrder`.
- Risk map from Recon (or triage).
- Tech stack from Recon.
- If scout hints exist (from the scout pass), use them to prioritize certain code sections, but scan all files regardless.

After completion, read `.bug-hunter/hunter-findings.json`.

**Merge scout + deep findings:** If scout pass ran, compare scout findings with deep Hunter findings. Promote any scout-only findings (bugs the deep Hunter missed) into the findings list for Skeptic review.

---

## Gap-fill check

Compare actual file coverage against the queue. Dispatch a gap-fill Hunter
for missed assigned source in risk order, within remaining capacity. Preserve
pending coverage when files cannot be read.

---

If TOTAL FINDINGS: 0, skip Skeptic and Referee. Go to `SKILL.md › Join and present the scan result`.

## Run Skeptic

Dispatch Skeptic using the standard dispatch pattern (see `dispatch.md`, role=`skeptic`).

For parallel mode, you may split into two Skeptics by directory if findings span multiple services:
- Skeptic-A: bugs in service/directory A
- Skeptic-B: bugs in service/directory B

Pass to each Skeptic only the bugs in their assigned scope. After completion, merge results.

If only one service/directory: use a single Skeptic.

---

## Run Referee

Dispatch Referee using the standard dispatch pattern (see `dispatch.md`, role=`referee`).

Pass the merged Hunter findings + Skeptic challenges.

After completion, read `.bug-hunter/referee.json`, then render `.bug-hunter/report.md` from the JSON artifacts.

---

## Return to the scan report

Proceed to `SKILL.md › Join and present the scan result`.
