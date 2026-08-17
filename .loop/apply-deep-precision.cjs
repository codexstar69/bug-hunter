const fs = require('fs');
const path = require('path');

const root = process.cwd();

function absolute(filePath) {
  return path.join(root, filePath);
}

function read(filePath) {
  return fs.readFileSync(absolute(filePath), 'utf8');
}

function write(filePath, content) {
  fs.writeFileSync(absolute(filePath), content, 'utf8');
}

function replaceOnce(filePath, search, replacement, label = search.slice(0, 80)) {
  const content = read(filePath);
  const first = content.indexOf(search);
  if (first < 0) {
    throw new Error(`${filePath}: replacement target not found: ${label}`);
  }
  if (content.indexOf(search, first + search.length) >= 0) {
    throw new Error(`${filePath}: replacement target is not unique: ${label}`);
  }
  write(filePath, `${content.slice(0, first)}${replacement}${content.slice(first + search.length)}`);
}

function replaceSection(filePath, startMarker, endMarker, replacement) {
  const content = read(filePath);
  const start = content.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`${filePath}: section start not found: ${startMarker}`);
  }
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    throw new Error(`${filePath}: section end not found: ${endMarker}`);
  }
  write(filePath, `${content.slice(0, start)}${replacement}${content.slice(end)}`);
}

function replaceRegex(filePath, pattern, replacement, label) {
  const content = read(filePath);
  const matches = [...content.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(`${filePath}: expected one regex match for ${label}, found ${matches.length}`);
  }
  write(filePath, content.replace(pattern, replacement));
}

function appendOnce(filePath, marker, text) {
  const content = read(filePath);
  if (content.includes(marker)) {
    return;
  }
  write(filePath, `${content.replace(/\s*$/, '')}\n\n${text.replace(/\s*$/, '')}\n`);
}

function patchTriage() {
  replaceOnce(
    'scripts/triage.cjs',
    "const {\n  DEFAULT_SOURCE_TOKEN_BUDGET,\n  MAX_FILES_PER_CHUNK,\n  SOURCE_EXTENSIONS\n} = require('./source-config.cjs');\n",
    "const {\n  DEFAULT_SOURCE_TOKEN_BUDGET,\n  MAX_FILES_PER_CHUNK,\n  buildSourceChunks,\n  isSupportedSourceFile,\n  isTestSourcePath\n} = require('./source-config.cjs');\n",
    'source-config import'
  );

  replaceSection(
    'scripts/triage.cjs',
    'const SOURCE_SHEBANG =',
    '// ─── Directories to always skip',
    ''
  );

  replaceOnce(
    'scripts/triage.cjs',
    `    } else if (entry.isFile()) {\n      const ext = path.extname(entry.name);\n      if (SOURCE_EXTENSIONS.has(ext)) {\n        results.push(fullPath);\n        continue;\n      }\n      if (ext === '') {\n        try {\n          if (hasSourceShebang(fullPath)) {\n            results.push(fullPath);\n          }\n        } catch {\n          // Skip unreadable files\n        }\n      }\n    }\n`,
    `    } else if (entry.isFile() && isSupportedSourceFile(fullPath)) {\n      results.push(fullPath);\n    }\n`,
    'walk source detection'
  );

  replaceOnce(
    'scripts/triage.cjs',
    `  if (TEST_FILE_PATTERNS.test(fileName) || parts.some((p) => TEST_PATTERNS.test(p))) {\n    return 'context-only';\n  }\n`,
    `  if (isTestSourcePath(relative)) {\n    return 'context-only';\n  }\n`,
    'test source classification'
  );

  replaceRegex(
    'scripts/triage.cjs',
    /  \/\/ Reserve most of the model context for reasoning, cross-file evidence, and output\.\n  let fileBudget;\n  if \(avgTokens <= 0\) \{\n    fileBudget = MAX_FILES_PER_CHUNK;\n  \} else \{\n    fileBudget = Math\.floor\(DEFAULT_SOURCE_TOKEN_BUDGET \/ avgTokens\);\n  \}\n  fileBudget = Math\.max\(1, Math\.min\(MAX_FILES_PER_CHUNK, fileBudget\)\);\n\n  return \{ fileBudget, avgLines, totalLines: estimatedTotalLines, avgTokens, sampledFiles: sampled \};/,
    `  // Use the first risk-ordered concrete chunk as the safe FILE_BUDGET.\n  // The runtime keeps the full variable-size plan and enforces every chunk.\n  const plannedChunks = buildSourceChunks(files, {\n    maxFiles: MAX_FILES_PER_CHUNK,\n    maxSourceTokens: DEFAULT_SOURCE_TOKEN_BUDGET,\n    enforceTokenBudget: true\n  });\n  const fileBudget = plannedChunks.length > 0\n    ? Math.max(1, plannedChunks[0].files.length)\n    : MAX_FILES_PER_CHUNK;\n\n  return {\n    fileBudget,\n    avgLines,\n    totalLines: estimatedTotalLines,\n    avgTokens,\n    sampledFiles: sampled,\n    plannedChunkCount: plannedChunks.length\n  };`,
    'triage concrete token plan'
  );

  replaceOnce(
    'scripts/triage.cjs',
    `    sampledFiles: budget.sampledFiles,\n    domains: domains.map((d) => ({\n`,
    `    sampledFiles: budget.sampledFiles,\n    plannedChunkCount: budget.plannedChunkCount || 0,\n    domains: domains.map((d) => ({\n`,
    'triage planned chunk count'
  );
}

function patchCodeIndex() {
  replaceOnce(
    'scripts/code-index.cjs',
    `const {\n  SOURCE_EXTENSION_LIST,\n  SOURCE_EXTENSIONS\n} = require('./source-config.cjs');\n`,
    `const {\n  SOURCE_EXTENSION_LIST,\n  inferSourceExtension,\n  isSupportedSourceFile,\n  isTestSourcePath\n} = require('./source-config.cjs');\n`,
    'code-index source-config import'
  );

  replaceSection(
    'scripts/code-index.cjs',
    'function isSupportedSource(filePath) {',
    'function inferRiskHint(relativePath) {',
    `function isSupportedSource(filePath) {\n  return isSupportedSourceFile(filePath);\n}\n\nfunction isTestFile(filePath) {\n  return isTestSourcePath(filePath);\n}\n\n`
  );

  replaceOnce(
    'scripts/code-index.cjs',
    `  const files = [...new Set(filesRaw.map((filePath) => normalizeFilePath(filePath)))]\n    .filter((filePath) => fs.existsSync(filePath))\n    .filter((filePath) => isSupportedSource(filePath))\n    .sort();\n`,
    `  const files = [...new Set(filesRaw.map((filePath) => normalizeFilePath(filePath)))]\n    .filter((filePath) => fs.existsSync(filePath))\n    .filter((filePath) => isSupportedSource(filePath));\n`,
    'preserve code-index input order'
  );

  replaceOnce(
    'scripts/code-index.cjs',
    `    const extension = path.extname(filePath);\n`,
    `    const extension = inferSourceExtension(filePath, content);\n`,
    'infer extensionless source language'
  );

  replaceOnce(
    'scripts/code-index.cjs',
    `  return [...selected].sort();\n`,
    `  return [...selected];\n`,
    'preserve query expansion order'
  );
}

