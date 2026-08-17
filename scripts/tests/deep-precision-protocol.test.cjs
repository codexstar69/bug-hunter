const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { buildFixerScope } = require('../artifact-planner.cjs');
const {
  makeSandbox,
  readJson,
  resolveSkillScript,
  runJson,
  runRaw,
  shellQuote,
  writeJson
} = require('./test-utils.cjs');

function writeWorker(filePath, lines) {
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function parseJsonOutput(result) {
  const output = String(result.stdout || '').trim();
  return output ? JSON.parse(output) : {};
}

function validFinding({ bugId, file, claim = 'Reachable behavioral failure.' }) {
  return {
    bugId,
    severity: 'Medium',
    category: 'logic',
    file,
    lines: '1',
    claim,
    evidence: `${file}:1 concrete evidence`,
    runtimeTrigger: 'Invoke the assigned entry point with a valid boundary input.',
    crossReferences: ['Single file'],
    confidenceScore: 90
  };
}

test('code index and delta selection preserve risk-prioritized input order', () => {
  const sandbox = makeSandbox('deep-order-');
  const codeIndex = resolveSkillScript('code-index.cjs');
  const deltaMode = resolveSkillScript('delta-mode.cjs');
  const filesPath = path.join(sandbox, 'files.json');
  const changedPath = path.join(sandbox, 'changed.json');
  const seedsPath = path.join(sandbox, 'seeds.json');
  const selectedPath = path.join(sandbox, 'selected.json');
  const indexPath = path.join(sandbox, 'index.json');
  const critical = path.join(sandbox, 'z-auth.js');
  const changed = path.join(sandbox, 'm-changed.js');
  const dependency = path.join(sandbox, 'a-dependency.js');

  fs.writeFileSync(critical, 'export function authenticate() { return true; }\n', 'utf8');
  fs.writeFileSync(changed, "import { dep } from './a-dependency';\nexport const value = dep();\n", 'utf8');
  fs.writeFileSync(dependency, 'export function dep() { return 1; }\n', 'utf8');
  writeJson(filesPath, [critical, changed, dependency]);
  writeJson(changedPath, [changed]);

  runJson('node', [codeIndex, 'build', indexPath, filesPath, sandbox]);
  const index = readJson(indexPath);
  assert.deepEqual(Object.keys(index.files), [critical, changed, dependency]);

  const selected = runJson('node', [deltaMode, 'select', indexPath, changedPath, '1']);
  assert.deepEqual(selected.selected, [changed, dependency]);
  assert.deepEqual(selected.expansionCandidates, [critical]);

  writeJson(seedsPath, [dependency]);
  writeJson(selectedPath, [changed, dependency]);
  const expansion = runJson('node', [
    deltaMode,
    'expand',
    indexPath,
    seedsPath,
    selectedPath,
    '1'
  ]);
  assert.deepEqual(expansion.prioritized, [critical]);
});

test('adaptive planning enforces the token budget on mixed-size contiguous chunks', () => {
  const sandbox = makeSandbox('deep-token-plan-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const filesPath = path.join(sandbox, 'files.json');
  const planPath = path.join(sandbox, 'plan.json');
  const sources = [];

  for (let index = 0; index < 2; index += 1) {
    const filePath = path.join(sandbox, `critical-large-${index}.js`);
    fs.writeFileSync(filePath, 'x'.repeat(100000), 'utf8');
    sources.push(filePath);
  }
  for (let index = 0; index < 8; index += 1) {
    const filePath = path.join(sandbox, `small-${index}.js`);
    fs.writeFileSync(filePath, 'x'.repeat(1000), 'utf8');
    sources.push(filePath);
  }
  writeJson(filesPath, sources);

  const result = runJson('node', [
    runner,
    'plan',
    '--files-json',
    filesPath,
    '--plan-path',
    planPath,
    '--max-source-tokens',
    '48000'
  ], { cwd: sandbox });

  assert.equal(result.chunkCount, 2);
  assert.deepEqual(result.chunks.flatMap((chunk) => chunk.files), sources);
  for (const chunk of result.chunks) {
    const estimatedTokens = chunk.files.reduce((sum, filePath) => {
      return sum + Math.max(1, Math.ceil(fs.statSync(filePath).size / 4));
    }, 0);
    assert.equal(estimatedTokens <= 48000, true);
  }
});

test('triage and index agree on shebang sources, test files, and minified exclusions', () => {
  const sandbox = makeSandbox('deep-source-detection-');
  const triage = resolveSkillScript('triage.cjs');
  const codeIndex = resolveSkillScript('code-index.cjs');
  const filesPath = path.join(sandbox, 'files.json');
  const indexPath = path.join(sandbox, 'index.json');
  const tool = path.join(sandbox, 'bin', 'tool');
  const goTest = path.join(sandbox, 'service_test.go');
  const minified = path.join(sandbox, 'bundle.min.js');

  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, '#!/usr/bin/env node\nconsole.log("ok");\n', 'utf8');
  fs.writeFileSync(goTest, 'package service\n', 'utf8');
  fs.writeFileSync(minified, 'var x=1;', 'utf8');
  writeJson(filesPath, [tool, goTest, minified]);

  const triageResult = runJson('node', [triage, 'scan', sandbox]);
  assert.equal(triageResult.totalFiles, 2);
  assert.deepEqual(triageResult.riskMap['context-only'], ['service_test.go']);

  runJson('node', [codeIndex, 'build', indexPath, filesPath, sandbox]);
  const index = readJson(indexPath);
  assert.deepEqual(Object.keys(index.files), [tool, goTest]);
  assert.equal(index.files[goTest].isTest, true);
});

test('chunk workers cannot report findings outside their assigned scan files', () => {
  const sandbox = makeSandbox('deep-finding-scope-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const source = path.join(sandbox, 'assigned.js');
  const outside = path.join(sandbox, 'not-assigned.js');
  const filesPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.bug-hunter', 'state.json');
  const workerPath = path.join(sandbox, 'worker.cjs');

  fs.writeFileSync(source, 'export const assigned = true;\n', 'utf8');
  fs.writeFileSync(outside, 'export const outside = true;\n', 'utf8');
  writeJson(filesPath, [source]);
  writeWorker(workerPath, [
    "const fs = require('fs');",
    "const args = process.argv;",
    "const output = args[args.indexOf('--findings-json') + 1];",
    `fs.writeFileSync(output, JSON.stringify([${JSON.stringify(validFinding({
      bugId: 'BUG-OUTSIDE',
      file: outside
    }))}]));`
  ]);

  const result = runRaw('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesPath,
    '--state',
    statePath,
    '--run-id',
    'finding-scope',
    '--worker-cmd',
    `node ${shellQuote(workerPath)} --findings-json {findingsJson}`,
    '--max-retries',
    '0',
    '--backoff-ms',
    '0'
  ], { cwd: sandbox });

  assert.notEqual(result.status, 0);
  const output = parseJsonOutput(result);
  assert.equal(output.ok, false);
  const state = readJson(statePath);
  assert.equal(state.bugLedger.length, 0);
  assert.equal(state.chunks[0].status, 'failed');
});

test('a source mutation during worker execution fails closed without findings or complete coverage', () => {
  const sandbox = makeSandbox('deep-worker-mutation-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const source = path.join(sandbox, 'source.js');
  const filesPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.bug-hunter', 'state.json');
  const workerPath = path.join(sandbox, 'worker.cjs');

  fs.writeFileSync(source, 'export const value = 1;\n', 'utf8');
  writeJson(filesPath, [source]);
  writeWorker(workerPath, [
    "const fs = require('fs');",
    "const args = process.argv;",
    "const output = args[args.indexOf('--findings-json') + 1];",
    "fs.writeFileSync(output, '[]');",
    `fs.appendFileSync(${JSON.stringify(source)}, 'export const changed = 2;\\n');`
  ]);

  const result = runRaw('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesPath,
    '--state',
    statePath,
    '--run-id',
    'worker-mutation',
    '--worker-cmd',
    `node ${shellQuote(workerPath)} --findings-json {findingsJson}`,
    '--max-retries',
    '0',
    '--backoff-ms',
    '0'
  ], { cwd: sandbox });

  assert.notEqual(result.status, 0);
  const output = parseJsonOutput(result);
  assert.equal(output.ok, false);
  assert.equal(output.coveragePath, null);
  const state = readJson(statePath);
  assert.equal(state.bugLedger.length, 0);
  assert.equal(state.chunks[0].status, 'failed');
  assert.equal(state.fileStates[source].status, 'failed');
});

test('state preserves strongest evidence, security metadata, and unique IDs across chunks', () => {
  const sandbox = makeSandbox('deep-ledger-merge-');
  const stateScript = resolveSkillScript('bug-hunter-state.cjs');
  const source = path.join(sandbox, 'auth.js');
  const filesPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, 'state.json');
  const firstPath = path.join(sandbox, 'first.json');
  const secondPath = path.join(sandbox, 'second.json');
  const collisionPath = path.join(sandbox, 'collision.json');

  fs.writeFileSync(source, 'export const auth = true;\n', 'utf8');
  writeJson(filesPath, [source]);
  runJson('node', [stateScript, 'init', statePath, 'extended', filesPath, '1']);
  writeJson(firstPath, [{
    bugId: 'BUG-1',
    severity: 'High',
    category: 'security',
    file: source,
    lines: '1',
    claim: 'Authorization can be bypassed.',
    evidence: 'Strong traced evidence.',
    runtimeTrigger: 'Authenticated low-privilege user requests the admin action.',
    crossReferences: ['routes.js:1'],
    confidenceScore: 96,
    confidenceLabel: 'high',
    stride: 'ElevationOfPrivilege',
    cwe: 'CWE-862'
  }]);
  writeJson(secondPath, [{
    bugId: 'BUG-SECOND',
    severity: 'Medium',
    category: 'logic',
    file: source,
    lines: '1',
    claim: 'Authorization can be bypassed.',
    evidence: 'Weaker later evidence.',
    runtimeTrigger: 'Vague trigger.',
    crossReferences: ['service.js:2'],
    confidenceScore: 40,
    confidenceLabel: 'low'
  }]);
  writeJson(collisionPath, [validFinding({
    bugId: 'BUG-1',
    file: source,
    claim: 'A separate reachable defect.'
  })]);

  runJson('node', [stateScript, 'record-findings', statePath, firstPath, 'chunk-1']);
  runJson('node', [stateScript, 'record-findings', statePath, secondPath, 'chunk-2']);
  runJson('node', [stateScript, 'record-findings', statePath, collisionPath, 'chunk-2']);

  const state = readJson(statePath);
  assert.equal(state.bugLedger.length, 2);
  const merged = state.bugLedger.find((entry) => entry.claim === 'Authorization can be bypassed.');
  const collision = state.bugLedger.find((entry) => entry.claim === 'A separate reachable defect.');
  assert.equal(merged.category, 'security');
  assert.equal(merged.evidence, 'Strong traced evidence.');
  assert.equal(merged.runtimeTrigger, 'Authenticated low-privilege user requests the admin action.');
  assert.deepEqual(merged.crossReferences.sort(), ['routes.js:1', 'service.js:2']);
  assert.equal(merged.confidenceScore, 96);
  assert.equal(merged.confidenceLabel, 'high');
  assert.equal(merged.stride, 'ElevationOfPrivilege');
  assert.equal(merged.cwe, 'CWE-862');
  assert.equal(collision.bugId === 'BUG-1', false);
});

