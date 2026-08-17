const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateArtifactFile } = require('./schema-runtime.cjs');
const { getEntry, hashDescriptor, putEntry } = require('./evidence-cache.cjs');
const {
  appendJournal,
  fillTemplate,
  runJsonScript,
  runWithRetry
} = require('./process-runner.cjs');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function nowIso() {
  return new Date().toISOString();
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function canonicalFilePath(filePath) {
  const resolved = path.resolve(String(filePath));
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function semanticJsonHash(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const value = readJson(filePath);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    value.generatedAt = null;
  }
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildEvidenceDescriptor({ statePath, scanFiles, adaptivePlanPath, retrievalPlanPath }) {
  const state = readJson(statePath);
  const sources = scanFiles.map((filePath) => {
    const canonical = canonicalFilePath(filePath);
    const fileState = state.fileStates && state.fileStates[canonical];
    return {
      path: canonical,
      hash: fileState && fileState.hash || null
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return {
    protocolVersion: 'world-class-v1',
    artifact: 'fact-card',
    sources,
    adaptivePlanHash: semanticJsonHash(adaptivePlanPath),
    retrievalPlanHash: semanticJsonHash(retrievalPlanPath)
  };
}

function normalizeFindingsToScope({ findings, scanFiles }) {
  const allowed = new Map(scanFiles.map((filePath) => {
    const canonical = canonicalFilePath(filePath);
    return [canonical, canonical];
  }));
  const normalized = [];
  const errors = [];

  for (const finding of toArray(findings)) {
    const canonical = canonicalFilePath(finding && finding.file);
    const assigned = allowed.get(canonical);
    if (!assigned) {
      errors.push(`Finding ${String((finding && finding.bugId) || '<unknown>')} targets an unassigned file: ${String((finding && finding.file) || '')}`);
      continue;
    }
    normalized.push({
      ...finding,
      file: assigned
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    findings: normalized
  };
}

function validateFindingsArtifact(findingsJsonPath) {
  if (!fs.existsSync(findingsJsonPath)) {
    return {
      ok: false,
      errors: [`Missing findings artifact: ${findingsJsonPath}`]
    };
  }
  return validateArtifactFile({
    artifactName: 'findings',
    filePath: findingsJsonPath
  });
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
    if (claim) {
      invariants.push(`Finding invariant: ${claim}`);
    }
  }

  return {
    chunkId,
    createdAt: nowIso(),
    apiContracts: [...new Set(apiContracts)].slice(0, 10),
    authAssumptions: [...new Set(authAssumptions)].slice(0, 10),
    invariants: [...new Set(invariants)].slice(0, 12)
  };
}

async function processPendingChunks({
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
  evidenceCacheDir = null,
  evidenceCacheOptions = {},
  adaptivePlanPath = '',
  retrievalPlanPath = ''
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
    const cachedFactsJsonPath = path.join(chunksDir, `${chunk.id}-cached-facts.json`);
    writeJson(chunkFilesJsonPath, chunk.files);

    const hashFilterResult = runJsonScript(stateScript, ['hash-filter', statePath, chunkFilesJsonPath]);
    const scanFiles = hashFilterResult.scan || [];
    const unavailableFiles = [
      ...(hashFilterResult.missing || []),
      ...(hashFilterResult.unreadable || []),
      ...(hashFilterResult.changed || [])
    ];
    if (unavailableFiles.length > 0) {
      const preview = unavailableFiles.slice(0, 3).join(', ');
      const suffix = unavailableFiles.length > 3 ? ` (+${unavailableFiles.length - 3} more)` : '';
      const errorMessage = `Assigned files are missing, unreadable, or changed from the run baseline: ${preview}${suffix}`;
      appendJournal(journalPath, {
        event: 'chunk-scope-unavailable',
        chunkId: chunk.id,
        unavailableCount: unavailableFiles.length,
        unavailableFiles: unavailableFiles.slice(0, 20)
      });
      runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'failed', errorMessage.slice(0, 240)]);
      if (failFast) {
        throw new Error(`Chunk ${chunk.id} has unavailable assigned files and fail-fast is enabled`);
      }
      continue;
    }
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
    removeFileIfExists(findingsJsonPath);
    removeFileIfExists(factsJsonPath);

    let evidenceDescriptor = null;
    let cachedFacts = null;
    if (evidenceCacheDir) {
      evidenceDescriptor = buildEvidenceDescriptor({
        statePath,
        scanFiles,
        adaptivePlanPath,
        retrievalPlanPath
      });
      const cacheKey = hashDescriptor(evidenceDescriptor);
      const cacheResult = getEntry(evidenceCacheDir, cacheKey);
      if (cacheResult.hit) {
        cachedFacts = cacheResult.value;
        appendJournal(journalPath, {
          event: 'evidence-cache-hit',
          chunkId: chunk.id,
          cacheKey
        });
      } else {
        appendJournal(journalPath, {
          event: 'evidence-cache-miss',
          chunkId: chunk.id,
          cacheKey,
          reason: cacheResult.reason || 'not-found'
        });
      }
    }
    writeJson(cachedFactsJsonPath, cachedFacts || {});
    runJsonScript(stateScript, ['mark-chunk', statePath, chunk.id, 'in_progress']);

    const command = fillTemplate(workerCmdTemplate, {
      chunkId: chunk.id,
      chunkFilesJson: chunkFilesJsonPath,
      scanFilesJson: scanFilesJsonPath,
      findingsJson: findingsJsonPath,
      factsJson: factsJsonPath,
      cachedFactsJson: cachedFactsJsonPath,
      adaptivePlanJson: adaptivePlanPath || '',
      retrievalPlanJson: retrievalPlanPath || '',
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
      chunkId: chunk.id,
      maxOutputBytes,
      killGraceMs,
      beforeAttempt: async () => {
        removeFileIfExists(findingsJsonPath);
        removeFileIfExists(factsJsonPath);
      },
      postAttempt: async () => {
        const findingsValidation = validateFindingsArtifact(findingsJsonPath);
        if (!findingsValidation.ok) {
          return {
            ok: false,
            errorMessage: findingsValidation.errors.join('; ')
          };
        }
        const findings = readJson(findingsJsonPath);
        const scoped = normalizeFindingsToScope({ findings, scanFiles });
        if (!scoped.ok) {
          return {
            ok: false,
            errorMessage: scoped.errors.join('; ')
          };
        }
        writeJson(findingsJsonPath, scoped.findings);
        return { ok: true };
      }
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

    const findings = readJson(findingsJsonPath);
    if (!fs.existsSync(factsJsonPath)) {
      writeJson(factsJsonPath, cachedFacts || buildHeuristicFactCard({
        chunkId: chunk.id,
        scanFiles,
        findings,
        index
      }));
    }

    const commitResult = runJsonScript(stateScript, [
      'commit-chunk',
      statePath,
      chunk.id,
      scanFilesJsonPath,
      findingsJsonPath,
      factsJsonPath,
      String(confidenceThreshold),
      'orchestrator'
    ]);
    if (!commitResult.ok) {
      appendJournal(journalPath, {
        event: 'chunk-integrity-failed',
        chunkId: chunk.id,
        errorMessage: String(commitResult.error || 'chunk integrity failed').slice(0, 500),
        verification: commitResult.verification || null
      });
      if (failFast) {
        throw new Error(`Chunk ${chunk.id} failed its integrity commit and fail-fast is enabled`);
      }
      continue;
    }

    if (evidenceCacheDir && evidenceDescriptor) {
      const stored = putEntry(
        evidenceCacheDir,
        evidenceDescriptor,
        readJson(factsJsonPath),
        evidenceCacheOptions
      );
      appendJournal(journalPath, {
        event: 'evidence-cache-store',
        chunkId: chunk.id,
        cacheKey: stored.key,
        prunedEntries: stored.prune && stored.prune.removedEntries || 0
      });
    }

    appendJournal(journalPath, {
      event: 'chunk-done',
      chunkId: chunk.id,
      attemptsUsed: runResult.attemptsUsed
    });
  }
}

module.exports = {
  processPendingChunks
};
