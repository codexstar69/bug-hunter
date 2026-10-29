#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { DEFAULT_KILL_GRACE_MS, runCommandOnce } = require('./process-runner.cjs');

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
  const canonicalRoot = fs.realpathSync(repoRoot);
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
      const cwd = resolveInsideRoot(canonicalRoot, raw.cwd || '.', `check ${id} cwd`);
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

function decodeBounded(buffer) {
  let text = buffer.toString('utf8');
  // A partial UTF-8 character can expand into a three-byte replacement character.
  while (Buffer.byteLength(text) > buffer.length) text = text.slice(0, -1);
  return text;
}

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const MAX_PENDING_LINE_CHARS = 64 * 1024;
// Where any redaction pattern can start. An overlong line is never cut inside
// one, so a key delimiter or a `password = value` pair reaches redactOutput whole.
const SECRET_START = /-----|authorization|bearer|api[_-]?key|access[_-]?token|secret|password|gh[opusr]_|github_pat_|\b(?:sk|rk|pk)-/i;

// Redacts the stream line by line before it is bounded. Redacting after the
// head/tail cut could drop a private key's BEGIN or END line and keep its body.
function streamingRedactor() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let inPrivateKey = false;
  let inSecretValue = false;
  const redactSegment = (segment, newline) => {
    let rest = segment;
    if (inSecretValue) {
      const end = rest.search(/[\s,;]/);
      if (end === -1) {
        // A line end also ends the value; a cut segment keeps suppressing.
        if (newline) inSecretValue = false;
        return newline;
      }
      inSecretValue = false;
      rest = rest.slice(end);
    }
    let out = '';
    while (rest) {
      if (inPrivateKey) {
        const end = PRIVATE_KEY_END.exec(rest);
        if (!end) return out;
        inPrivateKey = false;
        out += '[REDACTED_PRIVATE_KEY]';
        rest = rest.slice(end.index + end[0].length);
        continue;
      }
      const begin = PRIVATE_KEY_BEGIN.exec(rest);
      if (!begin) {
        out += redactOutput(rest);
        break;
      }
      out += redactOutput(rest.slice(0, begin.index));
      inPrivateKey = true;
      rest = rest.slice(begin.index + begin[0].length);
    }
    return inPrivateKey ? out : out + newline;
  };
  // Called only while pending exceeds MAX_PENDING_LINE_CHARS, so every cut
  // lands past 60,000 characters and each forced segment makes progress. A
  // secret that starts earlier stays inside the segment, where the private-key
  // and secret-value states carry it across the cut.
  const cutPoint = () => {
    const searchEnd = pending.length - 256;
    const blank = Math.max(pending.lastIndexOf(' ', searchEnd), pending.lastIndexOf('\t', searchEnd));
    const cut = blank >= searchEnd - 4096 ? blank + 1 : searchEnd;
    // Look a little past the cut too, so a keyword the cut would split is found.
    const windowStart = cut - 256;
    const secret = SECRET_START.exec(pending.slice(windowStart, cut + 32));
    return secret && windowStart + secret.index < cut ? windowStart + secret.index : cut;
  };
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      let out = '';
      if (pending.includes('\n')) {
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) out += redactSegment(line, '\n');
      }
      while (pending.length > MAX_PENDING_LINE_CHARS) {
        const cut = cutPoint();
        const segment = pending.slice(0, cut);
        pending = pending.slice(cut);
        const redacted = redactSegment(segment, '');
        out += redacted;
        // The cut fell inside a redacted value: suppress the rest of it in the
        // next segment, up to its terminator.
        if (!inPrivateKey && /[^\s,;]$/.test(segment) && redacted.endsWith('[REDACTED]')) inSecretValue = true;
      }
      return out;
    },
    flush() {
      pending += decoder.end();
      let out = pending ? redactSegment(pending, '') : '';
      pending = '';
      inSecretValue = false;
      if (inPrivateKey) {
        inPrivateKey = false;
        out += '[REDACTED_PRIVATE_KEY]';
      }
      return out;
    }
  };
}

function outputCapture(maxBytes) {
  const headLimit = Math.ceil(maxBytes / 2);
  const tailLimit = Math.floor(maxBytes / 2);
  const redactor = streamingRedactor();
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let bytes = 0;
  const store = (text) => {
    const chunk = Buffer.from(text, 'utf8');
    bytes += chunk.length;
    const headBytes = Math.min(chunk.length, headLimit - head.length);
    if (headBytes > 0) head = Buffer.concat([head, chunk.subarray(0, headBytes)]);
    const rest = chunk.subarray(headBytes);
    if (rest.length > 0 && tailLimit > 0) {
      tail = rest.length >= tailLimit
        ? Buffer.from(rest.subarray(-tailLimit))
        : Buffer.concat([tail, rest]).subarray(-tailLimit);
    }
  };
  return {
    append(chunk) {
      store(redactor.push(chunk));
    },
    result() {
      store(redactor.flush());
      const buffer = Buffer.concat([head, tail]);
      const truncated = bytes > maxBytes || buffer.length > maxBytes;
      if (!truncated) return { text: buffer.toString('utf8'), truncated: false };
      if (buffer.length < maxBytes) return { text: buffer.toString('utf8'), truncated: true };
      const marker = maxBytes >= 64 ? '\n[...output truncated...]\n' : '';
      const remaining = maxBytes - Buffer.byteLength(marker);
      const headBytes = Math.ceil(remaining / 2);
      const tailBytes = Math.floor(remaining / 2);
      return {
        text: decodeBounded(buffer.subarray(0, headBytes)) + marker
          + (tailBytes ? decodeBounded(buffer.subarray(-tailBytes)) : ''),
        truncated: true
      };
    }
  };
}

