# Single-File Mode (1 file)

### Step 4s: Run Hunter
Launch one general-purpose subagent with the hunter prompt. Pass the single file path. No risk map needed.
Wait for completion. If TOTAL FINDINGS: 0, go to Step 7.

### Step 5s: Run Skeptic
Launch one general-purpose subagent with the skeptic prompt. Inject the Hunter's findings.
Wait for completion.

### Step 6s: Run Referee
Launch one general-purpose subagent with the referee prompt. Inject Hunter + Skeptic reports.
Wait for completion. Go to Step 7.