function patchDeltaMode() {
  replaceOnce(
    'scripts/delta-mode.cjs',
    `    .map(([filePath]) => filePath)\n    .sort();\n`,
    `    .map(([filePath]) => filePath);\n`,
    'preserve overlay risk order'
  );
  replaceOnce(
    'scripts/delta-mode.cjs',
    `  const selected = [...selectedSet].sort();\n`,
    `  const selected = [...selectedSet];\n`,
    'preserve delta selection order'
  );
  replaceOnce(
    'scripts/delta-mode.cjs',
    `  const expanded = [...expandedSet]\n    .filter((filePath) => !alreadySelected.has(filePath))\n    .sort();\n  const overlayOnly = overlays.filter((filePath) => !expandedSet.has(filePath));\n\n  return {\n`,
    `  const expanded = [...expandedSet]\n    .filter((filePath) => !alreadySelected.has(filePath));\n  const overlayOnly = overlays.filter((filePath) => !expandedSet.has(filePath));\n  const prioritized = [...overlayOnly, ...expanded];\n\n  return {\n`,
    'preserve expansion order'
  );
  replaceOnce(
    'scripts/delta-mode.cjs',
    `    expanded,\n    overlayOnly,\n    metrics: {\n      expandedCount: expanded.length,\n      overlayOnlyCount: overlayOnly.length\n    }\n`,
    `    expanded,\n    overlayOnly,\n    prioritized,\n    metrics: {\n      expandedCount: expanded.length,\n      overlayOnlyCount: overlayOnly.length,\n      prioritizedCount: prioritized.length\n    }\n`,
    'return prioritized expansion'
  );
}

function writeStateStore() {
  write('scripts/state-store.cjs', `const childProcess = require('child_process');\nconst crypto = require('crypto');\nconst fs = require('fs');\nconst path = require('path');\nconst {\n  DEFAULT_MAX_OUTPUT_BYTES,\n  runJsonScript\n} = require('./process-runner.cjs');\n\nconst DEFAULT_TIMEOUT_MS = 120000;\n\nfunction ensureDir(dirPath) {\n  fs.mkdirSync(dirPath, { recursive: true });\n}\n\nfunction readJson(filePath) {\n  return JSON.parse(fs.readFileSync(filePath, 'utf8'));\n}\n\nfunction writeJsonAtomic(filePath, value) {\n  ensureDir(path.dirname(filePath));\n  const temporaryPath = path.join(\n    path.dirname(filePath),\n    \`.\${path.basename(filePath)}.\${process.pid}.\${crypto.randomUUID()}.tmp\`\n  );\n  try {\n    fs.writeFileSync(temporaryPath, \`\${JSON.stringify(value, null, 2)}\\n\`, {\n      encoding: 'utf8',\n      flag: 'wx'\n    });\n    fs.renameSync(temporaryPath, filePath);\n  } catch (error) {\n    if (fs.existsSync(temporaryPath)) {\n      fs.unlinkSync(temporaryPath);\n    }\n    throw error;\n  }\n}\n\nfunction isOutsideRoot(repositoryRoot, candidatePath) {\n  const relative = path.relative(repositoryRoot, candidatePath);\n  return relative.startsWith('..') || path.isAbsolute(relative);\n}\n\nfunction normalizeRunFiles(files, repositoryRoot, options = {}) {\n  if (!Array.isArray(files)) {\n    throw new Error('Run scope must be an array of file paths');\n  }\n  const canonicalRoot = fs.realpathSync(repositoryRoot);\n  const allowMissing = options.allowMissing === true;\n  const normalized = [];\n  const seen = new Set();\n\n  for (const filePath of files) {\n    const resolved = path.resolve(String(filePath));\n    let canonical = resolved;\n    if (fs.existsSync(resolved)) {\n      canonical = fs.realpathSync(resolved);\n      if (!fs.statSync(canonical).isFile()) {\n        throw new Error(\`Run scope entry is not a regular file: \${filePath}\`);\n      }\n    } else if (!allowMissing) {\n      throw new Error(\`Run scope file does not exist: \${filePath}\`);\n    }\n    if (isOutsideRoot(canonicalRoot, canonical)) {\n      throw new Error(\`Run scope file is outside the repository root: \${filePath}\`);\n    }\n    if (!seen.has(canonical)) {\n      seen.add(canonical);\n      normalized.push(canonical);\n    }\n  }\n  return normalized;\n}\n\nfunction getRepositoryIdentity() {\n  const result = childProcess.spawnSync('git', ['rev-parse', '--show-toplevel', 'HEAD'], {\n    cwd: process.cwd(),\n    encoding: 'utf8',\n    maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,\n    timeout: DEFAULT_TIMEOUT_MS\n  });\n  if (result.error || result.status !== 0) {\n    const message = result.error\n      ? result.error.message\n      : String(result.stderr || result.stdout || 'git identity lookup failed').trim();\n    throw new Error(\`Cannot establish repository identity: \${message}\`);\n  }\n  const [repositoryRoot, baseCommit] = String(result.stdout || '').trim().split(/\\r?\\n/);\n  if (!repositoryRoot || !baseCommit) {\n    throw new Error('Cannot establish repository identity: incomplete git output');\n  }\n  return {\n    repositoryRoot: fs.realpathSync(repositoryRoot),\n    baseCommit\n  };\n}\n\nfunction hashValue(value) {\n  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');\n}\n\nfunction buildRunIdentity({\n  runId,\n  mode,\n  backend,\n  filesJsonPath,\n  chunkSize,\n  maxSourceTokens,\n  tokenBudgetEnforced,\n  timeoutMs,\n  maxRetries,\n  confidenceThreshold,\n  deltaMode,\n  deltaHops\n}) {\n  const repository = getRepositoryIdentity();\n  const files = normalizeRunFiles(readJson(filesJsonPath), repository.repositoryRoot, {\n    allowMissing: true\n  });\n  return {\n    schemaVersion: 1,\n    runId,\n    repositoryRoot: repository.repositoryRoot,\n    baseCommit: repository.baseCommit,\n    mode,\n    backend,\n    scopeHash: hashValue(files),\n    optionsHash: hashValue({\n      chunkSize,\n      confidenceThreshold,\n      deltaHops,\n      deltaMode,\n      maxRetries,\n      maxSourceTokens,\n      timeoutMs,\n      tokenBudgetEnforced\n    })\n  };\n}\n\nfunction assertRunIdentity({ expected, actual, identityPath }) {\n  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {\n    throw new Error(\`Run identity is malformed: \${identityPath}\`);\n  }\n  const fields = [\n    'schemaVersion',\n    'runId',\n    'repositoryRoot',\n    'baseCommit',\n    'mode',\n    'backend',\n    'scopeHash',\n    'optionsHash'\n  ];\n  const differences = fields\n    .filter((field) => actual[field] !== expected[field])\n    .map((field) => {\n      return \`\${field}: stored=\${JSON.stringify(actual[field])}, current=\${JSON.stringify(expected[field])}\`;\n    });\n  if (differences.length > 0) {\n    throw new Error(\`Resume fingerprint mismatch for \${identityPath}: \${differences.join('; ')}\`);\n  }\n}\n\nfunction validateStateShape({ statePath, state }) {\n  if (!state || typeof state !== 'object' || Array.isArray(state)) {\n    throw new Error(\`State file must contain an object: \${statePath}\`);\n  }\n  if (!Number.isInteger(state.schemaVersion) || !Array.isArray(state.chunks) || !Array.isArray(state.bugLedger)) {\n    throw new Error(\`State file does not match the required runtime shape: \${statePath}\`);\n  }\n}\n\nfunction requeueResumableChunks({ statePath, stateScript, maxRetries }) {\n  const state = readJson(statePath);\n  validateStateShape({ statePath, state });\n  const resumable = state.chunks.filter((chunk) => {\n    if (chunk.status === 'in_progress') {\n      return true;\n    }\n    return chunk.status === 'failed' && Number(chunk.retries || 0) <= maxRetries;\n  });\n  resumable.map((chunk) => {\n    return runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'pending']);\n  });\n  return resumable.map((chunk) => chunk.id);\n}\n\nmodule.exports = {\n  assertRunIdentity,\n  buildRunIdentity,\n  getRepositoryIdentity,\n  normalizeRunFiles,\n  requeueResumableChunks,\n  validateStateShape,\n  writeJsonAtomic\n};\n`);
}

