const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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

  const badRenew = runRaw('node', [lockScript, 'renew', lockPath, 'wrong-token']);
  assert.notEqual(badRenew.status, 0);
  assert.match(`${badRenew.stdout || ''}${badRenew.stderr || ''}`, /lock-owner-mismatch/);

  const renew = runJson('node', [lockScript, 'renew', lockPath, acquire1.lock.ownerToken]);
  assert.equal(renew.ok, true);
  assert.equal(renew.renewed, true);
  assert.notEqual(renew.lock.generation, acquire1.lock.generation);

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

  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    cwd: sandbox,
    createdAtMs: Date.now() - 10_000,
    createdAt: new Date(Date.now() - 10_000).toISOString(),
    ownerToken: 'existing-owner-token',
    generation: 'existing-generation'
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
      const child = childProcess.spawn('node', [lockScript, 'acquire', lockPath, '120'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.on('close', (code) => {
        resolve(code);
      });
    });
  }));

  const successCount = results.filter((code) => code === 0).length;
  assert.equal(successCount, 1);
});

test('fix-lock fails closed and preserves a corrupted lock file', () => {
  const sandbox = makeSandbox('fix-lock-corrupt-');
  const lockScript = resolveSkillScript('fix-lock.cjs');
  const lockPath = path.join(sandbox, 'bug-hunter-fix.lock');
  const corruptedLock = '{broken json';
  fs.writeFileSync(lockPath, corruptedLock, 'utf8');

  const result = runRaw('node', [lockScript, 'acquire', lockPath, '120']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout || ''}${result.stderr || ''}`, /malformed-lock/);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), corruptedLock);
});

test('fix-lock rejects missing tokens and token-less lock metadata', () => {
  const sandbox = makeSandbox('fix-lock-token-required-');
  const lockScript = resolveSkillScript('fix-lock.cjs');
  const lockPath = path.join(sandbox, 'bug-hunter-fix.lock');
  const acquired = runJson('node', [lockScript, 'acquire', lockPath, '120']);

  const missingRenewToken = runRaw('node', [lockScript, 'renew', lockPath]);
  assert.notEqual(missingRenewToken.status, 0);
  assert.match(`${missingRenewToken.stdout || ''}${missingRenewToken.stderr || ''}`, /owner-token-required/);

  const missingReleaseToken = runRaw('node', [lockScript, 'release', lockPath]);
  assert.notEqual(missingReleaseToken.status, 0);
  assert.match(`${missingReleaseToken.stdout || ''}${missingReleaseToken.stderr || ''}`, /owner-token-required/);

  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  delete lock.ownerToken;
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  const tokenlessRelease = runRaw('node', [
    lockScript,
    'release',
    lockPath,
    acquired.lock.ownerToken
  ]);
  assert.notEqual(tokenlessRelease.status, 0);
  assert.match(`${tokenlessRelease.stdout || ''}${tokenlessRelease.stderr || ''}`, /malformed-lock/);
  assert.equal(fs.existsSync(lockPath), true);
});

test('fix-lock has one winner during stale takeover contention', async () => {
  const sandbox = makeSandbox('fix-lock-stale-race-');
  const lockScript = resolveSkillScript('fix-lock.cjs');
  const lockPath = path.join(sandbox, 'bug-hunter-fix.lock');
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: 999_999_999,
    host: os.hostname(),
    cwd: sandbox,
    createdAtMs: Date.now() - 10_000,
    createdAt: new Date(Date.now() - 10_000).toISOString(),
    ownerToken: 'stale-owner-token',
    generation: 'stale-generation'
  }, null, 2)}\n`, 'utf8');

  const results = await Promise.all(Array.from({ length: 20 }, () => {
    return new Promise((resolve) => {
      const child = childProcess.spawn('node', [lockScript, 'acquire', lockPath, '1'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.on('close', (code) => {
        resolve(code);
      });
    });
  }));

  assert.equal(results.filter((code) => {
    return code === 0;
  }).length, 1);
  const winningLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.notEqual(winningLock.generation, 'stale-generation');
  assert.equal(typeof winningLock.ownerToken, 'string');
  assert.equal(fs.existsSync(`${lockPath}.mutation-gate`), false);
});
