#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateArtifactValue } = require('./schema-runtime.cjs');

const VALID_CHUNK_STATUS = new Set(['pending', 'in_progress', 'done', 'failed']);
const VALID_FILE_STATUS = new Set(['pending', 'scanned', 'missing', 'unreadable', 'skipped', 'failed']);
const DEFAULT_CHUNK_SIZE = 30;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  // State is promoted only after the complete sibling file is durable.
  const directoryPath = path.dirname(filePath);
  const tempPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(tempPath, filePath);
    flushDirectory(directoryPath);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      fs.closeSync(fileDescriptor);
    }
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw error;
  }
}

function flushDirectory(directoryPath) {
  let directoryDescriptor;
  try {
    directoryDescriptor = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(directoryDescriptor);
  } catch (error) {
    if (!error || !['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (directoryDescriptor !== undefined) {
      fs.closeSync(directoryDescriptor);
    }
  }
}

function splitChunks(files, chunkSize) {
  const chunks = [];
  let index = 0;
  while (index < files.length) {
    const filesSlice = files.slice(index, index + chunkSize);
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      files: filesSlice,
      status: 'pending',
      retries: 0,
      startedAt: null,
      completedAt: null,
      lastError: null
    });
    index += chunkSize;
  }
  return chunks;
}

function nextChunkNumber(chunks) {
  const maxId = chunks.reduce((max, chunk) => {
    const match = /^chunk-(\d+)$/.exec(String(chunk.id || ''));
    if (!match) {
      return max;
    }
    const value = Number.parseInt(match[1], 10);
    if (!Number.isInteger(value)) {
      return max;
    }
    return Math.max(max, value);
  }, 0);
  return maxId + 1;
}

function buildInitialState({ mode, chunkSize, files }) {
  const normalizedFiles = [...new Set(files)].sort();
  const initializedAt = nowIso();
  return {
    schemaVersion: 3,
    generation: 0,
    mode,
    createdAt: initializedAt,
    updatedAt: initializedAt,
    chunkSize,
    runtime: {
      parallelDisabled: false
    },
    metrics: {
      filesTotal: normalizedFiles.length,
      filesScanned: 0,
      chunksTotal: Math.ceil(normalizedFiles.length / chunkSize),
      chunksDone: 0,
      findingsTotal: 0,
      findingsUnique: 0,
      lowConfidenceFindings: 0
    },
    chunks: splitChunks(normalizedFiles, chunkSize),
    fileStates: Object.fromEntries(normalizedFiles.map((filePath) => {
      return [filePath, {
        status: 'pending',
        updatedAt: initializedAt
      }];
    })),
    bugLedger: [],
    hashCache: {},
    factCards: {},
    consistency: {
      checkedAt: null,
      conflicts: []
    },
    fixPlan: null
  };
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) {
    throw new Error(`State file does not exist: ${statePath}`);
  }
  let state;
  try {
    state = readJson(statePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`State file is malformed JSON and was left unchanged: ${statePath}: ${message}`);
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`State file must contain an object and was left unchanged: ${statePath}`);
  }
  normalizeFileStates(state);
  return state;
}

function saveState(statePath, state) {
  state.updatedAt = nowIso();
  state.schemaVersion = 3;
  state.generation = Number.isInteger(state.generation) && state.generation >= 0
    ? state.generation + 1
    : 1;
  writeJson(statePath, state);
}

function normalizeFileStates(state) {
  if (!state.fileStates || typeof state.fileStates !== 'object' || Array.isArray(state.fileStates)) {
    const filePaths = Array.isArray(state.chunks)
      ? [...new Set(state.chunks.flatMap((chunk) => {
        return Array.isArray(chunk.files) ? chunk.files.map((filePath) => String(filePath)) : [];
      }))]
      : [];
    state.fileStates = Object.fromEntries(filePaths.map((filePath) => {
      const cached = state.hashCache && state.hashCache[filePath];
      return [filePath, {
        status: cached && cached.status === 'scanned' ? 'scanned' : 'pending',
        updatedAt: cached && cached.scannedAt ? cached.scannedAt : state.updatedAt || state.createdAt || nowIso()
      }];
    }));
  }
  updateFileMetrics(state);
}

