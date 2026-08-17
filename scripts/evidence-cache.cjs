#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

function entryPath(cacheRoot, key) {
  if (!/^[a-f0-9]{64}$/.test(String(key))) throw new Error('cache key must be a SHA-256 hex digest');
  const root = canonicalCacheRoot(cacheRoot);
  const directory = path.join(root, key.slice(0, 2));
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('cache shard must not be a symbolic link');
  }
  fs.mkdirSync(directory, { recursive: true });
  const canonicalDirectory = fs.realpathSync(directory);
  if (isOutsideRoot(root, canonicalDirectory)) {
    throw new Error('cache shard escaped cache root');
  }
  const target = path.join(canonicalDirectory, `${key}.json`);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
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

function listEntries(cacheRoot) {
  const root = canonicalCacheRoot(cacheRoot);
  const entries = [];
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^[a-f0-9]{2}$/.test(directory.name)) continue;
    const directoryPath = path.join(root, directory.name);
    for (const file of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      const filePath = path.join(directoryPath, file.name);
      const stat = fs.statSync(filePath);
      entries.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return entries;
}

function getEntry(cacheRoot, key, now = Date.now()) {
  const filePath = entryPath(cacheRoot, key);
  if (!fs.existsSync(filePath)) return { hit: false, key, value: null, metadata: null };
  const record = readJson(filePath);
  if (!record || record.schemaVersion !== 1 || record.key !== key) {
    throw new Error(`cache entry is malformed: ${filePath}`);
  }
  const expiresAtMs = Date.parse(record.expiresAt);
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) {
    fs.unlinkSync(filePath);
    return { hit: false, key, value: null, metadata: { expired: true } };
  }
  record.lastAccessedAt = new Date(now).toISOString();
  record.hits = Number(record.hits || 0) + 1;
  writeAtomic(filePath, record);
  return {
    hit: true,
    key,
    value: record.value,
    metadata: {
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastAccessedAt: record.lastAccessedAt,
      hits: record.hits,
      descriptor: record.descriptor
    }
  };
}

function pruneCache(cacheRoot, options = {}, now = Date.now()) {
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 'maxEntries');
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const maxAgeDays = positiveInteger(options.maxAgeDays, DEFAULT_MAX_AGE_DAYS, 'maxAgeDays');
  const cutoff = now - (maxAgeDays * 24 * 60 * 60 * 1000);
  let entries = listEntries(cacheRoot);
  const removed = [];
  for (const entry of entries) {
    let expired = entry.mtimeMs < cutoff;
    if (!expired) {
      try {
        const record = readJson(entry.filePath);
        const expiresAt = Date.parse(record.expiresAt);
        expired = Number.isFinite(expiresAt) && expiresAt <= now;
      } catch {
        expired = true;
      }
    }
    if (expired) {
      fs.unlinkSync(entry.filePath);
      removed.push({ filePath: entry.filePath, reason: 'expired-or-malformed' });
    }
  }
  entries = listEntries(cacheRoot).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  while (entries.length > maxEntries || totalBytes > maxBytes) {
    const entry = entries.shift();
    if (!entry) break;
    fs.unlinkSync(entry.filePath);
    totalBytes -= entry.size;
    removed.push({ filePath: entry.filePath, reason: 'capacity' });
  }
  return {
    ok: true,
    removed: removed.length,
    removedEntries: removed,
    remainingEntries: entries.length,
    remainingBytes: Math.max(0, totalBytes),
    limits: { maxEntries, maxBytes, maxAgeDays }
  };
}

function putEntry(cacheRoot, descriptor, value, options = {}, now = Date.now()) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('cache descriptor must be a JSON object');
  }
  const key = hashDescriptor(descriptor);
  const maxAgeDays = positiveInteger(options.maxAgeDays, DEFAULT_MAX_AGE_DAYS, 'maxAgeDays');
  const filePath = entryPath(cacheRoot, key);
  const existing = fs.existsSync(filePath) ? readJson(filePath) : null;
  const record = {
    schemaVersion: 1,
    key,
    descriptor: stableValue(descriptor),
    value,
    createdAt: existing && existing.createdAt || new Date(now).toISOString(),
    lastAccessedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (maxAgeDays * 24 * 60 * 60 * 1000)).toISOString(),
    hits: existing ? Number(existing.hits || 0) : 0
  };
  writeAtomic(filePath, record);
  const prune = pruneCache(cacheRoot, options, now);
  return { ok: true, key, filePath, prune };
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
