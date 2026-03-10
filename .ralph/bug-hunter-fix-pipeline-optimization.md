# Bug Hunter Fix Pipeline Optimization — 12 Issues

Implement all 12 approved optimizations across the auto-fix pipeline.

## Files modified:
- `modes/fix-pipeline.md` — Steps 8a, 8c, 8d, 9, 10c, 10d, 12
- `scripts/fix-lock.cjs` — Added `renew` command
- `SKILL.md` — Added `--dry-run` flag parsing
- `CHANGELOG.md` — v2.2.0 entry
- `README.md` — CLI flags table + output files table

## Checklist:
- [x] #1 Rollback timeout guard in Step 10c (timeout 60s per revert, global Phase 2 timeout)
- [x] #2 Dynamic lock TTL in Step 8a (max(1800, eligible_bugs * 600))
- [x] #3 Lock heartbeat renewal command in fix-lock.cjs
- [x] #4 Fixer context budget (MAX_BUGS_PER_FIXER = 5, batch dispatching)
- [x] #5 Cross-file dependency ordering via import graph in Step 8d
- [x] #6 Flaky test detection baseline (run twice) in Step 8c
- [x] #7 Per-bug revert granularity clarification in Step 9 + 10c
- [x] #8 Dynamic canary sizing (max(1, min(3, ceil(eligible * 0.2)))) in Step 8d
- [x] #9 Post-fix re-scan severity floor (MEDIUM+) in Step 10d
- [x] #10 Fix dry-run mode (--dry-run flag) in SKILL.md + fix-pipeline.md
- [x] #11 Machine-readable fix-report.json in Step 12
- [x] #12 Circuit breaker (>50% failure rate → halt) in Step 9
- [x] Update CHANGELOG.md
- [x] Update README.md CLI flags table

## Status: COMPLETE
Commit: e9b21e2 — pushed to origin/main
