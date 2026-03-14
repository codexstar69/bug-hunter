const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  readJson,
  resolveSkillScript,
  runJson,
  runRaw,
  writeJson
} = require('./test-utils.cjs');

const SCRIPT = resolveSkillScript('experiment-loop.cjs');

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

test('init creates JSONL with config header', () => {
  const sandbox = makeSandbox('exp-init-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  const result = runJson('node', [SCRIPT, 'init', logPath, 'test-session', 'bugs_found', 'higher', 'count']);
  assert.equal(result.ok, true);
  assert.equal(result.segment, 0);
  assert.equal(result.name, 'test-session');
  assert.equal(result.metric.name, 'bugs_found');
  assert.equal(result.metric.direction, 'higher');

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const config = JSON.parse(lines[0]);
  assert.equal(config.type, 'config');
  assert.equal(config.segment, 0);
});

test('init increments segment number on subsequent calls', () => {
  const sandbox = makeSandbox('exp-init-seg-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  runJson('node', [SCRIPT, 'init', logPath, 'session-1', 'metric_a', 'lower']);
  const result = runJson('node', [SCRIPT, 'init', logPath, 'session-2', 'metric_b', 'higher']);
  assert.equal(result.segment, 1);
});

test('init rejects invalid direction', () => {
  const sandbox = makeSandbox('exp-init-bad-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  const result = runRaw('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'sideways']);
  assert.notEqual(result.status, 0);
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test('status on empty log shows uninitialized', () => {
  const sandbox = makeSandbox('exp-status-empty-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  const result = runJson('node', [SCRIPT, 'status', logPath]);
  assert.equal(result.ok, true);
  assert.equal(result.initialized, false);
  assert.equal(result.totalRuns, 0);
});

test('status after init shows initialized with zero runs', () => {
  const sandbox = makeSandbox('exp-status-init-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'bugs', 'higher']);

  const result = runJson('node', [SCRIPT, 'status', logPath]);
  assert.equal(result.initialized, true);
  assert.equal(result.segment, 0);
  assert.equal(result.totalRuns, 0);
  assert.equal(result.name, 'test');
});

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

test('log records a keep result and increments counters', () => {
  const sandbox = makeSandbox('exp-log-keep-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'score', 'higher']);

  // Log baseline
  const baseline = runJson('node', [
    SCRIPT, 'log', logPath, 'keep', '100',
    '--description', 'baseline',
    '--auto-commit', 'false'
  ]);
  assert.equal(baseline.ok, true);
  assert.equal(baseline.runNumber, 1);
  assert.equal(baseline.status, 'keep');
  assert.equal(baseline.value, 100);
  assert.equal(baseline.isBest, true);

  // Log improvement
  const improved = runJson('node', [
    SCRIPT, 'log', logPath, 'keep', '120',
    '--description', 'improved scoring',
    '--auto-commit', 'false'
  ]);
  assert.equal(improved.ok, true);
  assert.equal(improved.runNumber, 2);
  assert.equal(improved.isBest, true);
  assert.equal(improved.kept, 2);

  // Verify status
  const status = runJson('node', [SCRIPT, 'status', logPath]);
  assert.equal(status.totalRuns, 2);
  assert.equal(status.kept, 2);
  assert.equal(status.bestMetric, 120);
});

test('log records discard and crash correctly', () => {
  const sandbox = makeSandbox('exp-log-statuses-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'time', 'lower']);

  runJson('node', [SCRIPT, 'log', logPath, 'keep', '50', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'discard', '55', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'crash', '', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'checks_failed', '48', '--auto-commit', 'false']);

  const status = runJson('node', [SCRIPT, 'status', logPath]);
  assert.equal(status.totalRuns, 4);
  assert.equal(status.kept, 1);
  assert.equal(status.discarded, 1);
  assert.equal(status.crashed, 1);
  assert.equal(status.checksFailed, 1);
  // best should still be 50 (baseline) since only baseline was kept
  assert.equal(status.bestMetric, 50);
});

test('log rejects invalid status', () => {
  const sandbox = makeSandbox('exp-log-bad-status-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);

  const result = runRaw('node', [SCRIPT, 'log', logPath, 'invalid', '100']);
  assert.notEqual(result.status, 0);
});

test('log rejects without init', () => {
  const sandbox = makeSandbox('exp-log-no-init-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  const result = runRaw('node', [SCRIPT, 'log', logPath, 'keep', '100']);
  assert.notEqual(result.status, 0);
});

// ---------------------------------------------------------------------------
// delta calculation
// ---------------------------------------------------------------------------

test('log computes delta from baseline correctly', () => {
  const sandbox = makeSandbox('exp-delta-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'score', 'higher']);

  runJson('node', [SCRIPT, 'log', logPath, 'keep', '200', '--auto-commit', 'false']);
  const result = runJson('node', [
    SCRIPT, 'log', logPath, 'keep', '250',
    '--auto-commit', 'false'
  ]);
  assert.equal(result.delta, 25); // (250 - 200) / 200 * 100 = 25%
});

// ---------------------------------------------------------------------------
// secondary metric consistency (pi-autoresearch guardrail)
// ---------------------------------------------------------------------------

test('log enforces secondary metric consistency', () => {
  const sandbox = makeSandbox('exp-secondary-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'score', 'higher']);

  // First log with secondary metrics establishes the set
  runJson('node', [
    SCRIPT, 'log', logPath, 'keep', '100',
    '--secondary', '{"memory_mb":512,"cpu_pct":45}',
    '--auto-commit', 'false'
  ]);

  // Missing a secondary metric should fail
  const result = runRaw('node', [
    SCRIPT, 'log', logPath, 'keep', '110',
    '--secondary', '{"memory_mb":500}',
    '--auto-commit', 'false'
  ]);
  assert.notEqual(result.status, 0);
  const output = (result.stdout || '').trim();
  assert.ok(output.includes('secondary-metric-mismatch'));

  // Adding a new unexpected metric should also fail
  const result2 = runRaw('node', [
    SCRIPT, 'log', logPath, 'keep', '110',
    '--secondary', '{"memory_mb":500,"cpu_pct":40,"disk_gb":10}',
    '--auto-commit', 'false'
  ]);
  assert.notEqual(result2.status, 0);

  // With --force, new metrics are allowed
  const forced = runJson('node', [
    SCRIPT, 'log', logPath, 'keep', '110',
    '--secondary', '{"memory_mb":500,"cpu_pct":40,"disk_gb":10}',
    '--auto-commit', 'false',
    '--force', 'true'
  ]);
  assert.equal(forced.ok, true);
});

// ---------------------------------------------------------------------------
// stop file (pi-autoresearch guardrail: user can halt at any time)
// ---------------------------------------------------------------------------

test('stop creates stop file and run detects it', () => {
  const sandbox = makeSandbox('exp-stop-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  const stopFile = path.join(sandbox, 'experiment.stop');

  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);
  runJson('node', [SCRIPT, 'stop', '--stop-file', stopFile]);

  assert.ok(fs.existsSync(stopFile));

  // Run should detect stop file and exit with error
  const result = runRaw('node', [
    SCRIPT, 'run', logPath, 'echo hello',
    '--stop-file', stopFile
  ]);
  assert.notEqual(result.status, 0);
  const output = JSON.parse((result.stdout || '').trim());
  assert.equal(output.stopped, true);
  assert.equal(output.reason, 'stop-file-detected');
});

test('clear-stop removes the stop file', () => {
  const sandbox = makeSandbox('exp-clear-stop-');
  const stopFile = path.join(sandbox, 'experiment.stop');

  runJson('node', [SCRIPT, 'stop', '--stop-file', stopFile]);
  assert.ok(fs.existsSync(stopFile));

  runJson('node', [SCRIPT, 'clear-stop', '--stop-file', stopFile]);
  assert.ok(!fs.existsSync(stopFile));
});

// ---------------------------------------------------------------------------
// run (command execution with timing)
// ---------------------------------------------------------------------------

test('run executes command and captures output', () => {
  const sandbox = makeSandbox('exp-run-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);

  const stopFile = path.join(sandbox, 'no-stop');
  const result = runJson('node', [
    SCRIPT, 'run', logPath, 'echo "METRIC score=42.5"',
    '--stop-file', stopFile
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
  assert.equal(result.parsedMetrics.score, 42.5);
  assert.ok(result.durationMs >= 0);
});

test('run captures failure correctly', () => {
  const sandbox = makeSandbox('exp-run-fail-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);

  const stopFile = path.join(sandbox, 'no-stop');
  const result = runJson('node', [
    SCRIPT, 'run', logPath, 'exit 1',
    '--stop-file', stopFile
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, 1);
});

test('run without init fails', () => {
  const sandbox = makeSandbox('exp-run-no-init-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  const stopFile = path.join(sandbox, 'no-stop');
  const result = runRaw('node', [
    SCRIPT, 'run', logPath, 'echo hi',
    '--stop-file', stopFile
  ]);
  assert.notEqual(result.status, 0);
});

// ---------------------------------------------------------------------------
// backpressure checks (pi-autoresearch guardrail)
// ---------------------------------------------------------------------------

test('run executes checks script when command passes', () => {
  const sandbox = makeSandbox('exp-checks-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);

  // Create a checks script that fails
  const checksScript = path.join(sandbox, 'checks.sh');
  fs.writeFileSync(checksScript, '#!/bin/bash\nexit 1\n', { mode: 0o755 });

  const stopFile = path.join(sandbox, 'no-stop');
  const result = runJson('node', [
    SCRIPT, 'run', logPath, 'echo "METRIC score=10"',
    '--stop-file', stopFile,
    '--checks-script', checksScript
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
  assert.equal(result.checksPassed, false);
  assert.equal(result.checksSkipped, false);
});

test('run skips checks when command fails', () => {
  const sandbox = makeSandbox('exp-checks-skip-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);

  const checksScript = path.join(sandbox, 'checks.sh');
  fs.writeFileSync(checksScript, '#!/bin/bash\nexit 1\n', { mode: 0o755 });

  const stopFile = path.join(sandbox, 'no-stop');
  const result = runJson('node', [
    SCRIPT, 'run', logPath, 'exit 1',
    '--stop-file', stopFile,
    '--checks-script', checksScript
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.checksSkipped, true); // Checks not run when command fails
});

// ---------------------------------------------------------------------------
// auto-resume rate limiting (pi-autoresearch guardrail)
// ---------------------------------------------------------------------------

test('can-resume returns true when no prior resume', () => {
  const sandbox = makeSandbox('exp-resume-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);

  const result = runJson('node', [SCRIPT, 'can-resume', logPath]);
  assert.equal(result.canResume, true);
});

test('record-resume and can-resume enforce cooldown', () => {
  const sandbox = makeSandbox('exp-resume-cooldown-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);
  runJson('node', [SCRIPT, 'record-resume', logPath]);

  const result = runJson('node', [SCRIPT, 'can-resume', logPath]);
  assert.equal(result.canResume, false);
  assert.ok(result.cooldownRemainingMs > 0);
});

// ---------------------------------------------------------------------------
// state reconstruction (pi-autoresearch pattern)
// ---------------------------------------------------------------------------

test('state is fully reconstructable from JSONL alone', () => {
  const sandbox = makeSandbox('exp-reconstruct-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  runJson('node', [SCRIPT, 'init', logPath, 'sess-1', 'bugs', 'higher', 'count']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '5', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'discard', '3', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '8', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'crash', '', '--auto-commit', 'false']);

  const status = runJson('node', [SCRIPT, 'status', logPath]);
  assert.equal(status.totalRuns, 4);
  assert.equal(status.kept, 2);
  assert.equal(status.discarded, 1);
  assert.equal(status.crashed, 1);
  assert.equal(status.bestMetric, 8);
  assert.equal(status.segmentCount, 1);
});

test('new segment resets baseline and best metric', () => {
  const sandbox = makeSandbox('exp-segments-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  // Segment 0
  runJson('node', [SCRIPT, 'init', logPath, 'sess-1', 'time', 'lower', 'ms']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '100', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '80', '--auto-commit', 'false']);

  // Segment 1 — new baseline
  runJson('node', [SCRIPT, 'init', logPath, 'sess-2', 'errors', 'lower', 'count']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '50', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '30', '--auto-commit', 'false']);

  const status = runJson('node', [SCRIPT, 'status', logPath]);
  assert.equal(status.segmentCount, 2);
  assert.equal(status.segment, 1);
  assert.equal(status.bestMetric, 30);
  assert.equal(status.name, 'sess-2');
  // Total across all segments
  assert.equal(status.totalRuns, 4);
});

// ---------------------------------------------------------------------------
// METRIC line parsing
// ---------------------------------------------------------------------------

test('run parses multiple METRIC lines from stdout', () => {
  const sandbox = makeSandbox('exp-parse-metrics-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);

  const stopFile = path.join(sandbox, 'no-stop');
  const cmd = 'echo "METRIC bugs_found=12"; echo "METRIC false_positives=2"; echo "METRIC confidence=87.5"';
  const result = runJson('node', [
    SCRIPT, 'run', logPath, cmd,
    '--stop-file', stopFile
  ]);
  assert.equal(result.parsedMetrics.bugs_found, 12);
  assert.equal(result.parsedMetrics.false_positives, 2);
  assert.equal(result.parsedMetrics.confidence, 87.5);
});

// ---------------------------------------------------------------------------
// lower-is-better direction
// ---------------------------------------------------------------------------

test('lower direction: improvement is detected correctly', () => {
  const sandbox = makeSandbox('exp-lower-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'perf', 'latency', 'lower', 'ms']);

  runJson('node', [SCRIPT, 'log', logPath, 'keep', '100', '--auto-commit', 'false']);
  const improved = runJson('node', [
    SCRIPT, 'log', logPath, 'keep', '85',
    '--auto-commit', 'false'
  ]);
  assert.equal(improved.isBest, true);
  assert.equal(improved.delta, -15); // (85 - 100) / 100 * 100 = -15%

  // Worse result (higher latency) should not be best
  const worse = runJson('node', [
    SCRIPT, 'log', logPath, 'keep', '95',
    '--auto-commit', 'false'
  ]);
  assert.equal(worse.isBest, false);
});

// ---------------------------------------------------------------------------
// max iterations hard cap
// ---------------------------------------------------------------------------

test('init accepts --max-iterations and stores it in config', () => {
  const sandbox = makeSandbox('exp-max-iter-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  const result = runJson('node', [
    SCRIPT, 'init', logPath, 'test', 'metric', 'higher', 'count',
    '--max-iterations', '5'
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.maxIterations, 5);

  const status = runJson('node', [SCRIPT, 'status', logPath]);
  assert.equal(status.maxIterations, 5);
  assert.equal(status.remaining, 5);
});

test('init uses default max iterations (10) when not specified', () => {
  const sandbox = makeSandbox('exp-max-iter-default-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);
  const status = runJson('node', [SCRIPT, 'status', logPath]);
  assert.equal(status.maxIterations, 10);
});

// ---------------------------------------------------------------------------
// check-continue (single gateway for all loop conditions)
// ---------------------------------------------------------------------------

test('check-continue returns true when conditions are met', () => {
  const sandbox = makeSandbox('exp-continue-ok-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  const stopFile = path.join(sandbox, 'no-stop');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);

  const result = runJson('node', [
    SCRIPT, 'check-continue', logPath, '--stop-file', stopFile
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.continue, true);
  assert.equal(result.iteration, 1);
  assert.equal(result.maxIterations, 10);
  assert.equal(result.remaining, 10);
});

test('check-continue stops at max iterations', () => {
  const sandbox = makeSandbox('exp-continue-cap-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  const stopFile = path.join(sandbox, 'no-stop');

  runJson('node', [SCRIPT, 'init', logPath, 'test', 'score', 'higher', 'count', '--max-iterations', '3']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '10', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '20', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '30', '--auto-commit', 'false']);

  const result = runJson('node', [
    SCRIPT, 'check-continue', logPath, '--stop-file', stopFile
  ]);
  assert.equal(result.continue, false);
  assert.equal(result.reason, 'max-iterations-reached');
});

test('check-continue stops on user stop file', () => {
  const sandbox = makeSandbox('exp-continue-stop-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  const stopFile = path.join(sandbox, 'experiment.stop');

  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);
  runJson('node', [SCRIPT, 'stop', '--stop-file', stopFile]);

  const result = runJson('node', [
    SCRIPT, 'check-continue', logPath, '--stop-file', stopFile
  ]);
  assert.equal(result.continue, false);
  assert.equal(result.reason, 'user-stopped');
});

test('check-continue stops after consecutive crashes', () => {
  const sandbox = makeSandbox('exp-continue-crash-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  const stopFile = path.join(sandbox, 'no-stop');

  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '10', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'crash', '', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'crash', '', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'crash', '', '--auto-commit', 'false']);

  const result = runJson('node', [
    SCRIPT, 'check-continue', logPath, '--stop-file', stopFile
  ]);
  assert.equal(result.continue, false);
  assert.equal(result.reason, 'consecutive-crashes');
});

test('check-continue resets crash counter on non-crash result', () => {
  const sandbox = makeSandbox('exp-continue-crash-reset-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  const stopFile = path.join(sandbox, 'no-stop');

  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);
  runJson('node', [SCRIPT, 'log', logPath, 'crash', '', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'crash', '', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '10', '--auto-commit', 'false']); // resets
  runJson('node', [SCRIPT, 'log', logPath, 'crash', '', '--auto-commit', 'false']);

  const result = runJson('node', [
    SCRIPT, 'check-continue', logPath, '--stop-file', stopFile
  ]);
  assert.equal(result.continue, true); // only 1 consecutive crash, not 3
});

test('check-continue stops on resume cooldown', () => {
  const sandbox = makeSandbox('exp-continue-cooldown-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  const stopFile = path.join(sandbox, 'no-stop');

  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher']);
  runJson('node', [SCRIPT, 'record-resume', logPath]);

  const result = runJson('node', [
    SCRIPT, 'check-continue', logPath, '--stop-file', stopFile
  ]);
  assert.equal(result.continue, false);
  assert.equal(result.reason, 'resume-cooldown');
});

test('check-continue shows remaining iterations correctly', () => {
  const sandbox = makeSandbox('exp-continue-remaining-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  const stopFile = path.join(sandbox, 'no-stop');

  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher', 'count', '--max-iterations', '5']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '10', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'discard', '8', '--auto-commit', 'false']);

  const result = runJson('node', [
    SCRIPT, 'check-continue', logPath, '--stop-file', stopFile
  ]);
  assert.equal(result.continue, true);
  assert.equal(result.iteration, 3);
  assert.equal(result.remaining, 3);
});

test('new segment resets segmentRuns counter for iteration cap', () => {
  const sandbox = makeSandbox('exp-segment-reset-cap-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  const stopFile = path.join(sandbox, 'no-stop');

  // Segment 0: use up all 3 iterations
  runJson('node', [SCRIPT, 'init', logPath, 'sess-1', 'metric', 'higher', 'count', '--max-iterations', '3']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '10', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '20', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '30', '--auto-commit', 'false']);

  // Should be capped
  const capped = runJson('node', [
    SCRIPT, 'check-continue', logPath, '--stop-file', stopFile
  ]);
  assert.equal(capped.continue, false);
  assert.equal(capped.reason, 'max-iterations-reached');

  // Segment 1: new session resets counter
  runJson('node', [SCRIPT, 'init', logPath, 'sess-2', 'metric', 'higher', 'count', '--max-iterations', '5']);
  const fresh = runJson('node', [
    SCRIPT, 'check-continue', logPath, '--stop-file', stopFile
  ]);
  assert.equal(fresh.continue, true);
  assert.equal(fresh.remaining, 5);
});

// ---------------------------------------------------------------------------
// status shows new fields
// ---------------------------------------------------------------------------

test('status shows segmentRuns, maxIterations, remaining, consecutiveCrashes', () => {
  const sandbox = makeSandbox('exp-status-fields-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  runJson('node', [SCRIPT, 'init', logPath, 'test', 'metric', 'higher', 'count', '--max-iterations', '8']);
  runJson('node', [SCRIPT, 'log', logPath, 'keep', '10', '--auto-commit', 'false']);
  runJson('node', [SCRIPT, 'log', logPath, 'crash', '', '--auto-commit', 'false']);

  const status = runJson('node', [SCRIPT, 'status', logPath]);
  assert.equal(status.segmentRuns, 2);
  assert.equal(status.maxIterations, 8);
  assert.equal(status.remaining, 6);
  assert.equal(status.consecutiveCrashes, 1);
});

// ---------------------------------------------------------------------------
// negative metric values
// ---------------------------------------------------------------------------

test('log handles negative metric values correctly', () => {
  const sandbox = makeSandbox('exp-negative-metric-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'pnl', 'higher', 'usd']);

  const baseline = runJson('node', [
    SCRIPT, 'log', logPath, 'keep', '-50',
    '--auto-commit', 'false'
  ]);
  assert.equal(baseline.ok, true);
  assert.equal(baseline.value, -50);
  assert.equal(baseline.isBest, true);

  // Improvement from -50 to -20 (higher is better, so -20 > -50)
  const improved = runJson('node', [
    SCRIPT, 'log', logPath, 'keep', '-20',
    '--auto-commit', 'false'
  ]);
  assert.equal(improved.isBest, true);
  assert.equal(improved.delta, 60); // (-20 - (-50)) / |-50| * 100 = 60%

  const status = runJson('node', [SCRIPT, 'status', logPath]);
  assert.equal(status.bestMetric, -20);
});

// ---------------------------------------------------------------------------
// zero and negative max-iterations edge cases
// ---------------------------------------------------------------------------

test('init with zero max-iterations defaults to 10', () => {
  const sandbox = makeSandbox('exp-zero-max-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  const result = runJson('node', [
    SCRIPT, 'init', logPath, 'test', 'metric', 'higher', 'count',
    '--max-iterations', '0'
  ]);
  assert.equal(result.ok, true);
  // Zero should be clamped or default — status should show a usable value
  const status = runJson('node', [SCRIPT, 'status', logPath]);
  assert.ok(status.maxIterations >= 1, `maxIterations should be >= 1, got ${status.maxIterations}`);
});

test('init with negative max-iterations defaults to 10', () => {
  const sandbox = makeSandbox('exp-neg-max-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  const result = runJson('node', [
    SCRIPT, 'init', logPath, 'test', 'metric', 'higher', 'count',
    '--max-iterations', '-5'
  ]);
  assert.equal(result.ok, true);
  const status = runJson('node', [SCRIPT, 'status', logPath]);
  assert.ok(status.maxIterations >= 1, `maxIterations should be >= 1, got ${status.maxIterations}`);
});

// ---------------------------------------------------------------------------
// --duration-ms flag in log
// ---------------------------------------------------------------------------

test('log accepts --duration-ms and persists it', () => {
  const sandbox = makeSandbox('exp-duration-ms-');
  const logPath = path.join(sandbox, 'experiment.jsonl');
  runJson('node', [SCRIPT, 'init', logPath, 'test', 'score', 'higher']);

  runJson('node', [
    SCRIPT, 'log', logPath, 'keep', '100',
    '--auto-commit', 'false',
    '--duration-ms', '5432'
  ]);

  // Read the JSONL and verify the result entry has durationMs
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  const resultEntry = JSON.parse(lines[lines.length - 1]);
  assert.equal(resultEntry.type, 'result');
  assert.equal(resultEntry.durationMs, 5432);
});

// ---------------------------------------------------------------------------
// corrupt JSONL lines are skipped gracefully
// ---------------------------------------------------------------------------

test('reconstructs state even with corrupt lines in JSONL', () => {
  const sandbox = makeSandbox('exp-corrupt-');
  const logPath = path.join(sandbox, 'experiment.jsonl');

  // Manually write JSONL with a corrupt line
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const configLine = JSON.stringify({
    type: 'config', segment: 0, timestamp: Date.now(),
    name: 'test', metric: { name: 'score', unit: '', direction: 'higher' }
  });
  const resultLine = JSON.stringify({
    type: 'result', segment: 0, timestamp: Date.now(),
    value: 42, status: 'keep', description: 'baseline'
  });
  fs.writeFileSync(logPath, `${configLine}\nNOT_JSON_LINE\n${resultLine}\n`);

  const status = runJson('node', [SCRIPT, 'status', logPath]);
  assert.equal(status.ok, true);
  assert.equal(status.initialized, true);
  assert.equal(status.totalRuns, 1);
  assert.equal(status.bestMetric, 42);
});