function patchBugHunterState() {
  replaceOnce(
    'scripts/bug-hunter-state.cjs',
    `const { validateArtifactValue } = require('./schema-runtime.cjs');\n\nconst VALID_CHUNK_STATUS`,
    `const { validateArtifactValue } = require('./schema-runtime.cjs');\nconst {\n  DEFAULT_SOURCE_TOKEN_BUDGET,\n  MAX_FILES_PER_CHUNK,\n  buildSourceChunks\n} = require('./source-config.cjs');\n\nconst VALID_CHUNK_STATUS`,
    'state source-config import'
  );
  replaceOnce(
    'scripts/bug-hunter-state.cjs',
    `const DEFAULT_CHUNK_SIZE = 30;\n`,
    `const DEFAULT_CHUNK_SIZE = MAX_FILES_PER_CHUNK;\n`,
    'state chunk constant'
  );

  replaceSection(
    'scripts/bug-hunter-state.cjs',
    'function splitChunks(files, chunkSize) {',
    'function nextChunkNumber(chunks) {',
    `function splitChunks(files, chunkSize, maxSourceTokens, enforceTokenBudget) {\n  return buildSourceChunks(files, {\n    maxFiles: chunkSize,\n    maxSourceTokens,\n    enforceTokenBudget\n  }).map((plannedChunk, index) => {\n    return {\n      id: \`chunk-\${index + 1}\`,\n      files: plannedChunk.files,\n      estimatedSourceTokens: plannedChunk.estimatedSourceTokens,\n      oversized: plannedChunk.oversized,\n      status: 'pending',\n      retries: 0,\n      startedAt: null,\n      completedAt: null,\n      lastError: null\n    };\n  });\n}\n\n`
  );

  replaceSection(
    'scripts/bug-hunter-state.cjs',
    'function buildInitialState({ mode, chunkSize, files }) {',
    'function readState(statePath) {',
    `function buildInitialState({\n  mode,\n  chunkSize,\n  maxSourceTokens,\n  enforceTokenBudget,\n  files\n}) {\n  const normalizedFiles = [...new Set(files.map((filePath) => String(filePath)))];\n  const initializedAt = nowIso();\n  const chunks = splitChunks(\n    normalizedFiles,\n    chunkSize,\n    maxSourceTokens,\n    enforceTokenBudget\n  );\n  return {\n    schemaVersion: 3,\n    generation: 0,\n    mode,\n    createdAt: initializedAt,\n    updatedAt: initializedAt,\n    chunkSize,\n    maxSourceTokens,\n    enforceTokenBudget,\n    runtime: {\n      parallelDisabled: false\n    },\n    metrics: {\n      filesTotal: normalizedFiles.length,\n      filesScanned: 0,\n      chunksTotal: chunks.length,\n      chunksDone: 0,\n      findingsTotal: 0,\n      findingsUnique: 0,\n      lowConfidenceFindings: 0\n    },\n    chunks,\n    fileStates: Object.fromEntries(normalizedFiles.map((filePath) => {\n      return [filePath, {\n        status: 'pending',\n        updatedAt: initializedAt\n      }];\n    })),\n    bugLedger: [],\n    hashCache: {},\n    factCards: {},\n    consistency: {\n      checkedAt: null,\n      conflicts: []\n    },\n    fixPlan: null\n  };\n}\n\n`
  );

  replaceOnce(
    'scripts/bug-hunter-state.cjs',
    `function normalizeFileStates(state) {\n  if (!state.fileStates || typeof state.fileStates !== 'object' || Array.isArray(state.fileStates)) {\n`,
    `function normalizeFileStates(state) {\n  if (!Number.isInteger(state.maxSourceTokens) || state.maxSourceTokens <= 0) {\n    state.maxSourceTokens = DEFAULT_SOURCE_TOKEN_BUDGET;\n  }\n  if (typeof state.enforceTokenBudget !== 'boolean') {\n    state.enforceTokenBudget = false;\n  }\n  if (!state.fileStates || typeof state.fileStates !== 'object' || Array.isArray(state.fileStates)) {\n`,
    'normalize new state fields'
  );

  replaceSection(
    'scripts/bug-hunter-state.cjs',
    'function hashFile(filePath) {',
    'function summarize(state) {',
    `function hashFile(filePath) {\n  const hash = crypto.createHash('sha256');\n  const fileDescriptor = fs.openSync(filePath, 'r');\n  try {\n    const buffer = Buffer.alloc(1024 * 1024);\n    let bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, null);\n    while (bytesRead > 0) {\n      hash.update(buffer.subarray(0, bytesRead));\n      bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, null);\n    }\n    return hash.digest('hex');\n  } finally {\n    fs.closeSync(fileDescriptor);\n  }\n}\n\n`
  );

  replaceOnce(
    'scripts/bug-hunter-state.cjs',
    `  console.error('  bug-hunter-state.cjs init <statePath> <mode> <filesJsonPath> [chunkSize]');\n`,
    `  console.error('  bug-hunter-state.cjs init <statePath> <mode> <filesJsonPath> [chunkSize] [maxSourceTokens] [enforceTokenBudget]');\n`,
    'state init usage'
  );
  replaceOnce(
    'scripts/bug-hunter-state.cjs',
    `  console.error('  bug-hunter-state.cjs hash-filter <statePath> <filesJsonPath>');\n  console.error('  bug-hunter-state.cjs hash-update <statePath> <filesJsonPath> [status]');\n`,
    `  console.error('  bug-hunter-state.cjs hash-filter <statePath> <filesJsonPath>');\n  console.error('  bug-hunter-state.cjs hash-verify <statePath> <filesJsonPath>');\n  console.error('  bug-hunter-state.cjs hash-update <statePath> <filesJsonPath> [status]');\n  console.error('  bug-hunter-state.cjs commit-chunk <statePath> <chunkId> <filesJsonPath> <findingsJsonPath> <factCardJsonPath> [confidenceThreshold] [source]');\n`,
    'state verification usage'
  );

  replaceSection(
    'scripts/bug-hunter-state.cjs',
    'function toConfidenceScore(value) {',
    'function main() {',
    `function toConfidenceScore(value) {\n  if (value === null || value === undefined || value === '') {\n    return null;\n  }\n  const parsed = Number(value);\n  if (!Number.isFinite(parsed)) {\n    return null;\n  }\n  return parsed;\n}\n\nfunction uniqueBugId(state, requestedBugId, key) {\n  const requested = String(requestedBugId || '').trim();\n  const collision = state.bugLedger.find((entry) => {\n    return entry.bugId === requested && entry.key !== key;\n  });\n  if (!collision) {\n    return requested;\n  }\n  const suffix = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8).toUpperCase();\n  let candidate = \`\${requested}-\${suffix}\`;\n  let counter = 2;\n  while (state.bugLedger.some((entry) => entry.bugId === candidate && entry.key !== key)) {\n    candidate = \`\${requested}-\${suffix}-\${counter}\`;\n    counter += 1;\n  }\n  return candidate;\n}\n\nfunction mergeFindingsIntoState({ state, findings, source, confidenceThreshold }) {\n  let inserted = 0;\n  let updated = 0;\n\n  for (const finding of findings) {\n    const file = String(finding.file || '').trim();\n    const lines = String(finding.lines || '').trim();\n    const claim = String(finding.claim || '').trim();\n    const severity = String(finding.severity || 'Low');\n    const category = String(finding.category || '').trim();\n    const evidence = String(finding.evidence || '').trim();\n    const runtimeTrigger = String(finding.runtimeTrigger || '').trim();\n    const crossReferences = Array.isArray(finding.crossReferences)\n      ? finding.crossReferences.map((entry) => String(entry)).filter(Boolean)\n      : [];\n    const confidenceScore = toConfidenceScore(finding.confidenceScore);\n    const confidenceLabel = finding.confidenceLabel\n      ? String(finding.confidenceLabel)\n      : undefined;\n    const requestedBugId = String(finding.bugId || '').trim();\n    const key = \`\${file}|\${lines}|\${claim}\`;\n    const existing = state.bugLedger.find((entry) => entry.key === key);\n\n    if (!existing) {\n      const bugId = uniqueBugId(state, requestedBugId, key);\n      state.bugLedger.push({\n        key,\n        bugId,\n        severity,\n        file,\n        lines,\n        category,\n        claim,\n        evidence,\n        runtimeTrigger,\n        crossReferences,\n        confidenceScore,\n        ...(confidenceLabel ? { confidenceLabel } : {}),\n        ...(finding.stride ? { stride: String(finding.stride) } : {}),\n        ...(finding.cwe ? { cwe: String(finding.cwe) } : {}),\n        status: 'open',\n        source,\n        updatedAt: nowIso()\n      });\n      inserted += 1;\n      continue;\n    }\n\n    const existingRank = severityRank(existing.severity);\n    const incomingRank = severityRank(severity);\n    const existingConfidence = toConfidenceScore(existing.confidenceScore);\n    const incomingStronger = confidenceScore !== null\n      && (existingConfidence === null || confidenceScore > existingConfidence);\n\n    if (incomingRank > existingRank) {\n      existing.severity = severity;\n    }\n    if (existing.category !== 'security') {\n      if (category === 'security' || incomingStronger) {\n        existing.category = category || existing.category;\n      }\n    }\n    if (incomingStronger) {\n      existing.evidence = evidence || existing.evidence;\n      existing.runtimeTrigger = runtimeTrigger || existing.runtimeTrigger;\n      existing.confidenceScore = confidenceScore;\n      if (confidenceLabel) {\n        existing.confidenceLabel = confidenceLabel;\n      }\n    } else if (existingConfidence === null && confidenceScore !== null) {\n      existing.confidenceScore = confidenceScore;\n    }\n    existing.crossReferences = [...new Set([\n      ...(Array.isArray(existing.crossReferences) ? existing.crossReferences : []),\n      ...crossReferences\n    ])];\n    if (category === 'security' || existing.category === 'security') {\n      if ((!existing.stride || incomingStronger) && finding.stride) {\n        existing.stride = String(finding.stride);\n      }\n      if ((!existing.cwe || incomingStronger) && finding.cwe) {\n        existing.cwe = String(finding.cwe);\n      }\n    }\n    existing.updatedAt = nowIso();\n    existing.source = source;\n    updated += 1;\n  }\n\n  state.metrics.findingsTotal += findings.length;\n  state.metrics.findingsUnique = state.bugLedger.length;\n  state.metrics.lowConfidenceFindings = state.bugLedger.filter((entry) => {\n    return entry.confidenceScore === null\n      || entry.confidenceScore === undefined\n      || Number(entry.confidenceScore) < confidenceThreshold;\n  }).length;\n  return { inserted, updated };\n}\n\nfunction normalizedFactCard(chunkId, factCard) {\n  return {\n    chunkId,\n    updatedAt: nowIso(),\n    apiContracts: Array.isArray(factCard.apiContracts) ? factCard.apiContracts : [],\n    authAssumptions: Array.isArray(factCard.authAssumptions) ? factCard.authAssumptions : [],\n    invariants: Array.isArray(factCard.invariants) ? factCard.invariants : []\n  };\n}\n\nfunction verifyPendingFiles({ state, files }) {\n  const verified = [];\n  const changed = [];\n  const missing = [];\n  const unreadable = [];\n  const hashes = {};\n\n  for (const filePath of files) {\n    const normalized = String(filePath);\n    if (!fs.existsSync(normalized)) {\n      missing.push(normalized);\n      setFileStatus({ state, filePath: normalized, status: 'missing' });\n      continue;\n    }\n    try {\n      const currentHash = hashFile(normalized);\n      const expectedHash = state.fileStates[normalized] && state.fileStates[normalized].hash;\n      if (!expectedHash || expectedHash !== currentHash) {\n        changed.push(normalized);\n        setFileStatus({ state, filePath: normalized, status: 'failed', hash: currentHash });\n        continue;\n      }\n      hashes[normalized] = currentHash;\n      verified.push(normalized);\n    } catch {\n      unreadable.push(normalized);\n      setFileStatus({ state, filePath: normalized, status: 'unreadable' });\n    }\n  }\n  return { verified, changed, missing, unreadable, hashes };\n}\n\nfunction markChunkFailed(state, chunk, errorMessage) {\n  chunk.status = 'failed';\n  chunk.lastError = errorMessage || 'unknown';\n  const failedAt = nowIso();\n  for (const filePath of chunk.files) {\n    const normalized = String(filePath);\n    const fileState = state.fileStates[normalized];\n    if (!fileState || fileState.status === 'pending') {\n      state.fileStates[normalized] = {\n        status: 'failed',\n        updatedAt: failedAt\n      };\n    }\n  }\n  state.metrics.chunksDone = state.chunks.filter((entry) => entry.status === 'done').length;\n  updateFileMetrics(state);\n}\n\nfunction main() {\n`
  );

  replaceSection(
    'scripts/bug-hunter-state.cjs',
    "  if (command === 'init') {",
    "  if (command === 'status') {",
    `  if (command === 'init') {\n    const [\n      statePath,\n      mode,\n      filesJsonPath,\n      chunkSizeRaw,\n      maxSourceTokensRaw,\n      enforceTokenBudgetRaw\n    ] = args;\n    if (!statePath || !mode || !filesJsonPath) {\n      usage();\n      process.exit(1);\n    }\n    const files = readJson(filesJsonPath);\n    assertArray(files, 'filesJson');\n    const chunkSizeParsed = Number.parseInt(chunkSizeRaw || '', 10);\n    const chunkSize = Number.isInteger(chunkSizeParsed) && chunkSizeParsed > 0\n      ? chunkSizeParsed\n      : DEFAULT_CHUNK_SIZE;\n    const maxSourceTokensParsed = Number.parseInt(maxSourceTokensRaw || '', 10);\n    const maxSourceTokens = Number.isInteger(maxSourceTokensParsed) && maxSourceTokensParsed > 0\n      ? maxSourceTokensParsed\n      : DEFAULT_SOURCE_TOKEN_BUDGET;\n    const enforceTokenBudget = String(enforceTokenBudgetRaw || 'false').toLowerCase() === 'true';\n    if (fs.existsSync(statePath)) {\n      readState(statePath);\n    }\n    const state = buildInitialState({\n      mode,\n      chunkSize,\n      maxSourceTokens,\n      enforceTokenBudget,\n      files\n    });\n    saveState(statePath, state);\n    console.log(JSON.stringify({\n      ok: true,\n      statePath,\n      summary: summarize(state)\n    }, null, 2));\n    return;\n  }\n\n`
  );

  replaceSection(
    'scripts/bug-hunter-state.cjs',
    "  if (command === 'record-findings') {",
    "  if (command === 'hash-filter') {",
    `  if (command === 'record-findings') {\n    const [statePath, findingsJsonPath, source = 'unknown', confidenceThresholdRaw] = args;\n    if (!statePath || !findingsJsonPath) {\n      usage();\n      process.exit(1);\n    }\n    const confidenceThreshold = Number.isInteger(Number.parseInt(String(confidenceThresholdRaw || ''), 10))\n      ? Number.parseInt(confidenceThresholdRaw, 10)\n      : 75;\n    const state = readState(statePath);\n    const findings = readJson(findingsJsonPath);\n    const validation = validateArtifactValue({\n      artifactName: 'findings',\n      value: findings\n    });\n    if (!validation.ok) {\n      throw new Error(\`Invalid findings artifact: \${validation.errors.join('; ')}\`);\n    }\n    const merged = mergeFindingsIntoState({\n      state,\n      findings,\n      source,\n      confidenceThreshold\n    });\n    saveState(statePath, state);\n    console.log(JSON.stringify({\n      ok: true,\n      ...merged,\n      metrics: state.metrics\n    }, null, 2));\n    return;\n  }\n\n`
  );

  replaceSection(
    'scripts/bug-hunter-state.cjs',
    "  if (command === 'hash-filter') {",
    "  if (command === 'hash-update') {",
    `  if (command === 'hash-filter') {\n    const [statePath, filesJsonPath] = args;\n    if (!statePath || !filesJsonPath) {\n      usage();\n      process.exit(1);\n    }\n    const state = readState(statePath);\n    const files = readJson(filesJsonPath);\n    assertArray(files, 'filesJson');\n\n    const scan = [];\n    const skip = [];\n    const missing = [];\n    const unreadable = [];\n\n    for (const filePath of files) {\n      const normalized = String(filePath);\n      if (!fs.existsSync(normalized)) {\n        missing.push(normalized);\n        setFileStatus({ state, filePath: normalized, status: 'missing' });\n        continue;\n      }\n      try {\n        const currentHash = hashFile(normalized);\n        const previous = state.hashCache[normalized];\n        if (previous && previous.hash === currentHash) {\n          skip.push(normalized);\n          setFileStatus({\n            state,\n            filePath: normalized,\n            status: 'skipped',\n            hash: currentHash\n          });\n        } else {\n          scan.push(normalized);\n          setFileStatus({\n            state,\n            filePath: normalized,\n            status: 'pending',\n            hash: currentHash\n          });\n        }\n      } catch {\n        unreadable.push(normalized);\n        setFileStatus({ state, filePath: normalized, status: 'unreadable' });\n      }\n    }\n\n    updateFileMetrics(state);\n    saveState(statePath, state);\n    console.log(JSON.stringify({ ok: true, scan, skip, missing, unreadable }, null, 2));\n    return;\n  }\n\n  if (command === 'hash-verify') {\n    const [statePath, filesJsonPath] = args;\n    if (!statePath || !filesJsonPath) {\n      usage();\n      process.exit(1);\n    }\n    const state = readState(statePath);\n    const files = readJson(filesJsonPath);\n    assertArray(files, 'filesJson');\n    const result = verifyPendingFiles({ state, files });\n    if (result.changed.length > 0 || result.missing.length > 0 || result.unreadable.length > 0) {\n      updateFileMetrics(state);\n      saveState(statePath, state);\n    }\n    console.log(JSON.stringify({ ok: true, ...result }, null, 2));\n    return;\n  }\n\n  if (command === 'commit-chunk') {\n    const [\n      statePath,\n      chunkId,\n      filesJsonPath,\n      findingsJsonPath,\n      factCardJsonPath,\n      confidenceThresholdRaw,\n      source = 'orchestrator'\n    ] = args;\n    if (!statePath || !chunkId || !filesJsonPath || !findingsJsonPath || !factCardJsonPath) {\n      usage();\n      process.exit(1);\n    }\n    const confidenceThreshold = Number.isInteger(Number.parseInt(String(confidenceThresholdRaw || ''), 10))\n      ? Number.parseInt(confidenceThresholdRaw, 10)\n      : 75;\n    const state = readState(statePath);\n    const chunk = state.chunks.find((entry) => entry.id === chunkId);\n    if (!chunk) {\n      throw new Error(\`Unknown chunk id: \${chunkId}\`);\n    }\n    const files = readJson(filesJsonPath);\n    const findings = readJson(findingsJsonPath);\n    const factCard = readJson(factCardJsonPath);\n    assertArray(files, 'filesJson');\n    const validation = validateArtifactValue({ artifactName: 'findings', value: findings });\n    if (!validation.ok) {\n      throw new Error(\`Invalid findings artifact: \${validation.errors.join('; ')}\`);\n    }\n    const allowedFiles = new Set(files.map((filePath) => path.resolve(String(filePath))));\n    const outsideFinding = findings.find((finding) => {\n      return !allowedFiles.has(path.resolve(String(finding.file || '')));\n    });\n    if (outsideFinding) {\n      const errorMessage = \`Finding is outside the assigned chunk scope: \${outsideFinding.file}\`;\n      markChunkFailed(state, chunk, errorMessage);\n      saveState(statePath, state);\n      console.log(JSON.stringify({ ok: false, error: errorMessage }, null, 2));\n      return;\n    }\n    const verification = verifyPendingFiles({ state, files });\n    if (verification.changed.length > 0\n      || verification.missing.length > 0\n      || verification.unreadable.length > 0) {\n      const errorMessage = 'Assigned source changed, disappeared, or became unreadable during worker execution';\n      markChunkFailed(state, chunk, errorMessage);\n      saveState(statePath, state);\n      console.log(JSON.stringify({\n        ok: false,\n        error: errorMessage,\n        verification\n      }, null, 2));\n      return;\n    }\n    const merged = mergeFindingsIntoState({\n      state,\n      findings,\n      source,\n      confidenceThreshold\n    });\n    for (const filePath of files) {\n      const normalized = String(filePath);\n      const currentHash = verification.hashes[normalized];\n      state.hashCache[normalized] = {\n        hash: currentHash,\n        status: 'scanned',\n        scannedAt: nowIso()\n      };\n      setFileStatus({\n        state,\n        filePath: normalized,\n        status: 'scanned',\n        hash: currentHash\n      });\n    }\n    state.factCards[chunkId] = normalizedFactCard(chunkId, factCard);\n    chunk.status = 'done';\n    chunk.completedAt = nowIso();\n    chunk.lastError = null;\n    state.metrics.chunksDone = state.chunks.filter((entry) => entry.status === 'done').length;\n    updateFileMetrics(state);\n    saveState(statePath, state);\n    console.log(JSON.stringify({\n      ok: true,\n      chunkId,\n      ...merged,\n      metrics: state.metrics\n    }, null, 2));\n    return;\n  }\n\n`
  );

  replaceSection(
    'scripts/bug-hunter-state.cjs',
    "  if (command === 'hash-update') {",
    "  if (command === 'append-files') {",
    `  if (command === 'hash-update') {\n    const [statePath, filesJsonPath, cacheStatus = 'scanned'] = args;\n    if (!statePath || !filesJsonPath) {\n      usage();\n      process.exit(1);\n    }\n    const state = readState(statePath);\n    const files = readJson(filesJsonPath);\n    assertArray(files, 'filesJson');\n    if (!VALID_FILE_STATUS.has(cacheStatus)) {\n      throw new Error(\`Invalid hash cache status: \${cacheStatus}\`);\n    }\n    const updatedFiles = [];\n    const missing = [];\n    const unreadable = [];\n\n    for (const filePath of files) {\n      const normalized = String(filePath);\n      if (!fs.existsSync(normalized)) {\n        missing.push(normalized);\n        setFileStatus({ state, filePath: normalized, status: 'missing' });\n        continue;\n      }\n      try {\n        const currentHash = hashFile(normalized);\n        state.hashCache[normalized] = {\n          hash: currentHash,\n          status: cacheStatus,\n          scannedAt: nowIso()\n        };\n        setFileStatus({\n          state,\n          filePath: normalized,\n          status: cacheStatus,\n          hash: currentHash\n        });\n        updatedFiles.push(normalized);\n      } catch {\n        unreadable.push(normalized);\n        setFileStatus({ state, filePath: normalized, status: 'unreadable' });\n      }\n    }\n\n    updateFileMetrics(state);\n    saveState(statePath, state);\n    console.log(JSON.stringify({\n      ok: true,\n      updated: updatedFiles.length,\n      missing,\n      unreadable,\n      updatedFiles\n    }, null, 2));\n    return;\n  }\n\n`
  );

  replaceOnce(
    'scripts/bug-hunter-state.cjs',
    `    const newChunks = splitChunks(toAppend, state.chunkSize)\n      .map((chunk, index) => {\n`,
    `    const newChunks = splitChunks(\n      toAppend,\n      state.chunkSize,\n      state.maxSourceTokens,\n      state.enforceTokenBudget\n    ).map((chunk, index) => {\n`,
    'token-aware appended chunks'
  );
}