test('hash cache uses a content digest even for files larger than ten megabytes', () => {
  const sandbox = makeSandbox('deep-large-hash-');
  const stateScript = resolveSkillScript('bug-hunter-state.cjs');
  const source = path.join(sandbox, 'large.js');
  const filesPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, 'state.json');

  fs.writeFileSync(source, Buffer.alloc((10 * 1024 * 1024) + 1, 65));
  writeJson(filesPath, [source]);
  runJson('node', [stateScript, 'init', statePath, 'extended', filesPath, '1']);
  runJson('node', [stateScript, 'hash-update', statePath, filesPath, 'scanned']);

  const state = readJson(statePath);
  assert.match(state.hashCache[source].hash, /^[a-f0-9]{64}$/);
});

test('Fixer scope authorizes only executable plan entries and rejects symlink escapes', () => {
  const sandbox = makeSandbox('deep-fixer-scope-');
  const safeFile = path.join(sandbox, 'safe.js');
  const manualFile = path.join(sandbox, 'manual.js');
  fs.writeFileSync(safeFile, 'export const safe = true;\n', 'utf8');
  fs.writeFileSync(manualFile, 'export const manual = true;\n', 'utf8');
  const safeFinding = validFinding({ bugId: 'BUG-SAFE', file: safeFile });
  const manualFinding = validFinding({ bugId: 'BUG-MANUAL', file: manualFile });
  const runIdentity = {
    runId: 'scope-test',
    repositoryRoot: fs.realpathSync(sandbox),
    baseCommit: 'abc123'
  };
  const scope = buildFixerScope({
    runIdentity,
    authorizedFindings: [safeFinding, manualFinding],
    fixPlan: {
      canary: [safeFinding],
      rollout: [],
      manualReview: [manualFinding]
    }
  });
  assert.deepEqual(scope.approvedBugIds, ['BUG-SAFE']);
  assert.deepEqual(scope.approvedFiles, [safeFile]);

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-hunter-scope-'));
  const outsideFile = path.join(outsideDir, 'outside.js');
  const link = path.join(sandbox, 'escape.js');
  try {
    fs.writeFileSync(outsideFile, 'export const outside = true;\n', 'utf8');
    fs.symlinkSync(outsideFile, link);
    const escapedFinding = validFinding({ bugId: 'BUG-ESCAPE', file: link });
    assert.throws(() => buildFixerScope({
      runIdentity,
      authorizedFindings: [escapedFinding],
      fixPlan: { canary: [escapedFinding], rollout: [], manualReview: [] }
    }), /outside the repository root/);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('run identity rejects assigned symlinks whose real target escapes the repository', () => {
  const sandbox = makeSandbox('deep-run-scope-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.bug-hunter', 'state.json');
  const workerPath = path.join(sandbox, 'worker.cjs');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-hunter-run-scope-'));
  const outsideFile = path.join(outsideDir, 'outside.js');
  const link = path.join(sandbox, 'escape.js');

  try {
    fs.writeFileSync(outsideFile, 'export const outside = true;\n', 'utf8');
    fs.symlinkSync(outsideFile, link);
    writeJson(filesPath, [link]);
    writeWorker(workerPath, [
      "const fs = require('fs');",
      "const args = process.argv;",
      "const output = args[args.indexOf('--findings-json') + 1];",
      "fs.writeFileSync(output, '[]');"
    ]);

    const result = runRaw('node', [
      runner,
      'run',
      '--skill-dir',
      skillDir,
      '--files-json',
      filesPath,
      '--state',
      statePath,
      '--run-id',
      'run-scope-escape',
      '--worker-cmd',
      `node ${shellQuote(workerPath)} --findings-json {findingsJson}`,
      '--max-retries',
      '0'
    ], { cwd: sandbox });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout || ''}${result.stderr || ''}`, /outside the repository root/);
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
