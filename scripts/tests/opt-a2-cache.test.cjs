const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { makeSandbox } = require('./test-utils.cjs');
const { cacheStats, getEntry, hashDescriptor, pruneCache, putEntry } = require('../evidence-cache.cjs');

test('a2 cache treats malformed records as misses and preserves absolute expiry after a hit', () => {
  const root = makeSandbox('a2-cache-expiry-');
  const now = Date.now();
  const result = putEntry(root, { file: 'a' }, { facts: ['a'] }, { maxAgeDays: 1 }, now);
  assert.equal(getEntry(root, result.key, now + 80000000).hit, true);
  assert.equal(getEntry(root, result.key, now + 86400000).hit, false);
  for (const malformed of ['not json', '{}', JSON.stringify({ schemaVersion: 1, key: result.key, expiresAt: 'never' })]) {
    fs.writeFileSync(result.filePath, malformed);
    assert.equal(getEntry(root, result.key).hit, false);
    assert.equal(fs.existsSync(result.filePath), true);
    pruneCache(root);
    assert.equal(fs.existsSync(result.filePath), false);
  }
});

test('a2 cache puts do bounded IO at capacity and repair interrupted metadata updates', () => {
  const root = makeSandbox('a2-cache-capacity-');
  for (let i = 0; i < 60; i += 1) putEntry(root, { i }, { facts: [i] }, { maxEntries: 60 });
  let reads = 0;
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (...args) { reads += 1; return originalRead.apply(this, args); };
  try {
    for (let i = 60; i < 120; i += 1) putEntry(root, { i }, { facts: [i] }, { maxEntries: 60 });
  } finally { fs.readFileSync = originalRead; }
  assert.ok(reads < 600, `expected bounded metadata reads, observed ${reads}`);
  assert.ok(cacheStats(root).entries <= 60);
  const atomic = fs.renameSync;
  let renames = 0;
  fs.renameSync = function (...args) { if (++renames === 3) throw new Error('interrupted metadata update'); return atomic.apply(this, args); };
  try { assert.throws(() => putEntry(root, { interrupted: true }, {}, { maxEntries: 60 }), /interrupted/); }
  finally { fs.renameSync = atomic; }
  assert.equal(getEntry(root, hashDescriptor({ interrupted: true })).hit, true);
  putEntry(root, { recovered: true }, {}, { maxEntries: 60 });
  assert.ok(cacheStats(root).entries <= 60);
});

test('a2 cache capacity metadata remains correct across concurrent CLI processes', async () => {
  const root = makeSandbox('a2-cache-processes-');
  const modulePath = path.resolve(__dirname, '../evidence-cache.cjs');
  await Promise.all(Array.from({ length: 4 }, (_, worker) => promisify(execFile)(process.execPath, ['-e', `
    const { putEntry } = require(process.argv[1]);
    for (let i = 0; i < 30; i += 1) putEntry(process.argv[2], { worker: process.argv[3], i }, {}, { maxEntries: 60 });
  `, modulePath, root, String(worker)])));
  assert.ok(cacheStats(root).entries <= 60);
  assert.equal(fs.existsSync(path.join(root, '.capacity-lock')), false);
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('a2 cache prune respects per-entry TTL and byte capacity and rejects symlink escapes', () => {
  const root = makeSandbox('a2-cache-prune-');
  const outside = makeSandbox('a2-cache-outside-');
  const now = Date.now();
  const old = putEntry(root, { old: true }, {}, { maxAgeDays: 1 }, now);
  getEntry(root, old.key, now + 80000000);
  const pruned = pruneCache(root, { maxAgeDays: 30 }, now + 86400000);
  assert.equal(pruned.remainingEntries, 0);
  assert.equal(fs.existsSync(old.filePath), false);
  putEntry(root, { large: true }, { text: 'x'.repeat(4000) }, { maxBytes: 1000 });
  assert.ok(cacheStats(root).bytes <= 1000);
  const descriptor = { escape: true };
  const key = hashDescriptor(descriptor);
  const shard = path.join(root, key.slice(0, 2));
  fs.mkdirSync(shard, { recursive: true });
  const target = path.join(shard, `${key}.json`);
  fs.writeFileSync(path.join(outside, 'record'), '{}');
  fs.symlinkSync(path.join(outside, 'record'), target);
  assert.throws(() => getEntry(root, key), /symbolic link|escaped/);
  assert.throws(() => putEntry(root, descriptor, {}), /symbolic link|escaped/);
});
