const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeSandbox, readJson, runRaw, shellQuote, writeJson } = require('./test-utils.cjs');
const stateScript = path.resolve(__dirname, '..', 'bug-hunter-state.cjs');

function fixture() {
  const dir = makeSandbox('opt-a1-owner-');
  const source = path.join(dir, 'source.js');
  fs.writeFileSync(source, 'const original = true;');
  const filesPath = path.join(dir, 'files.json');
  writeJson(filesPath, [source]);
  return { dir, source, filesPath, statePath: path.join(dir, 'state.json') };
}

test('a1 state owner excludes concurrent writers and permits atomic status snapshots', () => {
  const { openStateOwner } = require('../bug-hunter-state.cjs');
  const f = fixture();
  const owner = openStateOwner(f.statePath);
  try {
    owner.execute('init', 'extended', f.filesPath, '1');
    const original = fs.readFileSync(f.statePath, 'utf8');
    assert.throws(() => openStateOwner(f.statePath), /owned by another runner/);
    const writer = runRaw(process.execPath, [stateScript, 'mark-chunk', f.statePath, 'chunk-1', 'done']);
    assert.notEqual(writer.status, 0);
    assert.match(writer.stderr, /owned by another runner/);
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), original);
    const reader = runRaw(process.execPath, [stateScript, 'status', f.statePath]);
    assert.equal(reader.status, 0, reader.stderr);
    assert.equal(JSON.parse(reader.stdout).summary.chunkStatus.pending, 1);
  } finally {
    owner.close();
  }
  assert.equal(fs.existsSync(`${f.statePath}.lock`), false);
});

test('a1 failed state transaction preserves its durable generation and baseline', () => {
  const { openStateOwner } = require('../bug-hunter-state.cjs');
  const f = fixture();
  const owner = openStateOwner(f.statePath);
  try {
    owner.execute('init', 'extended', f.filesPath, '1');
    const original = readJson(f.statePath);
    assert.throws(() => owner.batch(() => {
      owner.execute('hash-filter', f.filesPath);
      owner.execute('mark-chunk', 'unknown', 'in_progress');
    }), /Unknown chunk id/);
    assert.deepEqual(readJson(f.statePath), original);
    assert.deepEqual(owner.read(), original);
  } finally {
    owner.close();
  }
});

test('a1 state owner reuses indexed source hashes and rejects pre-dispatch edits', () => {
  const { openStateOwner } = require('../bug-hunter-state.cjs');
  const f = fixture();
  const baseline = crypto.createHash('sha256').update(fs.readFileSync(f.source)).digest('hex');
  fs.writeFileSync(f.source, 'changed after indexing');
  const owner = openStateOwner(f.statePath, { sourceHashes: { [f.source]: baseline } });
  try {
    owner.execute('init', 'extended', f.filesPath, '1');
    assert.equal(owner.read().fileStates[f.source].initialHash, baseline);
    assert.deepEqual(owner.execute('hash-filter', f.filesPath).changed, [f.source]);
  } finally {
    owner.close();
  }
});

test('a1 in-process scheduler uses two durable transitions and fails changed-source commits atomically', async () => {
  const { openStateOwner } = require('../bug-hunter-state.cjs');
  const { processPendingChunks } = require('../chunk-scheduler.cjs');
  const f = fixture();
  const owner = openStateOwner(f.statePath);
  try {
    owner.execute('init', 'extended', f.filesPath, '1');
    const worker = path.join(f.dir, 'worker.cjs');
    fs.writeFileSync(worker, [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(f.source)}, 'changed during execution');`,
      "fs.writeFileSync(process.argv[2], '[]');"
    ].join('\n'));
    const initialGeneration = owner.read().generation;
    await processPendingChunks({
      statePath: f.statePath, stateOwner: owner,
      chunksDir: path.join(f.dir, 'chunks'), journalPath: path.join(f.dir, 'run.log'),
      workerCmdTemplate: `${shellQuote(process.execPath)} ${shellQuote(worker)} {findingsJson}`,
      timeoutMs: 5000, maxRetries: 0, backoffMs: 0, confidenceThreshold: 75,
      failFast: false, backend: 'local-sequential', mode: 'extended', skillDir: path.resolve(__dirname, '..', '..')
    });
    const state = readJson(f.statePath);
    assert.equal(state.generation, initialGeneration + 2);
    assert.equal(state.chunks[0].status, 'failed');
    assert.equal(state.fileStates[f.source].status, 'failed');
    assert.equal(state.metrics.filesScanned, 0);
    assert.deepEqual(state.bugLedger, []);
    assert.deepEqual(state.factCards, {});
    assert.match(fs.readFileSync(path.join(f.dir, 'run.log'), 'utf8'), /chunk-integrity-failed/);
  } finally {
    owner.close();
  }
});

test('a1 remaining script helpers use the current executable with node absent from PATH', () => {
  const cp = require('node:child_process');
  const f = fixture();
  const helper = path.join(f.dir, 'helper.cjs');
  fs.writeFileSync(helper, 'console.log(JSON.stringify({ ok: true }));');
  const modulePath = path.resolve(__dirname, '..', 'process-runner.cjs');
  const code = `
    const assert = require('node:assert/strict');
    const { runJsonScript, runTextScript } = require(${JSON.stringify(modulePath)});
    assert.equal(runJsonScript(${JSON.stringify(helper)}, []).ok, true);
    assert.equal(JSON.parse(runTextScript(${JSON.stringify(helper)}, [])).ok, true);
  `;
  const result = cp.spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8', env: { ...process.env, PATH: '' }
  });
  assert.equal(result.status, 0, result.stderr);
});
