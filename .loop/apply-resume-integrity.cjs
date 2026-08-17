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

function appendOnce(filePath, marker, text) {
  const content = read(filePath);
  if (content.includes(marker)) {
    return;
  }
  write(filePath, `${content.replace(/\s*$/, '')}\n\n${text.replace(/\s*$/, '')}\n`);
}

function patchStateStore() {
  replaceOnce(
    'scripts/state-store.cjs',
    `function isOutsideRoot(repositoryRoot, candidatePath) {\n  const relative = path.relative(repositoryRoot, candidatePath);\n  return relative.startsWith('..') || path.isAbsolute(relative);\n}\n`,
    `function isOutsideRoot(repositoryRoot, candidatePath) {\n  const relative = path.relative(repositoryRoot, candidatePath);\n  return relative === '..'\n    || relative.startsWith(\`..\${path.sep}\`)\n    || path.isAbsolute(relative);\n}\n`,
    'root containment boundary'
  );
}

function patchArtifactPlanner() {
  replaceOnce(
    'scripts/artifact-planner.cjs',
    `    if (relative.startsWith('..') || path.isAbsolute(relative)) {\n`,
    `    if (relative === '..'\n      || relative.startsWith(\`..\${path.sep}\`)\n      || path.isAbsolute(relative)) {\n`,
    'Fixer realpath containment boundary'
  );
}

function patchCoverage() {
  replaceOnce(
    'scripts/run-bug-hunter.cjs',
    `  if (chunkStatus === 'done') {\n    return 'done';\n  }\n  return 'pending';\n`,
    `  return 'pending';\n`,
    'chunk status cannot manufacture file evidence'
  );
  replaceOnce(
    'scripts/run-bug-hunter.cjs',
    `  const hasOpenChunks = toArray(state.chunks).some((chunk) => chunk.status !== 'done');\n\n  return {\n    schemaVersion: 1,\n    iteration: 1,\n    status: hasOpenChunks ? 'IN_PROGRESS' : 'COMPLETE',\n`,
    `  const hasIncompleteFiles = fileEntries.some((entry) => entry.status !== 'done');\n\n  return {\n    schemaVersion: 1,\n    iteration: 1,\n    status: hasIncompleteFiles ? 'IN_PROGRESS' : 'COMPLETE',\n`,
    'coverage completion derives from file evidence'
  );
}

