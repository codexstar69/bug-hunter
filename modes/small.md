# Small Mode (2-10 files)

### Step 4m: Run Recon
Launch one general-purpose subagent with the recon prompt. Pass the scan target.
Wait for completion. Capture the risk map.
Report architecture summary to user.

### Step 5m: Run Hunter
Launch one general-purpose subagent with the hunter prompt. Include the risk map and scan order.
Tell it: "Scan files in risk map order. You MUST cover all CRITICAL and HIGH files."
Wait for completion. If TOTAL FINDINGS: 0, go to Step 7.

### Step 5m-verify: Gap-fill check
Compare the Hunter's FILES SCANNED list against the risk map. If any CRITICAL or HIGH files are in FILES SKIPPED, launch a second Hunter (general lens) on ONLY the missed files. Merge any new findings into the main list.

### Step 6m: Run Skeptic
Launch one general-purpose subagent with the skeptic prompt. Inject findings + file list + tech stack from Recon.
Wait for completion.

### Step 7m: Run Referee
Launch one general-purpose subagent with the referee prompt. Inject Hunter + Skeptic reports.
Wait for completion. Go to Step 7.
