#!/usr/bin/env node

/**
 * experiment-loop.cjs — Autonomous experiment loop for bug-hunter
 *
 * Inspired by pi-autoresearch: append-only JSONL persistence, metric tracking
 * with baseline + delta, segmented sessions, stop-file interruption, and
 * auto-resume with rate limiting.
 *
 * Guardrails (from pi-autoresearch):
 *  - JSONL is append-only — never modify existing entries
 *  - Full state is reconstructable from the JSONL alone
 *  - Secondary metric consistency enforced across all results in a segment
 *  - Stop-file checked before every run — user can halt at any time
 *  - Auto-resume rate-limited to once per RESUME_COOLDOWN_MS
 *  - Backpressure checks (optional checks command) must pass before keeping
 *  - Each init starts a new segment with a fresh baseline
 *
 * Security: All shell commands use spawnSync with explicit argv arrays
 * (no shell interpolation). The single exception is the user-provided
 * benchmark command in `run`, which is intentionally executed via bash -c
 * because the user controls and specifies the command string.
 */

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESUME_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes — matches pi-autoresearch
const DEFAULT_STOP_FILE = '.bug-hunter/experiment.stop';
const DEFAULT_LOG_FILE = '.bug-hunter/experiment.jsonl';
const DEFAULT_CHECKS_SCRIPT = '.bug-hunter/experiment.checks.sh';
const MAX_STDOUT_BYTES = 50000; // Truncate captured output to prevent memory bloat
const DEFAULT_MAX_ITERATIONS = 10; // Hard cap — prevents runaway loops
const MAX_CONSECUTIVE_CRASHES = 3; // Auto-stop after N crashes in a row
const MIN_TIMEOUT_MS = 1000;       // 1 second minimum for --timeout-ms
const MAX_TIMEOUT_MS = 3600000;    // 1 hour maximum for --timeout-ms

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function ensureParent(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create parent directory for ${filePath}: ${msg}`);
  }
}

function appendJsonl(filePath, obj) {
  ensureParent(filePath);
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to append to ${filePath}: ${msg}`);
  }
}

function readJsonlLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    return [];
  }
  return raw.split('\n').map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Corrupt JSONL at ${filePath}:${index + 1}: ${message}`);
    }
  });
}

function truncateOutput(str, maxBytes) {
  if (!str || str.length <= maxBytes) {
    return str || '';
  }
  return `${str.slice(0, maxBytes)}\n... [truncated at ${maxBytes} bytes]`;
}

// ---------------------------------------------------------------------------
// State reconstruction from JSONL (pi-autoresearch pattern)
// ---------------------------------------------------------------------------

function reconstructState(logPath) {
  const lines = readJsonlLines(logPath);
  const state = {
    segments: [],
    currentSegment: -1,
    results: [],
    bestMetric: null,
    bestDelta: null,
    metricDef: null,
    metricDirection: null,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    secondaryMetricNames: null, // Set on first result with secondaryMetrics
    totalRuns: 0,
    segmentRuns: 0, // runs in current segment only (resets on new segment)
    kept: 0,
    discarded: 0,
    crashed: 0,
    checksFailed: 0,
    consecutiveCrashes: 0,
    lastResumeAt: null
  };

  for (const entry of lines) {
    if (entry.type === 'config') {
      state.currentSegment = typeof entry.segment === 'number' ? entry.segment : state.segments.length;
      state.segments.push({
        segment: state.currentSegment,
        name: entry.name || 'unnamed',
        metric: entry.metric || null,
        maxIterations: entry.maxIterations || DEFAULT_MAX_ITERATIONS,
        baselineIndex: null,
        results: []
      });
      state.metricDef = entry.metric || null;
      state.metricDirection = entry.metric ? entry.metric.direction : null;
      state.maxIterations = entry.maxIterations || DEFAULT_MAX_ITERATIONS;
      state.bestMetric = null;
      state.bestDelta = null;
      state.secondaryMetricNames = null; // Reset for new segment
      state.segmentRuns = 0;
      state.consecutiveCrashes = 0;
      continue;
    }

    if (entry.type === 'resume') {
      state.lastResumeAt = entry.timestamp || null;
      continue;
    }

    if (entry.type === 'result') {
      const seg = state.segments[state.segments.length - 1];
      if (!seg) {
        continue; // orphan result without a config header — skip
      }
      const result = {
        segment: state.currentSegment,
        value: entry.value,
        secondaryMetrics: entry.secondaryMetrics || {},
        status: entry.status || 'discard',
        description: entry.description || '',
        commit: entry.commit || '',
        durationMs: entry.durationMs || 0,
        timestamp: entry.timestamp || 0
      };

      seg.results.push(result);
      state.results.push(result);
      state.totalRuns += 1;
      state.segmentRuns += 1;

      if (result.status === 'keep') {
        state.kept += 1;
        state.consecutiveCrashes = 0;
      } else if (result.status === 'discard') {
        state.discarded += 1;
        state.consecutiveCrashes = 0;
      } else if (result.status === 'crash') {
        state.crashed += 1;
        state.consecutiveCrashes += 1;
      } else if (result.status === 'checks_failed') {
        state.checksFailed += 1;
        state.consecutiveCrashes = 0;
      }

      // Baseline is first result in segment
      if (seg.baselineIndex === null
        && result.status === 'keep'
        && typeof result.value === 'number') {
        seg.baselineIndex = seg.results.length - 1;
        state.bestMetric = result.value;
        state.bestDelta = null;
      } else if (typeof result.value === 'number' && state.bestMetric !== null) {
        const isBetter = state.metricDirection === 'lower'
          ? result.value < state.bestMetric
          : result.value > state.bestMetric;
        if (result.status === 'keep' && isBetter) {
          state.bestMetric = result.value;
        }
      }

      // Enforce secondary metric consistency within a segment
      if (result.secondaryMetrics && Object.keys(result.secondaryMetrics).length > 0) {
        if (state.secondaryMetricNames === null) {
          state.secondaryMetricNames = new Set(Object.keys(result.secondaryMetrics));
        }
      }
    }
  }

  // Compute delta from baseline
  if (state.bestMetric !== null && state.segments.length > 0) {
    const seg = state.segments[state.segments.length - 1];
    if (seg.baselineIndex !== null) {
      const baseline = seg.results[seg.baselineIndex].value;
      if (typeof baseline === 'number' && baseline !== 0) {
        state.bestDelta = ((state.bestMetric - baseline) / Math.abs(baseline)) * 100;
      }
    }
  }

  return state;
}

// ---------------------------------------------------------------------------
// Stop file check (pi-autoresearch guardrail: user can halt at any time)
// ---------------------------------------------------------------------------

function isStopRequested(stopFile) {
  return fs.existsSync(stopFile);
}

function clearStopFile(stopFile) {
  try {
    if (fs.existsSync(stopFile)) {
      fs.unlinkSync(stopFile);
    }
  } catch (err) {
    // Ignore ENOENT — file was already removed (race condition)
    if (err.code !== 'ENOENT') {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to remove stop file ${stopFile}: ${msg}`);
    }
  }
}

