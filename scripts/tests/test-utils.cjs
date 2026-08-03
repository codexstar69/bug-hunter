const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const createdSandboxes = new Set();

function cleanupSandboxes() {
  [...createdSandboxes]
    .sort((a, b) => b.length - a.length)
    .map((sandbox) => {
      try {
        fs.rmSync(sandbox, { recursive: true, force: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Failed to clean test sandbox ${sandbox}: ${message}\n`);
      }
      return sandbox;
    });
  createdSandboxes.clear();
}

process.once('exit', cleanupSandboxes);

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
  const sandbox = fs.mkdtempSync(path.join(tmpBase, prefix));
  createdSandboxes.add(sandbox);
  return sandbox;
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
  cleanupSandboxes,
  readJson,
  resolveSkillScript,
  runJson,
  runRaw,
  makeSandbox,
  shellQuote,
  writeJson
};
