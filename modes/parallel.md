# Parallel Mode (11-FILE_BUDGET files) — standard parallel

### Step 4p: Run Recon
Launch one general-purpose subagent with the recon prompt. Pass the scan target.
Wait for completion. Capture the risk map (scan order + detected patterns).

Report to user:
- Architecture summary
- CRITICAL: N files, HIGH: N files, MEDIUM: N files
- Context budget assessment
- Recently changed: N files

### Step 5p: Run parallel Hunter agents (dual-lens, full codebase)

Both Hunters scan ALL files in risk map order. They differ by **hunting lens**, not by file scope.

Launch BOTH Hunter agents **in parallel** (in a single message with two Agent tool calls):

**Hunter-A (Security lens) prompt additions:**
- "You are Hunter-A, the SECURITY specialist. Scan ALL files in risk map order. Your lens is SECURITY — focus exclusively on: injection (SQL, command, SSRF, path traversal), authentication/authorization bypass, input validation gaps at trust boundaries, secrets exposure, insecure deserialization, cryptographic misuse, and cross-file auth/authz gaps. Ignore pure logic bugs, style issues, and performance — Hunter-B covers those."
- Include the full risk map with scan order (CRITICAL -> HIGH -> MEDIUM)
- Include the Recon detected patterns (framework, auth, DB, dependencies)

**Hunter-B (Logic lens) prompt additions:**
- "You are Hunter-B, the LOGIC specialist. Scan ALL files in risk map order. Your lens is LOGIC AND CORRECTNESS — focus exclusively on: state management bugs, race conditions, deadlocks, error handling gaps (silent failures, swallowed errors, missing rollbacks), off-by-one errors, null/undefined dereferences, resource leaks, data integrity issues (truncation, encoding, timezone, overflow), API contract violations, and cross-file assumption mismatches. Ignore security vulnerabilities — Hunter-A covers those."
- Include the full risk map with scan order (CRITICAL -> HIGH -> MEDIUM)
- Include the Recon detected patterns (framework, auth, DB, dependencies)

Wait for BOTH to complete.

### Step 5p-verify: Gap-fill check

After both Hunters complete, collect their FILES SCANNED and FILES SKIPPED lists. Diff against the Recon risk map:
- Combine: all CRITICAL/HIGH files that appear in EITHER Hunter's FILES SKIPPED list AND don't appear in the other Hunter's FILES SCANNED list
- If any such files exist: launch a single gap-fill Hunter (general lens, no specialization) on ONLY those files, with the risk map for context
- Merge gap-fill findings into the main list (renumber sequentially)
- Report: "Gap-fill: [N] missed CRITICAL/HIGH files scanned, [M] additional findings"

If no files were missed, report: "Coverage verified: all CRITICAL and HIGH files scanned by at least one Hunter."

### Step 5pb: Merge Hunter findings

Combine the findings from all Hunters (including gap-fill if any) into a single unified bug list:
1. Renumber all BUG-IDs sequentially (Hunter-A's BUG-1..N, then Hunter-B's become BUG-(N+1)..M, then gap-fill)
2. **Deduplicate carefully**: if multiple Hunters reported the same file+line with overlapping claims, merge them — keep the higher severity, combine the evidence from both, and mark as "DUAL-LENS FINDING" (very high confidence signal)
3. Record which Hunter (Security/Logic/Gap-fill) found each bug
4. **Build a file-to-bugs index**: for each unique file path mentioned in any bug (primary file or cross-reference), list which BUG-IDs touch it. This index is used for Skeptic file-clustering.

If combined TOTAL FINDINGS: 0, go to Step 7.

Report to user: "Security Hunter found X findings, Logic Hunter found Y findings. Z dual-lens overlaps merged. Total: W unique findings."

### Step 6p: Run parallel Skeptic agents (directory-clustered)

**Group bugs by directory, not by sequential BUG-ID.** This minimizes duplicate file reads across Skeptics:

1. For each bug, extract the directory path of its primary file (e.g., `src/auth/login.ts` -> `src/auth/`)
2. Group all bugs that share the same top-level directory (or second-level if top-level is too coarse, like `src/`)
3. Split directory groups into TWO roughly equal halves by total bug count
4. Assign each half to a Skeptic

If there are 5 or fewer total bugs, run a single Skeptic instead (parallelism overhead not worth it).

Launch Skeptic agents **in parallel** (in a single message with two Agent tool calls):

Each Skeptic receives:
- Its assigned subset of the bug list (with full details: files, lines, claims, evidence, runtime triggers, cross-references)
- The note: "Your bugs are grouped by directory — all bugs in files from the same directory subtree are assigned to you together."
- The Recon detected patterns section (framework, auth, DB, dependencies)

Wait for BOTH to complete.

### Step 6pb: Merge Skeptic results

Combine the Skeptic results into a single unified challenge report:
1. Maintain the original BUG-ID numbering
2. Compile the ACCEPTED BUG LIST from both Skeptics
3. Compile the DISPROVED list from both Skeptics
4. Calculate combined Skeptic stats

### Step 7p: Run Referee (single agent — needs full picture)

Launch ONE general-purpose subagent with the referee prompt. Inject:
- The merged Hunter bug report (with notes on which Hunter found each bug and any duplicates)
- The merged Skeptic challenge report
- Note which bugs were found by both Hunters (these have higher prior probability of being real)
- The total bug count — if >20, remind the Referee to use its tiered verification strategy

The Referee must independently read the code to make final judgments (for Tier 1 bugs). The Referee will also spot-check Hunter evidence quotes against actual file contents.

If cross-partition reconciliation ran, include its results.

Wait for completion.

**If the Referee fails or times out:** Fall back to the Skeptic's accepted bug list as the final result.