function requestStop(stopFile) {
  ensureParent(stopFile);
  fs.writeFileSync(stopFile, `stop requested at ${nowIso()}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Auto-resume rate limiting (pi-autoresearch guardrail)
// ---------------------------------------------------------------------------

function canResume(state) {
  if (state.lastResumeAt === null) {
    return true;
  }
  return (nowMs() - state.lastResumeAt) >= RESUME_COOLDOWN_MS;
}

function recordResume(logPath) {
  const entry = { type: 'resume', timestamp: nowMs() };
  const validation = validateExperimentEntry(entry);
  if (!validation.ok) {
    throw new Error(`Invalid resume entry: ${validation.errors.join('; ')}`);
  }
  appendJsonl(logPath, entry);
}

// ---------------------------------------------------------------------------
// Secondary metric consistency enforcement (pi-autoresearch guardrail)
// ---------------------------------------------------------------------------

function validateSecondaryMetrics(state, secondaryMetrics, force) {
  if (!state.secondaryMetricNames || state.secondaryMetricNames.size === 0) {
    return { ok: true, errors: [] };
  }
  if (force) {
    return { ok: true, errors: [] };
  }

  const errors = [];
  const incoming = new Set(Object.keys(secondaryMetrics || {}));
  const expected = state.secondaryMetricNames;

  for (const name of expected) {
    if (!incoming.has(name)) {
      errors.push(`Missing secondary metric: ${name}`);
    }
  }
  for (const name of incoming) {
    if (!expected.has(name)) {
      errors.push(`Unexpected new secondary metric: ${name} (use --force to allow)`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Entry validation before JSONL write
// ---------------------------------------------------------------------------

function validateExperimentEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { ok: false, errors: ['Entry must be an object'] };
  }
  if (!['config', 'result', 'resume'].includes(entry.type)) {
    errors.push(`Invalid type: ${entry.type}`);
    return { ok: false, errors };
  }
  if (entry.type === 'config') {
    if (typeof entry.segment !== 'number') errors.push('config entry requires segment (number)');
    if (!entry.name) errors.push('config entry requires name');
    if (!entry.metric || !entry.metric.name || !entry.metric.direction) {
      errors.push('config entry requires metric with name and direction');
    }
    if (!Number.isInteger(entry.maxIterations) || entry.maxIterations < 1) {
      errors.push('config entry requires maxIterations (positive integer)');
    }
  }
  if (entry.type === 'result') {
    if (typeof entry.segment !== 'number') errors.push('result entry requires segment (number)');
    if (!['keep', 'discard', 'crash', 'checks_failed'].includes(entry.status)) {
      errors.push('result entry requires valid status');
    }
    if (typeof entry.durationMs !== 'number' || entry.durationMs < 0) {
      errors.push('result entry requires durationMs (non-negative number)');
    }
  }
  if (entry.type === 'resume') {
    if (typeof entry.timestamp !== 'number') errors.push('resume entry requires timestamp (number)');
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Run experiment
//
// Note: The benchmark command is executed via `bash -c` because the user
// provides the full command string (e.g. "bun run test"). This is by design
// — the command comes from the experiment session config, not untrusted input.
// All other shell interactions use spawnSync with explicit argv arrays.
// ---------------------------------------------------------------------------

function runExperiment(command, timeoutMs) {
  const startMs = nowMs();
  let result;
  try {
    result = childProcess.spawnSync('bash', ['-c', command], {
      encoding: 'utf8',
      timeout: timeoutMs || 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BUG_HUNTER_EXPERIMENT: '1' }
    });
  } catch (error) {
    const durationMs = nowMs() - startMs;
    return {
      passed: false,
      durationMs,
      exitCode: -1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false
    };
  }
  const durationMs = nowMs() - startMs;
  const timedOut = result.signal === 'SIGTERM'
    || result.signal === 'SIGKILL'
    || (result.error && result.error.code === 'ETIMEDOUT');
  // A null exit status means the process was killed by a signal — always a failure
  const exitedClean = result.status === 0 && result.signal === null;
  return {
    passed: exitedClean && !timedOut,
    durationMs,
    exitCode: result.status,
    stdout: truncateOutput(result.stdout || '', MAX_STDOUT_BYTES),
    stderr: truncateOutput(result.stderr || '', MAX_STDOUT_BYTES),
    timedOut
  };
}

// ---------------------------------------------------------------------------
// Run backpressure checks (pi-autoresearch guardrail)
// ---------------------------------------------------------------------------

function runChecks(checksScript) {
  if (!fs.existsSync(checksScript)) {
    return { passed: true, skipped: true, stdout: '', stderr: '', timedOut: false };
  }
  const result = childProcess.spawnSync('bash', [checksScript], {
    encoding: 'utf8',
    timeout: 300000, // 5 min max for checks
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BUG_HUNTER_EXPERIMENT: '1' }
  });
  const timedOut = result.signal === 'SIGTERM'
    || result.signal === 'SIGKILL'
    || (result.error && result.error.code === 'ETIMEDOUT');
  return {
    passed: result.status === 0 && !timedOut,
    skipped: false,
    stdout: truncateOutput(result.stdout || '', MAX_STDOUT_BYTES),
    stderr: truncateOutput(result.stderr || '', MAX_STDOUT_BYTES),
    timedOut
  };
}

// ---------------------------------------------------------------------------
// Parse METRIC lines from stdout (pi-autoresearch pattern)
// ---------------------------------------------------------------------------

function parseMetrics(stdout) {
  const metrics = {};
  const lines = (stdout || '').split('\n');
  for (const line of lines) {
    const match = /^METRIC\s+(\S+)=([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(line);
    if (match) {
      metrics[match[1]] = Number(match[2]);
    }
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Git helpers
//
// All git commands use spawnSync with explicit argv (no shell interpolation).
// ---------------------------------------------------------------------------

function gitCommitHash(cwd) {
  try {
    const result = childProcess.spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 10000
    });
    if (result.status !== 0) {
      return 'unknown';
    }
    return (result.stdout || '').trim() || 'unknown';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: git rev-parse failed: ${msg}`);
    return 'unknown';
  }
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveExistingAncestor(candidatePath) {
  let current = candidatePath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return fs.realpathSync(current);
}

