const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  readJson,
  resolveSkillScript,
  runJson,
  writeJson
} = require('./test-utils.cjs');

test('bug-hunter-state init/mark/hash/filter/record works end-to-end', () => {
  const sandbox = makeSandbox('bug-hunter-state-');
  const stateScript = resolveSkillScript('bug-hunter-state.cjs');
  const fileA = path.join(sandbox, 'a.ts');
  const fileB = path.join(sandbox, 'b.ts');
  fs.writeFileSync(fileA, 'const a = 1;\n', 'utf8');
  fs.writeFileSync(fileB, 'const b = 2;\n', 'utf8');

  const filesJson = path.join(sandbox, 'files.json');
  writeJson(filesJson, [fileA, fileB]);
  const statePath = path.join(sandbox, 'state.json');

  const init = runJson('node', [stateScript, 'init', statePath, 'extended', filesJson, '1']);
  assert.equal(init.ok, true);
  assert.equal(init.summary.metrics.filesTotal, 2);
  assert.equal(init.summary.metrics.chunksTotal, 2);

  const next = runJson('node', [stateScript, 'next-chunk', statePath]);
  assert.equal(next.done, false);
  assert.equal(next.chunk.id, 'chunk-1');

  const markProgress = runJson('node', [stateScript, 'mark-chunk', statePath, 'chunk-1', 'in_progress']);
  assert.equal(markProgress.chunk.status, 'in_progress');

  const hashFilter1 = runJson('node', [stateScript, 'hash-filter', statePath, filesJson]);
  assert.deepEqual(hashFilter1.skip, []);
  assert.equal(hashFilter1.scan.length, 2);

  const scanJson = path.join(sandbox, 'scan.json');
  writeJson(scanJson, hashFilter1.scan);
  runJson('node', [stateScript, 'hash-update', statePath, scanJson, 'scanned']);

  const hashFilter2 = runJson('node', [stateScript, 'hash-filter', statePath, filesJson]);
  assert.equal(hashFilter2.scan.length, 0);
  assert.equal(hashFilter2.skip.length, 2);

  const findingsJson = path.join(sandbox, 'findings.json');
  writeJson(findingsJson, [
    {
      bugId: 'BUG-1',
      severity: 'Low',
      category: 'logic',
      file: 'src/x.ts',
      lines: '1',
      claim: 'x',
      evidence: 'src/x.ts:1 first evidence',
      runtimeTrigger: 'Call x()',
      crossReferences: ['Single file'],
      confidenceScore: 40
    },
    {
      bugId: 'BUG-2',
      severity: 'Critical',
      category: 'security',
      file: 'src/x.ts',
      lines: '1',
      claim: 'x',
      evidence: 'src/x.ts:1 upgraded evidence',
      runtimeTrigger: 'Call x() with attacker-controlled input',
      crossReferences: ['Single file'],
      confidenceScore: 95,
      stride: 'Tampering',
      cwe: 'CWE-20'
    }
  ]);
  const recorded = runJson('node', [stateScript, 'record-findings', statePath, findingsJson, 'test']);
  assert.equal(recorded.inserted, 1);
  assert.equal(recorded.updated, 1);
  assert.equal(recorded.metrics.findingsUnique, 1);

  runJson('node', [stateScript, 'mark-chunk', statePath, 'chunk-1', 'done']);
  const status = runJson('node', [stateScript, 'status', statePath]);
  assert.equal(status.summary.metrics.chunksDone, 1);
  assert.equal(status.summary.chunkStatus.done, 1);

  const state = readJson(statePath);
  assert.equal(state.bugLedger[0].severity, 'Critical');
  assert.equal(state.bugLedger[0].confidenceScore, 95);
  assert.equal(state.metrics.lowConfidenceFindings, 0);

  const extraFile = path.join(sandbox, 'c.ts');
  fs.writeFileSync(extraFile, 'const c = 3;\n', 'utf8');
  const extraFilesJson = path.join(sandbox, 'extra-files.json');
  writeJson(extraFilesJson, [extraFile]);
  const appendResult = runJson('node', [stateScript, 'append-files', statePath, extraFilesJson]);
  assert.equal(appendResult.appended, 1);
  assert.equal(appendResult.chunksAdded, 1);

  const factCardJson = path.join(sandbox, 'fact-card.json');
  writeJson(factCardJson, {
    apiContracts: ['src/x.ts contract'],
    authAssumptions: ['auth check required'],
    invariants: ['state transition remains atomic']
  });
  const factCardResult = runJson('node', [stateScript, 'record-fact-card', statePath, 'chunk-1', factCardJson]);
  assert.equal(factCardResult.ok, true);
  const updatedState = readJson(statePath);
  assert.equal(updatedState.factCards['chunk-1'].apiContracts.length, 1);
});

