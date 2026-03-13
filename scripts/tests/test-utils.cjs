const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function runJson(cmd, args, options = {}) {
  const result = childProcess.spawnSync(cmd, args, {
    encoding: 'utf8',
    ...options
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    const message = stderr || stdout || `${cmd} failed`;
    const error = new Error(message);
    error.result = result;
    throw error;
  }
  const output = (result.stdout || '').trim();
  if (!output) {
    return {};
  }
  return JSON.parse(output);
}

function runRaw(cmd, args, options = {}) {
  return childProcess.spawnSync(cmd, args, {
    encoding: 'utf8',
    ...options
  });
}

function makeSandbox(prefix = 'bug-hunter-test-') {
  const tmpBase = path.resolve('tmp');
  fs.mkdirSync(tmpBase, { recursive: true });
  return fs.mkdtempSync(path.join(tmpBase, prefix));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveSkillScript(...parts) {
  return path.resolve(__dirname, '..', ...parts);
}

function shellQuote(value) {
  const s = String(value);
  if (s.length === 0) return "''";
  return `'${s.replace(/'/g, "'\\''")}'`;
}

module.exports = {
  readJson,
  resolveSkillScript,
  runJson,
  runRaw,
  makeSandbox,
  shellQuote,
  writeJson
};
