# Autoresearch: Bug Hunter Reliability & Quality Optimization

## Primary Metric
- **test_failures** — number of failing tests (lower is better)
- Measured by: `node --test scripts/tests/*.test.cjs 2>&1 | grep '# fail' | awk '{print $3}'`

## Secondary Metrics
- **test_pass** — number of passing tests (higher is better)
- **test_duration_s** — total test suite duration in seconds (lower is better)

## Baseline
- 60 total tests, 50 pass, 10 fail
- All failures in run-bug-hunter.test.cjs

## Rules
1. Each experiment = one logical fix or optimization
2. Run full test suite after each change
3. Never break passing tests
4. Commit each fix atomically
5. If a fix causes regressions, revert immediately

## Goal
Zero test failures, then optimize for quality/speed/reliability of the pipeline.
