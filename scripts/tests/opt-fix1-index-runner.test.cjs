const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeSandbox, readJson, runJson, runRaw, shellQuote, writeJson, resolveSkillScript } = require('./test-utils.cjs');
const { scan } = require('../triage.cjs');
const { buildIndex } = require('../code-index.cjs');
const { openStateOwner } = require('../bug-hunter-state.cjs');
const { getEntry, putEntry, pruneCache } = require('../evidence-cache.cjs');

function fixture(prefix = 'fix1-index-') {
  const root = makeSandbox(prefix);
  const source = path.join(root, 'src', 'entry.js');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "const jwt = require('jsonwebtoken');\n");
  const files = path.join(root, 'files.json');
  writeJson(files, [source]);
  return { root, source, files, index: path.join(root, 'index.json'), state: path.join(root, 'state.json') };
}

function deadPid() {
  const child = cp.spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  return child.pid;
}

test('fix1 A1 triage and code-index classify the same import trust boundaries', () => {
  const f = fixture();
  buildIndex(f.index, f.files, f.root);
  const indexed = readJson(f.index).files[f.source];
  const triage = scan(f.root);
  assert.equal(indexed.riskHint, 'critical');
  assert.ok(triage.riskMap[indexed.riskHint].includes('src/entry.js'));
  assert.equal(triage.domains[0].tier, 'CRITICAL');
});

test('fix1 A2 excluded single-file targets have zero source and scannable counts', () => {
  const f = fixture();
  for (const relative of ['entry.test.js', 'notes.txt', 'tests/service.js']) {
    const target = path.join(f.root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'const value = true;');
    const triage = scan(target);
    assert.equal(triage.totalFiles, 0, relative);
    assert.equal(triage.scannableFiles, 0, relative);
    assert.deepEqual(triage.scanOrder, [], relative);
    assert.equal(triage.plannedChunkCount, 0, relative);
  }
});

test('fix1 A3 unreadable known-extension source records coverage and index skip reasons', () => {
  const f = fixture();
  const original = fs.openSync;
  fs.openSync = function (file, ...args) {
    if (path.resolve(String(file)) === f.source) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original.call(this, file, ...args);
  };
  try {
    for (const target of [f.root, f.source]) {
      const triage = scan(target);
      assert.equal(triage.coverageComplete, false);
      assert.deepEqual(triage.coverageLimitations, [{ path: f.source, reason: 'file-read-failed', code: 'EACCES' }]);
      assert.equal(triage.scannableFiles, 0);
    }
    const result = buildIndex(f.index, f.files, f.root);
    assert.equal(result.ok, true);
    assert.equal(result.metrics.filesIndexed, 0);
    assert.deepEqual(result.skippedFiles, [{ path: f.source, reason: 'file-read-failed', code: 'EACCES' }]);
    assert.deepEqual(readJson(f.index).skippedFiles, result.skippedFiles);
  } finally { fs.openSync = original; }
});

