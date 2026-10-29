# Fix Loop (`--loop` with authorized fixing)

Read `modes/loop.md` and use its setup, cap, check-continue, resume, Recon reuse,
and coverage contract on every backend. There is one loop driver, including
runtimes with `ralph_start`/`ralph_done`.

For each permitted iteration:

1. Scan the next pending source assignment with the selected size mode.
2. For confirmed eligible findings, read `modes/fix-pipeline.md` and execute
   only the caller-authorized plan/fix/verification stages. Preserve immutable
   scope, canaries, circuit breakers, rollback, and separate commit authority.
3. Update coverage and `fixes` entries with actual terminal outcomes. Preserve
   failed/reverted/manual-review results; never retry a non-writable finding
   just because a loop is active. Apply the fix pipeline's retry/time limits.
4. Log the iteration through the shared loop contract. After any source mutation,
   finish verification for that fix batch and stop the scan run. The next audit
   starts with fresh triage, a new hash baseline, and Recon. Otherwise return to
   check-continue if authorized work remains. Report partial/blocked outcomes.

Do not require every discovered bug to be fixed to exit: manual decisions and
non-writable findings stay visible in the final report. A completion promise
requires terminal coverage, completed required verification/review, and no
pending authorized fix work. Source edits invalidate the old analysis baseline;
follow the stop-and-refresh rule above.
