#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { isDeadLocalPid, reclaimDeadLinkLock } = require('./link-lock.cjs');

const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_AGE_DAYS = 30;

function usage() {
  console.error('Usage:');
  console.error('  evidence-cache.cjs key --descriptor <json>');
  console.error('  evidence-cache.cjs get --cache-root <dir> --key <sha256>');
  console.error('  evidence-cache.cjs put --cache-root <dir> --descriptor <json> --value <json> [--max-entries <n>] [--max-bytes <n>] [--max-age-days <n>]');
  console.error('  evidence-cache.cjs prune --cache-root <dir> [--max-entries <n>] [--max-bytes <n>] [--max-age-days <n>]');
  console.error('  evidence-cache.cjs stats --cache-root <dir>');
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function hashDescriptor(descriptor) {
  return crypto.createHash('sha256').update(stableStringify(descriptor)).digest('hex');
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function canonicalCacheRoot(cacheRoot) {
  const resolved = path.resolve(cacheRoot);
  fs.mkdirSync(resolved, { recursive: true });
  return fs.realpathSync(resolved);
}

function isOutsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function entryPath(cacheRoot, key, create = true) {
  if (!/^[a-f0-9]{64}$/.test(String(key))) throw new Error('cache key must be a SHA-256 hex digest');
  const resolved = path.resolve(cacheRoot);
  if (!create && !safeStat(resolved)) return path.join(resolved, key.slice(0, 2), `${key}.json`);
  const root = create ? canonicalCacheRoot(resolved) : fs.realpathSync(resolved);
  const directory = path.join(root, key.slice(0, 2));
  if (safeStat(directory)?.isSymbolicLink()) {
    throw new Error('cache shard must not be a symbolic link');
  }
  if (create) fs.mkdirSync(directory, { recursive: true });
  if (!create && !safeStat(directory)) return path.join(directory, `${key}.json`);
  const canonicalDirectory = fs.realpathSync(directory);
  if (isOutsideRoot(root, canonicalDirectory)) {
    throw new Error('cache shard escaped cache root');
  }
  const target = path.join(canonicalDirectory, `${key}.json`);
  if (safeStat(target)?.isSymbolicLink()) {
    throw new Error('cache entry must not be a symbolic link');
  }
  if (isOutsideRoot(root, target)) {
    throw new Error('cache entry path escaped cache root');
  }
  return target;
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function safeStat(filePath) {
  try { return fs.lstatSync(filePath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function controlPath(root, name) {
  const target = path.join(root, name);
  if (safeStat(target)?.isSymbolicLink()) throw new Error('cache metadata must not be a symbolic link');
  return target;
}

// Serialize capacity accounting across CLI processes. Hard-link installation
// publishes a complete owner record, so an interrupted owner can be reclaimed.
function withMaintenance(cacheRoot, operation) {
  const root = canonicalCacheRoot(cacheRoot);
  const lock = controlPath(root, '.capacity-lock');
  const token = crypto.randomUUID();
  const candidate = path.join(root, `.capacity-lock.${token}.tmp`);
  fs.writeFileSync(candidate, JSON.stringify({ pid: process.pid, host: os.hostname(), token }), { flag: 'wx' });
  const deadline = Date.now() + 30000;
  try {
    while (true) {
      try { fs.linkSync(candidate, lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        controlPath(root, '.capacity-lock');
        let owner;
        try { owner = readJson(lock); }
        catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('cache maintenance lock is malformed');
        // A PID is only meaningful on its own host; a remote owner is waited out.
        const local = !owner.host || owner.host === os.hostname();
        if (local && isDeadLocalPid(owner.pid) && reclaimDeadLinkLock(lock, owner) !== 'busy') continue;
        if (Date.now() >= deadline) throw new Error('cache maintenance lock is busy');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { return operation(root); }
    finally { fs.unlinkSync(lock); }
  } finally { fs.unlinkSync(candidate); }
}

function listEntries(cacheRoot) {
  const root = canonicalCacheRoot(cacheRoot);
  const entries = [];
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    if (!/^[a-f0-9]{2}$/.test(directory.name)) continue;
    if (directory.isSymbolicLink()) throw new Error('cache shard must not be a symbolic link');
    if (!directory.isDirectory()) continue;
    const directoryPath = path.join(root, directory.name);
    for (const file of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      if (file.isSymbolicLink()) throw new Error('cache entry must not be a symbolic link');
      if (!file.isFile()) continue;
      const filePath = path.join(directoryPath, file.name);
      const stat = fs.statSync(filePath);
      entries.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return entries;
}

function readRecord(filePath, key) {
  let record;
  try { record = readJson(filePath); }
  catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') return null; throw error; }
  if (!record || record.schemaVersion !== 1 || record.key !== key || !Number.isFinite(Date.parse(record.expiresAt)) || !Object.hasOwn(record, 'value')) return null;
  return record;
}

function limitsFor(options) {
  return {
    maxEntries: positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 'maxEntries'),
    maxBytes: positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes'),
    maxAgeDays: positiveInteger(options.maxAgeDays, DEFAULT_MAX_AGE_DAYS, 'maxAgeDays')
  };
}

function readCapacity(root) {
  const target = controlPath(root, '.capacity.json');
  let data;
  try { data = readJson(target); }
  catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') return null; throw error; }
  if (!data || data.schemaVersion !== 1 || data.dirty || ![data.entries, data.bytes, data.putsSincePrune].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  return data;
}

function saveCapacity(root, data) {
  writeAtomic(controlPath(root, '.capacity.json'), { schemaVersion: 1, ...data });
}

function sweepStaleLockTemps(root, now) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!/^\.capacity-lock\.[a-f0-9-]+\.tmp$/.test(entry.name) || !entry.isFile()) continue;
    const temporary = path.join(root, entry.name);
    let owner;
    try { owner = readJson(temporary); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      if (!(error instanceof SyntaxError)) throw error;
      if (now - fs.statSync(temporary).mtimeMs > 30000) fs.unlinkSync(temporary);
      continue;
    }
    if (owner.host && owner.host !== os.hostname()) continue;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') fs.unlinkSync(temporary);
      else if (error.code !== 'EPERM') throw error;
    }
  }
}

function pruneUnlocked(root, limits, now, headroom = false) {
  sweepStaleLockTemps(root, now);
  const cutoff = now - limits.maxAgeDays * 86400000;
  const entries = listEntries(root);
  const retained = [];
  const removedEntries = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const key = path.basename(entry.filePath, '.json');
    const record = readRecord(entry.filePath, key);
    if (!record || Date.parse(record.expiresAt) <= now || entry.mtimeMs < cutoff) {
      fs.unlinkSync(entry.filePath);
      removedEntries.push({ filePath: entry.filePath, reason: 'expired-or-malformed' });
    } else {
      retained.push(entry);
      totalBytes += entry.size;
    }
  }
  // Fixed recency buckets keep maintenance linear, favoring older entries
  // without an O(n log n) sort on each periodic/capacity sweep.
  const oldest = retained.reduce((min, entry) => Math.min(min, entry.mtimeMs), Infinity);
  const newest = retained.reduce((max, entry) => Math.max(max, entry.mtimeMs), -Infinity);
  const buckets = Array.from({ length: 64 }, () => []);
  for (const entry of retained) {
    const bucket = newest > oldest ? Math.floor((entry.mtimeMs - oldest) / (newest - oldest) * 63) : 0;
    buckets[bucket].push(entry);
  }
  const evictionOrder = buckets.flat();
  const entryLimit = headroom ? Math.max(1, Math.floor(limits.maxEntries * 0.8)) : limits.maxEntries;
  const byteLimit = headroom ? Math.floor(limits.maxBytes * 0.8) : limits.maxBytes;
  let offset = 0;
  while (retained.length - offset > entryLimit || totalBytes > byteLimit) {
    const entry = evictionOrder[offset++];
    if (!entry) break;
    fs.unlinkSync(entry.filePath);
    totalBytes -= entry.size;
    removedEntries.push({ filePath: entry.filePath, reason: 'capacity' });
  }
  const remainingEntries = retained.length - offset;
  saveCapacity(root, { entries: remainingEntries, bytes: totalBytes, putsSincePrune: 0 });
  return { ok: true, removed: removedEntries.length, removedEntries, remainingEntries, remainingBytes: totalBytes, limits };
}

function getEntry(cacheRoot, key, now = Date.now()) {
  const filePath = entryPath(cacheRoot, key, false);
  const record = readRecord(filePath, key);
  if (!record || Date.parse(record.expiresAt) <= now) {
    return { hit: false, key, value: null, metadata: record ? { expired: true } : null };
  }
  // Reads are immutable and lock-free. Prune owns expiry deletion and capacity
  // accounting; access telemetry must not turn a cache hit into a write lease.
  return {
    hit: true, key, value: record.value,
    metadata: { createdAt: record.createdAt, expiresAt: record.expiresAt, lastAccessedAt: record.lastAccessedAt, hits: record.hits, descriptor: record.descriptor }
  };
}

function pruneCache(cacheRoot, options = {}, now = Date.now()) {
  const limits = limitsFor(options);
  return withMaintenance(cacheRoot, (root) => {
    // A crash during deletion leaves accounting explicitly untrusted.
    saveCapacity(root, { dirty: true });
    return pruneUnlocked(root, limits, now);
  });
}

function putEntry(cacheRoot, descriptor, value, options = {}, now = Date.now()) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('cache descriptor must be a JSON object');
  const key = hashDescriptor(descriptor);
  const limits = limitsFor(options);
  return withMaintenance(cacheRoot, (root) => {
    const filePath = entryPath(root, key);
    let capacity = readCapacity(root);
    if (!capacity) {
      pruneUnlocked(root, limits, now);
      capacity = readCapacity(root);
    }
    const existing = readRecord(filePath, key);
    const previousSize = safeStat(filePath)?.size || 0;
    const record = {
      schemaVersion: 1, key, descriptor: stableValue(descriptor), value,
      createdAt: existing && existing.createdAt || new Date(now).toISOString(),
      lastAccessedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + limits.maxAgeDays * 86400000).toISOString(),
      hits: existing ? Number(existing.hits || 0) : 0
    };
    // Persist intent first: interrupted entry/metadata writes force one rebuild.
    saveCapacity(root, { ...capacity, dirty: true });
    writeAtomic(filePath, record);
    capacity.entries += previousSize ? 0 : 1;
    capacity.bytes += fs.statSync(filePath).size - previousSize;
    capacity.putsSincePrune += 1;
    let prune;
    // Batch eviction creates headroom, preventing a full sweep on each put at capacity.
    if (capacity.entries > limits.maxEntries || capacity.bytes > limits.maxBytes || capacity.putsSincePrune >= Math.max(16, Math.floor(limits.maxEntries / 4))) {
      prune = pruneUnlocked(root, limits, now, capacity.entries > limits.maxEntries || capacity.bytes > limits.maxBytes);
    } else {
      saveCapacity(root, capacity);
      prune = { ok: true, removed: 0, removedEntries: [], remainingEntries: capacity.entries, remainingBytes: capacity.bytes, limits };
    }
    return { ok: true, key, filePath, prune };
  });
}

function cacheStats(cacheRoot) {
  const entries = listEntries(cacheRoot);
  return {
    ok: true,
    entries: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    oldestMtimeMs: entries.length === 0 ? null : Math.min(...entries.map((entry) => entry.mtimeMs)),
    newestMtimeMs: entries.length === 0 ? null : Math.max(...entries.map((entry) => entry.mtimeMs))
  };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === 'key') {
    if (!options.descriptor) throw new Error('--descriptor is required');
    console.log(JSON.stringify({ key: hashDescriptor(readJson(path.resolve(options.descriptor))) }, null, 2));
    return;
  }
  if (!options['cache-root']) throw new Error('--cache-root is required');
  const cacheRoot = path.resolve(options['cache-root']);
  if (command === 'get') {
    if (!options.key) throw new Error('--key is required');
    const result = getEntry(cacheRoot, options.key);
    console.log(JSON.stringify(result, null, 2));
    if (!result.hit) process.exitCode = 2;
    return;
  }
  const limits = {
    maxEntries: options['max-entries'],
    maxBytes: options['max-bytes'],
    maxAgeDays: options['max-age-days']
  };
  if (command === 'put') {
    if (!options.descriptor || !options.value) throw new Error('--descriptor and --value are required');
    console.log(JSON.stringify(putEntry(
      cacheRoot,
      readJson(path.resolve(options.descriptor)),
      readJson(path.resolve(options.value)),
      limits
    ), null, 2));
    return;
  }
  if (command === 'prune') {
    console.log(JSON.stringify(pruneCache(cacheRoot, limits), null, 2));
    return;
  }
  if (command === 'stats') {
    console.log(JSON.stringify(cacheStats(cacheRoot), null, 2));
    return;
  }
  usage();
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  cacheStats,
  getEntry,
  hashDescriptor,
  pruneCache,
  putEntry,
  stableStringify
};