function setFileStatus({ state, filePath, status, hash }) {
  if (!VALID_FILE_STATUS.has(status)) {
    throw new Error(`Invalid file status: ${status}`);
  }
  const nextState = {
    status,
    updatedAt: nowIso()
  };
  if (hash) {
    nextState.hash = hash;
  }
  state.fileStates[filePath] = nextState;
}

function updateFileMetrics(state) {
  if (!state.metrics || typeof state.metrics !== 'object') {
    state.metrics = {};
  }
  // Chunk completion is not scan evidence; only hash-update records a scan.
  state.metrics.filesScanned = Object.values(state.fileStates || {}).filter((fileState) => {
    return fileState && fileState.status === 'scanned';
  }).length;
}

function hashFile(filePath) {
  const stat = fs.statSync(filePath);
  const maxHashBytes = 10 * 1024 * 1024;
  if (stat.size > maxHashBytes) {
    return `size-${stat.size}-mtime-${stat.mtimeMs}`;
  }
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function summarize(state) {
  const pending = state.chunks.filter((chunk) => chunk.status === 'pending').length;
  const inProgress = state.chunks.filter((chunk) => chunk.status === 'in_progress').length;
  const done = state.chunks.filter((chunk) => chunk.status === 'done').length;
  const failed = state.chunks.filter((chunk) => chunk.status === 'failed').length;
  return {
    schemaVersion: state.schemaVersion,
    mode: state.mode,
    updatedAt: state.updatedAt,
    runtime: state.runtime,
    metrics: state.metrics,
    chunkStatus: {
      pending,
      inProgress,
      done,
      failed
    }
  };
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

function usage() {
  console.error('Usage:');
  console.error('  bug-hunter-state.cjs init <statePath> <mode> <filesJsonPath> [chunkSize]');
  console.error('  bug-hunter-state.cjs status <statePath>');
  console.error('  bug-hunter-state.cjs next-chunk <statePath>');
  console.error('  bug-hunter-state.cjs mark-chunk <statePath> <chunkId> <pending|in_progress|done|failed> [error]');
  console.error('  bug-hunter-state.cjs record-findings <statePath> <findingsJsonPath> [source] [confidenceThreshold]');
  console.error('  bug-hunter-state.cjs hash-filter <statePath> <filesJsonPath>');
  console.error('  bug-hunter-state.cjs hash-update <statePath> <filesJsonPath> [status]');
  console.error('  bug-hunter-state.cjs append-files <statePath> <filesJsonPath>');
  console.error('  bug-hunter-state.cjs record-fact-card <statePath> <chunkId> <factCardJsonPath>');
  console.error('  bug-hunter-state.cjs set-consistency <statePath> <consistencyJsonPath>');
  console.error('  bug-hunter-state.cjs set-fix-plan <statePath> <fixPlanJsonPath>');
  console.error('  bug-hunter-state.cjs set-parallel-disabled <statePath> <true|false>');
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

function toConfidenceScore(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    usage();
    process.exit(1);
  }

  if (command === 'init') {
    const [statePath, mode, filesJsonPath, chunkSizeRaw] = args;
    if (!statePath || !mode || !filesJsonPath) {
      usage();
      process.exit(1);
    }
    const files = readJson(filesJsonPath);
    assertArray(files, 'filesJson');
    const chunkSizeParsed = Number.parseInt(chunkSizeRaw || '', 10);
    const chunkSize = Number.isInteger(chunkSizeParsed) && chunkSizeParsed > 0
      ? chunkSizeParsed
      : DEFAULT_CHUNK_SIZE;
    if (fs.existsSync(statePath)) {
      readState(statePath);
    }
    const state = buildInitialState({ mode, chunkSize, files });
    saveState(statePath, state);
    console.log(JSON.stringify({
      ok: true,
      statePath,
      summary: summarize(state)
    }, null, 2));
    return;
  }

  if (command === 'status') {
    const [statePath] = args;
    const state = readState(statePath);
    console.log(JSON.stringify({
      ok: true,
      statePath,
      summary: summarize(state)
    }, null, 2));
    return;
  }

  if (command === 'next-chunk') {
    const [statePath] = args;
    const state = readState(statePath);
    const nextChunk = state.chunks.find((chunk) => chunk.status === 'pending');
    if (!nextChunk) {
      console.log(JSON.stringify({ ok: true, done: true }, null, 2));
      return;
    }
    console.log(JSON.stringify({ ok: true, done: false, chunk: nextChunk }, null, 2));
    return;
  }

  if (command === 'mark-chunk') {
    const [statePath, chunkId, status, errorMessage] = args;
    if (!statePath || !chunkId || !status) {
      usage();
      process.exit(1);
    }
    if (!VALID_CHUNK_STATUS.has(status)) {
      throw new Error(`Invalid chunk status: ${status}`);
    }
    const state = readState(statePath);
    const chunk = state.chunks.find((entry) => entry.id === chunkId);
    if (!chunk) {
      throw new Error(`Unknown chunk id: ${chunkId}`);
    }
    chunk.status = status;
    if (status === 'in_progress') {
      chunk.startedAt = nowIso();
      chunk.retries += 1;
      chunk.lastError = null;
    } else if (status === 'done') {
      chunk.completedAt = nowIso();
      chunk.lastError = null;
    } else if (status === 'failed') {
      chunk.lastError = errorMessage || 'unknown';
      const failedAt = nowIso();
      const failedFileStates = Object.fromEntries(chunk.files
        .filter((filePath) => {
          const fileState = state.fileStates[String(filePath)];
          return !fileState || fileState.status === 'pending';
        })
        .map((filePath) => {
          return [String(filePath), {
            status: 'failed',
            updatedAt: failedAt
          }];
        }));
      Object.assign(state.fileStates, failedFileStates);
    }
    state.metrics.chunksDone = state.chunks.filter((entry) => entry.status === 'done').length;
    updateFileMetrics(state);
    saveState(statePath, state);
    console.log(JSON.stringify({ ok: true, chunk }, null, 2));
    return;
  }

  if (command === 'record-findings') {
    const [statePath, findingsJsonPath, source = 'unknown', confidenceThresholdRaw] = args;
    if (!statePath || !findingsJsonPath) {
      usage();
      process.exit(1);
    }
    const confidenceThreshold = Number.isInteger(Number.parseInt(String(confidenceThresholdRaw || ''), 10))
      ? Number.parseInt(confidenceThresholdRaw, 10)
      : 75;
    const state = readState(statePath);
    const findings = readJson(findingsJsonPath);
    const validation = validateArtifactValue({
      artifactName: 'findings',
      value: findings
    });
    if (!validation.ok) {
      throw new Error(`Invalid findings artifact: ${validation.errors.join('; ')}`);
    }

    let inserted = 0;
    let updated = 0;
    for (const finding of findings) {
      const file = String(finding.file || '').trim();
      const lines = String(finding.lines || '').trim();
      const claim = String(finding.claim || '').trim();
      const severity = String(finding.severity || 'Low');
      const category = String(finding.category || '').trim();
      const evidence = String(finding.evidence || '').trim();
      const runtimeTrigger = String(finding.runtimeTrigger || '').trim();
      const crossReferences = Array.isArray(finding.crossReferences) ? finding.crossReferences : [];
      const confidenceScore = toConfidenceScore(finding.confidenceScore);
      const bugId = String(finding.bugId || '').trim();
      const key = `${file}|${lines}|${claim}`;
      const existing = state.bugLedger.find((entry) => entry.key === key);
      if (!existing) {
        state.bugLedger.push({
          key,
          bugId,
          severity,
          file,
          lines,
          category,
          claim,
          evidence,
          runtimeTrigger,
          crossReferences,
          confidenceScore,
          status: 'open',
          source,
          updatedAt: nowIso()
        });
        inserted += 1;
        continue;
      }
      const existingRank = severityRank(existing.severity);
      const incomingRank = severityRank(severity);
      if (incomingRank > existingRank) {
        existing.severity = severity;
      }
      if (!existing.bugId && bugId) {
        existing.bugId = bugId;
      }
      existing.category = category || existing.category;
      existing.evidence = evidence || existing.evidence;
      existing.runtimeTrigger = runtimeTrigger || existing.runtimeTrigger;
      existing.crossReferences = crossReferences.length > 0 ? crossReferences : existing.crossReferences;
      if (existing.confidenceScore === null && confidenceScore !== null) {
        existing.confidenceScore = confidenceScore;
      } else if (existing.confidenceScore !== null && confidenceScore !== null) {
        existing.confidenceScore = Math.max(existing.confidenceScore, confidenceScore);
      }
      existing.updatedAt = nowIso();
      existing.source = source;
      updated += 1;
    }

    state.metrics.findingsTotal += findings.length;
    state.metrics.findingsUnique = state.bugLedger.length;
    state.metrics.lowConfidenceFindings = state.bugLedger.filter((entry) => {
      return entry.confidenceScore === null || entry.confidenceScore < confidenceThreshold;
    }).length;
    saveState(statePath, state);
    console.log(JSON.stringify({
      ok: true,
      inserted,
      updated,
      metrics: state.metrics
    }, null, 2));
    return;
  }

  if (command === 'hash-filter') {
    const [statePath, filesJsonPath] = args;
    if (!statePath || !filesJsonPath) {
      usage();
      process.exit(1);
    }
    const state = readState(statePath);
    const files = readJson(filesJsonPath);
    assertArray(files, 'filesJson');

    const scan = [];
    const skip = [];
    const missing = [];

    for (const filePath of files) {
      const normalized = String(filePath);
      if (!fs.existsSync(normalized)) {
        missing.push(normalized);
        setFileStatus({
          state,
          filePath: normalized,
          status: 'missing'
        });
        continue;
      }
      const currentHash = hashFile(normalized);
      const previous = state.hashCache[normalized];
      if (previous && previous.hash === currentHash) {
        skip.push(normalized);
        setFileStatus({
          state,
          filePath: normalized,
          status: 'skipped',
          hash: currentHash
        });
      } else {
        scan.push(normalized);
        setFileStatus({
          state,
          filePath: normalized,
          status: 'pending',
          hash: currentHash
        });
      }
    }

    updateFileMetrics(state);
    saveState(statePath, state);
    console.log(JSON.stringify({ ok: true, scan, skip, missing }, null, 2));
    return;
  }

  if (command === 'hash-update') {
    const [statePath, filesJsonPath, cacheStatus = 'scanned'] = args;
    if (!statePath || !filesJsonPath) {
      usage();
      process.exit(1);
    }
    const state = readState(statePath);
    const files = readJson(filesJsonPath);
    assertArray(files, 'filesJson');
    if (!VALID_FILE_STATUS.has(cacheStatus)) {
      throw new Error(`Invalid hash cache status: ${cacheStatus}`);
    }
    const updatedFiles = [];
    const missing = [];

    for (const filePath of files) {
      const normalized = String(filePath);
      if (!fs.existsSync(normalized)) {
        missing.push(normalized);
        setFileStatus({
          state,
          filePath: normalized,
          status: 'missing'
        });
        continue;
      }
      const currentHash = hashFile(normalized);
      state.hashCache[normalized] = {
        hash: currentHash,
        status: cacheStatus,
        scannedAt: nowIso()
      };
      setFileStatus({
        state,
        filePath: normalized,
        status: cacheStatus,
        hash: currentHash
      });
      updatedFiles.push(normalized);
    }

    updateFileMetrics(state);
    saveState(statePath, state);
    console.log(JSON.stringify({
      ok: true,
      updated: updatedFiles.length,
      missing,
      updatedFiles
    }, null, 2));
    return;
  }

  if (command === 'append-files') {
    const [statePath, filesJsonPath] = args;
    if (!statePath || !filesJsonPath) {
      usage();
      process.exit(1);
    }
    const state = readState(statePath);
    const files = readJson(filesJsonPath);
    assertArray(files, 'filesJson');
    const existing = new Set(state.chunks.flatMap((chunk) => chunk.files));
    const toAppend = [...new Set(files.map((filePath) => String(filePath)))]
      .filter((filePath) => !existing.has(filePath))
      .sort();
    if (toAppend.length === 0) {
      console.log(JSON.stringify({ ok: true, appended: 0, chunksAdded: 0 }, null, 2));
      return;
    }

    const chunkNumberStart = nextChunkNumber(state.chunks);
    const newChunks = splitChunks(toAppend, state.chunkSize)
      .map((chunk, index) => {
        return {
          ...chunk,
          id: `chunk-${chunkNumberStart + index}`
        };
      });
    state.chunks.push(...newChunks);
    const appendedAt = nowIso();
    Object.assign(state.fileStates, Object.fromEntries(toAppend.map((filePath) => {
      return [filePath, {
        status: 'pending',
        updatedAt: appendedAt
      }];
    })));
    state.metrics.filesTotal += toAppend.length;
    state.metrics.chunksTotal = state.chunks.length;
    saveState(statePath, state);
    console.log(JSON.stringify({
      ok: true,
      appended: toAppend.length,
      chunksAdded: newChunks.length,
      summary: summarize(state)
    }, null, 2));
    return;
  }

  if (command === 'record-fact-card') {
    const [statePath, chunkId, factCardJsonPath] = args;
    if (!statePath || !chunkId || !factCardJsonPath) {
      usage();
      process.exit(1);
    }
    const state = readState(statePath);
    const factCard = readJson(factCardJsonPath);
    if (!state.factCards || typeof state.factCards !== 'object') {
      state.factCards = {};
    }
    state.factCards[chunkId] = {
      chunkId,
      updatedAt: nowIso(),
      apiContracts: Array.isArray(factCard.apiContracts) ? factCard.apiContracts : [],
      authAssumptions: Array.isArray(factCard.authAssumptions) ? factCard.authAssumptions : [],
      invariants: Array.isArray(factCard.invariants) ? factCard.invariants : []
    };
    saveState(statePath, state);
    console.log(JSON.stringify({
      ok: true,
      chunkId,
      factCards: Object.keys(state.factCards).length
    }, null, 2));
    return;
  }

  if (command === 'set-consistency') {
    const [statePath, consistencyJsonPath] = args;
    if (!statePath || !consistencyJsonPath) {
      usage();
      process.exit(1);
    }
    const state = readState(statePath);
    const consistency = readJson(consistencyJsonPath);
    state.consistency = consistency;
    saveState(statePath, state);
    console.log(JSON.stringify({
      ok: true,
      consistency
    }, null, 2));
    return;
  }

  if (command === 'set-fix-plan') {
    const [statePath, fixPlanJsonPath] = args;
    if (!statePath || !fixPlanJsonPath) {
      usage();
      process.exit(1);
    }
    const state = readState(statePath);
    const fixPlan = readJson(fixPlanJsonPath);
    const validation = validateArtifactValue({
      artifactName: 'fix-plan',
      value: fixPlan
    });
    if (!validation.ok) {
      throw new Error(`Invalid fix-plan artifact: ${validation.errors.join('; ')}`);
    }
    state.fixPlan = fixPlan;
    saveState(statePath, state);
    console.log(JSON.stringify({
      ok: true,
      fixPlan
    }, null, 2));
    return;
  }

  if (command === 'set-parallel-disabled') {
    const [statePath, boolValue] = args;
    if (!statePath || !boolValue) {
      usage();
      process.exit(1);
    }
    const state = readState(statePath);
    const normalized = String(boolValue).toLowerCase();
    if (normalized !== 'true' && normalized !== 'false') {
      throw new Error('set-parallel-disabled expects true or false');
    }
    state.runtime.parallelDisabled = normalized === 'true';
    saveState(statePath, state);
    console.log(JSON.stringify({
      ok: true,
      runtime: state.runtime
    }, null, 2));
    return;
  }

  usage();
  process.exit(1);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
