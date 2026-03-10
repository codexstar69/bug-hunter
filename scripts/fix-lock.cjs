#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

function usage() {
  console.error('Usage:');
  console.error('  fix-lock.cjs acquire <lockPath> [ttlSeconds]');
  console.error('  fix-lock.cjs renew <lockPath>');
  console.error('  fix-lock.cjs release <lockPath>');
  console.error('  fix-lock.cjs status <lockPath> [ttlSeconds]');
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
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
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

function writeLock(lockPath) {
  ensureParent(lockPath);
  const lockData = {
    pid: process.pid,
    host: os.hostname(),
    cwd: process.cwd(),
    createdAtMs: nowMs(),
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(lockData, null, 2)}\n`, 'utf8');
  return lockData;
}

function renew(lockPath) {
  const existing = readLock(lockPath);
  if (!existing) {
    console.log(JSON.stringify({ ok: false, renewed: false, reason: 'no-lock' }, null, 2));
    process.exit(1);
    return;
  }
  existing.createdAtMs = nowMs();
  existing.renewedAt = new Date().toISOString();
  fs.writeFileSync(lockPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, renewed: true, lock: existing }, null, 2));
}

function acquire(lockPath, ttlSeconds) {
  const existing = readLock(lockPath);
  if (!existing) {
    const lockData = writeLock(lockPath);
    console.log(JSON.stringify({ ok: true, acquired: true, lock: lockData }, null, 2));
    return;
  }

  if (!lockIsStale(existing, ttlSeconds)) {
    console.log(JSON.stringify({
      ok: false,
      acquired: false,
      reason: 'lock-held',
      lock: existing
    }, null, 2));
    process.exit(1);
  }

  fs.unlinkSync(lockPath);
  const lockData = writeLock(lockPath);
  console.log(JSON.stringify({
    ok: true,
    acquired: true,
    recoveredFromStaleLock: true,
    previousLock: existing,
    lock: lockData
  }, null, 2));
}

function release(lockPath) {
  const existing = readLock(lockPath);
  if (!existing) {
    console.log(JSON.stringify({ ok: true, released: false, reason: 'no-lock' }, null, 2));
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
  const [command, lockPath, ttlRaw] = process.argv.slice(2);
  if (!command || !lockPath) {
    usage();
    process.exit(1);
  }
  const ttlParsed = Number.parseInt(ttlRaw || '', 10);
  const ttlSeconds = Number.isInteger(ttlParsed) && ttlParsed > 0 ? ttlParsed : 1800;

  if (command === 'acquire') {
    acquire(lockPath, ttlSeconds);
    return;
  }
  if (command === 'renew') {
    renew(lockPath);
    return;
  }
  if (command === 'release') {
    release(lockPath);
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