function normalizeAllowedPaths({ allowedPaths, repositoryRoot }) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    throw new Error('Auto-commit requires a non-empty --allowed-paths JSON array');
  }

  const realRepositoryRoot = fs.realpathSync(repositoryRoot);
  return allowedPaths.map((allowedPath) => {
    if (typeof allowedPath !== 'string' || allowedPath.length === 0 || allowedPath.includes('\0')) {
      throw new Error('Every auto-commit path must be a non-empty string');
    }
    if (path.isAbsolute(allowedPath)) {
      throw new Error(`Auto-commit path must be repository-relative: ${allowedPath}`);
    }

    const normalized = path.normalize(allowedPath);
    if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`Auto-commit path escapes the repository: ${allowedPath}`);
    }

    const absolutePath = path.resolve(realRepositoryRoot, normalized);
    const realBoundary = fs.existsSync(absolutePath)
      ? fs.realpathSync(absolutePath)
      : resolveExistingAncestor(absolutePath);
    if (!isPathInside(realRepositoryRoot, absolutePath)
      || !isPathInside(realRepositoryRoot, realBoundary)) {
      throw new Error(`Auto-commit path escapes the repository through a symlink: ${allowedPath}`);
    }

    return normalized.split(path.sep).join('/');
  });
}

function parseDirtyPaths(statusOutput) {
  return statusOutput
    .split('\0')
    .filter(Boolean)
    .map((line) => line.slice(3));
}

function pathIsAllowed(filePath, allowedPaths) {
  return allowedPaths.some((allowedPath) => {
    return filePath === allowedPath || filePath.startsWith(`${allowedPath}/`);
  });
}

