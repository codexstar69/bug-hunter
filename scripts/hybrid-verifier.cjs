#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TOTAL_BUDGET_MS = 600000;
const SAFE_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'CI', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT',
  'LANG', 'LC_ALL', 'TERM', 'NODE_OPTIONS'
]);
const SENSITIVE_ENV_PATTERN = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION|API_KEY|ACCESS_KEY)/i;

const VALID_KINDS = new Set([
  'typecheck',
  'test',
  'targeted-test',
  'static',
  'security-static',
  'build',
  'lint',
  'fuzz',
  'custom'
]);

function usage() {
  console.error('Usage:');
  console.error('  hybrid-verifier.cjs detect --repo-root <path> [--output <plan.json>]');
  console.error('  hybrid-verifier.cjs run --repo-root <path> --plan <plan.json> [--output <report.json>] [--total-budget-ms <n>]');
  console.error('  hybrid-verifier.cjs validate --repo-root <path> --plan <plan.json>');
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function isOutsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function resolveInsideRoot(root, candidate, label) {
  const resolved = path.resolve(root, candidate || '.');
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  const real = fs.realpathSync(resolved);
  if (isOutsideRoot(root, real)) throw new Error(`${label} escapes repository root: ${candidate}`);
  return real;
}

function validateCommand(command, checkId) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error(`check ${checkId} command must be a non-empty argv array`);
  }
  return command.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) {
      throw new Error(`check ${checkId} command[${index}] must be a non-empty string without NUL`);
    }
    return entry;
  });
}

function validatePlan({ repoRoot, plan }) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, errors: ['verification plan must be a JSON object'], normalizedChecks: [] };
  }
  if (plan.schemaVersion !== 1) errors.push('verification plan schemaVersion must equal 1');
  if (!Array.isArray(plan.checks)) errors.push('verification plan checks must be an array');
  const seenIds = new Set();
  const normalizedChecks = [];
  for (const raw of Array.isArray(plan.checks) ? plan.checks : []) {
    try {
      const id = String(raw.id || '').trim();
      if (!id) throw new Error('verification check id is required');
      if (seenIds.has(id)) throw new Error(`duplicate verification check id: ${id}`);
      seenIds.add(id);
      const kind = String(raw.kind || 'custom');
      if (!VALID_KINDS.has(kind)) throw new Error(`check ${id} has unsupported kind: ${kind}`);
      const cwd = resolveInsideRoot(repoRoot, raw.cwd || '.', `check ${id} cwd`);
      const command = validateCommand(raw.command, id);
      const timeoutMs = positiveInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS, `check ${id} timeoutMs`);
      const expectedExitCodes = Array.isArray(raw.expectedExitCodes) && raw.expectedExitCodes.length > 0
        ? raw.expectedExitCodes.map((value) => Number(value))
        : [0];
      if (!expectedExitCodes.every(Number.isInteger)) {
        throw new Error(`check ${id} expectedExitCodes must contain integers`);
      }
      const findingIds = Array.isArray(raw.findingIds)
        ? [...new Set(raw.findingIds.map((value) => String(value).trim()).filter(Boolean))]
        : [];
      const env = raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
        ? Object.fromEntries(Object.entries(raw.env).map(([key, value]) => [String(key), String(value)]))
        : {};
      for (const key of Object.keys(env)) {
        if (SENSITIVE_ENV_PATTERN.test(key)) {
          throw new Error(`check ${id} env key is sensitive and cannot be injected: ${key}`);
        }
      }
      normalizedChecks.push({
        id,
        kind,
        command,
        cwd,
        timeoutMs,
        expectedExitCodes,
        required: raw.required === true,
        findingIds,
        env,
        confidenceOnPass: Number.isFinite(Number(raw.confidenceOnPass)) ? Number(raw.confidenceOnPass) : 2,
        confidenceOnFail: Number.isFinite(Number(raw.confidenceOnFail)) ? Number(raw.confidenceOnFail) : -15
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { ok: errors.length === 0, errors, normalizedChecks };
}

function redactOutput(value) {
  return String(value || '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]')
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/ig, '$1[REDACTED]');
}

function safeBaseEnv() {
  return Object.fromEntries(SAFE_ENV_KEYS
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
}

function publicValidation(validation) {
  return {
    ok: validation.ok,
    errors: validation.errors,
    normalizedChecks: validation.normalizedChecks.map(({ env, ...check }) => ({
      ...check,
      envKeys: Object.keys(env || {}).sort()
    }))
  };
}

function truncate(value, maxBytes) {
  const buffer = Buffer.from(redactOutput(value), 'utf8');
  if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), truncated: false };
  return {
    text: buffer.subarray(0, maxBytes).toString('utf8'),
    truncated: true
  };
}

