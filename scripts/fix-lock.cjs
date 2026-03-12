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

function readLock(lockPath) {
  if (!fs.existsSync(lockPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
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
  if (!lockData || typeof lockData.createdAtMs !== 'number') {
    return true;
  }
  const expired = nowMs() - lockData.createdAtMs > ttlSeconds * 1000;
  return expired;
}

function writeLock(lockPath, ownerTokenRaw, exclusive = true) {
  ensureParent(lockPath);
  const lockData = {
    pid: process.pid,
    host: os.hostname(),
    cwd: process.cwd(),
    ownerToken: ownerTokenRaw || crypto.randomUUID(),
    createdAtMs: nowMs(),
    createdAt: new Date().toISOString()
  };
  const fd = fs.openSync(lockPath, exclusive ? 'wx' : 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(lockData, null, 2)}\n`, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return lockData;
}

function assertOwner(existing, ownerToken) {
  if (!existing || !existing.ownerToken) {
    return true;
  }
  return ownerToken === existing.ownerToken;
}

function renew(lockPath, ownerToken) {
  const existing = readLock(lockPath);
  if (!existing) {
    console.log(JSON.stringify({ ok: false, renewed: false, reason: 'no-lock' }, null, 2));
    process.exit(1);
    return;
  }
  if (!assertOwner(existing, ownerToken)) {
    console.log(JSON.stringify({ ok: false, renewed: false, reason: 'lock-owner-mismatch' }, null, 2));
    process.exit(1);
    return;
  }
  existing.createdAtMs = nowMs();
  existing.renewedAt = new Date().toISOString();
  const tempPath = `${lockPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, lockPath);
  console.log(JSON.stringify({ ok: true, renewed: true, lock: existing }, null, 2));
}

function acquire(lockPath, ttlSeconds) {
  const existing = readLock(lockPath);
  if (!existing) {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
    try {
      const lockData = writeLock(lockPath);
      console.log(JSON.stringify({ ok: true, acquired: true, lock: lockData }, null, 2));
      return;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        const current = readLock(lockPath);
        console.log(JSON.stringify({
          ok: false,
          acquired: false,
          reason: 'lock-held',
          lock: current
        }, null, 2));
        process.exit(1);
        return;
      }
      throw error;
    }
  }

  const stale = lockIsStale(existing, ttlSeconds);
  const ownerAlive = typeof existing.pid === 'number' ? pidAlive(existing.pid) : false;

  if (!stale || ownerAlive) {
    console.log(JSON.stringify({
      ok: false,
      acquired: false,
      reason: ownerAlive ? 'lock-held-by-live-owner' : 'lock-held',
      stale,
      ownerAlive,
      lock: existing
    }, null, 2));
    process.exit(1);
  }

  fs.unlinkSync(lockPath);
  try {
    const lockData = writeLock(lockPath);
    console.log(JSON.stringify({
      ok: true,
      acquired: true,
      recoveredFromStaleLock: true,
      previousLock: existing,
      lock: lockData
    }, null, 2));
    return;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const current = readLock(lockPath);
      console.log(JSON.stringify({
        ok: false,
        acquired: false,
        reason: 'lock-held',
        lock: current
      }, null, 2));
      process.exit(1);
      return;
    }
    throw error;
  }
}

function release(lockPath, ownerToken) {
  const existing = readLock(lockPath);
  if (!existing) {
    console.log(JSON.stringify({ ok: true, released: false, reason: 'no-lock' }, null, 2));
    return;
  }
  if (!assertOwner(existing, ownerToken)) {
    console.log(JSON.stringify({ ok: false, released: false, reason: 'lock-owner-mismatch' }, null, 2));
    process.exit(1);
    return;
  }
  fs.unlinkSync(lockPath);
  console.log(JSON.stringify({ ok: true, released: true, previousLock: existing }, null, 2));
}

function status(lockPath, ttlSeconds) {
  const existing = readLock(lockPath);
  if (!existing) {
    console.log(JSON.stringify({ ok: true, exists: false }, null, 2));
    return;
  }
  const stale = lockIsStale(existing, ttlSeconds);
  const alive = typeof existing.pid === 'number' ? pidAlive(existing.pid) : false;
  console.log(JSON.stringify({
    ok: true,
    exists: true,
    stale,
    ownerAlive: alive,
    lock: existing
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
