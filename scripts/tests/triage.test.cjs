const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  resolveSkillScript,
  runJson,
  runRaw
} = require('./test-utils.cjs');

function writeSource(filePath, content = 'export const value = true;\n') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('triage orders every maintained source tier and includes bin and scripts', () => {
  const sandbox = makeSandbox('triage-order-');
  const triage = resolveSkillScript('triage.cjs');

  try {
    [
      'auth/session.js',
      'service/store.js',
      'plain/main.js',
      'scripts/tool.js',
      'docs/guide.js',
      'tests/main.test.js'
    ].map((relativePath) => {
      return path.join(sandbox, relativePath);
    }).map((filePath) => {
      writeSource(filePath);
      return filePath;
    });
    writeSource(path.join(sandbox, 'bin', 'cli'), '#!/usr/bin/env node\nconsole.log("ready");\n');

    const result = runJson('node', [triage, 'scan', sandbox]);
    assert.deepEqual(result.domains.map((domain) => {
      return domain.tier;
    }), ['CRITICAL', 'HIGH', 'MEDIUM', 'MEDIUM', 'LOW', 'LOW', 'CONTEXT-ONLY']);
    assert.deepEqual(result.scanOrder, [
      'auth/session.js',
      'service/store.js',
      'bin/cli',
      'plain/main.js',
      'docs/guide.js',
      'scripts/tool.js'
    ]);
    assert.equal(result.scannableFiles, 6);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('triage rejects invalid max depths and accepts a depth of zero', () => {
  const sandbox = makeSandbox('triage-depth-');
  const triage = resolveSkillScript('triage.cjs');

  try {
    writeSource(path.join(sandbox, 'root.js'));
    writeSource(path.join(sandbox, 'nested', 'hidden.js'));

    ['-1', '1.5', 'not-a-number', '101'].map((maxDepth) => {
      return runRaw('node', [triage, 'scan', sandbox, '--max-depth', maxDepth]);
    }).map((result) => {
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /integer between 0 and 100/);
      return result;
    });

    const rootOnly = runJson('node', [triage, 'scan', sandbox, '--max-depth', '0']);
    assert.equal(rootOnly.totalFiles, 1);
    assert.deepEqual(rootOnly.scanOrder, ['root.js']);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