test('bug-hunter-state rejects malformed findings artifacts', () => {
  const sandbox = makeSandbox('bug-hunter-state-invalid-');
  const stateScript = resolveSkillScript('bug-hunter-state.cjs');
  const filePath = path.join(sandbox, 'a.ts');
  fs.writeFileSync(filePath, 'const a = 1;\n', 'utf8');

  const filesJson = path.join(sandbox, 'files.json');
  writeJson(filesJson, [filePath]);
  const statePath = path.join(sandbox, 'state.json');
  runJson('node', [stateScript, 'init', statePath, 'extended', filesJson, '1']);

  const findingsJson = path.join(sandbox, 'findings.json');
  writeJson(findingsJson, [
    {
      bugId: 'BUG-1',
      severity: 'Low',
      category: 'logic',
      file: 'src/x.ts',
      lines: '1',
      evidence: 'src/x.ts:1 evidence',
      runtimeTrigger: 'Call x()',
      crossReferences: ['Single file'],
      confidenceScore: 40
    }
  ]);

  const result = require('node:child_process').spawnSync('node', [
    stateScript,
    'record-findings',
    statePath,
    findingsJson,
    'test'
  ], {
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /Invalid findings artifact/);
});

test('bug-hunter-state severity ranking orders High above Medium and Low', () => {
  const sandbox = makeSandbox('bug-hunter-state-severity-');
  const stateScript = resolveSkillScript('bug-hunter-state.cjs');
  const filePath = path.join(sandbox, 'a.ts');
  fs.writeFileSync(filePath, 'const a = 1;\n', 'utf8');

  const filesJson = path.join(sandbox, 'files.json');
  writeJson(filesJson, [filePath]);
  const statePath = path.join(sandbox, 'state.json');
  runJson('node', [stateScript, 'init', statePath, 'extended', filesJson, '1']);

  // Record a Low finding first
  const findingsLow = path.join(sandbox, 'findings-low.json');
  writeJson(findingsLow, [
    {
      bugId: 'BUG-SEV',
      severity: 'Low',
      category: 'logic',
      file: 'src/a.ts',
      lines: '1',
      claim: 'severity test',
      evidence: 'src/a.ts:1 evidence',
      runtimeTrigger: 'Call a()',
      crossReferences: ['Single file'],
      confidenceScore: 80
    }
  ]);
  runJson('node', [stateScript, 'record-findings', statePath, findingsLow, 'test']);

  // Record a High finding for the same location — should upgrade
  const findingsHigh = path.join(sandbox, 'findings-high.json');
  writeJson(findingsHigh, [
    {
      bugId: 'BUG-SEV',
      severity: 'High',
      category: 'logic',
      file: 'src/a.ts',
      lines: '1',
      claim: 'severity test',
      evidence: 'src/a.ts:1 evidence',
      runtimeTrigger: 'Call a()',
      crossReferences: ['Single file'],
      confidenceScore: 85
    }
  ]);
  runJson('node', [stateScript, 'record-findings', statePath, findingsHigh, 'test']);

  const state = readJson(statePath);
  assert.equal(state.bugLedger[0].severity, 'High');
  assert.equal(state.bugLedger[0].confidenceScore, 85);
});
