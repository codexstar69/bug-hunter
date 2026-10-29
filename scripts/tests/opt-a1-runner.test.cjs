const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const skillDir = path.resolve(__dirname, '..', '..');
const runner = path.join(skillDir, 'scripts', 'run-bug-hunter.cjs');
const stateScript = path.join(skillDir, 'scripts', 'bug-hunter-state.cjs');
const quote = (value) => `'${String(value).replace(/'/g, `'\''`)}'`;
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function fixture(t, contents = ['export const a = 1;']) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-opt-a1-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = contents.map((content, i) => {
    const file = path.join(dir, `source-${i}.js`);
    fs.writeFileSync(file, content);
    return file;
  });
  const filesPath = path.join(dir, 'files.json');
  write(filesPath, files);
  const worker = path.join(dir, 'worker.cjs');
  fs.writeFileSync(worker, "require('fs').writeFileSync(process.argv[2], '[]');\n");
  for (const args of [
    ['init', '-q'], ['add', '.'],
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']
  ]) {
    const result = cp.spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  function raw(args, script = runner) {
    return cp.spawnSync(process.execPath, [script, ...args], {
      cwd: dir, encoding: 'utf8', timeout: 30000
    });
  }
  function json(args, script = runner) {
    const result = raw(args, script);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }
  function run(extra = []) {
    return json([
      'run', '--skill-dir', skillDir, '--files-json', filesPath,
      '--worker-cmd', `${quote(process.execPath)} ${quote(worker)} {findingsJson}`,
      '--max-retries', '0', '--backoff-ms', '0', ...extra
    ]);
  }
  return { dir, files, filesPath, worker, raw, json, run };
}

test('a1 run and plan enforce file and token limits independently with explicit chunk size', (t) => {
  const f = fixture(t, ['a'.repeat(2400), 'b'.repeat(2400), 'c'.repeat(6000), 'd', 'e', 'f']);
  const limits = ['--chunk-size', '2', '--max-source-tokens', '1000'];
  const plan = f.json(['plan', '--files-json', f.filesPath, ...limits]);
  const run = f.run(['--run-id', 'budgeted', '--evidence-cache', 'false', ...limits]);
  const state = read(run.statePath);
  assert.equal(plan.tokenBudgetEnforced, true);
  assert.equal(state.enforceTokenBudget, true);
  assert.deepEqual(state.chunks.map((c) => c.files), plan.chunks.map((c) => c.files));
  for (const chunks of [plan.chunks, state.chunks]) {
    assert.equal(chunks.length, 5);
    assert.equal(chunks.filter((c) => c.oversized).length, 1);
    for (const chunk of chunks) {
      assert.ok(chunk.files.length <= 2);
      assert.ok(chunk.estimatedSourceTokens <= 1000 || (chunk.oversized && chunk.files.length === 1));
    }
  }
  const optOutPlan = f.json(['plan', '--files-json', f.filesPath, ...limits, '--enforce-token-budget', 'false']);
  const optOut = f.run(['--run-id', 'unbudgeted', '--evidence-cache', 'false', ...limits, '--enforce-token-budget', 'false']);
  assert.equal(optOutPlan.tokenBudgetEnforced, false);
  assert.equal(optOutPlan.chunks.length, 3);
  assert.equal(read(optOut.statePath).chunks.length, 3);
});

test('a1 init defaults to token enforcement and retains the explicit false opt-out', (t) => {
  const f = fixture(t, Array(3).fill('x'.repeat(120000)));
  const statePath = path.join(f.dir, 'state.json');
  f.json(['init', statePath, 'extended', f.filesPath, '30'], stateScript);
  const state = read(statePath);
  assert.equal(state.enforceTokenBudget, true);
  assert.equal(state.chunks.length, 3);
  assert.ok(state.chunks.every((chunk) => !chunk.oversized && chunk.estimatedSourceTokens <= 48000));
  f.json(['init', statePath, 'extended', f.filesPath, '30', '48000', 'false'], stateScript);
  assert.equal(read(statePath).chunks.length, 1);
});

test('a1 init and expansion baseline pending edits, deletions and replacements', (t) => {
  const f = fixture(t, ['first', 'edit', 'delete', 'replace', 'append']);
  const statePath = path.join(f.dir, 'state.json');
  const initialFiles = path.join(f.dir, 'initial.json');
  write(initialFiles, f.files.slice(0, 4));
  f.json(['init', statePath, 'extended', initialFiles, '1'], stateScript);
  const before = read(statePath);
  f.json(['append-files', statePath, f.filesPath], stateScript);
  assert.deepEqual(read(statePath).fileStates[f.files[1]], before.fileStates[f.files[1]]);
  fs.writeFileSync(f.files[1], 'edited');
  fs.unlinkSync(f.files[2]);
  fs.unlinkSync(f.files[3]);
  fs.writeFileSync(f.files[3], 'replacement');
  fs.writeFileSync(f.files[4], 'appended edit');
  const result = f.json(['hash-filter', statePath, f.filesPath], stateScript);
  assert.deepEqual(result.scan, [f.files[0]]);
  assert.deepEqual(result.changed, [f.files[1], f.files[3], f.files[4]]);
  assert.deepEqual(result.missing, [f.files[2]]);
  const after = read(statePath);
  for (const file of result.changed) assert.equal(after.fileStates[file].status, 'failed');
  assert.equal(after.fileStates[f.files[1]].initialHash, before.fileStates[f.files[1]].initialHash);
});

