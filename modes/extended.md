# Extended Mode (FILE_BUDGET+1 to FILE_BUDGET*2 files) — partitioned parallel

This mode adds file partitioning to keep each Hunter within context budget.

### Step 4e: Run Recon
Same as parallel mode. Capture the risk map. The Recon output should indicate "NEEDS PARTITIONING" in its Context Budget field.

### Step 5e: Partition files

Using the Recon risk map, create TWO file partitions:
- **Partition 1**: ALL CRITICAL files + first half of HIGH files + first half of MEDIUM files
- **Partition 2**: ALL CRITICAL files + second half of HIGH files + second half of MEDIUM files

CRITICAL files appear in BOTH partitions (they're highest value). HIGH/MEDIUM files are split evenly.

Test files (CONTEXT-ONLY) are included in both partitions.

Report to user: "Extended mode: [N] files split into 2 partitions ([P1] and [P2] files each, [C] CRITICAL files shared)."

### Step 5e-hunters: Run 4 Hunter agents

Launch FOUR Hunters **in parallel** (two pairs, each pair covers one partition):

- **Hunter-A1 (Security, Partition 1)**: Security lens on Partition 1 files
- **Hunter-B1 (Logic, Partition 1)**: Logic lens on Partition 1 files
- **Hunter-A2 (Security, Partition 2)**: Security lens on Partition 2 files
- **Hunter-B2 (Logic, Partition 2)**: Logic lens on Partition 2 files

Each Hunter receives the FULL risk map (for cross-reference context) but is instructed to only READ and REPORT on files in its assigned partition. If a cross-reference points to a file in the other partition, note it but don't trace it (the other partition's Hunters will cover it).

Wait for ALL to complete.

### Step 5e-verify: Gap-fill check
Same as parallel mode's gap-fill but across all 4 Hunters.

### Step 5e-merge: Merge all Hunter findings
Same logic as parallel mode's merge but across 4 Hunters. Deduplication is especially important here since CRITICAL files were scanned by all Hunters — expect duplicates on CRITICAL file bugs.

### Step 5e-reconcile: Cross-partition reconciliation

After merging, collect all UNTRACED CROSS-REFS from every Hunter. These are cross-references that pointed to files in a different partition and were noted but not traced.

If any untraced cross-refs exist:
1. Group them by target file
2. For each target file, collect the bug(s) that reference it and the specific claim about what the cross-ref should reveal
3. Launch a single **Reconciliation Agent** (general lens) with this prompt:
   - "You are a cross-reference verification agent. For each bug below, a Hunter identified a cross-file dependency but could not trace it because the file was in another partition. Your job: read the target file, trace the specific claim, and report whether the cross-reference SUPPORTS the bug claim, REFUTES it, or is INCONCLUSIVE. Do NOT find new bugs — only verify the cross-references you are given."
   - Pass the list of bugs + their untraced cross-refs + the merged findings for context
4. The Reconciliation Agent outputs a verdict for each cross-ref: SUPPORTS / REFUTES / INCONCLUSIVE
5. Update the merged bug list:
   - If REFUTES: add a note to the bug "Cross-ref refuted by reconciliation agent" — this weakens the finding
   - If SUPPORTS: add a note "Cross-ref verified by reconciliation agent" — this strengthens the finding
   - If INCONCLUSIVE: no change

If there are no untraced cross-refs, skip this step.

Report: "Cross-partition reconciliation: [N] cross-refs verified ([S] supported, [R] refuted, [I] inconclusive)" or "No cross-partition references to reconcile."

### Steps 6e and 7e
Same as parallel mode's Skeptic directory-clustering and Referee — they work identically regardless of how many Hunters ran.
