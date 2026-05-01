const fs = require('fs');
const path = require('path');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function severityRank(severity) {
  const normalized = String(severity || '').toLowerCase();
  if (normalized === 'critical') return 3;
  if (normalized === 'high') return 2;
  if (normalized === 'medium') return 1;
  if (normalized === 'low') return 0;
  return -1;
}

function shellQuote(value) {
  const stringValue = String(value);
  if (stringValue.length === 0) {
    return "''";
  }
  return `'${stringValue.replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  ensureDir,
  ensureParentDir,
  nowIso,
  readJson,
  writeJson,
  toArray,
  toPositiveInt,
  toBoolean,
  severityRank,
  shellQuote
};
