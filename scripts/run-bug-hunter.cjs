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
  getRepositoryIdentity,
  normalizeRunFiles,
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
const { buildAdaptivePolicy } = require('./adaptive-policy.cjs');
const { detectPlan: detectVerificationPlan, runPlan: runVerificationPlan } = require('./hybrid-verifier.cjs');
const { buildRetrievalPlan } = require('./retrieval-planner.cjs');
const {
  DEFAULT_SOURCE_TOKEN_BUDGET,
  MAX_FILES_PER_CHUNK,
  buildSourceChunks
} = require('./source-config.cjs');

const BACKEND_PRIORITY = ['spawn_agent', 'subagent', 'teams', 'local-sequential'];
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_CHUNK_SIZE = MAX_FILES_PER_CHUNK;
const DEFAULT_CONFIDENCE_THRESHOLD = 75;
const DEFAULT_CANARY_SIZE = 3;
const DEFAULT_DELTA_HOPS = 2;
const DEFAULT_EXPANSION_CAP = 40;

function usage() {
  console.error('Usage:');
  console.error('  run-bug-hunter.cjs preflight [--skill-dir <path>] [--available-backends <csv>] [--backend <name>]');
  console.error('  run-bug-hunter.cjs run --files-json <path> --worker-cmd <template> [--run-id <id> | --resume <run-id>] [--referee-path <path>] [--fixer-scope-path <path>] [--mode <name>] [--skill-dir <path>] [--state <path>] [--chunk-size <n>] [--max-source-tokens <n>] [--timeout-ms <n>] [--max-output-bytes <n>] [--kill-grace-ms <n>] [--max-retries <n>] [--backoff-ms <n>] [--available-backends <csv>] [--backend <name>] [--fail-fast <true|false>] [--use-index <true|false>] [--index-path <path>] [--delta-mode <true|false>] [--changed-files-json <path>] [--delta-hops <n>] [--expand-on-low-confidence <true|false>] [--confidence-threshold <n>] [--canary-size <n>] [--expansion-cap <n>] [--strategy-path <path>] [--strategy-markdown-path <path>]');
  console.error('  run-bug-hunter.cjs phase --artifact <name> --output-path <path> --worker-cmd <template> [--phase-name <name>] [--skill-dir <path>] [--journal-path <path>] [--render-cmd <template>] [--render-output-path <path>] [--timeout-ms <n>] [--render-timeout-ms <n>] [--max-output-bytes <n>] [--kill-grace-ms <n>] [--max-retries <n>] [--backoff-ms <n>]');
  console.error('  run-bug-hunter.cjs plan --files-json <path> [--mode <name>] [--skill-dir <path>] [--chunk-size <n>] [--max-source-tokens <n>] [--plan-path <path>]');
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
    path.join(skillDir, 'scripts', 'source-config.cjs'),
    path.join(skillDir, 'scripts', 'process-runner.cjs'),
    path.join(skillDir, 'scripts', 'state-store.cjs'),
    path.join(skillDir, 'scripts', 'artifact-planner.cjs'),
    path.join(skillDir, 'scripts', 'chunk-scheduler.cjs'),
    path.join(skillDir, 'scripts', 'benchmark-suite.cjs'),
    path.join(skillDir, 'scripts', 'adaptive-policy.cjs'),
    path.join(skillDir, 'scripts', 'hybrid-verifier.cjs'),
    path.join(skillDir, 'scripts', 'evidence-cache.cjs'),
    path.join(skillDir, 'scripts', 'retrieval-planner.cjs'),
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
    path.join(skillDir, 'schemas', 'benchmark-report.schema.json'),
    path.join(skillDir, 'schemas', 'adaptive-plan.schema.json'),
    path.join(skillDir, 'schemas', 'verification-report.schema.json'),
    path.join(skillDir, 'schemas', 'retrieval-plan.schema.json'),
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

function semanticArtifactHash(value) {
  const clone = JSON.parse(JSON.stringify(value));
  if (clone && typeof clone === 'object' && !Array.isArray(clone)) {
    clone.generatedAt = null;
  }
  return crypto.createHash('sha256').update(JSON.stringify(clone)).digest('hex');
}

function validateGeneratedArtifact(artifactName, value, label) {
  const validation = validateArtifactValue({ artifactName, value });
  if (!validation.ok) {
    throw new Error(`Generated invalid ${label}: ${validation.errors.join('; ') }`);
  }
}

function inferredTriage(files) {
  const riskMap = { critical: [], high: [], medium: [], low: [], 'context-only': [] };
  let tokenTotal = 0;
  for (const filePath of files) {
    const relative = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    try {
      tokenTotal += Math.max(1, Math.ceil(fs.statSync(filePath).size / 4));
    } catch {
      tokenTotal += 1;
    }
    if (/(^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\./i.test(relative)) {
      riskMap['context-only'].push(relative);
    } else if (/auth|security|session|token|permission|payment|webhook|crypto/i.test(relative)) {
      riskMap.critical.push(relative);
    } else if (/api|route|controller|service|database|queue|worker|upload|storage/i.test(relative)) {
      riskMap.high.push(relative);
    } else {
      riskMap.medium.push(relative);
    }
  }
  return {
    generatedAt: nowIso(),
    target: process.cwd(),
    totalFiles: files.length,
    scannableFiles: files.length,
    avgTokens: files.length === 0 ? 0 : Math.ceil(tokenTotal / files.length),
    riskMap,
    domains: []
  };
}

function semanticInputFileHash(filePath) {
  if (!filePath) {
    return null;
  }
  const resolvedPath = path.resolve(String(filePath));
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration input does not exist: ${resolvedPath}`);
  }
  return semanticArtifactHash(readJson(resolvedPath));
}

function writeOrValidateStablePlan({ planPath, plan, resumeRunId, label }) {
  if (resumeRunId) {
    if (!fs.existsSync(planPath)) {
      throw new Error(`${label} is missing for resumed run: ${planPath}`);
    }
    return readJson(planPath);
  }
  writeJson(planPath, plan);
  return plan;
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

function toCoverageStatus(fileState, chunkStatus) {
  const fileStatus = fileState && fileState.status;
  if (fileStatus === 'scanned' || fileStatus === 'skipped') {
    return 'done';
  }
  if (fileStatus === 'missing' || fileStatus === 'unreadable' || fileStatus === 'failed') {
    return 'failed';
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
      const normalizedPath = String(filePath);
      const fileState = state.fileStates && state.fileStates[normalizedPath];
      return {
        path: normalizedPath,
        status: toCoverageStatus(fileState, chunk.status)
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

  const hasIncompleteFiles = fileEntries.some((entry) => entry.status !== 'done');

  return {
    schemaVersion: 1,
    iteration: 1,
    status: hasIncompleteFiles ? 'IN_PROGRESS' : 'COMPLETE',
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
  return [...new Set(toArray(files).map((filePath) => path.resolve(String(filePath))))];
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
  const requestedChunkSize = options['chunk-size'] === undefined
    ? null
    : toPositiveInt(options['chunk-size'], DEFAULT_CHUNK_SIZE, '--chunk-size');
  const requestedMaxSourceTokens = options['max-source-tokens'] === undefined
    ? null
    : toPositiveInt(options['max-source-tokens'], DEFAULT_SOURCE_TOKEN_BUDGET, '--max-source-tokens');
  const requestedConfidenceThreshold = options['confidence-threshold'] === undefined
    ? null
    : toPositiveInt(options['confidence-threshold'], DEFAULT_CONFIDENCE_THRESHOLD, '--confidence-threshold');
  const requestedDeltaHops = options['delta-hops'] === undefined
    ? null
    : toNonNegativeInt(options['delta-hops'], DEFAULT_DELTA_HOPS, '--delta-hops');
  const requestedExpansionCap = options['expansion-cap'] === undefined
    ? null
    : toPositiveInt(options['expansion-cap'], DEFAULT_EXPANSION_CAP, '--expansion-cap');
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
    cachedFactsJson: 'preflight.json',
    adaptivePlanJson: 'preflight.json',
    retrievalPlanJson: 'preflight.json',
    backend,
    mode,
    statePath,
    skillDir
  }));
  const authorization = loadRefereeAuthorization(options['referee-path']);
  const canarySize = toPositiveInt(options['canary-size'], DEFAULT_CANARY_SIZE, '--canary-size');
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
  const adaptivePlanPath = path.resolve(options['adaptive-plan-path'] || path.join(path.dirname(statePath), 'adaptive-plan.json'));
  const retrievalPlanPath = path.resolve(options['retrieval-plan-path'] || path.join(path.dirname(statePath), 'retrieval-plan.json'));
  const verificationReportPath = path.resolve(options['verification-report-path'] || path.join(path.dirname(statePath), 'verification-report.json'));
  const verificationPlanPath = options['verification-plan'] ? path.resolve(options['verification-plan']) : null;
  const autoVerify = toBoolean(options['auto-verify'], false);
  const verificationRequired = toBoolean(options['verification-required'], false);
  const verificationTotalBudgetMs = toPositiveInt(
    options['verification-total-budget-ms'],
    600000,
    '--verification-total-budget-ms'
  );
  const verificationMaxOutputBytes = toPositiveInt(
    options['verification-max-output-bytes'],
    DEFAULT_MAX_OUTPUT_BYTES,
    '--verification-max-output-bytes'
  );
  const evidenceCacheEnabled = toBoolean(options['evidence-cache'], true);
  const evidenceCacheDir = evidenceCacheEnabled
    ? path.resolve(options['evidence-cache-dir'] || path.join(path.dirname(statePath), 'evidence-cache'))
    : null;
  const evidenceCacheOptions = {
    maxEntries: toPositiveInt(options['cache-max-entries'], 10000, '--cache-max-entries'),
    maxBytes: toPositiveInt(options['cache-max-bytes'], 268435456, '--cache-max-bytes'),
    maxAgeDays: toPositiveInt(options['cache-max-age-days'], 30, '--cache-max-age-days')
  };

  if (!resumeRunId && (fs.existsSync(statePath) || fs.existsSync(identityPath))) {
    throw new Error(`State already exists; use --resume with its run ID or choose a new --run-id: ${statePath}`);
  }
  if (resumeRunId && (!fs.existsSync(statePath) || !fs.existsSync(identityPath))) {
    throw new Error(`Cannot resume run ${resumeRunId}: state or identity is missing`);
  }

  const repositoryIdentity = getRepositoryIdentity();
  const requestedFiles = readJson(filesJsonPath);
  if (!Array.isArray(requestedFiles)) {
    throw new Error('--files-json must contain an array');
  }
  const normalizedInputFiles = normalizeRunFiles(
    requestedFiles,
    repositoryIdentity.repositoryRoot,
    { allowMissing: true }
  );
  const normalizedFilesJsonPath = path.resolve(
    path.dirname(statePath),
    'scope-files.json'
  );
  writeJson(normalizedFilesJsonPath, normalizedInputFiles);

  const adaptiveRequestHash = semanticArtifactHash({
    requestedProfile: options['adaptive-profile'] || 'balanced',
    securityReview: toBoolean(options['security-review'], false),
    triageInputHash: semanticInputFileHash(options['triage-path']),
    benchmarkReportHash: semanticInputFileHash(options['benchmark-report'])
  });
  const triageInput = options['triage-path']
    ? readJson(path.resolve(options['triage-path']))
    : inferredTriage(normalizedInputFiles);
  const benchmarkReport = options['benchmark-report']
    ? readJson(path.resolve(options['benchmark-report']))
    : null;
  const adaptivePlanCandidate = buildAdaptivePolicy({
    triage: triageInput,
    benchmarkReport,
    requestedProfile: options['adaptive-profile'] || 'balanced',
    securityReview: toBoolean(options['security-review'], false)
  });
  validateGeneratedArtifact('adaptive-plan', adaptivePlanCandidate, 'adaptive plan');
  const adaptivePlan = writeOrValidateStablePlan({
    planPath: adaptivePlanPath,
    plan: adaptivePlanCandidate,
    resumeRunId,
    label: 'Adaptive plan'
  });
  validateGeneratedArtifact('adaptive-plan', adaptivePlan, 'adaptive plan');
  const adaptivePlanHash = semanticArtifactHash(adaptivePlan);
  const chunkSize = requestedChunkSize || adaptivePlan.budgetPolicy.maxFilesPerChunk;
  const maxSourceTokens = requestedMaxSourceTokens || adaptivePlan.budgetPolicy.maxSourceTokens;
  const confidenceThreshold = requestedConfidenceThreshold || adaptivePlan.budgetPolicy.confidenceThreshold;
  const deltaHops = requestedDeltaHops === null ? adaptivePlan.budgetPolicy.deltaHops : requestedDeltaHops;
  const expansionCap = requestedExpansionCap || adaptivePlan.budgetPolicy.expansionCap;
  const tokenBudgetEnforced = options['enforce-token-budget'] === undefined
    ? requestedChunkSize === null
    : toBoolean(options['enforce-token-budget'], true);
  const resolvedOptions = {
    ...options,
    'delta-hops': String(deltaHops)
  };

  const scope = prepareIndexAndScope({
    options: resolvedOptions,
    skillDir,
    statePath,
    filesJsonPath: normalizedFilesJsonPath,
    journalPath
  });
  const activeFilesRaw = readJson(scope.activeFilesJsonPath);
  if (!Array.isArray(activeFilesRaw)) {
    throw new Error('Active files JSON must contain an array');
  }
  const activeFiles = normalizeRunFiles(
    activeFilesRaw,
    repositoryIdentity.repositoryRoot,
    { allowMissing: true }
  );
  writeJson(scope.activeFilesJsonPath, activeFiles);

  const indexForRetrieval = loadIndex(scope.indexPath) || {
    root: repositoryIdentity.repositoryRoot,
    files: Object.fromEntries(activeFiles.map((filePath) => {
      let estimatedTokens = 1;
      try {
        estimatedTokens = Math.max(1, Math.ceil(fs.statSync(filePath).size / 4));
      } catch {
        estimatedTokens = 1;
      }
      return [filePath, {
        relativePath: path.relative(repositoryIdentity.repositoryRoot, filePath),
        riskHint: 'medium',
        dependencies: [],
        symbols: [],
        estimatedTokens
      }];
    }))
  };
  const requestedRetrievalMaxTokens = options['retrieval-max-tokens'] === undefined
    ? null
    : toPositiveInt(options['retrieval-max-tokens'], maxSourceTokens, '--retrieval-max-tokens');
  const requestedRetrievalMaxFiles = options['retrieval-max-files'] === undefined
    ? null
    : toPositiveInt(options['retrieval-max-files'], chunkSize, '--retrieval-max-files');
  const retrievalRequestHash = semanticArtifactHash({
    hypothesesInputHash: semanticInputFileHash(options['hypotheses-json']),
    requestedMaxTokens: requestedRetrievalMaxTokens,
    requestedMaxFiles: requestedRetrievalMaxFiles,
    useIndex: toBoolean(options['use-index'], false)
  });
  const hypotheses = options['hypotheses-json']
    ? readJson(path.resolve(options['hypotheses-json']))
    : activeFiles.slice(0, Math.min(5, activeFiles.length)).map((filePath, index) => ({
      id: `SCOPE-${index + 1}`,
      file: filePath,
      claim: 'Prioritize the assigned source boundary for behavioral and security analysis.',
      keywords: [path.basename(filePath)]
    }));
  const retrievalPlanCandidate = buildRetrievalPlan({
    index: indexForRetrieval,
    hypotheses,
    maxTokens: requestedRetrievalMaxTokens || maxSourceTokens,
    maxFiles: requestedRetrievalMaxFiles || chunkSize,
    dependencyHops: Math.max(1, deltaHops)
  });
  validateGeneratedArtifact('retrieval-plan', retrievalPlanCandidate, 'retrieval plan');
  const retrievalPlan = writeOrValidateStablePlan({
    planPath: retrievalPlanPath,
    plan: retrievalPlanCandidate,
    resumeRunId,
    label: 'Retrieval plan'
  });
  validateGeneratedArtifact('retrieval-plan', retrievalPlan, 'retrieval plan');
  const retrievalPlanHash = semanticArtifactHash(retrievalPlan);
  const verificationPlan = verificationPlanPath
    ? readJson(verificationPlanPath)
    : autoVerify ? detectVerificationPlan(repositoryIdentity.repositoryRoot) : null;
  if (verificationRequired && (!verificationPlan || !Array.isArray(verificationPlan.checks) || verificationPlan.checks.length === 0)) {
    throw new Error('Verification is required, but no executable verification checks were supplied or detected');
  }
  const verificationPlanHash = verificationPlan ? semanticArtifactHash(verificationPlan) : null;

  const runIdentity = buildRunIdentity({
    runId,
    mode,
    backend,
    filesJsonPath: scope.activeFilesJsonPath,
    chunkSize,
    maxSourceTokens,
    tokenBudgetEnforced,
    timeoutMs,
    maxRetries,
    confidenceThreshold,
    deltaMode: scope.deltaMode,
    deltaHops: scope.deltaHops,
    adaptivePlanHash,
    retrievalPlanHash,
    adaptiveRequestHash,
    retrievalRequestHash,
    verificationPlanHash,
    evidenceCacheProtocol: evidenceCacheDir ? 'world-class-v1' : null
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
    runJsonScript(stateScript, [
      'init',
      statePath,
      mode,
      scope.activeFilesJsonPath,
      String(chunkSize),
      String(maxSourceTokens),
      String(tokenBudgetEnforced)
    ]);
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
    chunkSize,
    maxSourceTokens,
    tokenBudgetEnforced,
    timeoutMs,
    maxRetries,
    backoffMs,
    adaptiveProfile: adaptivePlan.profile,
    adaptivePlanPath,
    retrievalPlanPath,
    verificationRequired,
    evidenceCacheEnabled
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
    confidenceThreshold,
    evidenceCacheDir,
    evidenceCacheOptions,
    adaptivePlanPath,
    retrievalPlanPath
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
      const expandedFiles = toArray(expansion.prioritized).length > 0
        ? toArray(expansion.prioritized)
        : [
          ...toArray(expansion.overlayOnly),
          ...toArray(expansion.expanded)
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
            confidenceThreshold,
            evidenceCacheDir,
            evidenceCacheOptions,
            adaptivePlanPath,
            retrievalPlanPath
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

  let verificationReport = null;
  if (!hasOpenOrFailedChunks && verificationPlan) {
    verificationReport = runVerificationPlan({
      repoRoot: repositoryIdentity.repositoryRoot,
      plan: verificationPlan,
      totalBudgetMs: verificationTotalBudgetMs,
      maxOutputBytes: verificationMaxOutputBytes
    });
    validateGeneratedArtifact('verification-report', verificationReport, 'verification report');
    writeJson(verificationReportPath, verificationReport);
    appendJournal(journalPath, {
      event: 'hybrid-verification',
      ok: verificationReport.ok,
      summary: verificationReport.summary
    });
  }
  const verificationFailed = Boolean(verificationReport && verificationRequired && !verificationReport.ok);

  if (hasOpenOrFailedChunks || verificationFailed) {
    appendJournal(journalPath, {
      event: 'fix-planning-skipped',
      reason: verificationFailed ? 'required-verification-failed' : 'incomplete-or-failed-chunks',
      chunkStatus: status.summary.chunkStatus,
      verification: verificationReport ? verificationReport.summary : null
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
      adaptivePlanPath,
      retrievalPlanPath,
      verificationReportPath: verificationReport ? verificationReportPath : null,
      evidenceCacheDir,
      adaptiveProfile: adaptivePlan.profile,
      verification: verificationReport ? verificationReport.summary : null,
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
      adaptivePlanPath,
      retrievalPlanPath,
      verificationReportPath: verificationReport ? verificationReportPath : null,
      evidenceCacheDir,
      adaptiveProfile: adaptivePlan.profile,
      verification: verificationReport ? verificationReport.summary : null,
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
    canary: fixPlan.totals.canary,
    adaptiveProfile: adaptivePlan.profile,
    verification: verificationReport ? verificationReport.summary : null
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
    adaptivePlanPath,
    retrievalPlanPath,
    verificationReportPath: verificationReport ? verificationReportPath : null,
    evidenceCacheDir,
    adaptiveProfile: adaptivePlan.profile,
    verification: verificationReport ? verificationReport.summary : null,
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
    const requestedChunkSize = options['chunk-size'] === undefined
      ? null
      : toPositiveInt(options['chunk-size'], DEFAULT_CHUNK_SIZE, '--chunk-size');
    const maxSourceTokens = toPositiveInt(
      options['max-source-tokens'],
      DEFAULT_SOURCE_TOKEN_BUDGET,
      '--max-source-tokens'
    );
    const planPath = path.resolve(options['plan-path'] || '.bug-hunter/plan.json');

    const files = readJson(filesJsonPath);
    if (!Array.isArray(files)) {
      throw new Error('--files-json must contain an array');
    }
    const maxFilesPerChunk = requestedChunkSize || DEFAULT_CHUNK_SIZE;
    const tokenBudgetEnforced = requestedChunkSize === null;
    const totalFiles = files.length;
    const plannedChunks = buildSourceChunks(files, {
      maxFiles: maxFilesPerChunk,
      maxSourceTokens,
      enforceTokenBudget: tokenBudgetEnforced
    });
    const chunks = plannedChunks.map((plannedChunk, index) => {
      return {
        id: `chunk-${index + 1}`,
        files: plannedChunk.files,
        fileCount: plannedChunk.files.length,
        estimatedSourceTokens: plannedChunk.estimatedSourceTokens,
        oversized: plannedChunk.oversized,
        status: 'pending'
      };
    });
    const chunkSize = chunks.reduce((max, chunk) => {
      return Math.max(max, chunk.fileCount);
    }, 0);

    const planOutput = {
      generatedAt: nowIso(),
      mode,
      skillDir,
      totalFiles,
      chunkSize,
      maxFilesPerChunk,
      maxSourceTokens,
      tokenBudgetEnforced,
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
