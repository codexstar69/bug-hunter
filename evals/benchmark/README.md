# Behavioral benchmark

This corpus measures detection quality against nine calibration labels in five
small cases. It includes authorization, nullability, concurrency, SQL injection,
token signing, pagination, error handling, and input type failures. Safe ownership
middleware, enum-constrained SQL ordering, parameterized queries, null guards, and
mutex-protected operations act as false-positive traps. `clean-python-api` has no
labelled defects. The sources are snippets for scanning, not deployed services.

`public-manifest.json` names each case root, case-relative source paths, and SHA-256
digests. `private-labels.json` contains the labels and binds them to the manifest's
digest. These are **in-repo calibration data, not a hidden test set**. Validation
reads every listed file, verifies its digest, and rejects answer comments and
mechanism phrases from the labels. Do not give labels, recordings, or git history
to a scanner being evaluated. Copy only a case's `sourceFiles` into a fresh target
directory before scanning it. New cases and corpus changes require label review
and new hashes; do not rehash an accidental edit to make validation pass.

## Deterministic CI and scorer unit tests

```sh
pnpm benchmark:validate
pnpm benchmark:gate
node --test scripts/tests/opt-d-benchmark.test.cjs
```

`benchmark:gate` scores `recorded/runs.json`, recomputes the gate, and validates the
report schema. It never invokes a model or executes the snippets. The supplied
recordings are explicitly **synthetic** plumbing fixtures, with one intentional
miss; they are not evidence of a model's detection quality. A separately captured
synthetic scan is included in `recorded/synthetic-fixture/` to exercise import.
Replace the CI runs with reviewed real recordings when available, retaining their
honest provenance. No measured live baseline is bundled with this change.

`golden-runs.json` remains a synthetic scorer unit test with perfect matches and
slightly different locations/wording across repeats. `pnpm benchmark:fixture`
keeps its existing behavior of scoring those golden runs. A prompt change alone
does not change recorded findings: capture fresh paired runs to evaluate it.

## Import a real scan

Run the skill with `/bug-hunter --scan-only .` in an isolated copy of one case.
Keep the resulting `.bug-hunter/findings.json`, `referee.json`, and
`scan-report.json`. The recorder accepts either the target directory or its
`.bug-hunter` directory. It validates the canonical artifacts, joins confirmed
rows to Referee verdicts, and uses the Referee's severity and confidence. It
rejects duplicate IDs, inconsistent rows/counts, and findings outside the case.
Dismissed, manual-review, and unreviewed rows are not final predictions.

```sh
node scripts/benchmark-suite.cjs record \
  --run-dir /tmp/scan-auth/.bug-hunter \
  --case auth-boundary-js --profile balanced --repeat 1 \
  --telemetry /tmp/scan-auth/usage.json \
  --evidence-kind replayed --output /tmp/baseline-runs.json
```

`--manifest` and `--labels` override the bundled paths. `--profile` defaults to
`balanced`; `--repeat` defaults to `1`. Existing output bundles are appended to;
duplicate case/profile/repeat identities and mixed evidence kinds are rejected.
The output contains raw `runs`, per-run `scores`, artifact digests, corpus hashes,
and optional agent/model/skill revision metadata. Re-scoring always recomputes
matches from the raw runs. Repeat the command for every case and required repeat
(currently two balanced repeats per case), then score:

```sh
node scripts/benchmark-suite.cjs score \
  --manifest evals/benchmark/public-manifest.json \
  --labels evals/benchmark/private-labels.json \
  --runs /tmp/baseline-runs.json --output /tmp/baseline-report.json
node scripts/benchmark-suite.cjs gate --report /tmp/baseline-report.json
```

The optional telemetry JSON, also auto-detected as `.bug-hunter/telemetry.json`,
accepts measured `inputTokens`, `outputTokens`, `durationMs`, and `costUsd` (USD),
plus `agent`, `model`, and `skillGitSha`. Claude JSON fields `usage.input_tokens`,
`usage.output_tokens`, `usage.cache_creation_input_tokens`,
`usage.cache_read_input_tokens`, `total_cost_usd`, and `duration_ms` are also
supported. Codex token usage can be supplied as an extracted `usage` object;
cost/duration must be separately measured. Capture elapsed wall time in the
runner; file timestamps are not elapsed time. Absent measurements stay `null`
with aggregate telemetry status `unknown`, and efficiency gates fail closed.
Do not invent a cost from a token count. Explicit measured zero remains zero.
Time to first true positive is unknown unless a raw finding has `emittedAtMs`.

Every input bundle and report has `evidenceKind`: `synthetic`, `replayed`, or
`live`. `record` defaults to `replayed` because it imports existing artifacts.
Use `live` only when the importing runner has just captured the scan, and
`synthetic` for hand-authored data. This field exposes provenance to downstream
policy; the benchmark does not change adaptive policy behavior.

## Matching and gates

Predictions must first satisfy the canonical findings schema, including evidence,
runtime trigger, confidence, references, and security classification when needed.
A match requires the exact case-relative file, overlapping line ranges with at
most five lines of tolerance (`lineTolerance` may override it up to ten), severity
within one rank, and agreement with every mechanism phrase group. The groups
contain paraphrases and are checked in claim/evidence/runtime trigger, never in
references or category names. This is deterministic lexical calibration, not a
semantic adjudicator; review novel findings before adding labels. An unmatched
prediction is counted as a false positive, including duplicate predictions.

True-positive stability uses label IDs. False positives use file, range, and
category, excluding claim wording. The efficiency gate uses **total tokens /
total true positives across all runs**, charging clean controls and missed runs.
The legacy `maxMedianTokensPerTruePositive` threshold remains accepted as an alias
for that total-efficiency limit; the median is retained as a diagnostic metric.
Severity-weighted recall pools label weights instead of averaging clean runs.
Every observed profile must pass quality and efficiency gates separately.
`gate` recomputes checks from metrics and thresholds; stored `ok` is not authority.

## Compare paired reports

```sh
node scripts/benchmark-suite.cjs compare \
  --baseline /tmp/baseline-report.json \
  --candidate /tmp/candidate-report.json --output /tmp/comparison.json
# Equivalent package entry:
pnpm benchmark:compare --baseline /tmp/baseline-report.json --candidate /tmp/candidate-report.json
```

Reports must use the same manifest digest and label catalog and pair the same
case/profile/repeat identities. The output lists each label's hit rate, newly
found/lost instances, new and removed false positives, precision/recall, and
95% percentile bootstrap intervals for each report and their paired difference.
The fixed seed and 1,000 bootstrap samples make comparison deterministic. Each
sample resamples whole cases, preserving repeats and profiles within a case.
With only five cases these intervals are descriptive; a perfect small corpus can
produce a degenerate interval and is not proof of generalization.

Comparison exits nonzero when a previously always-found High/Critical label is
lost, precision or recall drops by more than 0.05, total tokens per true positive
or p95 duration rises by more than 20%, or the needed efficiency measurement is
unknown. Newly found labels, lost labels, and false-positive deltas are reported
even when tolerances allow the aggregate change. Comparison does not certify
synthetic results as live evidence; evidence kinds are included in its output.

The older `evals/evaluate-fixture.cjs` command remains a thin compatibility wrapper
around this matcher. `evals/expected-findings.json` points to the same six fixture
labels instead of maintaining a second set of answers.
