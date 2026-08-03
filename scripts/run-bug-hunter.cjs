#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateArtifactFile, validateArtifactValue } = require('./schema-runtime.cjs');
const {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  appendJournal,
  fillTemplate,
  parseCommand,
  runCommandOnce,
  runJsonScript,
  runTextScript,
  runWithRetry
} = require('./process-runner.cjs');
const {
  assertRunIdentity,
  buildRunIdentity,
  requeueResumableChunks,
  validateStateShape,
  writeJsonAtomic
} = require('./state-store.cjs');
const {
  buildConsistencyReport,
  buildFixPlan,
  buildFixStrategy,
  buildFixerScope,
  selectRefereeAuthorizedFindings
} = require('./artifact-planner.cjs');
const { processPendingChunks } = require('./chunk-scheduler.cjs');

const BACKEND_PRIORITY = ['spawn_agent', 'subagent', 'teams', 'local-sequential'];
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
  console.error('  run-bug-hunter.cjs run --files-json <path> --worker-cmd <template> [--run-id <id> | --resume <run-id>] [--referee-path <path>] [--fixer-scope-path <path>] [--mode <name>] [--skill-dir <path>] [--state <path>] [--chunk-size <n>] [--timeout-ms <n>] [--max-output-bytes <n>] [--kill-grace-ms <n>] [--max-retries <n>] [--backoff-ms <n>] [--available-backends <csv>] [--backend <name>] [--fail-fast <true|false>] [--use-index <true|false>] [--index-path <path>] [--delta-mode <true|false>] [--changed-files-json <path>] [--delta-hops <n>] [--expand-on-low-confidence <true|false>] [--confidence-threshold <n>] [--canary-size <n>] [--expansion-cap <n>] [--strategy-path <path>] [--strategy-markdown-path <path>]');
  console.error('  run-bug-hunter.cjs phase --artifact <name> --output-path <path> --worker-cmd <template> [--phase-name <name>] [--skill-dir <path>] [--journal-path <path>] [--render-cmd <template>] [--render-output-path <path>] [--timeout-ms <n>] [--render-timeout-ms <n>] [--max-output-bytes <n>] [--kill-grace-ms <n>] [--max-retries <n>] [--backoff-ms <n>]');
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