function patchStateEvidence() {
  replaceOnce(
    'scripts/bug-hunter-state.cjs',
    `function setFileStatus({ state, filePath, status, hash }) {\n  if (!VALID_FILE_STATUS.has(status)) {\n    throw new Error(\`Invalid file status: \${status}\`);\n  }\n  const nextState = {\n    status,\n    updatedAt: nowIso()\n  };\n  if (hash) {\n    nextState.hash = hash;\n  }\n  state.fileStates[filePath] = nextState;\n}\n`,
    `function setFileStatus({\n  state,\n  filePath,\n  status,\n  hash,\n  initialHash,\n  observedHash,\n  clearObservedHash = false\n}) {\n  if (!VALID_FILE_STATUS.has(status)) {\n    throw new Error(\`Invalid file status: \${status}\`);\n  }\n  const previous = state.fileStates[filePath]\n    && typeof state.fileStates[filePath] === 'object'\n    && !Array.isArray(state.fileStates[filePath])\n    ? state.fileStates[filePath]\n    : {};\n  const nextState = {\n    ...previous,\n    status,\n    updatedAt: nowIso()\n  };\n  if (hash) {\n    nextState.hash = hash;\n  }\n  if (initialHash) {\n    nextState.initialHash = initialHash;\n  }\n  if (observedHash) {\n    nextState.observedHash = observedHash;\n  }\n  if (clearObservedHash) {\n    delete nextState.observedHash;\n  }\n  state.fileStates[filePath] = nextState;\n}\n`,
    'preserve source evidence fields'
  );

  replaceOnce(
    'scripts/bug-hunter-state.cjs',
    `      const failedFileStates = Object.fromEntries(chunk.files\n        .filter((filePath) => {\n          const fileState = state.fileStates[String(filePath)];\n          return !fileState || fileState.status === 'pending';\n        })\n        .map((filePath) => {\n          return [String(filePath), {\n            status: 'failed',\n            updatedAt: failedAt\n          }];\n        }));\n`,
    `      const failedFileStates = Object.fromEntries(chunk.files\n        .filter((filePath) => {\n          const fileState = state.fileStates[String(filePath)];\n          return !fileState || fileState.status === 'pending';\n        })\n        .map((filePath) => {\n          const normalized = String(filePath);\n          const fileState = state.fileStates[normalized];\n          return [normalized, {\n            ...(fileState || {}),\n            status: 'failed',\n            updatedAt: failedAt\n          }];\n        }));\n`,
    'preserve hashes when a worker attempt fails'
  );

  replaceSection(
    'scripts/bug-hunter-state.cjs',
    'function verifyPendingFiles({ state, files }) {',
    'function markChunkFailed(state, chunk, errorMessage) {',
    `function verifyPendingFiles({ state, files }) {\n  const verified = [];\n  const changed = [];\n  const missing = [];\n  const unreadable = [];\n  const hashes = {};\n\n  for (const filePath of files) {\n    const normalized = String(filePath);\n    if (!fs.existsSync(normalized)) {\n      missing.push(normalized);\n      setFileStatus({ state, filePath: normalized, status: 'missing' });\n      continue;\n    }\n    try {\n      const currentHash = hashFile(normalized);\n      const fileState = state.fileStates[normalized] || {};\n      const expectedHash = fileState.hash;\n      const initialHash = fileState.initialHash || expectedHash;\n      if (!expectedHash || expectedHash !== currentHash) {\n        changed.push(normalized);\n        setFileStatus({\n          state,\n          filePath: normalized,\n          status: 'failed',\n          hash: expectedHash || currentHash,\n          initialHash: initialHash || currentHash,\n          observedHash: currentHash\n        });\n        continue;\n      }\n      hashes[normalized] = currentHash;\n      verified.push(normalized);\n    } catch {\n      unreadable.push(normalized);\n      setFileStatus({ state, filePath: normalized, status: 'unreadable' });\n    }\n  }\n  return { verified, changed, missing, unreadable, hashes };\n}\n\n`
  );

  replaceOnce(
    'scripts/bug-hunter-state.cjs',
    `    if (!fileState || fileState.status === 'pending') {\n      state.fileStates[normalized] = {\n        status: 'failed',\n        updatedAt: failedAt\n      };\n    }\n`,
    `    if (!fileState || fileState.status === 'pending') {\n      state.fileStates[normalized] = {\n        ...(fileState || {}),\n        status: 'failed',\n        updatedAt: failedAt\n      };\n    }\n`,
    'preserve evidence in integrity failure helper'
  );

  replaceSection(
    'scripts/bug-hunter-state.cjs',
    "  if (command === 'hash-filter') {",
    "  if (command === 'hash-verify') {",
    `  if (command === 'hash-filter') {\n    const [statePath, filesJsonPath] = args;\n    if (!statePath || !filesJsonPath) {\n      usage();\n      process.exit(1);\n    }\n    const state = readState(statePath);\n    const files = readJson(filesJsonPath);\n    assertArray(files, 'filesJson');\n\n    const scan = [];\n    const skip = [];\n    const changed = [];\n    const missing = [];\n    const unreadable = [];\n\n    for (const filePath of files) {\n      const normalized = String(filePath);\n      if (!fs.existsSync(normalized)) {\n        missing.push(normalized);\n        setFileStatus({ state, filePath: normalized, status: 'missing' });\n        continue;\n      }\n      try {\n        const currentHash = hashFile(normalized);\n        const fileState = state.fileStates[normalized] || {};\n        const initialHash = fileState.initialHash || currentHash;\n        if (fileState.initialHash && fileState.initialHash !== currentHash) {\n          changed.push(normalized);\n          setFileStatus({\n            state,\n            filePath: normalized,\n            status: 'failed',\n            hash: fileState.hash || fileState.initialHash,\n            initialHash: fileState.initialHash,\n            observedHash: currentHash\n          });\n          continue;\n        }\n        const previous = state.hashCache[normalized];\n        if (previous && previous.hash === currentHash) {\n          skip.push(normalized);\n          setFileStatus({\n            state,\n            filePath: normalized,\n            status: 'skipped',\n            hash: currentHash,\n            initialHash,\n            clearObservedHash: true\n          });\n        } else {\n          scan.push(normalized);\n          setFileStatus({\n            state,\n            filePath: normalized,\n            status: 'pending',\n            hash: currentHash,\n            initialHash,\n            clearObservedHash: true\n          });\n        }\n      } catch {\n        unreadable.push(normalized);\n        setFileStatus({ state, filePath: normalized, status: 'unreadable' });\n      }\n    }\n\n    updateFileMetrics(state);\n    saveState(statePath, state);\n    console.log(JSON.stringify({ ok: true, scan, skip, changed, missing, unreadable }, null, 2));\n    return;\n  }\n\n`
  );

  replaceOnce(
    'scripts/bug-hunter-state.cjs',
    `      setFileStatus({\n        state,\n        filePath: normalized,\n        status: 'scanned',\n        hash: currentHash\n      });\n`,
    `      const fileState = state.fileStates[normalized] || {};\n      setFileStatus({\n        state,\n        filePath: normalized,\n        status: 'scanned',\n        hash: currentHash,\n        initialHash: fileState.initialHash || currentHash,\n        clearObservedHash: true\n      });\n`,
    'commit keeps the run baseline'
  );

  replaceOnce(
    'scripts/bug-hunter-state.cjs',
    `        setFileStatus({\n          state,\n          filePath: normalized,\n          status: cacheStatus,\n          hash: currentHash\n        });\n`,
    `        const fileState = state.fileStates[normalized] || {};\n        setFileStatus({\n          state,\n          filePath: normalized,\n          status: cacheStatus,\n          hash: currentHash,\n          initialHash: fileState.initialHash || currentHash,\n          clearObservedHash: true\n        });\n`,
    'hash update keeps the run baseline'
  );
}