function writeChunkScheduler() {
  write('scripts/chunk-scheduler.cjs', `const fs = require('fs');\nconst path = require('path');\nconst { validateArtifactFile } = require('./schema-runtime.cjs');\nconst {\n  appendJournal,\n  fillTemplate,\n  runJsonScript,\n  runWithRetry\n} = require('./process-runner.cjs');\n\nfunction ensureDir(dirPath) {\n  fs.mkdirSync(dirPath, { recursive: true });\n}\n\nfunction readJson(filePath) {\n  return JSON.parse(fs.readFileSync(filePath, 'utf8'));\n}\n\nfunction writeJson(filePath, value) {\n  ensureDir(path.dirname(filePath));\n  fs.writeFileSync(filePath, \`\${JSON.stringify(value, null, 2)}\\n\`, 'utf8');\n}\n\nfunction toArray(value) {\n  return Array.isArray(value) ? value : [];\n}\n\nfunction nowIso() {\n  return new Date().toISOString();\n}\n\nfunction removeFileIfExists(filePath) {\n  if (filePath && fs.existsSync(filePath)) {\n    fs.unlinkSync(filePath);\n  }\n}\n\nfunction canonicalFilePath(filePath) {\n  const resolved = path.resolve(String(filePath));\n  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;\n}\n\nfunction normalizeFindingsToScope({ findings, scanFiles }) {\n  const allowed = new Map(scanFiles.map((filePath) => {\n    const canonical = canonicalFilePath(filePath);\n    return [canonical, canonical];\n  }));\n  const normalized = [];\n  const errors = [];\n\n  for (const finding of toArray(findings)) {\n    const canonical = canonicalFilePath(finding && finding.file);\n    const assigned = allowed.get(canonical);\n    if (!assigned) {\n      errors.push(\`Finding \${String((finding && finding.bugId) || '<unknown>')} targets an unassigned file: \${String((finding && finding.file) || '')}\`);\n      continue;\n    }\n    normalized.push({\n      ...finding,\n      file: assigned\n    });\n  }\n  return {\n    ok: errors.length === 0,\n    errors,\n    findings: normalized\n  };\n}\n\nfunction validateFindingsArtifact(findingsJsonPath) {\n  if (!fs.existsSync(findingsJsonPath)) {\n    return {\n      ok: false,\n      errors: [\`Missing findings artifact: \${findingsJsonPath}\`]\n    };\n  }\n  return validateArtifactFile({\n    artifactName: 'findings',\n    filePath: findingsJsonPath\n  });\n}\n\nfunction buildHeuristicFactCard({ chunkId, scanFiles, findings, index }) {\n  const files = toArray(scanFiles).map((item) => path.resolve(String(item)));\n  const findingsList = toArray(findings);\n  const apiContracts = [];\n  const authAssumptions = [];\n  const invariants = [];\n\n  for (const filePath of files) {\n    const meta = index && index.files ? index.files[filePath] : null;\n    if (!meta) {\n      continue;\n    }\n    const relative = meta.relativePath || filePath;\n    const boundaries = toArray(meta.trustBoundaries);\n    if (boundaries.includes('external-input')) {\n      apiContracts.push(\`\${relative}: external-input boundary\`);\n    }\n    if (boundaries.includes('auth')) {\n      authAssumptions.push(\`\${relative}: auth boundary must preserve identity and authorization checks\`);\n    }\n    if (boundaries.includes('data-store')) {\n      invariants.push(\`\${relative}: data-store writes must keep state transitions atomic\`);\n    }\n  }\n\n  for (const finding of findingsList) {\n    const claim = String((finding && finding.claim) || '').trim();\n    if (claim) {\n      invariants.push(\`Finding invariant: \${claim}\`);\n    }\n  }\n\n  return {\n    chunkId,\n    createdAt: nowIso(),\n    apiContracts: [...new Set(apiContracts)].slice(0, 10),\n    authAssumptions: [...new Set(authAssumptions)].slice(0, 10),\n    invariants: [...new Set(invariants)].slice(0, 12)\n  };\n}\n\nasync function processPendingChunks({\n  statePath,\n  stateScript,\n  chunksDir,\n  journalPath,\n  workerCmdTemplate,\n  timeoutMs,\n  maxOutputBytes,\n  killGraceMs,\n  maxRetries,\n  backoffMs,\n  failFast,\n  backend,\n  mode,\n  skillDir,\n  index,\n  confidenceThreshold\n}) {\n  while (true) {\n    const next = runJsonScript(stateScript, ['next-chunk', statePath]);\n    if (next.done) {\n      break;\n    }\n    const chunk = next.chunk;\n    const chunkFilesJsonPath = path.join(chunksDir, \`\${chunk.id}-files.json\`);\n    const scanFilesJsonPath = path.join(chunksDir, \`\${chunk.id}-scan-files.json\`);\n    const findingsJsonPath = path.join(chunksDir, \`\${chunk.id}-findings.json\`);\n    const factsJsonPath = path.join(chunksDir, \`\${chunk.id}-facts.json\`);\n    writeJson(chunkFilesJsonPath, chunk.files);\n\n    const hashFilterResult = runJsonScript(stateScript, ['hash-filter', statePath, chunkFilesJsonPath]);\n    const scanFiles = hashFilterResult.scan || [];\n    const unavailableFiles = [\n      ...(hashFilterResult.missing || []),\n      ...(hashFilterResult.unreadable || [])\n    ];\n    if (unavailableFiles.length > 0) {\n      const preview = unavailableFiles.slice(0, 3).join(', ');\n      const suffix = unavailableFiles.length > 3 ? \` (+\${unavailableFiles.length - 3} more)\` : '';\n      const errorMessage = \`Assigned files are missing or unreadable before scanning: \${preview}\${suffix}\`;\n      appendJournal(journalPath, {\n        event: 'chunk-scope-unavailable',\n        chunkId: chunk.id,\n        unavailableCount: unavailableFiles.length,\n        unavailableFiles: unavailableFiles.slice(0, 20)\n      });\n      runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'failed', errorMessage.slice(0, 240)]);\n      if (failFast) {\n        throw new Error(\`Chunk \${chunk.id} has unavailable assigned files and fail-fast is enabled\`);\n      }\n      continue;\n    }\n    if (scanFiles.length === 0) {\n      appendJournal(journalPath, {\n        event: 'chunk-skip',\n        chunkId: chunk.id,\n        reason: 'hash-cache-no-changes'\n      });\n      runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'done']);\n      continue;\n    }\n\n    writeJson(scanFilesJsonPath, scanFiles);\n    removeFileIfExists(findingsJsonPath);\n    removeFileIfExists(factsJsonPath);\n    runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'in_progress']);\n\n    const command = fillTemplate(workerCmdTemplate, {\n      chunkId: chunk.id,\n      chunkFilesJson: chunkFilesJsonPath,\n      scanFilesJson: scanFilesJsonPath,\n      findingsJson: findingsJsonPath,\n      factsJson: factsJsonPath,\n      backend,\n      mode,\n      statePath,\n      skillDir\n    });\n\n    const runResult = await runWithRetry({\n      command,\n      timeoutMs,\n      maxRetries,\n      backoffMs,\n      journalPath,\n      phase: 'chunk-worker',\n      chunkId: chunk.id,\n      maxOutputBytes,\n      killGraceMs,\n      beforeAttempt: async () => {\n        removeFileIfExists(findingsJsonPath);\n        removeFileIfExists(factsJsonPath);\n      },\n      postAttempt: async () => {\n        const findingsValidation = validateFindingsArtifact(findingsJsonPath);\n        if (!findingsValidation.ok) {\n          return {\n            ok: false,\n            errorMessage: findingsValidation.errors.join('; ')\n          };\n        }\n        const findings = readJson(findingsJsonPath);\n        const scoped = normalizeFindingsToScope({ findings, scanFiles });\n        if (!scoped.ok) {\n          return {\n            ok: false,\n            errorMessage: scoped.errors.join('; ')\n          };\n        }\n        writeJson(findingsJsonPath, scoped.findings);\n        return { ok: true };\n      }\n    });\n\n    if (!runResult.ok) {\n      const errorMessage = (runResult.result && runResult.result.stderr) || 'worker failed';\n      runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'failed', errorMessage.slice(0, 240)]);\n      appendJournal(journalPath, {\n        event: 'chunk-failed',\n        chunkId: chunk.id,\n        errorMessage: errorMessage.slice(0, 500)\n      });\n      if (failFast) {\n        throw new Error(\`Chunk \${chunk.id} failed and fail-fast is enabled\`);\n      }\n      continue;\n    }\n\n    const findings = readJson(findingsJsonPath);\n    if (!fs.existsSync(factsJsonPath)) {\n      writeJson(factsJsonPath, buildHeuristicFactCard({\n        chunkId: chunk.id,\n        scanFiles,\n        findings,\n        index\n      }));\n    }\n\n    const commitResult = runJsonScript(stateScript, [\n      'commit-chunk',\n      statePath,\n      chunk.id,\n      scanFilesJsonPath,\n      findingsJsonPath,\n      factsJsonPath,\n      String(confidenceThreshold),\n      'orchestrator'\n    ]);\n    if (!commitResult.ok) {\n      appendJournal(journalPath, {\n        event: 'chunk-integrity-failed',\n        chunkId: chunk.id,\n        errorMessage: String(commitResult.error || 'chunk integrity failed').slice(0, 500),\n        verification: commitResult.verification || null\n      });\n      if (failFast) {\n        throw new Error(\`Chunk \${chunk.id} failed its integrity commit and fail-fast is enabled\`);\n      }\n      continue;\n    }\n\n    appendJournal(journalPath, {\n      event: 'chunk-done',\n      chunkId: chunk.id,\n      attemptsUsed: runResult.attemptsUsed\n    });\n  }\n}\n\nmodule.exports = {\n  processPendingChunks\n};\n`);
}