function gitAutoCommit({ description, cwd, allowedPaths }) {
  try {
    const rootResult = childProcess.spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: 10000
    });
    if (rootResult.status !== 0) {
      const stderr = (rootResult.stderr || '').trim();
      return { ok: false, error: stderr || 'not inside a Git repository' };
    }

    const repositoryRoot = (rootResult.stdout || '').trim();
    const normalizedPaths = normalizeAllowedPaths({ allowedPaths, repositoryRoot });
    const statusResult = childProcess.spawnSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
      { cwd: repositoryRoot, encoding: 'utf8', timeout: 30000 }
    );
    if (statusResult.status !== 0) {
      const stderr = (statusResult.stderr || '').trim();
      return { ok: false, error: stderr || 'git status failed' };
    }

    const outsidePaths = parseDirtyPaths(statusResult.stdout || '')
      .filter((filePath) => !pathIsAllowed(filePath, normalizedPaths));
    if (outsidePaths.length > 0) {
      return {
        ok: false,
        error: `Dirty paths outside the approved auto-commit scope: ${outsidePaths.join(', ')}`
      };
    }

    const addResult = childProcess.spawnSync(
      'git',
      ['add', '--', ...normalizedPaths],
      { cwd: repositoryRoot, encoding: 'utf8', timeout: 30000 }
    );
    if (addResult.status !== 0) {
      const stderr = (addResult.stderr || '').trim();
      return { ok: false, error: stderr || `git add exited ${addResult.status}` };
    }

    const msg = `experiment: ${description}\n\nResult: keep`;
    const result = childProcess.spawnSync('git', ['commit', '-m', msg], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 30000
    });
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      console.error(`Warning: git commit exited ${result.status}: ${stderr}`);
      return { ok: false, error: stderr || `exit code ${result.status}` };
    }
    return { ok: true, error: '' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: git auto-commit failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// CLI commands
// ---------------------------------------------------------------------------

function usage() {
  console.error('Usage:');
  console.error('  experiment-loop.cjs init <logPath> <name> <metricName> <direction> [unit] [--max-iterations <n>]');
  console.error('  experiment-loop.cjs run <logPath> <command> [--timeout-ms <n>] [--checks-script <path>] [--stop-file <path>]');
  console.error('  experiment-loop.cjs log <logPath> <status> <metricValue> [--description <text>] [--secondary <json>] [--auto-commit <true|false>] [--allowed-paths <json-array>] [--force <true|false>] [--duration-ms <ms>]');
  console.error('  experiment-loop.cjs check-continue <logPath> [--stop-file <path>]');
  console.error('  experiment-loop.cjs status <logPath>');
  console.error('  experiment-loop.cjs stop [--stop-file <path>]');
  console.error('  experiment-loop.cjs clear-stop [--stop-file <path>]');
  console.error('  experiment-loop.cjs can-resume <logPath>');
  console.error('  experiment-loop.cjs record-resume <logPath>');
}

function parseNamedArgs(args) {
  const named = {};
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] || '';
      named[key] = value;
      i += 2;
    } else {
      i += 1;
    }
  }
  return named;
}

function cmdInit(args) {
  const positional = [];
  const named = {};
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith('--')) {
      named[args[i].slice(2)] = args[i + 1] || '';
      i += 2;
    } else {
      positional.push(args[i]);
      i += 1;
    }
  }

  const [logPath, name, metricName, direction, unit] = positional;
  if (!logPath || !name || !metricName || !direction) {
    usage();
    process.exit(1);
  }
  if (direction !== 'lower' && direction !== 'higher') {
    console.error('direction must be "lower" or "higher"');
    process.exit(1);
  }

  const maxIterParsed = Number.parseInt(named['max-iterations'] || '', 10);
  const maxIterations = Number.isInteger(maxIterParsed) && maxIterParsed > 0
    ? maxIterParsed
    : DEFAULT_MAX_ITERATIONS;

  const state = reconstructState(logPath);
  const segment = state.currentSegment + 1;

  const configEntry = {
    type: 'config',
    segment,
    timestamp: nowMs(),
    name,
    maxIterations,
    metric: {
      name: metricName,
      unit: unit || '',
      direction
    }
  };

  const configValidation = validateExperimentEntry(configEntry);
  if (!configValidation.ok) {
    console.error(`Invalid config entry: ${configValidation.errors.join('; ')}`);
    process.exit(1);
  }
  appendJsonl(logPath, configEntry);
  console.log(JSON.stringify({
    ok: true,
    segment,
    name,
    maxIterations,
    metric: configEntry.metric,
    logPath
  }, null, 2));
}

