const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_MAX_OUTPUT_BYTES,
  runJsonScript
} = require('./process-runner.cjs');

const DEFAULT_TIMEOUT_MS = 120000;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
    throw error;
  }
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) {
    throw new Error('Run scope must be an array of file paths');
  }
  return [...new Set(files.map((filePath) => path.resolve(String(filePath))))].sort();
}

function gitIdentity() {
  const result = childProcess.spawnSync('git', ['rev-parse', '--show-toplevel', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
    timeout: DEFAULT_TIMEOUT_MS
  });
  if (result.error || result.status !== 0) {
    const message = result.error
      ? result.error.message
      : String(result.stderr || result.stdout || 'git identity lookup failed').trim();
    throw new Error(`Cannot establish repository identity: ${message}`);
  }
  const [repositoryRoot, baseCommit] = String(result.stdout || '').trim().split(/\r?\n/);
  if (!repositoryRoot || !baseCommit) {
    throw new Error('Cannot establish repository identity: incomplete git output');
  }
  return {
    repositoryRoot: fs.realpathSync(repositoryRoot),
    baseCommit
  };
}

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildRunIdentity({
  runId,
  mode,
  backend,
  filesJsonPath,
  chunkSize,
  timeoutMs,
  maxRetries,
  confidenceThreshold,
  deltaMode,
  deltaHops
}) {
  const files = normalizeFiles(readJson(filesJsonPath));
  const repository = gitIdentity();
  return {
    schemaVersion: 1,
    runId,
    repositoryRoot: repository.repositoryRoot,
    baseCommit: repository.baseCommit,
    mode,
    backend,
    scopeHash: hashValue(files),
    optionsHash: hashValue({
      chunkSize,
      confidenceThreshold,
      deltaHops,
      deltaMode,
      maxRetries,
      timeoutMs
    })
  };
}

function assertRunIdentity({ expected, actual, identityPath }) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    throw new Error(`Run identity is malformed: ${identityPath}`);
  }
  const fields = [
    'schemaVersion',
    'runId',
    'repositoryRoot',
    'baseCommit',
    'mode',
    'backend',
    'scopeHash',
    'optionsHash'
  ];
  const differences = fields
    .filter((field) => actual[field] !== expected[field])
    .map((field) => {
      return `${field}: stored=${JSON.stringify(actual[field])}, current=${JSON.stringify(expected[field])}`;
    });
  if (differences.length > 0) {
    throw new Error(`Resume fingerprint mismatch for ${identityPath}: ${differences.join('; ')}`);
  }
}

function validateStateShape({ statePath, state }) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`State file must contain an object: ${statePath}`);
  }
  if (!Number.isInteger(state.schemaVersion) || !Array.isArray(state.chunks) || !Array.isArray(state.bugLedger)) {
    throw new Error(`State file does not match the required runtime shape: ${statePath}`);
  }
}

function requeueResumableChunks({ statePath, stateScript, maxRetries }) {
  const state = readJson(statePath);
  validateStateShape({ statePath, state });
  const resumable = state.chunks.filter((chunk) => {
    if (chunk.status === 'in_progress') {
      return true;
    }
    return chunk.status === 'failed' && Number(chunk.retries || 0) <= maxRetries;
  });
  resumable.map((chunk) => {
    return runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'pending']);
  });
  return resumable.map((chunk) => chunk.id);
}

module.exports = {
  assertRunIdentity,
  buildRunIdentity,
  requeueResumableChunks,
  validateStateShape,
  writeJsonAtomic
};