test('fix1 A4 cache hits and expiry reads stay lock-free and immutable under contention', () => {
  const f = fixture();
  const root = path.join(f.root, 'cache');
  const now = Date.now();
  const result = putEntry(root, { source: 'a' }, { facts: ['fact'] }, { maxAgeDays: 1 }, now);
  const before = fs.readFileSync(result.filePath, 'utf8');
  const capacity = fs.readFileSync(path.join(root, '.capacity.json'), 'utf8');
  writeJson(path.join(root, '.capacity-lock'), { pid: process.pid, token: 'held' });
  const originals = { linkSync: fs.linkSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
  try {
    fs.linkSync = () => { throw Object.assign(new Error('no hard links'), { code: 'ENOTSUP' }); };
    fs.writeFileSync = fs.renameSync = () => { throw new Error('read attempted a write'); };
    assert.equal(getEntry(root, result.key, now + 1).hit, true);
    assert.equal(getEntry(root, result.key, now + 86400000).hit, false);
    assert.equal(getEntry(path.join(root, 'missing'), result.key).hit, false);
    assert.equal(fs.existsSync(path.join(root, 'missing')), false);
  } finally { Object.assign(fs, originals); }
  assert.equal(fs.readFileSync(result.filePath, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(root, '.capacity.json'), 'utf8'), capacity);
  fs.unlinkSync(path.join(root, '.capacity-lock'));
  const abandoned = path.join(root, '.capacity-lock.1234-abcd.tmp');
  const active = path.join(root, '.capacity-lock.abcd-5678.tmp');
  writeJson(abandoned, { pid: deadPid(), host: os.hostname(), token: 'dead' });
  writeJson(active, { pid: process.pid, host: os.hostname(), token: 'alive' });
  pruneCache(root, {}, now + 86400000);
  assert.equal(fs.existsSync(abandoned), false);
  assert.equal(fs.existsSync(active), true);
  assert.equal(fs.existsSync(result.filePath), false);
});

test('fix1 R1 runner --use-index accepts unchanged invalid UTF-8 and records raw byte hashes', () => {
  const f = fixture();
  const bytes = Buffer.from([101, 120, 112, 111, 114, 116, 32, 255, 10]);
  fs.writeFileSync(f.source, bytes);
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  buildIndex(f.index, f.files, f.root);
  const entry = readJson(f.index).files[f.source];
  assert.equal(entry.hash, expected);
  assert.equal(entry.hashAlgorithm, 'sha256-bytes');
  assert.equal(entry.bytes, bytes.length);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']]) {
    const result = cp.spawnSync('git', args, { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const worker = path.join(f.root, 'worker.cjs');
  fs.writeFileSync(worker, "require('fs').writeFileSync(process.argv[2], '[]');");
  const result = runJson(process.execPath, [resolveSkillScript('run-bug-hunter.cjs'), 'run',
    '--skill-dir', path.resolve(__dirname, '..', '..'), '--files-json', f.files,
    '--run-id', 'raw-bytes', '--use-index', 'true', '--evidence-cache', 'false', '--max-retries', '0',
    '--worker-cmd', `${shellQuote(process.execPath)} ${shellQuote(worker)} {findingsJson}`
  ], { cwd: f.root, timeout: 30000 });
  const state = readJson(result.statePath);
  assert.equal(state.fileStates[f.source].initialHash, expected);
  assert.equal(state.fileStates[f.source].status, 'scanned');
  assert.equal(state.metrics.filesScanned, 1);
});

test('fix1 R2 state owner reclaims a dead local mutation gate', () => {
  const f = fixture();
  const lock = `${f.state}.lock`;
  const gate = `${lock}.gate`;
  // A gate is a hard link of its owner's `<gate>.<token>.tmp` record.
  const publishGate = (pid) => {
    const record = { pid, host: os.hostname(), token: crypto.randomUUID() };
    writeJson(`${gate}.${record.token}.tmp`, record);
    fs.linkSync(`${gate}.${record.token}.tmp`, gate);
    return record;
  };
  writeJson(lock, publishGate(deadPid()));
  const owner = openStateOwner(f.state);
  owner.execute('init', 'extended', f.files, '1');
  assert.equal(fs.existsSync(gate), false);
  owner.close();
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(path.dirname(gate)).filter((name) => name.startsWith(path.basename(gate))), []);

  publishGate(process.pid);
  assert.throws(() => openStateOwner(f.state), /mutation in progress/);
});

test('fix1 R2 a dead gate without its owner record is reported, not removed', () => {
  const f = fixture();
  const gate = `${f.state}.lock.gate`;
  writeJson(gate, { pid: deadPid(), host: os.hostname(), token: crypto.randomUUID() });
  assert.throws(() => openStateOwner(f.state), /no owner record/);
  assert.equal(fs.existsSync(gate), true);
});

test('fix1 R3 a file absent at init is changed when it becomes readable', () => {
  const f = fixture();
  fs.unlinkSync(f.source);
  const owner = openStateOwner(f.state);
  try {
    owner.execute('init', 'extended', f.files, '1');
    assert.equal(owner.read().fileStates[f.source].baselineUnavailable, true);
    fs.writeFileSync(f.source, 'new source');
    const filtered = owner.execute('hash-filter', f.files);
    assert.deepEqual(filtered.changed, [f.source]);
    assert.deepEqual(filtered.unreadable, []);
    assert.deepEqual(filtered.scan, []);
    assert.equal(owner.read().fileStates[f.source].status, 'failed');
  } finally { owner.close(); }
});

test('fix1 C2 hash-verify returns false and fails the CLI for invalidated source evidence', () => {
  const f = fixture();
  const script = resolveSkillScript('bug-hunter-state.cjs');
  runJson(process.execPath, [script, 'init', f.state, 'extended', f.files, '1']);
  runJson(process.execPath, [script, 'hash-filter', f.state, f.files]);
  assert.equal(runJson(process.execPath, [script, 'hash-verify', f.state, f.files]).ok, true);
  fs.writeFileSync(f.source, 'changed');
  const changed = runRaw(process.execPath, [script, 'hash-verify', f.state, f.files]);
  assert.equal(changed.status, 1, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).ok, false);
  assert.deepEqual(JSON.parse(changed.stdout).changed, [f.source]);
  fs.unlinkSync(f.source);
  const missing = runRaw(process.execPath, [script, 'hash-verify', f.state, f.files]);
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).ok, false);
  assert.deepEqual(JSON.parse(missing.stdout).missing, [f.source]);
  fs.mkdirSync(f.source);
  const unreadable = runRaw(process.execPath, [script, 'hash-verify', f.state, f.files]);
  assert.equal(unreadable.status, 1, unreadable.stderr);
  assert.equal(JSON.parse(unreadable.stdout).ok, false);
  assert.deepEqual(JSON.parse(unreadable.stdout).unreadable, [f.source]);
});

test('fix2 a live owner closes while a competing opener holds the mutation gate', () => {
  const f = fixture();
  const owner = openStateOwner(f.state);
  owner.execute('init', 'extended', f.files, '1');
  // A competing opener is inside the gate, inspecting this live lease.
  const gate = `${f.state}.lock.gate`;
  writeJson(gate, { pid: process.pid, host: os.hostname(), token: crypto.randomUUID() });
  owner.close();
  assert.equal(fs.existsSync(`${f.state}.lock`), false);
  fs.unlinkSync(gate);
});