function patchArtifactPlanner() {
  replaceOnce(
    'scripts/artifact-planner.cjs',
    `const path = require('path');\n`,
    `const fs = require('fs');\nconst path = require('path');\n`,
    'artifact planner fs import'
  );

  replaceSection(
    'scripts/artifact-planner.cjs',
    'function buildFixerScope({ runIdentity, authorizedFindings, fixPlan }) {',
    'module.exports = {',
    `function buildFixerScope({ runIdentity, authorizedFindings, fixPlan }) {\n  const repositoryRoot = fs.realpathSync(runIdentity.repositoryRoot);\n  const findingsById = new Map();\n\n  for (const finding of authorizedFindings) {\n    const bugId = String(finding.bugId || '').trim();\n    if (!bugId) {\n      throw new Error('Referee-authorized finding is missing a bug ID');\n    }\n    if (findingsById.has(bugId)) {\n      throw new Error(\`Duplicate Referee-authorized bug ID: \${bugId}\`);\n    }\n    const resolvedFile = path.resolve(String(finding.file));\n    if (!fs.existsSync(resolvedFile)) {\n      throw new Error(\`Referee-authorized file does not exist: \${finding.file}\`);\n    }\n    const realFile = fs.realpathSync(resolvedFile);\n    const relative = path.relative(repositoryRoot, realFile);\n    if (relative.startsWith('..') || path.isAbsolute(relative)) {\n      throw new Error(\`Referee-authorized file is outside the repository root: \${finding.file}\`);\n    }\n    findingsById.set(bugId, { finding, realFile });\n  }\n\n  const planEntries = [\n    ...toArray(fixPlan && fixPlan.canary),\n    ...toArray(fixPlan && fixPlan.rollout),\n    ...toArray(fixPlan && fixPlan.manualReview)\n  ];\n  for (const entry of planEntries) {\n    const bugId = String(entry.bugId || '').trim();\n    const authorized = findingsById.get(bugId);\n    if (!authorized) {\n      throw new Error(\`Fix plan expanded beyond Referee authorization: \${bugId} at \${entry.file}\`);\n    }\n    const resolvedEntry = path.resolve(String(entry.file || ''));\n    const realEntry = fs.existsSync(resolvedEntry)\n      ? fs.realpathSync(resolvedEntry)\n      : resolvedEntry;\n    if (realEntry !== authorized.realFile) {\n      throw new Error(\`Fix plan expanded beyond Referee authorization: \${bugId} at \${entry.file}\`);\n    }\n  }\n\n  const executableEntries = [\n    ...toArray(fixPlan && fixPlan.canary),\n    ...toArray(fixPlan && fixPlan.rollout)\n  ];\n  const approvedBugIds = new Set();\n  const approvedFiles = new Set();\n  for (const entry of executableEntries) {\n    const bugId = String(entry.bugId || '').trim();\n    const authorized = findingsById.get(bugId);\n    approvedBugIds.add(bugId);\n    approvedFiles.add(authorized.realFile);\n  }\n\n  return {\n    schemaVersion: 1,\n    runId: runIdentity.runId,\n    repositoryRoot,\n    baseCommit: runIdentity.baseCommit,\n    approvedBugIds: [...approvedBugIds].sort(),\n    approvedFiles: [...approvedFiles].sort()\n  };\n}\n\n`
  );
}