function patchScheduler() {
  replaceOnce(
    'scripts/chunk-scheduler.cjs',
    `    const unavailableFiles = [\n      ...(hashFilterResult.missing || []),\n      ...(hashFilterResult.unreadable || [])\n    ];\n`,
    `    const unavailableFiles = [\n      ...(hashFilterResult.missing || []),\n      ...(hashFilterResult.unreadable || []),\n      ...(hashFilterResult.changed || [])\n    ];\n`,
    'scheduler sees run-baseline drift'
  );
  replaceOnce(
    'scripts/chunk-scheduler.cjs',
    `      const errorMessage = \`Assigned files are missing or unreadable before scanning: \${preview}\${suffix}\`;\n`,
    `      const errorMessage = \`Assigned files are missing, unreadable, or changed from the run baseline: \${preview}\${suffix}\`;\n`,
    'scheduler drift error'
  );
}

function patchDocs() {
  appendOnce(
    'docs/precision-protocol.md',
    '## 9. Resume immutability',
    `## 9. Resume immutability\n\nThe first readable hash observed for an assigned file is the immutable content\nbaseline for that run. A failed worker cannot establish a new baseline by\nmodifying source and then relying on \`--resume\`; resumed chunks reject drift\nbefore dispatch. Restoring the original bytes permits a normal retry. Coverage\nstatus is derived from per-file scan evidence, never from a parent chunk's\nstatus alone.`
  );
}

function recordPass() {
  let progress = read('.loop/progress.md');
  progress = progress.replace(
    '- [ ] Preserve the original pre-worker source hash across failed retries and resume.',
    '- [x] Preserve the original pre-worker source hash across failed retries and resume.'
  );
  progress = progress.replace(
    '- [ ] Reject resumed chunks when assigned source content drifted after a failed worker.',
    '- [x] Reject resumed chunks when assigned source content drifted after a failed worker.'
  );
  progress = progress.replace(
    '- [ ] Ensure chunk status alone can never report a pending file as completed coverage.',
    '- [x] Ensure chunk status alone can never report a pending file as completed coverage.'
  );
  progress = progress.replace(
    '- [ ] Accept valid in-repository paths whose basename starts with two dots while still rejecting escapes.',
    '- [x] Accept valid in-repository paths whose basename starts with two dots while still rejecting escapes.'
  );
  progress = progress.replace(
    '- [ ] Add regression tests for the post-hardening resume and coverage edge cases.',
    '- [x] Add regression tests for the post-hardening resume and coverage edge cases.'
  );
  progress = progress.replace(
    '- [ ] Re-run the sealed gate and final PR-triggered CI checks.',
    '- [ ] Re-run the sealed gate and final PR-triggered CI checks.'
  );
  write('.loop/progress.md', progress);

  appendOnce(
    '.loop/journal.md',
    '## Iteration 17 — resume integrity hardening — passed',
    `## Iteration 17 — resume integrity hardening — passed\n\nThe three post-hardening regressions pass and the sealed check exited 0 with\nall 193 tests passing. Per-run source baselines now survive failed attempts,\nresumed drift is rejected before worker dispatch, coverage completion requires\nper-file done evidence, and valid in-repository names beginning with \`..\` no\nlonger collide with the parent-directory escape check.`
  );
}

if (process.argv.includes('--record-pass')) {
  recordPass();
} else {
  patchStateStore();
  patchArtifactPlanner();
  patchCoverage();
  patchStateEvidence();
  patchScheduler();
  patchDocs();
}
