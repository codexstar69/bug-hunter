const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { validateArtifactValue } = require('../schema-runtime.cjs');
const {
  makeSandbox,
  readJson,
  resolveSkillScript,
  runJson,
  runRaw,
  writeJson
} = require('./test-utils.cjs');

test('state initialization preserves caller-provided risk order', () => {
  const sandbox = makeSandbox('precision-order-');
  const stateScript = resolveSkillScript('bug-hunter-state.cjs');
  const filesPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, 'state.json');
  const files = [
    path.join(sandbox, 'z-critical.js'),
    path.join(sandbox, 'm-high.js'),
    path.join(sandbox, 'a-medium.js')
  ];
  writeJson(filesPath, files);

  runJson('node', [stateScript, 'init', statePath, 'extended', filesPath, '2']);
  const state = readJson(statePath);
  assert.deepEqual(state.chunks.flatMap((chunk) => chunk.files), files);
});

test('triage and code-index share the complete source extension catalog', () => {
  const sandbox = makeSandbox('precision-source-catalog-');
  const triage = resolveSkillScript('triage.cjs');
  const codeIndex = resolveSkillScript('code-index.cjs');
  const filesPath = path.join(sandbox, 'files.json');
  const indexPath = path.join(sandbox, 'index.json');
  const sources = [
    path.join(sandbox, 'src', 'service.cs'),
    path.join(sandbox, 'src', 'worker.lua')
  ];
  fs.mkdirSync(path.dirname(sources[0]), { recursive: true });
  fs.writeFileSync(sources[0], 'class Service {}\n', 'utf8');
  fs.writeFileSync(sources[1], 'return true\n', 'utf8');
  writeJson(filesPath, sources);

  const triageResult = runJson('node', [triage, 'scan', sandbox]);
  assert.equal(triageResult.totalFiles, 2);
  runJson('node', [codeIndex, 'build', indexPath, filesPath, sandbox]);
  const index = readJson(indexPath);
  assert.equal(index.metrics.filesIndexed, 2);
  assert.deepEqual(Object.keys(index.files).sort(), [...sources].sort());
});

test('plan derives chunk size from the bounded source-token budget', () => {
  const sandbox = makeSandbox('precision-token-budget-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const filesPath = path.join(sandbox, 'files.json');
  const planPath = path.join(sandbox, 'plan.json');
  const sources = Array.from({ length: 4 }, (_, index) => {
    const filePath = path.join(sandbox, 'src', `large-${index}.js`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'x'.repeat(220000), 'utf8');
    return filePath;
  });
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

  assert.equal(result.maxSourceTokens, 48000);
  assert.equal(result.chunkSize, 1);
  assert.equal(result.chunkCount, 4);
});

test('missing assigned files fail the scan closed', () => {
  const sandbox = makeSandbox('precision-missing-scope-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, 'state.json');
  const missingPath = path.join(sandbox, 'src', 'deleted.js');
  writeJson(filesPath, [missingPath]);

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
    'missing-scope',
    '--worker-cmd',
    'node -e "process.exit(0)"',
    '--timeout-ms',
    '5000'
  ], { cwd: sandbox });

  assert.equal(result.status, 1);
  const output = JSON.parse(String(result.stdout || '').trim());
  assert.equal(output.ok, false);
  assert.equal(output.status.chunkStatus.failed, 1);
  const state = readJson(statePath);
  assert.equal(state.fileStates[missingPath].status, 'missing');
});

test('findings schema requires actionable security evidence', () => {
  const base = {
    bugId: 'BUG-1',
    severity: 'High',
    category: 'security',
    file: 'src/auth.js',
    lines: '10-12',
    claim: 'Authentication can be bypassed.',
    evidence: 'src/auth.js:10-12 compares an untrusted role loosely.',
    runtimeTrigger: 'Submit role=admin as an attacker-controlled string.',
    crossReferences: ['src/routes.js:5-8'],
    confidenceScore: 92
  };

  assert.equal(validateArtifactValue({ artifactName: 'findings', value: [base] }).ok, false);
  assert.equal(validateArtifactValue({
    artifactName: 'findings',
    value: [{ ...base, stride: 'ElevationOfPrivilege', cwe: 'CWE-862' }]
  }).ok, true);
  assert.equal(validateArtifactValue({
    artifactName: 'findings',
    value: [{ ...base, crossReferences: [], stride: 'ElevationOfPrivilege', cwe: 'CWE-862' }]
  }).ok, false);
  assert.equal(validateArtifactValue({
    artifactName: 'findings',
    value: [{ ...base, stride: 'N/A', cwe: 'N/A' }]
  }).ok, false);
});

test('role guidance keeps exploitable abuse cases and loads examples progressively', () => {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const hunter = fs.readFileSync(path.join(projectRoot, 'skills', 'hunter', 'SKILL.md'), 'utf8');
  const skeptic = fs.readFileSync(path.join(projectRoot, 'skills', 'skeptic', 'SKILL.md'), 'utf8');

  assert.doesNotMatch(skeptic, /Rate limiting concerns (informational only, not a bug)/);
  assert.match(skeptic, /credential stuffing/);
  assert.match(skeptic, /OTP\/reset abuse/);
  assert.match(hunter, /Do not spend context on examples for every chunk/);
  assert.match(skeptic, /Do not spend context on examples for settled cases/);
});