function patchRunBugHunter() {
  replaceOnce(
    'scripts/run-bug-hunter.cjs',
    `  assertRunIdentity,\n  buildRunIdentity,\n  requeueResumableChunks,\n`,
    `  assertRunIdentity,\n  buildRunIdentity,\n  getRepositoryIdentity,\n  normalizeRunFiles,\n  requeueResumableChunks,\n`,
    'run state-store imports'
  );
  replaceOnce(
    'scripts/run-bug-hunter.cjs',
    `  DEFAULT_SOURCE_TOKEN_BUDGET,\n  MAX_FILES_PER_CHUNK\n`,
    `  DEFAULT_SOURCE_TOKEN_BUDGET,\n  MAX_FILES_PER_CHUNK,\n  buildSourceChunks\n`,
    'run source chunk import'
  );

  replaceSection(
    'scripts/run-bug-hunter.cjs',
    'function estimateSourceTokens(filePath) {',
    'function resolveSkillDir(options) {',
    ''
  );

  replaceOnce(
    'scripts/run-bug-hunter.cjs',
    `  const scope = prepareIndexAndScope({\n    options,\n    skillDir,\n    statePath,\n    filesJsonPath,\n    journalPath\n  });\n  const activeFiles = readJson(scope.activeFilesJsonPath);\n  if (!Array.isArray(activeFiles)) {\n    throw new Error('Active files JSON must contain an array');\n  }\n  const chunkSize = requestedChunkSize || deriveAdaptiveChunkSize(activeFiles, maxSourceTokens);\n\n  const runIdentity = buildRunIdentity({\n`,
    `  const repositoryIdentity = getRepositoryIdentity();\n  const requestedFiles = readJson(filesJsonPath);\n  if (!Array.isArray(requestedFiles)) {\n    throw new Error('--files-json must contain an array');\n  }\n  const normalizedInputFiles = normalizeRunFiles(\n    requestedFiles,\n    repositoryIdentity.repositoryRoot,\n    { allowMissing: true }\n  );\n  const normalizedFilesJsonPath = path.resolve(\n    path.dirname(statePath),\n    'scope-files.json'\n  );\n  writeJson(normalizedFilesJsonPath, normalizedInputFiles);\n\n  const scope = prepareIndexAndScope({\n    options,\n    skillDir,\n    statePath,\n    filesJsonPath: normalizedFilesJsonPath,\n    journalPath\n  });\n  const activeFilesRaw = readJson(scope.activeFilesJsonPath);\n  if (!Array.isArray(activeFilesRaw)) {\n    throw new Error('Active files JSON must contain an array');\n  }\n  const activeFiles = normalizeRunFiles(\n    activeFilesRaw,\n    repositoryIdentity.repositoryRoot,\n    { allowMissing: true }\n  );\n  writeJson(scope.activeFilesJsonPath, activeFiles);\n  const chunkSize = requestedChunkSize || DEFAULT_CHUNK_SIZE;\n  const tokenBudgetEnforced = requestedChunkSize === null;\n\n  const runIdentity = buildRunIdentity({\n`,
    'normalize run scope before state'
  );

  replaceOnce(
    'scripts/run-bug-hunter.cjs',
    `    filesJsonPath: scope.activeFilesJsonPath,\n    chunkSize,\n    timeoutMs,\n`,
    `    filesJsonPath: scope.activeFilesJsonPath,\n    chunkSize,\n    maxSourceTokens,\n    tokenBudgetEnforced,\n    timeoutMs,\n`,
    'run identity token options'
  );

  replaceOnce(
    'scripts/run-bug-hunter.cjs',
    `    runJsonScript(stateScript, ['init', statePath, mode, scope.activeFilesJsonPath, String(chunkSize)]);\n`,
    `    runJsonScript(stateScript, [\n      'init',\n      statePath,\n      mode,\n      scope.activeFilesJsonPath,\n      String(chunkSize),\n      String(maxSourceTokens),\n      String(tokenBudgetEnforced)\n    ]);\n`,
    'initialize token-aware state'
  );

  replaceOnce(
    'scripts/run-bug-hunter.cjs',
    `    chunkSize,\n    maxSourceTokens,\n    timeoutMs,\n`,
    `    chunkSize,\n    maxSourceTokens,\n    tokenBudgetEnforced,\n    timeoutMs,\n`,
    'journal token enforcement'
  );

  replaceOnce(
    'scripts/run-bug-hunter.cjs',
    `      const expandedFiles = [\n        ...toArray(expansion.expanded),\n        ...toArray(expansion.overlayOnly)\n      ];\n`,
    `      const expandedFiles = toArray(expansion.prioritized).length > 0\n        ? toArray(expansion.prioritized)\n        : [\n          ...toArray(expansion.overlayOnly),\n          ...toArray(expansion.expanded)\n        ];\n`,
    'prioritize delta overlays'
  );

  replaceRegex(
    'scripts/run-bug-hunter.cjs',
    /    const chunkSize = requestedChunkSize \|\| deriveAdaptiveChunkSize\(files, maxSourceTokens\);\n    const totalFiles = files\.length;\n\n    const chunks = \[\];\n    for \(let i = 0; i < totalFiles; i \+= chunkSize\) \{\n      const chunkFiles = files\.slice\(i, i \+ chunkSize\);\n      chunks\.push\(\{\n        id: `chunk-\$\{chunks\.length \+ 1\}`,\n        files: chunkFiles,\n        fileCount: chunkFiles\.length,\n        status: 'pending'\n      \}\);\n    \}/,
    `    const maxFilesPerChunk = requestedChunkSize || DEFAULT_CHUNK_SIZE;\n    const tokenBudgetEnforced = requestedChunkSize === null;\n    const totalFiles = files.length;\n    const plannedChunks = buildSourceChunks(files, {\n      maxFiles: maxFilesPerChunk,\n      maxSourceTokens,\n      enforceTokenBudget: tokenBudgetEnforced\n    });\n    const chunks = plannedChunks.map((plannedChunk, index) => {\n      return {\n        id: \`chunk-\${index + 1}\`,\n        files: plannedChunk.files,\n        fileCount: plannedChunk.files.length,\n        estimatedSourceTokens: plannedChunk.estimatedSourceTokens,\n        oversized: plannedChunk.oversized,\n        status: 'pending'\n      };\n    });\n    const chunkSize = chunks.reduce((max, chunk) => {\n      return Math.max(max, chunk.fileCount);\n    }, 0);`,
    'plan concrete token chunks'
  );

  replaceOnce(
    'scripts/run-bug-hunter.cjs',
    `      chunkSize,\n      maxSourceTokens,\n      chunkCount: chunks.length,\n`,
    `      chunkSize,\n      maxFilesPerChunk,\n      maxSourceTokens,\n      tokenBudgetEnforced,\n      chunkCount: chunks.length,\n`,
    'plan token metadata'
  );
}