function executeCheck(check, maxOutputBytes, deadlineMs) {
  return new Promise((resolve) => {
    const [command, ...args] = check.command;
    const stdout = outputCapture(maxOutputBytes);
    const stderr = outputCapture(maxOutputBytes);
    const child = childProcess.spawn(command, args, {
      cwd: check.cwd,
      env: { ...safeBaseEnv(), ...check.env },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let timeoutHit = false;
    let spawnError = null;
    let exitResult = { status: null, signal: null };
    let settled = false;
    let killTimer = null;
    let groupPollTimer = null;
    let settleTimer = null;
    let treeTermination = Promise.resolve();
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(groupPollTimer);
      clearTimeout(settleTimer);
      treeTermination.then(() => {
        resolve({ ...exitResult, error: spawnError, timeoutHit, stdout: stdout.result(), stderr: stderr.result() });
      });
    };
    // Match process-runner's detached group signaling and unconditional escalation.
    // Its runCommandOnce uses ambient cwd/env and kills on output volume, so it
    // cannot execute verification checks with their isolated environment/capture.
    const signalTree = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          if (signal === 'SIGTERM') {
            // Windows has no POSIX process groups/signals; taskkill handles descendants.
            treeTermination = runCommandOnce({
              command: `taskkill /pid ${child.pid} /T /F`,
              timeoutMs: Math.max(1, Math.min(DEFAULT_KILL_GRACE_MS, deadlineMs - Date.now())),
              killGraceMs: 0
            }).then((result) => {
              if (!result.ok) {
                throw Object.assign(new Error(result.stderr), { code: 'TASKKILL_FAILED' });
              }
            }).catch((error) => {
              spawnError = error;
              try { child.kill('SIGKILL'); } catch (killError) { spawnError = killError; }
            });
          } else child.kill(signal);
        } else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') spawnError = error;
      }
    };
    const groupAlive = () => {
      if (!child.pid || process.platform === 'win32') return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        // macOS answers EPERM while the group's last members are exiting zombies
        // awaiting reaping: still alive. The check deadline bounds the wait.
        if (error.code === 'EPERM') return true;
        if (error.code !== 'ESRCH') spawnError = error;
        return false;
      }
    };
    const awaitGroupDrain = () => {
      if (settled || timeoutHit) return;
      if (!groupAlive()) settle();
      else groupPollTimer = setTimeout(awaitGroupDrain, 10);
    };
    // Reserve pipe-close/reaping time inside the plan wall. Escalation never
    // receives a fresh grace period after the total plan budget has expired.
    // The wall contract permits 100 ms of OS timer-dispatch drift (regression-tested).
    const settleGraceMs = 25;
    const timer = setTimeout(() => {
      timeoutHit = true;
      // A leader may have exited successfully before its descendants timed out.
      // Only a subsequent leader exit is evidence of the final kill outcome.
      exitResult = { status: null, signal: null };
      clearTimeout(groupPollTimer);
      signalTree('SIGTERM');
      killTimer = setTimeout(() => {
        signalTree('SIGKILL');
        // Do not wait for close: an inherited pipe may be held outside the group.
        settleTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settle();
        }, Math.max(0, Math.min(settleGraceMs, deadlineMs - Date.now())));
      }, Math.max(0, Math.min(DEFAULT_KILL_GRACE_MS, check.timeoutMs,
        deadlineMs - Date.now() - settleGraceMs)));
    }, Math.max(0, Math.min(check.timeoutMs, deadlineMs - Date.now() - settleGraceMs)));
    child.stdout.on('data', (chunk) => stdout.append(chunk));
    child.stderr.on('data', (chunk) => stderr.append(chunk));
    child.once('error', (error) => {
      spawnError = error;
      if (!timeoutHit) settle();
    });
    child.once('exit', (status, signal) => { exitResult = { status, signal }; });
    child.once('close', () => {
      if (!timeoutHit) awaitGroupDrain();
    });
  });
}

async function runCheck(check, maxOutputBytes, deadlineMs) {
  const startedAt = Date.now();
  const result = await executeCheck(check, maxOutputBytes, deadlineMs);
  const durationMs = Date.now() - startedAt;
  let status;
  let passed = false;
  let errorCode = null;
  if (result.timeoutHit) {
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
    stdout: result.stdout.text,
    stderr: result.stderr.text,
    outputTruncated: result.stdout.truncated || result.stderr.truncated,
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

async function runPlan({ repoRoot, plan, totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }) {
  totalBudgetMs = positiveInteger(totalBudgetMs, DEFAULT_TOTAL_BUDGET_MS, 'totalBudgetMs');
  maxOutputBytes = positiveInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes');
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
    results.push(await runCheck({ ...check, timeoutMs: Math.min(check.timeoutMs, remainingBudget) },
      maxOutputBytes, startedAt + totalBudgetMs));
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
    const commandForScript = (script) => [packageManager, 'run', script];
    const candidates = [
      ['typecheck', 'typecheck', true],
      ['test', 'test', true],
      ['lint', 'lint', false],
      ['build', 'build', false]
    ];
    for (const [id, kind, required] of candidates) {
      if (Object.prototype.hasOwnProperty.call(scripts, id) && typeof scripts[id] === 'string' && scripts[id].trim()) {
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

async function main() {
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
    const report = await runPlan({
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
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  buildFindingEvidence,
  detectPlan,
  isOutsideRoot,
  publicValidation,
  redactOutput,
  runPlan,
  streamingRedactor,
  validatePlan
};