function runCheck(check, maxOutputBytes) {
  const startedAt = Date.now();
  const [command, ...args] = check.command;
  const result = childProcess.spawnSync(command, args, {
    cwd: check.cwd,
    env: { ...safeBaseEnv(), ...check.env },
    encoding: 'utf8',
    shell: false,
    timeout: check.timeoutMs,
    maxBuffer: maxOutputBytes * 2,
    windowsHide: true
  });
  const durationMs = Date.now() - startedAt;
  const stdout = truncate(result.stdout, maxOutputBytes);
  const stderr = truncate(result.stderr, maxOutputBytes);
  let status;
  let passed = false;
  let errorCode = null;
  if (result.error && result.error.code === 'ETIMEDOUT') {
    status = 'TIMEOUT';
    errorCode = 'ETIMEDOUT';
  } else if (result.error && result.error.code === 'ENOENT') {
    status = 'UNAVAILABLE';
    errorCode = 'ENOENT';
  } else if (result.error) {
    status = 'ERROR';
    errorCode = result.error.code || 'ERROR';
  } else {
    passed = check.expectedExitCodes.includes(result.status);
    status = passed ? 'PASS' : 'FAIL';
  }
  return {
    id: check.id,
    kind: check.kind,
    required: check.required,
    command: check.command,
    cwd: check.cwd,
    status,
    passed,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal || null,
    errorCode,
    durationMs,
    stdout: stdout.text,
    stderr: stderr.text,
    outputTruncated: stdout.truncated || stderr.truncated,
    findingIds: check.findingIds,
    confidenceDelta: passed ? check.confidenceOnPass : check.confidenceOnFail
  };
}

function buildFindingEvidence(results) {
  const evidence = new Map();
  for (const result of results) {
    for (const findingId of result.findingIds) {
      const entry = evidence.get(findingId) || {
        findingId,
        confidenceDelta: 0,
        passedChecks: [],
        failedChecks: [],
        unavailableChecks: []
      };
      entry.confidenceDelta += result.confidenceDelta;
      if (result.status === 'PASS') entry.passedChecks.push(result.id);
      else if (result.status === 'UNAVAILABLE') entry.unavailableChecks.push(result.id);
      else entry.failedChecks.push(result.id);
      evidence.set(findingId, entry);
    }
  }
  return [...evidence.values()].sort((a, b) => a.findingId.localeCompare(b.findingId));
}