function patchDocs() {
  replaceOnce(
    'docs/precision-protocol.md',
    `Unless the caller supplies \`--chunk-size\`, the runtime estimates source tokens\nfrom file bytes and chooses a 1-30 file chunk using a 48,000-source-token budget.\nThe 75th-percentile file size is used so a few tiny files cannot hide a mostly\nlarge chunk. Use \`--max-source-tokens\` to tune the budget for a model or agent.\n`,
    `Unless the caller supplies \`--chunk-size\`, the runtime estimates source tokens\nfrom every assigned file and greedily builds risk-ordered 1-30 file chunks whose\ncombined estimate stays within a 48,000-source-token budget. A single oversized\nfile is isolated and explicitly marked oversized instead of silently inflating a\nmixed chunk. Use \`--max-source-tokens\` to tune the budget for a model or agent.\n`,
    'docs exact token chunks'
  );

  appendOnce(
    'docs/precision-protocol.md',
    '## 7. Scope and evidence integrity',
    `## 7. Scope and evidence integrity\n\nRun scope is canonicalized through real paths and must remain inside the Git\nrepository. Hunter findings are accepted only for the exact files assigned to\nthe current chunk. The source hashes captured before dispatch are verified again\nbefore findings, fact cards, hashes, and chunk completion are committed in one\nstate transaction. Source mutation, deletion, unreadability, or symlink escape\nfails the chunk closed.\n\nFixer scope contains only canary and rollout entries. Confirmed findings that are\nclassified for manual review or report-only remediation never become writable\nFixer authorization.\n\n## 8. Stable evidence merge\n\nDuplicate observations retain the strongest confidence-backed evidence, union\ncross-references, preserve security STRIDE/CWE metadata, and receive unique\nstable IDs when separate bugs collide on a worker-provided ID. Large-file cache\nkeys use streaming SHA-256 rather than size and timestamp surrogates.`
  );
}