function cmdRun(args) {
  const positional = [];
  const named = {};
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith('--')) {
      named[args[i].slice(2)] = args[i + 1] || '';
      i += 2;
    } else {
      positional.push(args[i]);
      i += 1;
    }
  }

  const logPath = positional[0];
  const command = positional[1];
  if (!logPath || !command) {
    usage();
    process.exit(1);
  }

  const stopFile = named['stop-file'] || DEFAULT_STOP_FILE;
  const rawTimeout = Number.parseInt(named['timeout-ms'] || '', 10);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= MIN_TIMEOUT_MS && rawTimeout <= MAX_TIMEOUT_MS
    ? rawTimeout
    : 120000;
  const checksScript = named['checks-script'] || DEFAULT_CHECKS_SCRIPT;

  // GUARDRAIL: Check stop file before every run
  if (isStopRequested(stopFile)) {
    console.log(JSON.stringify({
      ok: false,
      stopped: true,
      reason: 'stop-file-detected',
      stopFile
    }, null, 2));
    process.exit(1);
  }

  // Verify session exists
  const state = reconstructState(logPath);
  if (state.currentSegment < 0) {
    console.error('No experiment session initialized. Run init first.');
    process.exit(1);
  }

  // Run the experiment command
  const runResult = runExperiment(command, timeoutMs);

  // Parse METRIC lines from stdout
  const parsedMetrics = parseMetrics(runResult.stdout);

  // If the command passed, run backpressure checks
  let checksResult = { passed: true, skipped: true, stdout: '', stderr: '' };
  if (runResult.passed) {
    checksResult = runChecks(checksScript);
  }

  const output = {
    ok: true,
    stopped: false,
    passed: runResult.passed,
    checksPassed: checksResult.passed,
    checksSkipped: checksResult.skipped,
    checksTimedOut: checksResult.timedOut || false,
    durationMs: runResult.durationMs,
    exitCode: runResult.exitCode,
    timedOut: runResult.timedOut,
    parsedMetrics,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    checksStdout: checksResult.stdout || '',
    checksStderr: checksResult.stderr || ''
  };

  console.log(JSON.stringify(output, null, 2));
}

function cmdLog(args) {
  const positional = [];
  const named = {};
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith('--')) {
      named[args[i].slice(2)] = args[i + 1] || '';
      i += 2;
    } else {
      positional.push(args[i]);
      i += 1;
    }
  }

  const logPath = positional[0];
  const status = positional[1];
  const metricValueRaw = positional[2];

  if (!logPath || !status) {
    usage();
    process.exit(1);
  }

  const validStatuses = new Set(['keep', 'discard', 'crash', 'checks_failed']);
  if (!validStatuses.has(status)) {
    console.error(`Invalid status: ${status}. Must be one of: ${[...validStatuses].join(', ')}`);
    process.exit(1);
  }

  const metricValue = metricValueRaw !== undefined && metricValueRaw !== ''
    ? Number(metricValueRaw) : null;
  if (metricValueRaw !== undefined && metricValueRaw !== '' && !Number.isFinite(metricValue)) {
    console.error(`Invalid metric value: ${metricValueRaw}`);
    process.exit(1);
  }

  const description = named['description'] || '';
  const force = named['force'] === 'true';
  const autoCommit = named['auto-commit'] === 'true';
  let allowedPaths = [];
  if (named['allowed-paths']) {
    try {
      allowedPaths = JSON.parse(named['allowed-paths']);
    } catch {
      console.error('Invalid --allowed-paths JSON');
      process.exit(1);
    }
  }
  const durationMs = named['duration-ms'] !== undefined
    ? Number(named['duration-ms']) : 0;
  let secondaryMetrics = {};
  if (named['secondary']) {
    try {
      secondaryMetrics = JSON.parse(named['secondary']);
    } catch {
      console.error('Invalid --secondary JSON');
      process.exit(1);
    }
    // Validate all secondary metric values are finite numbers
    for (const [key, val] of Object.entries(secondaryMetrics)) {
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        console.error(`Invalid secondary metric value for "${key}": expected a number, got ${typeof val}`);
        process.exit(1);
      }
    }
  }

  const state = reconstructState(logPath);
  if (state.currentSegment < 0) {
    console.error('No experiment session initialized. Run init first.');
    process.exit(1);
  }

  // GUARDRAIL: Enforce secondary metric consistency
  const metricValidation = validateSecondaryMetrics(state, secondaryMetrics, force);
  if (!metricValidation.ok) {
    console.log(JSON.stringify({
      ok: false,
      reason: 'secondary-metric-mismatch',
      errors: metricValidation.errors
    }, null, 2));
    process.exit(1);
  }

  // Auto-commit on keep (pi-autoresearch pattern)
  let commit = 'not-created';
  let commitOk = true;
  let commitError = '';
  let recordedStatus = status;
  if (status === 'keep' && autoCommit) {
    const commitResult = gitAutoCommit({
      description: description || `experiment #${state.totalRuns + 1}`,
      cwd: process.cwd(),
      allowedPaths
    });
    commitOk = commitResult.ok;
    commitError = commitResult.error;
    commit = commitOk ? gitCommitHash(process.cwd()) : 'not-created';
    if (!commitOk) {
      recordedStatus = 'checks_failed';
    }
  }

  // Compute delta from baseline
  let delta = null;
  if (metricValue !== null && state.segments.length > 0) {
    const seg = state.segments[state.segments.length - 1];
    if (seg.baselineIndex !== null) {
      const baseline = seg.results[seg.baselineIndex].value;
      if (typeof baseline === 'number' && baseline !== 0) {
        delta = ((metricValue - baseline) / Math.abs(baseline)) * 100;
      }
    }
  }

  const resultEntry = {
    type: 'result',
    segment: state.currentSegment,
    timestamp: nowMs(),
    value: metricValue,
    secondaryMetrics,
    status: recordedStatus,
    description,
    commit,
    commitOk,
    commitError,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0
  };

  const resultValidation = validateExperimentEntry(resultEntry);
  if (!resultValidation.ok) {
    console.error(`Invalid result entry: ${resultValidation.errors.join('; ')}`);
    process.exit(1);
  }
  appendJsonl(logPath, resultEntry);

  // Determine if this is the new best
  let isBest = false;
  if (recordedStatus === 'keep' && metricValue !== null && state.bestMetric !== null) {
    isBest = state.metricDirection === 'lower'
      ? metricValue < state.bestMetric
      : metricValue > state.bestMetric;
  }
  // First result is always the baseline / best
  if (state.totalRuns === 0 && recordedStatus === 'keep' && metricValue !== null) {
    isBest = true;
  }

  console.log(JSON.stringify({
    ok: commitOk,
    segment: state.currentSegment,
    runNumber: state.totalRuns + 1,
    status: recordedStatus,
    requestedStatus: status,
    value: metricValue,
    delta,
    isBest,
    commit,
    commitOk,
    commitError,
    kept: state.kept + (recordedStatus === 'keep' ? 1 : 0),
    discarded: state.discarded + (recordedStatus === 'discard' ? 1 : 0),
    crashed: state.crashed + (recordedStatus === 'crash' ? 1 : 0),
    checksFailed: state.checksFailed + (recordedStatus === 'checks_failed' ? 1 : 0)
  }, null, 2));
  if (!commitOk) {
    process.exitCode = 1;
  }
}

