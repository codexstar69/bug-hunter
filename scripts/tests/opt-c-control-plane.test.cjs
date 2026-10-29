const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeSandbox, runJson, runRaw, writeJson } = require('./test-utils.cjs');
const { createSchemaRef } = require('../schema-runtime.cjs');

const root = path.resolve(__dirname, '../..');
const guard = path.join(root, 'scripts/payload-guard.cjs');
const loop = path.join(root, 'scripts/experiment-loop.cjs');
const taskByteBudgets = {
  recon: 12200, 'triage-hunter': 15800, hunter: 15800,
  skeptic: 15100, referee: 13600, fixer: 14500
};

for (const [role, artifact] of Object.entries({
  recon: 'recon', 'triage-hunter': 'findings', hunter: 'findings',
  skeptic: 'skeptic', referee: 'referee', fixer: 'fix-report'
})) {
  test(`render preserves the complete ${role} skill and bounds wrapper context`, () => {
    const sandbox = makeSandbox(`opt-c-${role}-`);
    const payloadPath = path.join(sandbox, 'payload.json');
    runJson('node', [guard, 'generate', role, payloadPath]);
    const payload = JSON.parse(fs.readFileSync(payloadPath));
    payload.skillDir = root;
    payload.outputFilePath = path.join(sandbox, 'result.json');
    payload.targetDescription = 'An assigned target';
    payload.phaseSpecificContext = { evidence: 'literal $& evidence' };
    if (role === 'fixer') {
      payload.scopeManifest.repositoryRoot = sandbox;
      payload.scopeManifest.approvedFiles = [path.join(sandbox, 'src/example.ts')];
      payload.bugs[0].file = payload.scopeManifest.approvedFiles[0];
      payload.worktreeRules = 'Use only the assigned isolated worktree.';
    }
    writeJson(payloadPath, payload);
    const output = path.join(sandbox, 'tasks', 'task.md');
    const rendered = runJson('node', [guard, 'render', role, payloadPath, '--out', output]);
    assert.equal(rendered.outputPath, output);
    const task = fs.readFileSync(output, 'utf8');
    assert.ok(Buffer.byteLength(task) <= taskByteBudgets[role], `${role}: rendered task exceeds its byte budget`);
    const skillRole = role === 'triage-hunter' ? 'hunter' : role;
    assert.ok(task.includes(fs.readFileSync(path.join(root, 'skills', skillRole, 'SKILL.md'), 'utf8')));
    assert.doesNotMatch(task, /\{[A-Z][A-Z0-9_]*\}|Variable Reference|The orchestrator MUST|# Subagent Task Wrapper/);
    assert.ok(task.includes(payload.outputFilePath));
    assert.ok(task.includes('literal $& evidence'));
    assert.ok(task.includes(`**Artifact name for validation:** \`${artifact}\``));
    assert.match(task, /may read other repository files as evidence/i);
    if (role !== 'fixer') {
      assert.doesNotMatch(task, /Worktree Isolation Rules|WORKTREE_RULES|Fixer scope manifest|Commit allowed by caller/);
    } else {
      assert.match(task, /Worktree Isolation Rules/);
      assert.ok(task.includes(JSON.stringify(payload.scopeManifest, null, 2)));
      assert.match(task, /Use only the assigned isolated worktree/);
      assert.match(task, /\nfalse\n/);
    }
    runJson('node', [guard, 'render', role, payloadPath, '--out', output]);
    assert.equal(fs.readFileSync(output, 'utf8'), task, 'render must be deterministic');
  });
}

test('render rejects invalid payloads and mismatched schemas before writing', () => {
  const sandbox = makeSandbox('opt-c-render-invalid-');
  const payloadPath = path.join(sandbox, 'payload.json');
  const output = path.join(sandbox, 'task.md');
  for (const payload of [null, { skillDir: root }, {
    skillDir: root, targetFiles: ['a.js'], riskMap: {}, techStack: {},
    outputSchema: createSchemaRef('skeptic')
  }]) {
    writeJson(payloadPath, payload);
    assert.notEqual(runRaw('node', [guard, 'render', 'hunter', payloadPath, '--out', output]).status, 0);
    assert.equal(fs.existsSync(output), false);
  }
});

test('render performs one substitution pass and keeps evidence placeholders inert', () => {
  const sandbox = makeSandbox('opt-c-render-data-');
  const payloadPath = path.join(sandbox, 'payload.json');
  writeJson(payloadPath, {
    skillDir: root, targetFiles: ['src/a.js'], riskMap: {}, techStack: {},
    outputSchema: createSchemaRef('findings'),
    phaseSpecificContext: { text: '{PROMPT_CONTENT} $& {OUTPUT_FILE_PATH}' }
  });
  const output = path.join(sandbox, 'task.md');
  runJson('node', [guard, 'render', 'hunter', payloadPath, '--out', output]);
  assert.ok(fs.readFileSync(output, 'utf8').includes('{PROMPT_CONTENT} $& {OUTPUT_FILE_PATH}'));
});

test('experiment init scales its default cap and iteration eleven remains available', () => {
  const sandbox = makeSandbox('opt-c-loop-');
  for (const [files, budget, expected] of [[0, 30, 12], [600, 30, 28], [100000, 1, 200]]) {
    const log = path.join(sandbox, `experiment-${files}.jsonl`);
    const result = runJson('node', [loop, 'init', log, 'scan', 'bugs_confirmed', 'higher', 'count',
      '--scannable-files', String(files), '--file-budget', String(budget)]);
    assert.equal(result.maxIterations, expected);
  }
  const log = path.join(sandbox, 'explicit.jsonl');
  runJson('node', [loop, 'init', log, 'scan', 'bugs_confirmed', 'higher', 'count', '--max-iterations', '40']);
  for (let index = 0; index < 10; index += 1) {
    runJson('node', [loop, 'log', log, 'keep', '0', '--auto-commit', 'false']);
  }
  const next = runJson('node', [loop, 'check-continue', log, '--stop-file', path.join(sandbox, 'stop')]);
  assert.equal(next.continue, true);
  assert.equal(next.iteration, 11);
});

test('boundary dispatch preparation reuses overlapping reviewed findings before verification', () => {
  const sandbox = makeSandbox('opt-c-boundary-');
  const findings = path.join(sandbox, 'findings.json');
  const ledger = path.join(sandbox, 'reviewed.json');
  const output = path.join(sandbox, 'dispatch.json');
  const base = { file: 'src/a.js', lines: '10-15', category: 'logic', bugId: 'BUG-1',
    severity: 'High', claim: 'Overlapping defect', evidence: 'src/a.js:12',
    runtimeTrigger: 'Call the handler', crossReferences: ['Single file'], confidenceScore: 90 };
  const reviewed = { ...base, verdict: 'REAL_BUG', trueSeverity: 'High', confidenceLabel: 'high',
    verificationMode: 'EVIDENCE_BASED', analysisSummary: 'Confirmed from the unchanged source.' };
  writeJson(ledger, [reviewed]);
  writeJson(findings, [
    { ...base, bugId: 'BOUNDARY-1', lines: '12-14' },
    { ...base, bugId: 'BOUNDARY-2', lines: '16-20' },
    { ...base, bugId: 'BOUNDARY-3', file: 'src/b.js' },
    { ...base, bugId: 'BOUNDARY-4', category: 'security' }
  ]);
  runJson('node', [guard, 'dedup-boundaries', findings, ledger, '--out', output]);
  const prepared = JSON.parse(fs.readFileSync(output));
  assert.deepEqual(prepared.findings.map((row) => row.bugId), ['BOUNDARY-2', 'BOUNDARY-3', 'BOUNDARY-4']);
  assert.equal(prepared.reused[0].existingBugId, 'BUG-1');
  assert.equal(prepared.reused[0].finding.bugId, 'BOUNDARY-1');
  assert.equal(prepared.reused[0].verdict, 'REAL_BUG');
  writeJson(ledger, [{ ...reviewed, verdict: 'UNREVIEWED' }]);
  runJson('node', [guard, 'dedup-boundaries', findings, ledger, '--out', output]);
  assert.equal(JSON.parse(fs.readFileSync(output)).findings.length, 4);
  writeJson(ledger, [reviewed, { ...reviewed, bugId: 'BUG-2', verdict: 'NOT_A_BUG' }]);
  runJson('node', [guard, 'dedup-boundaries', findings, ledger, '--out', output]);
  assert.equal(JSON.parse(fs.readFileSync(output)).findings.length, 4, 'ambiguous overlaps need review');
  writeJson(findings, [{ ...base, lines: 'unknown' }]);
  writeJson(ledger, [reviewed]);
  runJson('node', [guard, 'dedup-boundaries', findings, ledger, '--out', output]);
  assert.equal(JSON.parse(fs.readFileSync(output)).findings.length, 1, 'unknown is not a line range');
});

test('boundary pairs come from index edges and domain membership without prefix collisions', () => {
  const sandbox = makeSandbox('opt-c-pairs-');
  const index = path.join(sandbox, 'index.json');
  const triage = path.join(sandbox, 'triage.json');
  const output = path.join(sandbox, 'pairs.json');
  writeJson(index, { reverseDependencies: {
    'src/auth/a.js': ['src/orders/b.js', 'src/auth/c.js', 'outside.js'],
    'src/orders/b.js': ['src/auth/a.js']
  } });
  writeJson(triage, { domainFileLists: {
    'src/auth': ['src/auth/a.js', 'src/auth/c.js'], 'src/orders': ['src/orders/b.js'],
    'src/auth-extra': ['src/auth-extra/d.js']
  } });
  runJson('node', [guard, 'boundary-pairs', index, triage, '--out', output]);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), [{
    domains: ['src/auth', 'src/orders'], files: ['src/auth/a.js', 'src/orders/b.js']
  }]);
});
