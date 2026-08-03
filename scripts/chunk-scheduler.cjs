const fs = require('fs');
const path = require('path');
const { validateArtifactFile } = require('./schema-runtime.cjs');
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
  confidenceThreshold
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
    removeFileIfExists(findingsJsonPath);
    removeFileIfExists(factsJsonPath);
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
      chunkId: chunk.id,
      maxOutputBytes,
      killGraceMs,
      beforeAttempt: async () => {
        removeFileIfExists(findingsJsonPath);
        removeFileIfExists(factsJsonPath);
      },
      postAttempt: async () => {
        const findingsValidation = validateFindingsArtifact(findingsJsonPath);
        if (findingsValidation.ok) {
          return { ok: true };
        }
        return {
          ok: false,
          errorMessage: findingsValidation.errors.join('; ')
        };
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

    runJsonScript(stateScript, ['record-findings', statePath, findingsJsonPath, 'orchestrator', String(confidenceThreshold)]);
    const findings = readJson(findingsJsonPath);

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

module.exports = {
  processPendingChunks
};