function cmdStatus(args) {
  const [logPath] = args;
  if (!logPath) {
    usage();
    process.exit(1);
  }

  const state = reconstructState(logPath);

  const currentSeg = state.segments.length > 0
    ? state.segments[state.segments.length - 1]
    : null;

  console.log(JSON.stringify({
    ok: true,
    initialized: state.currentSegment >= 0,
    segment: state.currentSegment,
    name: currentSeg ? currentSeg.name : null,
    metricDef: state.metricDef,
    totalRuns: state.totalRuns,
    segmentRuns: state.segmentRuns,
    maxIterations: state.maxIterations,
    remaining: Math.max(0, state.maxIterations - state.segmentRuns),
    kept: state.kept,
    discarded: state.discarded,
    crashed: state.crashed,
    checksFailed: state.checksFailed,
    consecutiveCrashes: state.consecutiveCrashes,
    bestMetric: state.bestMetric,
    bestDelta: state.bestDelta,
    secondaryMetricNames: state.secondaryMetricNames
      ? [...state.secondaryMetricNames]
      : null,
    segmentCount: state.segments.length,
    canResume: canResume(state)
  }, null, 2));
}

function cmdStop(args) {
  const named = parseNamedArgs(args);
  const stopFile = named['stop-file'] || DEFAULT_STOP_FILE;
  requestStop(stopFile);
  console.log(JSON.stringify({
    ok: true,
    stopped: true,
    stopFile,
    message: 'Stop file created. The experiment loop will halt before the next run.'
  }, null, 2));
}

function cmdClearStop(args) {
  const named = parseNamedArgs(args);
  const stopFile = named['stop-file'] || DEFAULT_STOP_FILE;
  clearStopFile(stopFile);
  console.log(JSON.stringify({
    ok: true,
    cleared: true,
    stopFile
  }, null, 2));
}

