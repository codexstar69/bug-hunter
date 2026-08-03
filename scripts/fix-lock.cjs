#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function usage() {
  console.error('Usage:');
  console.error('  fix-lock.cjs acquire <lockPath> [ttlSeconds]');
  console.error('  fix-lock.cjs renew <lockPath> <ownerToken>');
  console.error('  fix-lock.cjs release <lockPath> <ownerToken>');
  console.error('  fix-lock.cjs status <lockPath> [ttlSeconds]');
  console.error('  Note: acquire returns lock.ownerToken; pass it to renew/release.');
}

function nowMs() {
  return Date.now();
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function flushDirectory(directoryPath) {
  let directoryDescriptor;
  try {
    directoryDescriptor = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(directoryDescriptor);
  } catch (error) {
    if (!error || !['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (directoryDescriptor !== undefined) {
      fs.closeSync(directoryDescriptor);
    }
  }
}

function lockFingerprint(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function readLockSnapshot(lockPath) {
  if (!fs.existsSync(lockPath)) {
    return { status: 'missing' };
  }

  const raw = (() => {
    try {
      return fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  })();
  if (raw === null) {
    return { status: 'missing' };
  }

  const parsed = (() => {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `invalid-json: ${message}` };
    }
  })();
  if (!parsed.ok) {
    return { status: 'malformed', reason: parsed.reason };
  }

  const lock = parsed.value;
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    return { status: 'malformed', reason: 'lock metadata must be an object' };
  }
  if (typeof lock.ownerToken !== 'string' || lock.ownerToken.trim() === '') {
    return { status: 'malformed', reason: 'lock metadata requires ownerToken' };
  }
  if (!Number.isFinite(lock.createdAtMs)) {
    return { status: 'malformed', reason: 'lock metadata requires createdAtMs' };
  }

  const fingerprint = lockFingerprint(raw);
  const generation = typeof lock.generation === 'string' && lock.generation
    ? lock.generation
    : `legacy:${fingerprint}`;
  return {
    status: 'valid',
    lock: {
      ...lock,
      generation
    },
    generation
  };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && (error.code === 'ESRCH' || error.code === 'EPERM')) {
      return error.code === 'EPERM';
    }
    return false;
  }
}

function lockIsStale(lockData, ttlSeconds) {
  return nowMs() - lockData.createdAtMs > ttlSeconds * 1000;
}

function buildLock({ ownerToken, previousLock }) {
  const timestamp = nowMs();
  const lock = {
    pid: previousLock ? previousLock.pid : process.pid,
    host: previousLock ? previousLock.host : os.hostname(),
    cwd: previousLock ? previousLock.cwd : process.cwd(),
    ownerToken: ownerToken || crypto.randomUUID(),
    generation: crypto.randomUUID(),
    createdAtMs: timestamp,
    createdAt: previousLock && previousLock.createdAt
      ? previousLock.createdAt
      : new Date(timestamp).toISOString()
  };
  if (previousLock) {
    lock.renewedAt = new Date(timestamp).toISOString();
  }
  return lock;
}