test('a1 documented cache directory, shared default and boolean forms work across run IDs', (t) => {
  const f = fixture(t);
  const first = f.run(['--run-id', 'one']);
  const second = f.run(['--run-id', 'two']);
  assert.equal(first.evidenceCacheDir, path.join(f.dir, '.bug-hunter', 'evidence-cache'));
  assert.equal(first.evidenceCacheDir, second.evidenceCacheDir);
  assert.match(fs.readFileSync(second.journalPath, 'utf8'), /evidence-cache-hit/);
  const custom = path.join(f.dir, 'cache with spaces');
  const disabled = f.run(['--run-id', 'disabled', '--evidence-cache', 'false']);
  assert.equal(disabled.evidenceCacheDir, null);
  assert.doesNotMatch(fs.readFileSync(disabled.journalPath, 'utf8'), /evidence-cache-(?:hit|miss|store)/);
  const enabled = f.run(['--run-id', 'enabled', '--evidence-cache']);
  assert.equal(enabled.evidenceCacheDir, first.evidenceCacheDir);
  const legacy = f.run(['--run-id', 'legacy', '--evidence-cache', 'true', '--evidence-cache-dir', custom]);
  assert.equal(legacy.evidenceCacheDir, custom);
  assert.ok(fs.readdirSync(custom).length > 0);
});

test('a1 documented evidence-cache directory is honored and reusable', (t) => {
  const f = fixture(t);
  const custom = path.join(f.dir, 'cache with spaces');
  const first = f.run(['--run-id', 'custom-one', '--evidence-cache', custom]);
  assert.equal(first.evidenceCacheDir, custom);
  assert.ok(fs.readdirSync(custom).length > 0);
  const second = f.run(['--run-id', 'custom-two', '--evidence-cache', custom]);
  assert.match(fs.readFileSync(second.journalPath, 'utf8'), /evidence-cache-hit/);
});

test('a1 verification-report aliases the report path', (t) => {
  const f = fixture(t);
  const plan = path.join(f.dir, 'verification-plan.json');
  write(plan, { schemaVersion: 1, checks: [{
    id: 'runtime', kind: 'test', command: [process.execPath, '-e', 'process.exit(0)'],
    cwd: '.', timeoutMs: 5000, required: true, findingIds: []
  }] });
  const report = path.join(f.dir, 'custom-report.json');
  const result = f.run([
    '--run-id', 'alias', '--evidence-cache', 'false', '--verification-plan', plan,
    '--verification-report', report
  ]);
  assert.equal(result.verificationReportPath, report);
  assert.ok(fs.existsSync(report));
});

test('a1 unknown runner flags fail loudly on each command', (t) => {
  const f = fixture(t);
  for (const command of ['preflight', 'run', 'plan', 'phase']) {
    const unknown = f.raw([command, '--skill-dir', skillDir, '--evidnce-cache', 'false']);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown flag: --evidnce-cache/);
  }
});

test('a1 runner detects edits to a later chunk before its worker starts', (t) => {
  const f = fixture(t, ['first', 'second']);
  fs.writeFileSync(f.worker, [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(f.files[1])}, 'edited after init');`,
    "fs.writeFileSync(process.argv[2], '[]');"
  ].join('\n'));
  const result = f.raw([
    'run', '--skill-dir', skillDir, '--files-json', f.filesPath, '--run-id', 'pending-edit',
    '--chunk-size', '1', '--evidence-cache', 'false', '--max-retries', '0',
    '--worker-cmd', `${quote(process.execPath)} ${quote(f.worker)} {findingsJson}`
  ]);
  assert.equal(result.status, 1, result.stderr);
  const state = read(path.join(f.dir, '.bug-hunter', 'runs', 'pending-edit', 'state.json'));
  assert.deepEqual(state.chunks.map((chunk) => chunk.status), ['done', 'failed']);
  assert.equal(state.fileStates[f.files[1]].status, 'failed');
  assert.equal(state.metrics.filesScanned, 1);
});

test('a1 SIGKILL mid-chunk resumes a dead owner and preserves pending baselines', (t) => {
  const f = fixture(t, ['first', 'second']);
  const marker = path.join(f.dir, 'killed-once');
  fs.writeFileSync(f.worker, [
    "const fs = require('fs');",
    `if (!fs.existsSync(${JSON.stringify(marker)})) {`,
    `  fs.writeFileSync(${JSON.stringify(marker)}, 'killed');`,
    "  process.kill(process.ppid, 'SIGKILL');",
    "  process.exit(0);",
    '}',
    "fs.writeFileSync(process.argv[2], '[]');"
  ].join('\n'));
  const common = [
    'run', '--skill-dir', skillDir, '--files-json', f.filesPath, '--chunk-size', '1',
    '--evidence-cache', 'false', '--max-retries', '0', '--backoff-ms', '0',
    '--worker-cmd', `${quote(process.execPath)} ${quote(f.worker)} {findingsJson}`
  ];
  const killed = f.raw([...common, '--run-id', 'crash']);
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const statePath = path.join(f.dir, '.bug-hunter', 'runs', 'crash', 'state.json');
  const before = read(statePath);
  assert.equal(before.chunks[0].status, 'in_progress');
  assert.ok(fs.existsSync(`${statePath}.lock`));
  const resumed = f.json([...common, '--resume', 'crash']);
  assert.equal(resumed.status.chunkStatus.done, 2);
  assert.equal(resumed.status.metrics.filesScanned, 2);
  const after = read(statePath);
  for (const file of f.files) assert.equal(after.fileStates[file].initialHash, before.fileStates[file].initialHash);
  assert.equal(fs.existsSync(`${statePath}.lock`), false);
  assert.ok(after.generation > before.generation);
  assert.ok(fs.readdirSync(path.dirname(statePath)).every((name) => !name.endsWith('.tmp')));
});
