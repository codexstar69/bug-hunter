#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKEND_PRIORITY = ['spawn_agent', 'subagent', 'team', 'local-sequential'];
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_CHUNK_SIZE = 30;
const DEFAULT_CONFIDENCE_THRESHOLD = 75;
const DEFAULT_CANARY_SIZE = 3;
const DEFAULT_DELTA_HOPS = 2;
const DEFAULT_EXPANSION_CAP = 40;

function usage() {
  console.error('Usage:');
  console.error('  run-bug-hunter.cjs preflight [--skill-dir <path>] [--available-backends <csv>] [--backend <name>]');
  console.error('  run-bug-hunter.cjs run --files-json <path> [--mode <name>] [--skill-dir <path>] [--state <path>] [--chunk-size <n>] [--worker-cmd <template>] [--timeout-ms <n>] [--max-retries <n>] [--backoff-ms <n>] [--available-backends <csv>] [--backend <name>] [--fail-fast <true|false>] [--use-index <true|false>] [--index-path <path>] [--delta-mode <true|false>] [--changed-files-json <path>] [--delta-hops <n>] [--expand-on-low-confidence <true|false>] [--confidence-threshold <n>] [--canary-size <n>] [--expansion-cap <n>]');
  console.error('  run-bug-hunter.cjs plan --files-json <path> [--mode <name>] [--skill-dir <path>] [--chunk-size <n>] [--plan-path <path>]');
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      index += 1;
      continue;
    }
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      options[key] = 'true';
      index += 1;
      continue;
    }
    options[key] = value;
    index += 2;
  }
  return { command, options };
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return fallback;
}

function resolveSkillDir(options) {
  if (options['skill-dir']) {
    return path.resolve(options['skill-dir']);
  }
  return path.resolve(__dirname, '..');
}

