#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { validateArtifactValue } = require('./schema-runtime.cjs');
const { isDeadLocalPid, reclaimDeadLinkLock } = require('./link-lock.cjs');
const {
  DEFAULT_SOURCE_TOKEN_BUDGET,
  MAX_FILES_PER_CHUNK,
  buildSourceChunks
} = require('./source-config.cjs');

const VALID_CHUNK_STATUS = new Set(['pending', 'in_progress', 'done', 'failed']);
const VALID_FILE_STATUS = new Set(['pending', 'scanned', 'missing', 'unreadable', 'skipped', 'failed']);
const DEFAULT_CHUNK_SIZE = MAX_FILES_PER_CHUNK;

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

function splitChunks(files, chunkSize, maxSourceTokens, enforceTokenBudget) {
  return buildSourceChunks(files, {
    maxFiles: chunkSize,
    maxSourceTokens,
    enforceTokenBudget
  }).map((plannedChunk, index) => {
    return {
      id: `chunk-${index + 1}`,
      files: plannedChunk.files,
      estimatedSourceTokens: plannedChunk.estimatedSourceTokens,
      oversized: plannedChunk.oversized,
      status: 'pending',
      retries: 0,
      startedAt: null,
      completedAt: null,
      lastError: null
    };
  });
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

function buildInitialState({
  mode,
  chunkSize,
  maxSourceTokens,
  enforceTokenBudget,
  files,
  sourceHashes = {}
}) {
  const normalizedFiles = [...new Set(files.map((filePath) => String(filePath)))];
  const initializedAt = nowIso();
  const chunks = splitChunks(
    normalizedFiles,
    chunkSize,
    maxSourceTokens,
    enforceTokenBudget
  );
  return {
    schemaVersion: 3,
    generation: 0,
    mode,
    createdAt: initializedAt,
    updatedAt: initializedAt,
    chunkSize,
    maxSourceTokens,
    enforceTokenBudget,
    runtime: {
      parallelDisabled: false
    },
    metrics: {
      filesTotal: normalizedFiles.length,
      filesScanned: 0,
      chunksTotal: chunks.length,
      chunksDone: 0,
      findingsTotal: 0,
      findingsUnique: 0,
      lowConfidenceFindings: 0
    },
    chunks,
    fileStates: Object.fromEntries(normalizedFiles.map((filePath) => {
      return [filePath, captureBaseline(filePath, initializedAt, sourceHashes[filePath])];
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
  if (!Number.isInteger(state.maxSourceTokens) || state.maxSourceTokens <= 0) {
    state.maxSourceTokens = DEFAULT_SOURCE_TOKEN_BUDGET;
  }
  if (typeof state.enforceTokenBudget !== 'boolean') {
    state.enforceTokenBudget = false;
  }
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

function setFileStatus({
  state,
  filePath,
  status,
  hash,
  initialHash,
  observedHash,
  clearObservedHash = false
}) {
  if (!VALID_FILE_STATUS.has(status)) {
    throw new Error(`Invalid file status: ${status}`);
  }
  const previous = state.fileStates[filePath]
    && typeof state.fileStates[filePath] === 'object'
    && !Array.isArray(state.fileStates[filePath])
    ? state.fileStates[filePath]
    : {};
  const nextState = {
    ...previous,
    status,
    updatedAt: nowIso()
  };
  if (hash) {
    nextState.hash = hash;
  }
  if (initialHash) {
    nextState.initialHash = initialHash;
  }
  if (observedHash) {
    nextState.observedHash = observedHash;
  }
  if (clearObservedHash) {
    delete nextState.observedHash;
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
  const hash = crypto.createHash('sha256');
  const fileDescriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, null);
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function captureBaseline(filePath, initializedAt, indexedHash) {
  try {
    return {
      status: 'pending',
      initialHash: indexedHash || hashFile(filePath),
      updatedAt: initializedAt
    };
  } catch (error) {
    return {
      status: error.code === 'ENOENT' ? 'missing' : 'unreadable',
      baselineUnavailable: true,
      updatedAt: initializedAt
    };
  }
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
  console.error('  bug-hunter-state.cjs init <statePath> <mode> <filesJsonPath> [chunkSize] [maxSourceTokens] [enforceTokenBudget]');
  console.error('  bug-hunter-state.cjs status <statePath>');
  console.error('  bug-hunter-state.cjs next-chunk <statePath>');
  console.error('  bug-hunter-state.cjs mark-chunk <statePath> <chunkId> <pending|in_progress|done|failed> [error]');
  console.error('  bug-hunter-state.cjs record-findings <statePath> <findingsJsonPath> [source] [confidenceThreshold]');
  console.error('  bug-hunter-state.cjs hash-filter <statePath> <filesJsonPath>');
  console.error('  bug-hunter-state.cjs hash-verify <statePath> <filesJsonPath>');
  console.error('  bug-hunter-state.cjs hash-update <statePath> <filesJsonPath> [status]');
  console.error('  bug-hunter-state.cjs commit-chunk <statePath> <chunkId> <filesJsonPath> <findingsJsonPath> <factCardJsonPath> [confidenceThreshold] [source]');
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

function uniqueBugId(state, requestedBugId, key) {
  const requested = String(requestedBugId || '').trim();
  const collision = state.bugLedger.find((entry) => {
    return entry.bugId === requested && entry.key !== key;
  });
  if (!collision) {
    return requested;
  }
  const suffix = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8).toUpperCase();
  let candidate = `${requested}-${suffix}`;
  let counter = 2;
  while (state.bugLedger.some((entry) => entry.bugId === candidate && entry.key !== key)) {
    candidate = `${requested}-${suffix}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function mergeFindingsIntoState({ state, findings, source, confidenceThreshold }) {
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
    const crossReferences = Array.isArray(finding.crossReferences)
      ? finding.crossReferences.map((entry) => String(entry)).filter(Boolean)
      : [];
    const confidenceScore = toConfidenceScore(finding.confidenceScore);
    const confidenceLabel = finding.confidenceLabel
      ? String(finding.confidenceLabel)
      : undefined;
    const requestedBugId = String(finding.bugId || '').trim();
    const key = `${file}|${lines}|${claim}`;
    const existing = state.bugLedger.find((entry) => entry.key === key);

    if (!existing) {
      const bugId = uniqueBugId(state, requestedBugId, key);
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
        ...(confidenceLabel ? { confidenceLabel } : {}),
        ...(finding.stride ? { stride: String(finding.stride) } : {}),
        ...(finding.cwe ? { cwe: String(finding.cwe) } : {}),
        status: 'open',
        source,
        updatedAt: nowIso()
      });
      inserted += 1;
      continue;
    }

    const existingRank = severityRank(existing.severity);
    const incomingRank = severityRank(severity);
    const existingConfidence = toConfidenceScore(existing.confidenceScore);
    const incomingStronger = confidenceScore !== null
      && (existingConfidence === null || confidenceScore > existingConfidence);

    if (incomingRank > existingRank) {
      existing.severity = severity;
    }
    if (existing.category !== 'security') {
      if (category === 'security' || incomingStronger) {
        existing.category = category || existing.category;
      }
    }
    if (incomingStronger) {
      existing.evidence = evidence || existing.evidence;
      existing.runtimeTrigger = runtimeTrigger || existing.runtimeTrigger;
      existing.confidenceScore = confidenceScore;
      if (confidenceLabel) {
        existing.confidenceLabel = confidenceLabel;
      }
    } else if (existingConfidence === null && confidenceScore !== null) {
      existing.confidenceScore = confidenceScore;
    }
    existing.crossReferences = [...new Set([
      ...(Array.isArray(existing.crossReferences) ? existing.crossReferences : []),
      ...crossReferences
    ])];
    if (category === 'security' || existing.category === 'security') {
      if ((!existing.stride || incomingStronger) && finding.stride) {
        existing.stride = String(finding.stride);
      }
      if ((!existing.cwe || incomingStronger) && finding.cwe) {
        existing.cwe = String(finding.cwe);
      }
    }
    existing.updatedAt = nowIso();
    existing.source = source;
    updated += 1;
  }

  state.metrics.findingsTotal += findings.length;
  state.metrics.findingsUnique = state.bugLedger.length;
  state.metrics.lowConfidenceFindings = state.bugLedger.filter((entry) => {
    return entry.confidenceScore === null
      || entry.confidenceScore === undefined
      || Number(entry.confidenceScore) < confidenceThreshold;
  }).length;
  return { inserted, updated };
}

function normalizedFactCard(chunkId, factCard) {
  return {
    chunkId,
    updatedAt: nowIso(),
    apiContracts: Array.isArray(factCard.apiContracts) ? factCard.apiContracts : [],
    authAssumptions: Array.isArray(factCard.authAssumptions) ? factCard.authAssumptions : [],
    invariants: Array.isArray(factCard.invariants) ? factCard.invariants : []
  };
}

function verifyPendingFiles({ state, files }) {
  const verified = [];
  const changed = [];
  const missing = [];
  const unreadable = [];
  const hashes = {};

  for (const filePath of files) {
    const normalized = String(filePath);
    if (!fs.existsSync(normalized)) {
      missing.push(normalized);
      setFileStatus({ state, filePath: normalized, status: 'missing' });
      continue;
    }
    try {
      const currentHash = hashFile(normalized);
      const fileState = state.fileStates[normalized] || {};
      const expectedHash = fileState.hash;
      const initialHash = fileState.initialHash || expectedHash;
      if (!expectedHash || expectedHash !== currentHash) {
        changed.push(normalized);
        setFileStatus({
          state,
          filePath: normalized,
          status: 'failed',
          hash: expectedHash || currentHash,
          initialHash: initialHash || currentHash,
          observedHash: currentHash
        });
        continue;
      }
      hashes[normalized] = currentHash;
      verified.push(normalized);
    } catch {
      unreadable.push(normalized);
      setFileStatus({ state, filePath: normalized, status: 'unreadable' });
    }
  }
  return { verified, changed, missing, unreadable, hashes };
}

function markChunkFailed(state, chunk, errorMessage) {
  chunk.status = 'failed';
  chunk.lastError = errorMessage || 'unknown';
  const failedAt = nowIso();
  for (const filePath of chunk.files) {
    const normalized = String(filePath);
    const fileState = state.fileStates[normalized];
    if (!fileState || fileState.status === 'pending') {
      state.fileStates[normalized] = {
        ...(fileState || {}),
        status: 'failed',
        updatedAt: failedAt
      };
    }
  }
  state.metrics.chunksDone = state.chunks.filter((entry) => entry.status === 'done').length;
  updateFileMetrics(state);
}

function executeStateCommand(command, args, owner) {
  const readState = () => owner.read();
  const saveState = (_statePath, state) => owner.save(state);

  if (!command) {
    throw new Error(`Missing arguments for state command: ${command || '<none>'}`);
  }

  if (command === 'init') {
    const [
      statePath,
      mode,
      filesJsonPath,
      chunkSizeRaw,
      maxSourceTokensRaw,
      enforceTokenBudgetRaw
    ] = args;
    if (!statePath || !mode || !filesJsonPath) {
      throw new Error(`Missing arguments for state command: ${command}`);
    }
    const files = readJson(filesJsonPath);
    assertArray(files, 'filesJson');
    const chunkSizeParsed = Number.parseInt(chunkSizeRaw || '', 10);
    const chunkSize = Number.isInteger(chunkSizeParsed) && chunkSizeParsed > 0
      ? chunkSizeParsed
      : DEFAULT_CHUNK_SIZE;
    const maxSourceTokensParsed = Number.parseInt(maxSourceTokensRaw || '', 10);
    const maxSourceTokens = Number.isInteger(maxSourceTokensParsed) && maxSourceTokensParsed > 0
      ? maxSourceTokensParsed
      : DEFAULT_SOURCE_TOKEN_BUDGET;
    const enforceTokenBudget = String(enforceTokenBudgetRaw || 'true').toLowerCase() === 'true';
    if (fs.existsSync(statePath)) {
      readState(statePath);
    }
    const state = buildInitialState({
      mode,
      chunkSize,
      maxSourceTokens,
      enforceTokenBudget,
      files,
      sourceHashes: owner.sourceHashes
    });
    saveState(statePath, state);
    return {
      ok: true,
      statePath,
      summary: summarize(state)
    };
  }

  if (command === 'status') {
    const [statePath] = args;
    const state = readState(statePath);
    return {
      ok: true,
      statePath,
      summary: summarize(state)
    };
  }

  if (command === 'next-chunk') {
    const [statePath] = args;
    const state = readState(statePath);
    const nextChunk = state.chunks.find((chunk) => chunk.status === 'pending');
    if (!nextChunk) {
      return { ok: true, done: true };
    }
    return { ok: true, done: false, chunk: nextChunk };
  }

  if (command === 'mark-chunk') {
    const [statePath, chunkId, status, errorMessage] = args;
    if (!statePath || !chunkId || !status) {
      throw new Error(`Missing arguments for state command: ${command}`);
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
          const normalized = String(filePath);
          const fileState = state.fileStates[normalized];
          return [normalized, {
            ...(fileState || {}),
            status: 'failed',
            updatedAt: failedAt
          }];
        }));
      Object.assign(state.fileStates, failedFileStates);
    }
    state.metrics.chunksDone = state.chunks.filter((entry) => entry.status === 'done').length;
    updateFileMetrics(state);
    saveState(statePath, state);
    return { ok: true, chunk };
  }

  if (command === 'record-findings') {
    const [statePath, findingsJsonPath, source = 'unknown', confidenceThresholdRaw] = args;
    if (!statePath || !findingsJsonPath) {
      throw new Error(`Missing arguments for state command: ${command}`);
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
    const merged = mergeFindingsIntoState({
      state,
      findings,
      source,
      confidenceThreshold
    });
    saveState(statePath, state);
    return {
      ok: true,
      ...merged,
      metrics: state.metrics
    };
  }

  if (command === 'hash-filter') {
    const [statePath, filesJsonPath] = args;
    if (!statePath || !filesJsonPath) {
      throw new Error(`Missing arguments for state command: ${command}`);
    }
    const state = readState(statePath);
    const files = readJson(filesJsonPath);
    assertArray(files, 'filesJson');

    const scan = [];
    const skip = [];
    const changed = [];
    const missing = [];
    const unreadable = [];

    for (const filePath of files) {
      const normalized = String(filePath);
      if (!fs.existsSync(normalized)) {
        missing.push(normalized);
        setFileStatus({ state, filePath: normalized, status: 'missing' });
        continue;
      }
      try {
        const currentHash = hashFile(normalized);
        const fileState = state.fileStates[normalized] || {};
        const initialHash = fileState.initialHash || currentHash;
        if (fileState.baselineUnavailable) {
          changed.push(normalized);
          setFileStatus({ state, filePath: normalized, status: 'failed', observedHash: currentHash });
          continue;
        }
        if (fileState.initialHash && fileState.initialHash !== currentHash) {
          changed.push(normalized);
          setFileStatus({
            state,
            filePath: normalized,
            status: 'failed',
            hash: fileState.hash || fileState.initialHash,
            initialHash: fileState.initialHash,
            observedHash: currentHash
          });
          continue;
        }
        const previous = state.hashCache[normalized];
        if (previous && previous.hash === currentHash) {
          skip.push(normalized);
          setFileStatus({
            state,
            filePath: normalized,
            status: 'skipped',
            hash: currentHash,
            initialHash,
            clearObservedHash: true
          });
        } else {
          scan.push(normalized);
          setFileStatus({
            state,
            filePath: normalized,
            status: 'pending',
            hash: currentHash,
            initialHash,
            clearObservedHash: true
          });
        }
      } catch {
        unreadable.push(normalized);
        setFileStatus({ state, filePath: normalized, status: 'unreadable' });
      }
    }

    updateFileMetrics(state);
    saveState(statePath, state);
    return { ok: true, scan, skip, changed, missing, unreadable };
  }

  if (command === 'hash-verify') {
    const [statePath, filesJsonPath] = args;
    if (!statePath || !filesJsonPath) {
      throw new Error(`Missing arguments for state command: ${command}`);
    }
    const state = readState(statePath);
    const files = readJson(filesJsonPath);
    assertArray(files, 'filesJson');
    const result = verifyPendingFiles({ state, files });
    if (result.changed.length > 0 || result.missing.length > 0 || result.unreadable.length > 0) {
      updateFileMetrics(state);
      saveState(statePath, state);
    }
    return { ...result, ok: result.changed.length === 0 && result.missing.length === 0 && result.unreadable.length === 0 };
  }

  if (command === 'commit-chunk') {
    const [
      statePath,
      chunkId,
      filesJsonPath,
      findingsJsonPath,
      factCardJsonPath,
      confidenceThresholdRaw,
      source = 'orchestrator'
    ] = args;
    if (!statePath || !chunkId || !filesJsonPath || !findingsJsonPath || !factCardJsonPath) {
      throw new Error(`Missing arguments for state command: ${command}`);
    }
    const confidenceThreshold = Number.isInteger(Number.parseInt(String(confidenceThresholdRaw || ''), 10))
      ? Number.parseInt(confidenceThresholdRaw, 10)
      : 75;
    const state = readState(statePath);
    const chunk = state.chunks.find((entry) => entry.id === chunkId);
    if (!chunk) {
      throw new Error(`Unknown chunk id: ${chunkId}`);
    }
    const files = readJson(filesJsonPath);
    const findings = readJson(findingsJsonPath);
    const factCard = readJson(factCardJsonPath);
    assertArray(files, 'filesJson');
    const validation = validateArtifactValue({ artifactName: 'findings', value: findings });
    if (!validation.ok) {
      throw new Error(`Invalid findings artifact: ${validation.errors.join('; ')}`);
    }
    const allowedFiles = new Set(files.map((filePath) => path.resolve(String(filePath))));
    const outsideFinding = findings.find((finding) => {
      return !allowedFiles.has(path.resolve(String(finding.file || '')));
    });
    if (outsideFinding) {
      const errorMessage = `Finding is outside the assigned chunk scope: ${outsideFinding.file}`;
      markChunkFailed(state, chunk, errorMessage);
      saveState(statePath, state);
      return { ok: false, error: errorMessage };
    }
    const verification = verifyPendingFiles({ state, files });
    if (verification.changed.length > 0
      || verification.missing.length > 0
      || verification.unreadable.length > 0) {
      const errorMessage = 'Assigned source changed, disappeared, or became unreadable during worker execution';
      markChunkFailed(state, chunk, errorMessage);
      saveState(statePath, state);
      return {
        ok: false,
        error: errorMessage,
        verification
      };
    }
    const merged = mergeFindingsIntoState({
      state,
      findings,
      source,
      confidenceThreshold
    });
    for (const filePath of files) {
      const normalized = String(filePath);
      const currentHash = verification.hashes[normalized];
      state.hashCache[normalized] = {
        hash: currentHash,
        status: 'scanned',
        scannedAt: nowIso()
      };
      const fileState = state.fileStates[normalized] || {};
      setFileStatus({
        state,
        filePath: normalized,
        status: 'scanned',
        hash: currentHash,
        initialHash: fileState.initialHash || currentHash,
        clearObservedHash: true
      });
    }
    state.factCards[chunkId] = normalizedFactCard(chunkId, factCard);
    chunk.status = 'done';
    chunk.completedAt = nowIso();
    chunk.lastError = null;
    state.metrics.chunksDone = state.chunks.filter((entry) => entry.status === 'done').length;
    updateFileMetrics(state);
    saveState(statePath, state);
    return {
      ok: true,
      chunkId,
      ...merged,
      metrics: state.metrics
    };
  }

  if (command === 'hash-update') {
    const [statePath, filesJsonPath, cacheStatus = 'scanned'] = args;
    if (!statePath || !filesJsonPath) {
      throw new Error(`Missing arguments for state command: ${command}`);
    }
    const state = readState(statePath);
    const files = readJson(filesJsonPath);
    assertArray(files, 'filesJson');
    if (!VALID_FILE_STATUS.has(cacheStatus)) {
      throw new Error(`Invalid hash cache status: ${cacheStatus}`);
    }
    const updatedFiles = [];
    const missing = [];
    const unreadable = [];

    for (const filePath of files) {
      const normalized = String(filePath);
      if (!fs.existsSync(normalized)) {
        missing.push(normalized);
        setFileStatus({ state, filePath: normalized, status: 'missing' });
        continue;
      }
      try {
        const currentHash = hashFile(normalized);
        state.hashCache[normalized] = {
          hash: currentHash,
          status: cacheStatus,
          scannedAt: nowIso()
        };
        const fileState = state.fileStates[normalized] || {};
        setFileStatus({
          state,
          filePath: normalized,
          status: cacheStatus,
          hash: currentHash,
          initialHash: fileState.initialHash || currentHash,
          clearObservedHash: true
        });
        updatedFiles.push(normalized);
      } catch {
        unreadable.push(normalized);
        setFileStatus({ state, filePath: normalized, status: 'unreadable' });
      }
    }

    updateFileMetrics(state);
    saveState(statePath, state);
    return {
      ok: true,
      updated: updatedFiles.length,
      missing,
      unreadable,
      updatedFiles
    };
  }

  if (command === 'append-files') {
    const [statePath, filesJsonPath] = args;
    if (!statePath || !filesJsonPath) {
      throw new Error(`Missing arguments for state command: ${command}`);
    }
    const state = readState(statePath);
    const files = readJson(filesJsonPath);
    assertArray(files, 'filesJson');
    const existing = new Set(state.chunks.flatMap((chunk) => chunk.files));
    const toAppend = [...new Set(files.map((filePath) => String(filePath)))]
      .filter((filePath) => !existing.has(filePath));
    if (toAppend.length === 0) {
      return { ok: true, appended: 0, chunksAdded: 0 };
    }

    const chunkNumberStart = nextChunkNumber(state.chunks);
    const newChunks = splitChunks(
      toAppend,
      state.chunkSize,
      state.maxSourceTokens,
      state.enforceTokenBudget
    ).map((chunk, index) => {
        return {
          ...chunk,
          id: `chunk-${chunkNumberStart + index}`
        };
      });
    state.chunks.push(...newChunks);
    const appendedAt = nowIso();
    Object.assign(state.fileStates, Object.fromEntries(toAppend.map((filePath) => {
      return [filePath, captureBaseline(filePath, appendedAt)];
    })));
    state.metrics.filesTotal += toAppend.length;
    state.metrics.chunksTotal = state.chunks.length;
    saveState(statePath, state);
    return {
      ok: true,
      appended: toAppend.length,
      chunksAdded: newChunks.length,
      summary: summarize(state)
    };
  }

  if (command === 'record-fact-card') {
    const [statePath, chunkId, factCardJsonPath] = args;
    if (!statePath || !chunkId || !factCardJsonPath) {
      throw new Error(`Missing arguments for state command: ${command}`);
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
    return {
      ok: true,
      chunkId,
      factCards: Object.keys(state.factCards).length
    };
  }

  if (command === 'set-consistency') {
    const [statePath, consistencyJsonPath] = args;
    if (!statePath || !consistencyJsonPath) {
      throw new Error(`Missing arguments for state command: ${command}`);
    }
    const state = readState(statePath);
    const consistency = readJson(consistencyJsonPath);
    state.consistency = consistency;
    saveState(statePath, state);
    return {
      ok: true,
      consistency
    };
  }

  if (command === 'set-fix-plan') {
    const [statePath, fixPlanJsonPath] = args;
    if (!statePath || !fixPlanJsonPath) {
      throw new Error(`Missing arguments for state command: ${command}`);
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
    return {
      ok: true,
      fixPlan
    };
  }

  if (command === 'set-parallel-disabled') {
    const [statePath, boolValue] = args;
    if (!statePath || !boolValue) {
      throw new Error(`Missing arguments for state command: ${command}`);
    }
    const state = readState(statePath);
    const normalized = String(boolValue).toLowerCase();
    if (normalized !== 'true' && normalized !== 'false') {
      throw new Error('set-parallel-disabled expects true or false');
    }
    state.runtime.parallelDisabled = normalized === 'true';
    saveState(statePath, state);
    return {
      ok: true,
      runtime: state.runtime
    };
  }

  throw new Error(`Unknown state command: ${command}`);
}

function withLockGate(lockPath, operation) {
  const gatePath = `${lockPath}.gate`;
  const token = crypto.randomUUID();
  const candidate = `${gatePath}.${token}.tmp`;
  const record = { pid: process.pid, host: os.hostname(), token };
  fs.writeFileSync(candidate, JSON.stringify(record), { flag: 'wx' });
  try {
    while (true) {
      try { fs.linkSync(candidate, gatePath); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = readJson(gatePath); }
        catch (readError) {
          if (readError.code === 'ENOENT') continue;
          throw new Error(`Malformed state mutation gate: ${gatePath}`);
        }
        const dead = owner.host === os.hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0
          && isDeadLocalPid(owner.pid);
        // A dead local owner's generation is reclaimed through its record (link-lock.cjs).
        if (!dead || reclaimDeadLinkLock(gatePath, owner) === 'busy') {
          throw new Error(`State lock mutation in progress: ${gatePath}`);
        }
      }
    }
    try { return operation(); }
    finally { fs.unlinkSync(gatePath); }
  } finally { fs.unlinkSync(candidate); }
}

function openStateOwner(statePath, { sourceHashes = {} } = {}) {
  statePath = path.resolve(statePath);
  ensureDir(statePath);
  const lockPath = `${statePath}.lock`;
  const token = crypto.randomUUID();
  withLockGate(lockPath, () => {
    if (fs.existsSync(lockPath)) {
      let lock;
      try {
        lock = readJson(lockPath);
      } catch {
        throw new Error(`Malformed state owner lock: ${lockPath}`);
      }
      if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0 || !lock.token || !lock.host) {
        throw new Error(`Malformed state owner lock: ${lockPath}`);
      }
      let alive = true;
      if (lock.host === os.hostname()) {
        try {
          process.kill(lock.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') alive = false;
          else if (error.code !== 'EPERM') throw error;
        }
      }
      if (alive) throw new Error(`State is owned by another runner (PID ${lock.pid}): ${statePath}`);
    }
    // Publish complete metadata atomically; a killed worker leaves a reclaimable PID lease.
    writeJson(lockPath, { pid: process.pid, host: os.hostname(), token });
  });

  let state;
  let closed = false;
  let batching = false;
  let dirty = false;
  const assertOpen = () => {
    if (closed) throw new Error(`State owner is closed: ${statePath}`);
  };
  const owner = {
    sourceHashes,
    read() {
      assertOpen();
      if (!state) state = readState(statePath);
      return state;
    },
    save(nextState) {
      assertOpen();
      state = nextState;
      if (batching) dirty = true;
      else saveState(statePath, state);
    },
    execute(command, ...args) {
      assertOpen();
      return executeStateCommand(command, [statePath, ...args], owner);
    },
    batch(operation) {
      assertOpen();
      if (batching) throw new Error('Nested state transactions are not supported');
      batching = true;
      dirty = false;
      try {
        const result = operation();
        if (dirty) saveState(statePath, state);
        return result;
      } catch (error) {
        state = undefined;
        throw error;
      } finally {
        batching = false;
        dirty = false;
      }
    },
    close() {
      if (closed) return;
      // No gate: an opener replaces the lease only when it is absent or its
      // owner is dead, so this live owner's token check cannot race a new
      // lease, and a competing opener inside the gate cannot block cleanup.
      const lock = readJson(lockPath);
      if (lock.token !== token) throw new Error(`State owner lock changed: ${lockPath}`);
      fs.unlinkSync(lockPath);
      closed = true;
    }
  };
  return owner;
}

function main() {
  const [command, statePath, ...args] = process.argv.slice(2);
  if (!command || !statePath) {
    usage();
    process.exitCode = 1;
    return;
  }
  if (['status', 'next-chunk'].includes(command)) {
    // Atomic state promotion lets observers read a complete snapshot during a run.
    const snapshot = { read: () => readState(statePath) };
    console.log(JSON.stringify(executeStateCommand(command, [statePath, ...args], snapshot), null, 2));
    return;
  }
  const owner = openStateOwner(statePath);
  try {
    const result = owner.execute(command, ...args);
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  } finally {
    owner.close();
  }
}

module.exports = { openStateOwner };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