function cmdCheckContinue(args) {
  const positional = [];
  const named = {};
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith('--')) {
      named[args[i].slice(2)] = args[i + 1] || '';
      i += 2;
    } else {
      positional.push(args[i]);
      i += 1;
    }
  }

  const logPath = positional[0];
  if (!logPath) {
    usage();
    process.exit(1);
  }

  const stopFile = named['stop-file'] || DEFAULT_STOP_FILE;
  const state = reconstructState(logPath);

  // 1. Not initialized
  if (state.currentSegment < 0) {
    console.log(JSON.stringify({
      ok: true,
      continue: false,
      reason: 'not-initialized',
      message: 'No experiment session. Run init first.'
    }, null, 2));
    return;
  }

  // 2. User requested stop (stop file)
  if (isStopRequested(stopFile)) {
    console.log(JSON.stringify({
      ok: true,
      continue: false,
      reason: 'user-stopped',
      message: `Stop file detected at ${stopFile}. Run clear-stop to resume.`
    }, null, 2));
    return;
  }

  // 3. Hard iteration cap reached
  if (state.segmentRuns >= state.maxIterations) {
    console.log(JSON.stringify({
      ok: true,
      continue: false,
      reason: 'max-iterations-reached',
      message: `Reached iteration cap: ${state.segmentRuns}/${state.maxIterations}. Session complete.`,
      segmentRuns: state.segmentRuns,
      maxIterations: state.maxIterations
    }, null, 2));
    return;
  }

  // 4. Consecutive crash breaker
  if (state.consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
    console.log(JSON.stringify({
      ok: true,
      continue: false,
      reason: 'consecutive-crashes',
      message: `${state.consecutiveCrashes} consecutive crashes. Stopping to prevent waste. Fix the issue and re-init.`,
      consecutiveCrashes: state.consecutiveCrashes
    }, null, 2));
    return;
  }

  // 5. Resume cooldown (for auto-resume after agent context limit)
  if (!canResume(state)) {
    const cooldownRemaining = state.lastResumeAt !== null
      ? Math.max(0, RESUME_COOLDOWN_MS - (nowMs() - state.lastResumeAt))
      : 0;
    console.log(JSON.stringify({
      ok: true,
      continue: false,
      reason: 'resume-cooldown',
      message: `Auto-resume cooldown active. ${Math.ceil(cooldownRemaining / 1000)}s remaining.`,
      cooldownRemainingMs: cooldownRemaining
    }, null, 2));
    return;
  }

  // All checks passed — safe to continue
  console.log(JSON.stringify({
    ok: true,
    continue: true,
    iteration: state.segmentRuns + 1,
    maxIterations: state.maxIterations,
    remaining: state.maxIterations - state.segmentRuns,
    totalRuns: state.totalRuns,
    bestMetric: state.bestMetric,
    bestDelta: state.bestDelta
  }, null, 2));
}

function cmdCanResume(args) {
  const [logPath] = args;
  if (!logPath) {
    usage();
    process.exit(1);
  }
  const state = reconstructState(logPath);
  const allowed = canResume(state);
  const cooldownRemaining = state.lastResumeAt !== null
    ? Math.max(0, RESUME_COOLDOWN_MS - (nowMs() - state.lastResumeAt))
    : 0;
  console.log(JSON.stringify({
    ok: true,
    canResume: allowed,
    cooldownRemainingMs: cooldownRemaining,
    lastResumeAt: state.lastResumeAt
  }, null, 2));
}

function cmdRecordResume(args) {
  const [logPath] = args;
  if (!logPath) {
    usage();
    process.exit(1);
  }
  recordResume(logPath);
  console.log(JSON.stringify({ ok: true, resumedAt: nowMs() }, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    usage();
    process.exit(1);
  }

  const commands = {
    'init': cmdInit,
    'run': cmdRun,
    'log': cmdLog,
    'check-continue': cmdCheckContinue,
    'status': cmdStatus,
    'stop': cmdStop,
    'clear-stop': cmdClearStop,
    'can-resume': cmdCanResume,
    'record-resume': cmdRecordResume
  };

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
  }

  handler(args);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