function getAvailableBackends(options) {
  if (options['available-backends']) {
    return String(options['available-backends'])
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (process.env.BUG_HUNTER_BACKENDS) {
    return String(process.env.BUG_HUNTER_BACKENDS)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return ['local-sequential'];
}

function selectBackend(options) {
  const forcedBackend = options.backend || process.env.BUG_HUNTER_BACKEND;
  if (forcedBackend) {
    if (!BACKEND_PRIORITY.includes(forcedBackend)) {
      throw new Error(`Unsupported backend: ${forcedBackend}`);
    }
    return { selected: forcedBackend, available: getAvailableBackends(options), forced: true };
  }
  const available = getAvailableBackends(options);
  const selected = BACKEND_PRIORITY.find((backend) => available.includes(backend)) || 'local-sequential';
  return { selected, available, forced: false };
}

function requiredScripts(skillDir) {
  return [
    path.join(skillDir, 'scripts', 'bug-hunter-state.cjs'),
    path.join(skillDir, 'scripts', 'payload-guard.cjs'),
    path.join(skillDir, 'scripts', 'fix-lock.cjs'),
    path.join(skillDir, 'scripts', 'doc-lookup.cjs'),
    path.join(skillDir, 'scripts', 'context7-api.cjs'),
    path.join(skillDir, 'scripts', 'code-index.cjs'),
    path.join(skillDir, 'scripts', 'delta-mode.cjs')
  ];
}

function preflight(options) {
  const skillDir = resolveSkillDir(options);
  const missing = requiredScripts(skillDir).filter((filePath) => !fs.existsSync(filePath));
  const backend = selectBackend(options);
  return {
    ok: missing.length === 0,
    skillDir,
    backend,
    missing
  };
}

function runJsonScript(scriptPath, args) {
  const result = childProcess.spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(stderr || stdout || `Script failed: ${scriptPath}`);
  }
  const output = (result.stdout || '').trim();
  if (!output) {
    return {};
  }
  return JSON.parse(output);
}

function appendJournal(logPath, event) {
  ensureDir(path.dirname(logPath));
  const line = JSON.stringify({ at: nowIso(), ...event });
  fs.appendFileSync(logPath, `${line}\n`, 'utf8');
}

function fillTemplate(template, variables) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    if (!(key in variables)) {
      return match;
    }
    return String(variables[key]);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommandOnce({ command, timeoutMs }) {
  return new Promise((resolve) => {
    const child = childProcess.spawn('/bin/zsh', ['-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timeoutHit = false;

    const timer = setTimeout(() => {
      timeoutHit = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 2000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timeoutHit,
        code: code || 0,
        timeoutHit,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

async function runWithRetry({
  command,
  timeoutMs,
  maxRetries,
  backoffMs,
  journalPath,
  phase,
  chunkId
}) {
  const attempts = maxRetries + 1;
  let lastResult = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    appendJournal(journalPath, {
      event: 'attempt-start',
      phase,
      chunkId,
      attempt,
      attempts,
      timeoutMs
    });
    const result = await runCommandOnce({ command, timeoutMs });
    lastResult = result;
    appendJournal(journalPath, {
      event: 'attempt-end',
      phase,
      chunkId,
      attempt,
      ok: result.ok,
      code: result.code,
      timeoutHit: result.timeoutHit,
      stderr: result.stderr.slice(0, 500)
    });
    if (result.ok) {
      return { ok: true, result, attemptsUsed: attempt };
    }
    if (attempt < attempts) {
      const delayMs = backoffMs * 2 ** (attempt - 1);
      appendJournal(journalPath, {
        event: 'retry-backoff',
        phase,
        chunkId,
        attempt,
        delayMs
      });
      await sleep(delayMs);
    }
  }

  return {
    ok: false,
    result: lastResult,
    attemptsUsed: attempts
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function severityRank(severity) {
  const normalized = String(severity || '').toLowerCase();
  if (normalized === 'critical') {
    return 3;
  }
  if (normalized === 'high') {
    return 2;
  }
  if (normalized === 'medium') {
    return 1;
  }
  if (normalized === 'low') {
    return 0;
  }
  return -1;
}

function buildHeuristicFactCard({ chunkId, scanFiles, findings, index }) {
  const files = toArray(scanFiles).map((item) => path.resolve(String(item)));
  const findingsList = toArray(findings);
  const apiContracts = [];
  const authAssumptions = [];
  const invariants = [];

  for (const filePath of files) {
    const meta = index && index.files ? index.files[filePath] : null;
    if (!meta) {
      continue;
    }
    const relative = meta.relativePath || filePath;
    const boundaries = toArray(meta.trustBoundaries);
    if (boundaries.includes('external-input')) {
      apiContracts.push(`${relative}: external-input boundary`);
    }
    if (boundaries.includes('auth')) {
      authAssumptions.push(`${relative}: auth boundary must preserve identity and authorization checks`);
    }
    if (boundaries.includes('data-store')) {
      invariants.push(`${relative}: data-store writes must keep state transitions atomic`);
    }
  }

  for (const finding of findingsList) {
    const claim = String((finding && finding.claim) || '').trim();
    if (!claim) {
      continue;
    }
    invariants.push(`Finding invariant: ${claim}`);
  }

  return {
    chunkId,
    createdAt: nowIso(),
    apiContracts: [...new Set(apiContracts)].slice(0, 10),
    authAssumptions: [...new Set(authAssumptions)].slice(0, 10),
    invariants: [...new Set(invariants)].slice(0, 12)
  };
}

function buildConsistencyReport({ bugLedger, confidenceThreshold }) {
  const conflicts = [];
  const byBugId = new Map();
  const byLocation = new Map();

  for (const entry of bugLedger) {
    const bugId = String(entry.bugId || '').trim();
    const locationKey = `${entry.file || ''}|${entry.lines || ''}`;
    if (bugId) {
      if (!byBugId.has(bugId)) {
        byBugId.set(bugId, []);
      }
      byBugId.get(bugId).push(entry);
    }
    if (!byLocation.has(locationKey)) {
      byLocation.set(locationKey, []);
    }
    byLocation.get(locationKey).push(entry);
  }

  for (const [bugId, entries] of byBugId.entries()) {
    const uniqueKeys = new Set(entries.map((entry) => entry.key));
    if (uniqueKeys.size > 1) {
      conflicts.push({
        type: 'bug-id-reused',
        bugId,
        count: uniqueKeys.size,
        files: [...new Set(entries.map((entry) => entry.file))].sort()
      });
    }
  }

  for (const [location, entries] of byLocation.entries()) {
    const claims = [...new Set(entries.map((entry) => String(entry.claim || '').trim()).filter(Boolean))];
    if (claims.length > 1) {
      conflicts.push({
        type: 'location-claim-conflict',
        location,
        claims: claims.slice(0, 5)
      });
    }
  }

  const lowConfidence = bugLedger.filter((entry) => {
    const confidence = entry.confidence;
    return confidence === null || confidence === undefined || Number(confidence) < confidenceThreshold;
  }).length;

  return {
    checkedAt: nowIso(),
    confidenceThreshold,
    totalFindings: bugLedger.length,
    lowConfidenceFindings: lowConfidence,
    conflicts
  };
}

function buildFixPlan({ bugLedger, confidenceThreshold, canarySize }) {
  const withConfidence = bugLedger.map((entry) => {
    const confidenceRaw = entry.confidence;
    const confidence = Number.isFinite(Number(confidenceRaw)) ? Number(confidenceRaw) : null;
    return {
      ...entry,
      confidence
    };
  });
  const eligible = withConfidence
    .filter((entry) => entry.confidence !== null && entry.confidence >= confidenceThreshold)
    .sort((left, right) => {
      const severityDiff = severityRank(right.severity) - severityRank(left.severity);
      if (severityDiff !== 0) {
        return severityDiff;
      }
      const confidenceDiff = (right.confidence || 0) - (left.confidence || 0);
      if (confidenceDiff !== 0) {
        return confidenceDiff;
      }
      return String(left.key).localeCompare(String(right.key));
    });
  const manualReview = withConfidence
    .filter((entry) => entry.confidence === null || entry.confidence < confidenceThreshold);
  const canary = eligible.slice(0, canarySize);
  const rollout = eligible.slice(canarySize);

  return {
    generatedAt: nowIso(),
    confidenceThreshold,
    canarySize,
    totals: {
      findings: withConfidence.length,
      eligible: eligible.length,
      canary: canary.length,
      rollout: rollout.length,
      manualReview: manualReview.length
    },
    canary,
    rollout,
    manualReview
  };
}

function loadIndex(indexPath) {
  if (!indexPath || !fs.existsSync(indexPath)) {
    return null;
  }
  return readJson(indexPath);
}

function normalizeFiles(files) {
  return [...new Set(toArray(files).map((filePath) => path.resolve(String(filePath))))].sort();
}

async function processPendingChunks({
  statePath,
  stateScript,
  chunksDir,
  journalPath,
  workerCmdTemplate,
  timeoutMs,
  maxRetries,
  backoffMs,
  failFast,
  backend,
  mode,
  skillDir,
  index
}) {
  while (true) {
    const next = runJsonScript(stateScript, ['next-chunk', statePath]);
    if (next.done) {
      break;
    }
    const chunk = next.chunk;
    const chunkFilesJsonPath = path.join(chunksDir, `${chunk.id}-files.json`);
    const scanFilesJsonPath = path.join(chunksDir, `${chunk.id}-scan-files.json`);
    const findingsJsonPath = path.join(chunksDir, `${chunk.id}-findings.json`);
    const factsJsonPath = path.join(chunksDir, `${chunk.id}-facts.json`);
    writeJson(chunkFilesJsonPath, chunk.files);

    const hashFilterResult = runJsonScript(stateScript, ['hash-filter', statePath, chunkFilesJsonPath]);
    const scanFiles = hashFilterResult.scan || [];
    if (scanFiles.length === 0) {
      appendJournal(journalPath, {
        event: 'chunk-skip',
        chunkId: chunk.id,
        reason: 'hash-cache-no-changes'
      });
      runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'done']);
      continue;
    }

    writeJson(scanFilesJsonPath, scanFiles);
    if (fs.existsSync(findingsJsonPath)) {
      fs.unlinkSync(findingsJsonPath);
    }
    if (fs.existsSync(factsJsonPath)) {
      fs.unlinkSync(factsJsonPath);
    }
    runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'in_progress']);

    const command = fillTemplate(workerCmdTemplate, {
      chunkId: chunk.id,
      chunkFilesJson: chunkFilesJsonPath,
      scanFilesJson: scanFilesJsonPath,
      findingsJson: findingsJsonPath,
      factsJson: factsJsonPath,
      backend,
      mode,
      statePath,
      skillDir
    });

    const runResult = await runWithRetry({
      command,
      timeoutMs,
      maxRetries,
      backoffMs,
      journalPath,
      phase: 'chunk-worker',
      chunkId: chunk.id
    });

    if (!runResult.ok) {
      const errorMessage = (runResult.result && runResult.result.stderr) || 'worker failed';
      runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'failed', errorMessage.slice(0, 240)]);
      appendJournal(journalPath, {
        event: 'chunk-failed',
        chunkId: chunk.id,
        errorMessage: errorMessage.slice(0, 500)
      });
      if (failFast) {
        throw new Error(`Chunk ${chunk.id} failed and fail-fast is enabled`);
      }
      continue;
    }

    let findings = [];
    if (fs.existsSync(findingsJsonPath)) {
      runJsonScript(stateScript, ['record-findings', statePath, findingsJsonPath, 'orchestrator']);
      findings = readJson(findingsJsonPath);
    }

    if (fs.existsSync(factsJsonPath)) {
      runJsonScript(stateScript, ['record-fact-card', statePath, chunk.id, factsJsonPath]);
    } else {
      const factCard = buildHeuristicFactCard({
        chunkId: chunk.id,
        scanFiles,
        findings,
        index
      });
      writeJson(factsJsonPath, factCard);
      runJsonScript(stateScript, ['record-fact-card', statePath, chunk.id, factsJsonPath]);
    }

    runJsonScript(stateScript, ['hash-update', statePath, scanFilesJsonPath, 'scanned']);
    runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'done']);
    appendJournal(journalPath, {
      event: 'chunk-done',
      chunkId: chunk.id,
      attemptsUsed: runResult.attemptsUsed
    });
  }
}

function prepareIndexAndScope({
  options,
  skillDir,
  statePath,
  filesJsonPath,
  journalPath
}) {
  const useIndex = toBoolean(options['use-index'], false);
  const deltaMode = toBoolean(options['delta-mode'], false);
  const deltaHops = toPositiveInt(options['delta-hops'], DEFAULT_DELTA_HOPS);
  const codeIndexScript = path.join(skillDir, 'scripts', 'code-index.cjs');
  const deltaModeScript = path.join(skillDir, 'scripts', 'delta-mode.cjs');
  const scopeDir = path.dirname(statePath);
  const indexPath = path.resolve(options['index-path'] || path.join(scopeDir, 'index.json'));

  let activeFilesJsonPath = filesJsonPath;
  let deltaResult = null;

  if (useIndex || deltaMode) {
    runJsonScript(codeIndexScript, ['build', indexPath, filesJsonPath, process.cwd()]);
    appendJournal(journalPath, {
      event: 'index-built',
      indexPath
    });
  }

  if (deltaMode) {
    if (!options['changed-files-json']) {
      throw new Error('--changed-files-json is required when --delta-mode=true');
    }
    const changedFilesJsonPath = path.resolve(options['changed-files-json']);
    deltaResult = runJsonScript(deltaModeScript, [
      'select',
      indexPath,
      changedFilesJsonPath,
      String(deltaHops)
    ]);
    const deltaSelectedPath = path.resolve(scopeDir, 'delta-selected-files.json');
    writeJson(deltaSelectedPath, deltaResult.selected || []);
    activeFilesJsonPath = deltaSelectedPath;
    appendJournal(journalPath, {
      event: 'delta-selected',
      selected: (deltaResult.selected || []).length,
      expansionCandidates: (deltaResult.expansionCandidates || []).length
    });
  }

  return {
    indexPath: (useIndex || deltaMode) ? indexPath : null,
    deltaMode,
    deltaResult,
    activeFilesJsonPath
  };
}

async function runPipeline(options) {
  if (!options['files-json']) {
    throw new Error('--files-json is required for run command');
  }
  const skillDir = resolveSkillDir(options);
  const preflightResult = preflight(options);
  if (!preflightResult.ok) {
    throw new Error(`Missing helper scripts: ${preflightResult.missing.join(', ')}`);
  }

  const backend = preflightResult.backend.selected;
  const mode = options.mode || 'extended';
  const filesJsonPath = path.resolve(options['files-json']);
  const statePath = path.resolve(options.state || '.bug-hunter/state.json');
  const chunkSize = toPositiveInt(options['chunk-size'], DEFAULT_CHUNK_SIZE);
  const timeoutMs = toPositiveInt(options['timeout-ms'], DEFAULT_TIMEOUT_MS);
  const maxRetries = toPositiveInt(options['max-retries'], DEFAULT_MAX_RETRIES);
  const backoffMs = toPositiveInt(options['backoff-ms'], DEFAULT_BACKOFF_MS);
  const failFast = toBoolean(options['fail-fast'], false);
  const workerCmdTemplate = options['worker-cmd'] || 'node -e "process.exit(0)"';
  const confidenceThreshold = toPositiveInt(options['confidence-threshold'], DEFAULT_CONFIDENCE_THRESHOLD);
  const canarySize = toPositiveInt(options['canary-size'], DEFAULT_CANARY_SIZE);
  const expansionCap = toPositiveInt(options['expansion-cap'], DEFAULT_EXPANSION_CAP);
  const expandOnLowConfidence = toBoolean(options['expand-on-low-confidence'], true);
  const journalPath = path.resolve(options['journal-path'] || '.bug-hunter/run.log');
  const stateScript = path.join(skillDir, 'scripts', 'bug-hunter-state.cjs');
  const deltaModeScript = path.join(skillDir, 'scripts', 'delta-mode.cjs');
  const chunksDir = path.resolve(path.dirname(statePath), 'chunks');
  const consistencyReportPath = path.resolve(options['consistency-report'] || path.join(path.dirname(statePath), 'consistency.json'));
  const fixPlanPath = path.resolve(options['fix-plan-path'] || path.join(path.dirname(statePath), 'fix-plan.json'));
  const factsPath = path.resolve(options['facts-path'] || path.join(path.dirname(statePath), 'bug-hunter-facts.json'));
  ensureDir(chunksDir);

  appendJournal(journalPath, {
    event: 'run-start',
    mode,
    backend,
    statePath,
    filesJsonPath,
    timeoutMs,
    maxRetries,
    backoffMs
  });

  const scope = prepareIndexAndScope({
    options,
    skillDir,
    statePath,
    filesJsonPath,
    journalPath
  });

  if (!fs.existsSync(statePath)) {
    runJsonScript(stateScript, ['init', statePath, mode, scope.activeFilesJsonPath, String(chunkSize)]);
  }

  let index = loadIndex(scope.indexPath);
  await processPendingChunks({
    statePath,
    stateScript,
    chunksDir,
    journalPath,
    workerCmdTemplate,
    timeoutMs,
    maxRetries,
    backoffMs,
    failFast,
    backend,
    mode,
    skillDir,
    index
  });

  if (scope.deltaMode && expandOnLowConfidence) {
    const state = readJson(statePath);
    const lowConfidenceFiles = normalizeFiles(state.bugLedger
      .filter((entry) => {
        return entry.confidence === null || entry.confidence === undefined || Number(entry.confidence) < confidenceThreshold;
      })
      .map((entry) => entry.file));
    if (lowConfidenceFiles.length > 0 && scope.indexPath) {
      const lowConfidenceFilesJsonPath = path.resolve(path.dirname(statePath), 'low-confidence-files.json');
      const selectedFilesJsonPath = scope.activeFilesJsonPath;
      writeJson(lowConfidenceFilesJsonPath, lowConfidenceFiles);
      const expansion = runJsonScript(deltaModeScript, [
        'expand',
        scope.indexPath,
        lowConfidenceFilesJsonPath,
        selectedFilesJsonPath,
        String(DEFAULT_DELTA_HOPS)
      ]);
      const expandedFiles = [
        ...toArray(expansion.expanded),
        ...toArray(expansion.overlayOnly)
      ];
      const cappedExpandedFiles = normalizeFiles(expandedFiles).slice(0, expansionCap);
      if (cappedExpandedFiles.length > 0) {
        const expansionFilesJsonPath = path.resolve(path.dirname(statePath), 'delta-expansion-files.json');
        writeJson(expansionFilesJsonPath, cappedExpandedFiles);
        const appendResult = runJsonScript(stateScript, ['append-files', statePath, expansionFilesJsonPath]);
        appendJournal(journalPath, {
          event: 'delta-expansion',
          lowConfidenceFiles: lowConfidenceFiles.length,
          expansionCandidates: expandedFiles.length,
          expansionAppended: appendResult.appended || 0
        });
        if ((appendResult.appended || 0) > 0) {
          const mergedSelected = normalizeFiles([
            ...readJson(selectedFilesJsonPath),
            ...cappedExpandedFiles
          ]);
          writeJson(selectedFilesJsonPath, mergedSelected);
          await processPendingChunks({
            statePath,
            stateScript,
            chunksDir,
            journalPath,
            workerCmdTemplate,
            timeoutMs,
            maxRetries,
            backoffMs,
            failFast,
            backend,
            mode,
            skillDir,
            index
          });
        }
      }
    }
  }

  const finalState = readJson(statePath);
  const status = runJsonScript(stateScript, ['status', statePath]);
  const consistency = buildConsistencyReport({
    bugLedger: toArray(finalState.bugLedger),
    confidenceThreshold
  });
  writeJson(consistencyReportPath, consistency);
  runJsonScript(stateScript, ['set-consistency', statePath, consistencyReportPath]);

  const fixPlan = buildFixPlan({
    bugLedger: toArray(finalState.bugLedger),
    confidenceThreshold,
    canarySize
  });
  writeJson(fixPlanPath, fixPlan);
  runJsonScript(stateScript, ['set-fix-plan', statePath, fixPlanPath]);

  writeJson(factsPath, finalState.factCards || {});

  appendJournal(journalPath, {
    event: 'run-end',
    status: status.summary,
    consistencyConflicts: consistency.conflicts.length,
    canary: fixPlan.totals.canary
  });

  return {
    ok: true,
    backend,
    journalPath,
    statePath,
    indexPath: scope.indexPath,
    deltaMode: scope.deltaMode,
    deltaSummary: scope.deltaResult ? {
      selectedCount: (scope.deltaResult.selected || []).length,
      expansionCandidatesCount: (scope.deltaResult.expansionCandidates || []).length
    } : null,
    consistencyReportPath,
    fixPlanPath,
    factsPath,
    status: status.summary,
    consistency: {
      conflicts: consistency.conflicts.length,
      lowConfidenceFindings: consistency.lowConfidenceFindings
    },
    fixPlan: fixPlan.totals
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command) {
    usage();
    process.exit(1);
  }

  if (command === 'preflight') {
    const result = preflight(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exit(1);
    }
    return;
  }

  if (command === 'run') {
    const result = await runPipeline(options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'plan') {
    if (!options['files-json']) {
      throw new Error('--files-json is required for plan command');
    }
    const skillDir = resolveSkillDir(options);
    const filesJsonPath = path.resolve(options['files-json']);
    const mode = options.mode || 'extended';
    const chunkSize = toPositiveInt(options['chunk-size'], DEFAULT_CHUNK_SIZE);
    const planPath = path.resolve(options['plan-path'] || '.bug-hunter/plan.json');

    const files = readJson(filesJsonPath);
    const totalFiles = files.length;

    const chunks = [];
    for (let i = 0; i < totalFiles; i += chunkSize) {
      const chunkFiles = files.slice(i, i + chunkSize);
      chunks.push({
        id: `chunk-${chunks.length + 1}`,
        files: chunkFiles,
        fileCount: chunkFiles.length,
        status: 'pending'
      });
    }

    const planOutput = {
      generatedAt: nowIso(),
      mode,
      skillDir,
      totalFiles,
      chunkSize,
      chunkCount: chunks.length,
      phases: ['recon', 'hunter', 'skeptic', 'referee'],
      chunks,
      instructions: [
        'This plan was generated for LLM agent consumption.',
        'The agent should process chunks in order, using the state scripts to track progress.',
        'For local-sequential mode: read modes/local-sequential.md for execution instructions.',
        'For subagent mode: read modes/extended.md or modes/scaled.md for dispatch patterns.'
      ]
    };

    writeJson(planPath, planOutput);
    console.log(JSON.stringify(planOutput, null, 2));
    return;
  }

  usage();
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
