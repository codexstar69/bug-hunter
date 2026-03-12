const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  resolveSkillScript,
  runJson,
  runRaw
} = require('./test-utils.cjs');

test('fix-lock enforces single writer and supports token-protected release', () => {
  const sandbox = makeSandbox('fix-lock-');
  const lockScript = resolveSkillScript('fix-lock.cjs');
  const lockPath = path.join(sandbox, 'bug-hunter-fix.lock');

  const acquire1 = runJson('node', [lockScript, 'acquire', lockPath, '120']);
  assert.equal(acquire1.ok, true);
  assert.equal(acquire1.acquired, true);
  assert.equal(typeof acquire1.lock.ownerToken, 'string');
  assert.equal(acquire1.lock.ownerToken.length > 8, true);

  const acquire2 = runRaw('node', [lockScript, 'acquire', lockPath, '120']);
  assert.notEqual(acquire2.status, 0);
  const output2 = `${acquire2.stdout || ''}${acquire2.stderr || ''}`;
  assert.match(output2, /lock-held/);

  const renew = runJson('node', [lockScript, 'renew', lockPath, acquire1.lock.ownerToken]);
  assert.equal(renew.ok, true);
  assert.equal(renew.renewed, true);

  const badRelease = runRaw('node', [lockScript, 'release', lockPath, 'wrong-token']);
  assert.notEqual(badRelease.status, 0);
  assert.match(`${badRelease.stdout || ''}${badRelease.stderr || ''}`, /lock-owner-mismatch/);

  const status = runJson('node', [lockScript, 'status', lockPath, '120']);
  assert.equal(status.exists, true);
  assert.equal(status.stale, false);

  const release = runJson('node', [lockScript, 'release', lockPath, acquire1.lock.ownerToken]);
  assert.equal(release.ok, true);
  assert.equal(release.released, true);

  const statusAfter = runJson('node', [lockScript, 'status', lockPath, '120']);
  assert.equal(statusAfter.exists, false);
});

test('fix-lock does not steal an expired lock from a still-running owner', () => {
  const sandbox = makeSandbox('fix-lock-live-owner-');
  const lockScript = resolveSkillScript('fix-lock.cjs');
  const lockPath = path.join(sandbox, 'bug-hunter-fix.lock');

  require('fs').writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    host: 'test-host',
    cwd: sandbox,
    createdAtMs: Date.now() - 10_000,
    createdAt: new Date(Date.now() - 10_000).toISOString(),
    ownerToken: 'existing-owner-token'
  }, null, 2)}\n`, 'utf8');

  const acquire = runRaw('node', [lockScript, 'acquire', lockPath, '1']);
  assert.notEqual(acquire.status, 0);
  assert.match(`${acquire.stdout || ''}${acquire.stderr || ''}`, /lock-held-by-live-owner|lock-held/);
});

test('fix-lock acquires atomically under contention', async () => {
  const sandbox = makeSandbox('fix-lock-race-');
  const lockScript = resolveSkillScript('fix-lock.cjs');
  const lockPath = path.join(sandbox, 'bug-hunter-fix.lock');

  const results = await Promise.all(Array.from({ length: 20 }, () => {
    return new Promise((resolve) => {
      const child = require('node:child_process').spawn('node', [lockScript, 'acquire', lockPath, '120'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.on('close', (code) => resolve(code));
    });
  }));

  const successCount = results.filter((code) => code === 0).length;
  assert.equal(successCount, 1);
});

test('fix-lock recovers from a corrupted lock file', () => {
  const sandbox = makeSandbox('fix-lock-corrupt-');
  const lockScript = resolveSkillScript('fix-lock.cjs');
  const lockPath = path.join(sandbox, 'bug-hunter-fix.lock');
  require('fs').writeFileSync(lockPath, '{broken json', 'utf8');

  const result = runJson('node', [lockScript, 'acquire', lockPath, '120']);
  assert.equal(result.ok, true);
  assert.equal(result.acquired, true);
});