function toPositiveInt(value, fallback, label = 'value') {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function toNonNegativeInt(value, fallback, label = 'value') {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
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
    path.join(skillDir, 'scripts', 'process-runner.cjs'),
    path.join(skillDir, 'scripts', 'state-store.cjs'),
    path.join(skillDir, 'scripts', 'artifact-planner.cjs'),
    path.join(skillDir, 'scripts', 'chunk-scheduler.cjs'),
    path.join(skillDir, 'scripts', 'payload-guard.cjs'),
    path.join(skillDir, 'scripts', 'schema-validate.cjs'),
    path.join(skillDir, 'scripts', 'schema-runtime.cjs'),
    path.join(skillDir, 'scripts', 'generated-schema-validators.cjs'),
    path.join(skillDir, 'scripts', 'schema-catalog.cjs'),
    path.join(skillDir, 'scripts', 'render-report.cjs'),
    path.join(skillDir, 'scripts', 'fix-lock.cjs'),
    path.join(skillDir, 'scripts', 'doc-lookup.cjs'),
    path.join(skillDir, 'scripts', 'context7-api.cjs'),
    path.join(skillDir, 'scripts', 'delta-mode.cjs'),
    path.join(skillDir, 'scripts', 'pr-scope.cjs'),
    path.join(skillDir, 'schemas', 'findings.schema.json'),
    path.join(skillDir, 'schemas', 'skeptic.schema.json'),
    path.join(skillDir, 'schemas', 'referee.schema.json'),
    path.join(skillDir, 'schemas', 'coverage.schema.json'),
    path.join(skillDir, 'schemas', 'fix-report.schema.json'),
    path.join(skillDir, 'schemas', 'fix-plan.schema.json'),
    path.join(skillDir, 'schemas', 'fix-strategy.schema.json'),
    path.join(skillDir, 'schemas', 'fixer-scope.schema.json'),
    path.join(skillDir, 'schemas', 'recon.schema.json'),
    path.join(skillDir, 'schemas', 'shared.schema.json'),
    // Core agent skills (migrated from prompts/)
    path.join(skillDir, 'skills', 'hunter', 'SKILL.md'),
    path.join(skillDir, 'skills', 'skeptic', 'SKILL.md'),
    path.join(skillDir, 'skills', 'referee', 'SKILL.md'),
    path.join(skillDir, 'skills', 'fixer', 'SKILL.md'),
    path.join(skillDir, 'skills', 'recon', 'SKILL.md'),
    path.join(skillDir, 'skills', 'doc-lookup', 'SKILL.md'),
    // Security skills
    path.join(skillDir, 'skills', 'threat-model-generation', 'SKILL.md'),
    path.join(skillDir, 'skills', 'commit-security-scan', 'SKILL.md'),
    path.join(skillDir, 'skills', 'security-review', 'SKILL.md'),
    path.join(skillDir, 'skills', 'vulnerability-validation', 'SKILL.md')
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

function loadRefereeAuthorization(refereePath) {
  if (!refereePath) {
    return null;
  }
  const resolvedPath = path.resolve(refereePath);
  const validation = validateNamedArtifact({
    artifactName: 'referee',
    filePath: resolvedPath
  });
  if (!validation.ok) {
    throw new Error(`Invalid Referee artifact: ${validation.errors.join('; ')}`);
  }
  const verdicts = readJson(resolvedPath);
  const verdictsById = new Map();
  verdicts.map((verdict) => {
    const bugId = String(verdict.bugId || '').trim();
    if (verdictsById.has(bugId)) {
      throw new Error(`Duplicate Referee verdict for bug ID: ${bugId}`);
    }
    verdictsById.set(bugId, verdict);
    return verdict;
  });
  return {
    path: resolvedPath,
    verdicts,
    verdictsById
  };
}

function toCoverageStatus(chunkStatus) {
  if (chunkStatus === 'done') {
    return 'done';
  }
  if (chunkStatus === 'in_progress') {
    return 'in_progress';
  }
  if (chunkStatus === 'failed') {
    return 'failed';
  }
  return 'pending';
}

function buildCoverageArtifact({ state, fixPlan }) {
  const fileEntries = toArray(state.chunks).flatMap((chunk) => {
    return toArray(chunk.files).map((filePath) => {
      return {
        path: String(filePath),
        status: toCoverageStatus(chunk.status)
      };
    });
  });

  const bugs = toArray(state.bugLedger).map((entry) => {
    return {
      bugId: String(entry.bugId || '').trim() || String(entry.key || '').trim(),
      severity: String(entry.severity || 'Low'),
      file: String(entry.file || '').trim(),
      claim: String(entry.claim || '').trim()
    };
  });

  const fixStatusByBugId = new Map();
  for (const entry of toArray(fixPlan && fixPlan.canary)) {
    fixStatusByBugId.set(String(entry.bugId || '').trim(), 'CANARY');
  }
  for (const entry of toArray(fixPlan && fixPlan.rollout)) {
    fixStatusByBugId.set(String(entry.bugId || '').trim(), 'ROLLOUT');
  }
  for (const entry of toArray(fixPlan && fixPlan.manualReview)) {
    fixStatusByBugId.set(String(entry.bugId || '').trim(), 'MANUAL_REVIEW');
  }

  const fixes = [...fixStatusByBugId.entries()]
    .filter(([bugId]) => Boolean(bugId))
    .map(([bugId, status]) => {
      return {
        bugId,
        status
      };
    });

  const hasOpenChunks = toArray(state.chunks).some((chunk) => chunk.status !== 'done');

  return {
    schemaVersion: 1,
    iteration: 1,
    status: hasOpenChunks ? 'IN_PROGRESS' : 'COMPLETE',
    files: fileEntries,
    bugs,
    fixes
  };
}

function renderCoverageMarkdown(coverage) {
  const lines = [
    '# Bug Hunter Coverage',
    '',
    `- Status: ${coverage.status}`,
    `- Iteration: ${coverage.iteration}`,
    `- Files: ${coverage.files.length}`,
    `- Bugs: ${coverage.bugs.length}`,
    `- Fix entries: ${coverage.fixes.length}`,
    '',
    '## Files'
  ];

  if (coverage.files.length === 0) {
    lines.push('- None');
  } else {
    for (const entry of coverage.files) {
      lines.push(`- ${entry.status} | ${entry.path}`);
    }
  }

  lines.push('', '## Bugs');
  if (coverage.bugs.length === 0) {
    lines.push('- None');
  } else {
    for (const bug of coverage.bugs) {
      lines.push(`- ${bug.bugId} | ${bug.severity} | ${bug.file} | ${bug.claim}`);
    }
  }

  lines.push('', '## Fixes');
  if (coverage.fixes.length === 0) {
    lines.push('- None');
  } else {
    for (const fix of coverage.fixes) {
      lines.push(`- ${fix.bugId} | ${fix.status}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function validateNamedArtifact({ artifactName, filePath }) {
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      errors: [`Missing ${artifactName} artifact: ${filePath}`]
    };
  }
  return validateArtifactFile({
    artifactName,
    filePath
  });
}

function removeFileIfExists(filePath) {
  if (!filePath) {
    return;
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

async function runPhase(options) {
  const artifact = String(options.artifact || '').trim();
  if (!artifact) {
    throw new Error('--artifact is required for phase command');
  }
  if (!options['output-path']) {
    throw new Error('--output-path is required for phase command');
  }
  if (!options['worker-cmd']) {
    throw new Error('--worker-cmd is required for phase command');
  }

  const skillDir = resolveSkillDir(options);
  const preflightResult = preflight(options);
  if (!preflightResult.ok) {
    throw new Error(`Missing helper scripts: ${preflightResult.missing.join(', ')}`);
  }

  const phaseName = options['phase-name'] || artifact;
  const outputPath = path.resolve(options['output-path']);
  const renderOutputPath = options['render-output-path']
    ? path.resolve(options['render-output-path'])
    : null;
  const workerCmdTemplate = options['worker-cmd'];
  const renderCmdTemplate = options['render-cmd'] || null;
  const timeoutMs = toPositiveInt(options['timeout-ms'], DEFAULT_TIMEOUT_MS, '--timeout-ms');
  const renderTimeoutMs = toPositiveInt(options['render-timeout-ms'], timeoutMs, '--render-timeout-ms');
  const maxOutputBytes = toPositiveInt(
    options['max-output-bytes'],
    DEFAULT_MAX_OUTPUT_BYTES,
    '--max-output-bytes'
  );
  const killGraceMs = toPositiveInt(
    options['kill-grace-ms'],
    DEFAULT_KILL_GRACE_MS,
    '--kill-grace-ms'
  );
  const maxRetries = toNonNegativeInt(options['max-retries'], DEFAULT_MAX_RETRIES, '--max-retries');
  const backoffMs = toNonNegativeInt(options['backoff-ms'], DEFAULT_BACKOFF_MS, '--backoff-ms');
  const journalPath = path.resolve(
    options['journal-path'] || path.join(path.dirname(outputPath), `${phaseName}.log`)
  );
  const templateVariables = {
    artifact,
    outputPath,
    outputFilePath: outputPath,
    renderOutputPath: renderOutputPath || '',
    journalPath,
    phaseName,
    skillDir
  };

  ensureDir(path.dirname(outputPath));
  if (renderOutputPath) {
    ensureDir(path.dirname(renderOutputPath));
  }
  removeFileIfExists(outputPath);
  removeFileIfExists(renderOutputPath);

  appendJournal(journalPath, {
    event: 'phase-start',
    artifact,
    phase: phaseName,
    outputPath,
    renderOutputPath
  });

  const workerCommand = fillTemplate(workerCmdTemplate, templateVariables);
  const runResult = await runWithRetry({
    command: workerCommand,
    timeoutMs,
    maxRetries,
    backoffMs,
    journalPath,
    phase: phaseName,
    chunkId: artifact,
    maxOutputBytes,
    killGraceMs,
    beforeAttempt: async () => {
      removeFileIfExists(outputPath);
      removeFileIfExists(renderOutputPath);
    },
    postAttempt: async () => {
      const validation = validateNamedArtifact({
        artifactName: artifact,
        filePath: outputPath
      });
      if (validation.ok) {
        return { ok: true };
      }
      return {
        ok: false,
        errorMessage: validation.errors.join('; ')
      };
    }
  });

  if (!runResult.ok) {
    const errorMessage = (runResult.result && runResult.result.stderr) || `${phaseName} failed`;
    appendJournal(journalPath, {
      event: 'phase-failed',
      artifact,
      phase: phaseName,
      errorMessage: errorMessage.slice(0, 500)
    });
    throw new Error(errorMessage);
  }

  if (renderCmdTemplate) {
    const renderCommand = fillTemplate(renderCmdTemplate, templateVariables);
    appendJournal(journalPath, {
      event: 'phase-render-start',
      artifact,
      phase: phaseName,
      renderOutputPath
    });
    const renderResult = await runCommandOnce({
      command: renderCommand,
      timeoutMs: renderTimeoutMs,
      maxOutputBytes,
      killGraceMs
    });
    if (!renderResult.ok) {
      const renderError = renderResult.stderr || renderResult.stdout || `${phaseName} render failed`;
      appendJournal(journalPath, {
        event: 'phase-render-failed',
        artifact,
        phase: phaseName,
        errorMessage: renderError.slice(0, 500)
      });
      throw new Error(renderError);
    }
    if (renderOutputPath) {
      fs.writeFileSync(renderOutputPath, `${renderResult.stdout}\n`, 'utf8');
    }
    appendJournal(journalPath, {
      event: 'phase-render-end',
      artifact,
      phase: phaseName,
      renderOutputPath
    });
  }

  appendJournal(journalPath, {
    event: 'phase-end',
    artifact,
    phase: phaseName,
    attemptsUsed: runResult.attemptsUsed
  });

  return {
    ok: true,
    artifact,
    phase: phaseName,
    outputPath,
    renderOutputPath,
    journalPath,
    attemptsUsed: runResult.attemptsUsed
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

function prepareIndexAndScope({
  options,
  skillDir,
  statePath,
  filesJsonPath,
  journalPath
}) {
  const useIndex = toBoolean(options['use-index'], false);
  const deltaMode = toBoolean(options['delta-mode'], false);
  const deltaHops = toNonNegativeInt(options['delta-hops'], DEFAULT_DELTA_HOPS, '--delta-hops');
  const codeIndexScript = path.join(skillDir, 'scripts', 'code-index.cjs');
  const deltaModeScript = path.join(skillDir, 'scripts', 'delta-mode.cjs');
  const scopeDir = path.dirname(statePath);
  const indexPath = path.resolve(options['index-path'] || path.join(scopeDir, 'index.json'));

  let activeFilesJsonPath = filesJsonPath;
  let deltaResult = null;

  if (useIndex || deltaMode) {
    if (!fs.existsSync(codeIndexScript)) {
      if (deltaMode) {
        throw new Error('code-index.cjs is required when --delta-mode=true');
      }
      appendJournal(journalPath, {
        event: 'index-skip',
        reason: 'missing-code-index',
        codeIndexScript
      });
      return {
        indexPath: null,
        deltaMode: false,
        deltaHops,
        deltaResult: null,
        activeFilesJsonPath
      };
    }
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
    deltaHops,
    deltaResult,
    activeFilesJsonPath
  };
}

async function runPipeline(options) {
  if (!options['files-json']) {
    throw new Error('--files-json is required for run command');
  }
  if (!options['worker-cmd']) {
    throw new Error('--worker-cmd is required for run command; no no-op worker is available');
  }
  if (options.resume && options['run-id']) {
    throw new Error('--resume and --run-id cannot be used together');
  }
  const skillDir = resolveSkillDir(options);
  const preflightResult = preflight(options);
  if (!preflightResult.ok) {
    throw new Error(`Missing helper scripts: ${preflightResult.missing.join(', ')}`);
  }

  const backend = preflightResult.backend.selected;
  const mode = options.mode || 'extended';
  const filesJsonPath = path.resolve(options['files-json']);
  const resumeRunId = options.resume ? String(options.resume) : null;
  const runId = resumeRunId || String(options['run-id'] || crypto.randomUUID());
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error('Run ID must use only letters, numbers, dot, underscore, or hyphen');
  }
  const statePath = path.resolve(
    options.state || path.join('.bug-hunter', 'runs', runId, 'state.json')
  );
  const identityPath = `${statePath}.identity.json`;
  const chunkSize = toPositiveInt(options['chunk-size'], DEFAULT_CHUNK_SIZE, '--chunk-size');
  const timeoutMs = toPositiveInt(options['timeout-ms'], DEFAULT_TIMEOUT_MS, '--timeout-ms');
  const maxOutputBytes = toPositiveInt(
    options['max-output-bytes'],
    DEFAULT_MAX_OUTPUT_BYTES,
    '--max-output-bytes'
  );
  const killGraceMs = toPositiveInt(
    options['kill-grace-ms'],
    DEFAULT_KILL_GRACE_MS,
    '--kill-grace-ms'
  );
  const maxRetries = toNonNegativeInt(options['max-retries'], DEFAULT_MAX_RETRIES, '--max-retries');
  const backoffMs = toNonNegativeInt(options['backoff-ms'], DEFAULT_BACKOFF_MS, '--backoff-ms');
  const failFast = toBoolean(options['fail-fast'], false);
  const workerCmdTemplate = options['worker-cmd'];
  parseCommand(fillTemplate(workerCmdTemplate, {
    chunkId: 'preflight',
    chunkFilesJson: 'preflight.json',
    scanFilesJson: 'preflight.json',
    findingsJson: 'preflight.json',
    factsJson: 'preflight.json',
    backend,
    mode,
    statePath,
    skillDir
  }));
  const authorization = loadRefereeAuthorization(options['referee-path']);
  const confidenceThreshold = toPositiveInt(
    options['confidence-threshold'],
    DEFAULT_CONFIDENCE_THRESHOLD,
    '--confidence-threshold'
  );
  const canarySize = toPositiveInt(options['canary-size'], DEFAULT_CANARY_SIZE, '--canary-size');
  const expansionCap = toPositiveInt(
    options['expansion-cap'],
    DEFAULT_EXPANSION_CAP,
    '--expansion-cap'
  );
  const expandOnLowConfidence = toBoolean(options['expand-on-low-confidence'], true);
  const journalPath = path.resolve(
    options['journal-path'] || path.join(path.dirname(statePath), 'run.log')
  );
  const stateScript = path.join(skillDir, 'scripts', 'bug-hunter-state.cjs');
  const deltaModeScript = path.join(skillDir, 'scripts', 'delta-mode.cjs');
  const chunksDir = path.resolve(path.dirname(statePath), 'chunks');
  const consistencyReportPath = path.resolve(options['consistency-report'] || path.join(path.dirname(statePath), 'consistency.json'));
  const fixPlanPath = path.resolve(options['fix-plan-path'] || path.join(path.dirname(statePath), 'fix-plan.json'));
  const fixerScopePath = path.resolve(options['fixer-scope-path'] || path.join(path.dirname(statePath), 'fixer-scope.json'));
  const strategyPath = path.resolve(options['strategy-path'] || path.join(path.dirname(statePath), 'fix-strategy.json'));
  const strategyMarkdownPath = path.resolve(options['strategy-markdown-path'] || path.join(path.dirname(statePath), 'fix-strategy.md'));
  const coveragePath = path.resolve(options['coverage-path'] || path.join(path.dirname(statePath), 'coverage.json'));
  const coverageMarkdownPath = path.resolve(options['coverage-markdown-path'] || path.join(path.dirname(statePath), 'coverage.md'));
  const factsPath = path.resolve(options['facts-path'] || path.join(path.dirname(statePath), 'bug-hunter-facts.json'));

  if (!resumeRunId && (fs.existsSync(statePath) || fs.existsSync(identityPath))) {
    throw new Error(`State already exists; use --resume with its run ID or choose a new --run-id: ${statePath}`);
  }
  if (resumeRunId && (!fs.existsSync(statePath) || !fs.existsSync(identityPath))) {
    throw new Error(`Cannot resume run ${resumeRunId}: state or identity is missing`);
  }

  const scope = prepareIndexAndScope({
    options,
    skillDir,
    statePath,
    filesJsonPath,
    journalPath
  });

  const runIdentity = buildRunIdentity({
    runId,
    mode,
    backend,
    filesJsonPath: scope.activeFilesJsonPath,
    chunkSize,
    timeoutMs,
    maxRetries,
    confidenceThreshold,
    deltaMode: scope.deltaMode,
    deltaHops: scope.deltaHops
  });

  if (resumeRunId) {
    assertRunIdentity({
      expected: runIdentity,
      actual: readJson(identityPath),
      identityPath
    });
    requeueResumableChunks({
      statePath,
      stateScript,
      maxRetries
    });
  } else {
    runJsonScript(stateScript, ['init', statePath, mode, scope.activeFilesJsonPath, String(chunkSize)]);
    writeJsonAtomic(identityPath, runIdentity);
  }

  ensureDir(chunksDir);
  appendJournal(journalPath, {
    event: resumeRunId ? 'run-resume' : 'run-start',
    runId,
    mode,
    backend,
    statePath,
    filesJsonPath,
    timeoutMs,
    maxRetries,
    backoffMs
  });

  let index = loadIndex(scope.indexPath);
  await processPendingChunks({
    statePath,
    stateScript,
    chunksDir,
    journalPath,
    workerCmdTemplate,
    timeoutMs,
    maxOutputBytes,
    killGraceMs,
    maxRetries,
    backoffMs,
    failFast,
    backend,
    mode,
    skillDir,
    index,
    confidenceThreshold
  });

  if (scope.deltaMode && expandOnLowConfidence) {
    const state = readJson(statePath);
    const lowConfidenceFiles = normalizeFiles(state.bugLedger
      .filter((entry) => {
        return entry.confidenceScore === null || entry.confidenceScore === undefined || Number(entry.confidenceScore) < confidenceThreshold;
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
        String(scope.deltaHops ?? DEFAULT_DELTA_HOPS)
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
            maxOutputBytes,
            killGraceMs,
            maxRetries,
            backoffMs,
            failFast,
            backend,
            mode,
            skillDir,
            index,
            confidenceThreshold
          });
        }
      }
    }
  }

  const finalState = readJson(statePath);
  validateStateShape({ statePath, state: finalState });
  const status = runJsonScript(stateScript, ['status', statePath]);
  const consistency = buildConsistencyReport({
    bugLedger: toArray(finalState.bugLedger),
    confidenceThreshold
  });
  writeJson(consistencyReportPath, consistency);
  runJsonScript(stateScript, ['set-consistency', statePath, consistencyReportPath]);

  const hasOpenOrFailedChunks = (status.summary.chunkStatus.pending || 0) > 0
    || (status.summary.chunkStatus.inProgress || 0) > 0
    || (status.summary.chunkStatus.failed || 0) > 0;

  if (hasOpenOrFailedChunks) {
    appendJournal(journalPath, {
      event: 'fix-planning-skipped',
      reason: 'incomplete-or-failed-chunks',
      chunkStatus: status.summary.chunkStatus
    });

    return {
      ok: false,
      runId,
      identityPath,
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
      strategyPath: null,
      strategyMarkdownPath: null,
      fixPlanPath: null,
      fixerScopePath: null,
      coveragePath: null,
      coverageMarkdownPath: null,
      factsPath,
      status: status.summary,
      consistency: {
        conflicts: consistency.conflicts.length,
        lowConfidenceFindings: consistency.lowConfidenceFindings
      },
      fixStrategy: null,
      fixPlan: null
    };
  }

  if (!authorization) {
    const coverage = buildCoverageArtifact({
      state: finalState,
      fixPlan: null
    });
    const coverageValidation = validateArtifactValue({
      artifactName: 'coverage',
      value: coverage
    });
    if (!coverageValidation.ok) {
      throw new Error(`Generated invalid coverage artifact: ${coverageValidation.errors.join('; ')}`);
    }
    writeJson(coveragePath, coverage);
    ensureDir(path.dirname(coverageMarkdownPath));
    fs.writeFileSync(coverageMarkdownPath, renderCoverageMarkdown(coverage), 'utf8');
    writeJson(factsPath, finalState.factCards || {});
    appendJournal(journalPath, {
      event: 'fix-planning-skipped',
      reason: 'no-validated-referee-artifact'
    });
    return {
      ok: true,
      runId,
      identityPath,
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
      strategyPath: null,
      strategyMarkdownPath: null,
      fixPlanPath: null,
      fixerScopePath: null,
      coveragePath,
      coverageMarkdownPath,
      factsPath,
      status: status.summary,
      consistency: {
        conflicts: consistency.conflicts.length,
        lowConfidenceFindings: consistency.lowConfidenceFindings
      },
      fixStrategy: null,
      fixPlan: null
    };
  }

  const authorizedFindings = selectRefereeAuthorizedFindings({
    bugLedger: toArray(finalState.bugLedger),
    authorization
  });
  const authorizedConsistency = buildConsistencyReport({
    bugLedger: authorizedFindings,
    confidenceThreshold
  });
  const fixPlan = buildFixPlan({
    bugLedger: authorizedFindings,
    confidenceThreshold,
    canarySize,
    consistency: authorizedConsistency
  });
  const fixPlanValidation = validateArtifactValue({
    artifactName: 'fix-plan',
    value: fixPlan
  });
  if (!fixPlanValidation.ok) {
    throw new Error(`Generated invalid fix plan artifact: ${fixPlanValidation.errors.join('; ')}`);
  }
  writeJson(fixPlanPath, fixPlan);
  runJsonScript(stateScript, ['set-fix-plan', statePath, fixPlanPath]);

  const fixerScope = buildFixerScope({
    runIdentity,
    authorizedFindings,
    fixPlan
  });
  const fixerScopeValidation = validateArtifactValue({
    artifactName: 'fixer-scope',
    value: fixerScope
  });
  if (!fixerScopeValidation.ok) {
    throw new Error(`Generated invalid Fixer scope artifact: ${fixerScopeValidation.errors.join('; ')}`);
  }
  if (fs.existsSync(fixerScopePath)) {
    const existingScope = readJson(fixerScopePath);
    if (JSON.stringify(existingScope) !== JSON.stringify(fixerScope)) {
      throw new Error(`Immutable Fixer scope already exists with different authorization: ${fixerScopePath}`);
    }
  } else {
    writeJsonAtomic(fixerScopePath, fixerScope);
  }

  const fixStrategy = buildFixStrategy({
    fixPlan,
    confidenceThreshold
  });
  const fixStrategyValidation = validateArtifactValue({
    artifactName: 'fix-strategy',
    value: fixStrategy
  });
  if (!fixStrategyValidation.ok) {
    throw new Error(`Generated invalid fix strategy artifact: ${fixStrategyValidation.errors.join('; ')}`);
  }
  writeJson(strategyPath, fixStrategy);
  ensureDir(path.dirname(strategyMarkdownPath));
  fs.writeFileSync(
    strategyMarkdownPath,
    runTextScript(path.join(skillDir, 'scripts', 'render-report.cjs'), ['fix-strategy', strategyPath]),
    'utf8'
  );

  const coverage = buildCoverageArtifact({
    state: finalState,
    fixPlan
  });
  const coverageValidation = validateArtifactValue({
    artifactName: 'coverage',
    value: coverage
  });
  if (!coverageValidation.ok) {
    throw new Error(`Generated invalid coverage artifact: ${coverageValidation.errors.join('; ')}`);
  }
  writeJson(coveragePath, coverage);
  ensureDir(path.dirname(coverageMarkdownPath));
  fs.writeFileSync(coverageMarkdownPath, renderCoverageMarkdown(coverage), 'utf8');

  writeJson(factsPath, finalState.factCards || {});

  appendJournal(journalPath, {
    event: 'run-end',
    status: status.summary,
    consistencyConflicts: consistency.conflicts.length,
    canary: fixPlan.totals.canary
  });

  return {
    ok: true,
    runId,
    identityPath,
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
    strategyPath,
    strategyMarkdownPath,
    fixPlanPath,
    fixerScopePath,
    coveragePath,
    coverageMarkdownPath,
    factsPath,
    status: status.summary,
    consistency: {
      conflicts: consistency.conflicts.length,
      lowConfidenceFindings: consistency.lowConfidenceFindings
    },
    fixStrategy: fixStrategy.summary,
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
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'phase') {
    const result = await runPhase(options);
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
    const chunkSize = toPositiveInt(options['chunk-size'], DEFAULT_CHUNK_SIZE, '--chunk-size');
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