function runPlan({ repoRoot, plan, totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }) {
  const canonicalRoot = fs.realpathSync(repoRoot);
  const validation = validatePlan({ repoRoot: canonicalRoot, plan });
  if (!validation.ok) {
    return {
      schemaVersion: 1,
      artifact: 'verification-report',
      ok: false,
      generatedAt: new Date().toISOString(),
      repositoryRoot: canonicalRoot,
      validation: publicValidation(validation),
      checks: [],
      summary: {
        total: 0,
        passed: 0,
        failed: 0,
        unavailable: 0,
        timeout: 0,
        skippedBudget: 0,
        requiredFailures: 0,
        durationMs: 0
      },
      findingEvidence: []
    };
  }
  const startedAt = Date.now();
  const results = [];
  for (const check of validation.normalizedChecks) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= totalBudgetMs) {
      results.push({
        id: check.id,
        kind: check.kind,
        required: check.required,
        command: check.command,
        cwd: check.cwd,
        status: 'SKIPPED_BUDGET',
        passed: false,
        exitCode: null,
        signal: null,
        errorCode: null,
        durationMs: 0,
        stdout: '',
        stderr: '',
        outputTruncated: false,
        findingIds: check.findingIds,
        confidenceDelta: check.confidenceOnFail
      });
      continue;
    }
    const remainingBudget = Math.max(1, totalBudgetMs - elapsed);
    results.push(runCheck({ ...check, timeoutMs: Math.min(check.timeoutMs, remainingBudget) }, maxOutputBytes));
  }
  const requiredFailures = results.filter((result) => result.required && result.status !== 'PASS');
  const summary = {
    total: results.length,
    passed: results.filter((result) => result.status === 'PASS').length,
    failed: results.filter((result) => ['FAIL', 'ERROR'].includes(result.status)).length,
    unavailable: results.filter((result) => result.status === 'UNAVAILABLE').length,
    timeout: results.filter((result) => result.status === 'TIMEOUT').length,
    skippedBudget: results.filter((result) => result.status === 'SKIPPED_BUDGET').length,
    requiredFailures: requiredFailures.length,
    durationMs: Date.now() - startedAt
  };
  return {
    schemaVersion: 1,
    artifact: 'verification-report',
    ok: requiredFailures.length === 0,
    generatedAt: new Date().toISOString(),
    repositoryRoot: canonicalRoot,
    validation: publicValidation(validation),
    totalBudgetMs,
    checks: results,
    summary,
    findingEvidence: buildFindingEvidence(results)
  };
}

function detectPlan(repoRoot) {
  const canonicalRoot = fs.realpathSync(repoRoot);
  const packagePath = path.join(canonicalRoot, 'package.json');
  const checks = [];
  if (fs.existsSync(packagePath)) {
    const packageJson = readJson(packagePath);
    const scripts = packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
    const packageManager = String(packageJson.packageManager || '').split('@')[0] || 'npm';
    const commandForScript = (script) => packageManager === 'npm'
      ? ['npm', 'run', script, '--if-present']
      : [packageManager, 'run', script, '--if-present'];
    const candidates = [
      ['typecheck', 'typecheck', true],
      ['test', 'test', true],
      ['lint', 'lint', false],
      ['build', 'build', false]
    ];
    for (const [id, kind, required] of candidates) {
      if (Object.prototype.hasOwnProperty.call(scripts, id)) {
        checks.push({
          id,
          kind,
          command: commandForScript(id),
          cwd: '.',
          timeoutMs: kind === 'test' ? 300000 : 180000,
          required,
          findingIds: []
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repositoryRoot: canonicalRoot,
    checks
  };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  const repoRoot = fs.realpathSync(path.resolve(options['repo-root'] || process.cwd()));
  if (command === 'detect') {
    const plan = detectPlan(repoRoot);
    if (options.output) writeJson(path.resolve(options.output), plan);
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (!options.plan) throw new Error('--plan is required');
  const plan = readJson(path.resolve(options.plan));
  if (command === 'validate') {
    const result = validatePlan({ repoRoot, plan });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'run') {
    const report = runPlan({
      repoRoot,
      plan,
      totalBudgetMs: positiveInteger(options['total-budget-ms'], DEFAULT_TOTAL_BUDGET_MS, '--total-budget-ms'),
      maxOutputBytes: positiveInteger(options['max-output-bytes'], DEFAULT_MAX_OUTPUT_BYTES, '--max-output-bytes')
    });
    if (options.output) writeJson(path.resolve(options.output), report);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  usage();
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  buildFindingEvidence,
  detectPlan,
  isOutsideRoot,
  publicValidation,
  redactOutput,
  runPlan,
  validatePlan
};