function writeLockCandidate(lockPath, lockData) {
  ensureParent(lockPath);
  const candidatePath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.candidate`;
  const fileDescriptor = fs.openSync(candidatePath, 'wx');
  try {
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(lockData, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fileDescriptor);
  } finally {
    fs.closeSync(fileDescriptor);
  }
  return candidatePath;
}

function installNewLock(lockPath, lockData) {
  const candidatePath = writeLockCandidate(lockPath, lockData);
  try {
    fs.linkSync(candidatePath, lockPath);
    flushDirectory(path.dirname(lockPath));
  } finally {
    if (fs.existsSync(candidatePath)) {
      fs.unlinkSync(candidatePath);
    }
  }
}

function replaceLock(lockPath, lockData) {
  const candidatePath = writeLockCandidate(lockPath, lockData);
  try {
    fs.renameSync(candidatePath, lockPath);
    flushDirectory(path.dirname(lockPath));
  } catch (error) {
    if (fs.existsSync(candidatePath)) {
      fs.unlinkSync(candidatePath);
    }
    throw error;
  }
}

function emitFailure(payload) {
  console.log(JSON.stringify({ ok: false, ...payload }, null, 2));
  process.exitCode = 1;
  return null;
}

function withMutationGate(lockPath, operation) {
  ensureParent(lockPath);
  // Every compliant mutation uses the same atomic gate. An orphaned gate blocks
  // mutations for manual recovery instead of guessing that concurrent work died.
  const gatePath = `${lockPath}.mutation-gate`;
  try {
    fs.mkdirSync(gatePath);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return emitFailure({ reason: 'lock-mutation-in-progress' });
    }
    throw error;
  }

  try {
    return operation();
  } finally {
    fs.rmdirSync(gatePath);
  }
}

function assertOwner(existing, ownerToken) {
  return Boolean(
    existing
    && typeof existing.ownerToken === 'string'
    && existing.ownerToken
    && typeof ownerToken === 'string'
    && ownerToken
    && ownerToken === existing.ownerToken
  );
}

function snapshotStillMatches(lockPath, expectedGeneration) {
  // Renew, release, and stale takeover are bound to the exact observed lease.
  const current = readLockSnapshot(lockPath);
  return current.status === 'valid' && current.generation === expectedGeneration;
}

function renew(lockPath, ownerToken) {
  if (!ownerToken) {
    emitFailure({ renewed: false, reason: 'owner-token-required' });
    return;
  }

  withMutationGate(lockPath, () => {
    const existing = readLockSnapshot(lockPath);
    if (existing.status === 'missing') {
      return emitFailure({ renewed: false, reason: 'no-lock' });
    }
    if (existing.status === 'malformed') {
      return emitFailure({ renewed: false, reason: 'malformed-lock', detail: existing.reason });
    }
    if (!assertOwner(existing.lock, ownerToken)) {
      return emitFailure({ renewed: false, reason: 'lock-owner-mismatch' });
    }
    if (!snapshotStillMatches(lockPath, existing.generation)) {
      return emitFailure({ renewed: false, reason: 'lock-generation-changed' });
    }

    const renewedLock = buildLock({
      ownerToken,
      previousLock: existing.lock
    });
    replaceLock(lockPath, renewedLock);
    console.log(JSON.stringify({ ok: true, renewed: true, lock: renewedLock }, null, 2));
    return renewedLock;
  });
}

function acquire(lockPath, ttlSeconds) {
  withMutationGate(lockPath, () => {
    const existing = readLockSnapshot(lockPath);
    if (existing.status === 'malformed') {
      return emitFailure({ acquired: false, reason: 'malformed-lock', detail: existing.reason });
    }
    if (existing.status === 'missing') {
      const lockData = buildLock({});
      try {
        installNewLock(lockPath, lockData);
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          const current = readLockSnapshot(lockPath);
          return emitFailure({
            acquired: false,
            reason: 'lock-held',
            lock: current.status === 'valid' ? current.lock : null
          });
        }
        throw error;
      }
      console.log(JSON.stringify({ ok: true, acquired: true, lock: lockData }, null, 2));
      return lockData;
    }

    const stale = lockIsStale(existing.lock, ttlSeconds);
    const ownerAlive = existing.lock.host === os.hostname()
      && typeof existing.lock.pid === 'number'
      && pidAlive(existing.lock.pid);
    if (!stale || ownerAlive) {
      return emitFailure({
        acquired: false,
        reason: ownerAlive ? 'lock-held-by-live-owner' : 'lock-held',
        stale,
        ownerAlive,
        lock: existing.lock
      });
    }
    if (!snapshotStillMatches(lockPath, existing.generation)) {
      return emitFailure({ acquired: false, reason: 'lock-generation-changed' });
    }

    const lockData = buildLock({});
    replaceLock(lockPath, lockData);
    console.log(JSON.stringify({
      ok: true,
      acquired: true,
      recoveredFromStaleLock: true,
      previousLock: existing.lock,
      lock: lockData
    }, null, 2));
    return lockData;
  });
}

function release(lockPath, ownerToken) {
  if (!ownerToken) {
    emitFailure({ released: false, reason: 'owner-token-required' });
    return;
  }

  withMutationGate(lockPath, () => {
    const existing = readLockSnapshot(lockPath);
    if (existing.status === 'missing') {
      console.log(JSON.stringify({ ok: true, released: false, reason: 'no-lock' }, null, 2));
      return null;
    }
    if (existing.status === 'malformed') {
      return emitFailure({ released: false, reason: 'malformed-lock', detail: existing.reason });
    }
    if (!assertOwner(existing.lock, ownerToken)) {
      return emitFailure({ released: false, reason: 'lock-owner-mismatch' });
    }
    if (!snapshotStillMatches(lockPath, existing.generation)) {
      return emitFailure({ released: false, reason: 'lock-generation-changed' });
    }

    fs.unlinkSync(lockPath);
    flushDirectory(path.dirname(lockPath));
    console.log(JSON.stringify({ ok: true, released: true, previousLock: existing.lock }, null, 2));
    return existing.lock;
  });
}

function status(lockPath, ttlSeconds) {
  const existing = readLockSnapshot(lockPath);
  if (existing.status === 'missing') {
    console.log(JSON.stringify({ ok: true, exists: false }, null, 2));
    return;
  }
  if (existing.status === 'malformed') {
    emitFailure({
      exists: true,
      malformed: true,
      reason: 'malformed-lock',
      detail: existing.reason
    });
    return;
  }

  const stale = lockIsStale(existing.lock, ttlSeconds);
  const ownerAlive = existing.lock.host === os.hostname()
    && typeof existing.lock.pid === 'number'
    && pidAlive(existing.lock.pid);
  console.log(JSON.stringify({
    ok: true,
    exists: true,
    stale,
    ownerAlive,
    lock: existing.lock
  }, null, 2));
}

function main() {
  const [command, lockPath, rawArg] = process.argv.slice(2);
  if (!command || !lockPath) {
    usage();
    process.exit(1);
  }
  const ttlParsed = Number.parseInt(rawArg || '', 10);
  const ttlSeconds = Number.isInteger(ttlParsed) && ttlParsed > 0 ? ttlParsed : 1800;

  if (command === 'acquire') {
    acquire(lockPath, ttlSeconds);
    return;
  }
  if (command === 'renew') {
    renew(lockPath, rawArg);
    return;
  }
  if (command === 'release') {
    release(lockPath, rawArg);
    return;
  }
  if (command === 'status') {
    status(lockPath, ttlSeconds);
    return;
  }
  usage();
  process.exit(1);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