function recordPass() {
  let progress = read('.loop/progress.md');
  progress = progress.replace(/- \[ \] Audit scope integrity/g, '- [x] Audit scope integrity');
  progress = progress.replace(/- \[ \] Preserve risk order/g, '- [x] Preserve risk order');
  progress = progress.replace(/- \[ \] Enforce the source-token budget/g, '- [x] Enforce the source-token budget');
  progress = progress.replace(/- \[ \] Align extensionless shebang discovery/g, '- [x] Align extensionless shebang discovery');
  progress = progress.replace(/- \[ \] Audit state, hash-cache, retry, resume, and failure semantics/g, '- [x] Audit state, hash-cache, retry, resume, and failure semantics');
  progress = progress.replace(/- \[ \] Add adversarial regression tests/g, '- [x] Add adversarial regression tests');
  progress = progress.replace(/- \[ \] Re-run the sealed gate/g, '- [x] Re-run the sealed gate');
  write('.loop/progress.md', progress);

  appendOnce(
    '.loop/journal.md',
    '## Iteration 12 — deep precision hardening — passed',
    `## Iteration 12 — deep precision hardening — passed\n\nThe nine adversarial regressions now pass. The sealed check exited 0 with all\n190 tests passing, generated assets current, preflight successful, and package\ninventory valid. Scope is realpath-contained, findings are chunk-bound, worker\nsource mutation fails closed, token budgets are enforced per concrete chunk,\nevidence merges preserve security metadata, large files use SHA-256, and Fixer\nauthorization excludes manual-review and report-only findings.`
  );
}

if (process.argv.includes('--record-pass')) {
  recordPass();
} else {
  patchTriage();
  patchCodeIndex();
  patchDeltaMode();
  writeStateStore();
  patchBugHunterState();
  writeChunkScheduler();
  patchArtifactPlanner();
  patchRunBugHunter();
  patchDocs();
}
