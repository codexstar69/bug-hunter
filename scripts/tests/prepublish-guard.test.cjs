'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const TEST_ROOT = path.join(REPOSITORY_ROOT, 'tmp');

function createGuardFixture() {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const fixtureRoot = path.join(
    TEST_ROOT,
    `prepublish-guard-${process.pid}-${crypto.randomUUID()}`
  );
  const scriptsDir = path.join(fixtureRoot, 'scripts');
  const fakeBinDir = path.join(fixtureRoot, 'fake-bin');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.copyFileSync(
    path.join(REPOSITORY_ROOT, 'scripts', 'prepublish-guard.cjs'),
    path.join(scriptsDir, 'prepublish-guard.cjs')
  );
  fs.writeFileSync(
    path.join(fixtureRoot, 'package.json'),
    `${JSON.stringify({ version: '1.2.3' })}\n`
  );

  const fakeGitPath = path.join(fakeBinDir, 'git');
  fs.writeFileSync(fakeGitPath, `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2).join(' ');
const scenario = process.env.FAKE_GIT_SCENARIO || 'success';
if (args === 'status --porcelain') process.exit(0);
if (args === 'rev-parse --verify HEAD^{commit}') {
  process.stdout.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n');
  process.exit(0);
}
if (args === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
  if (scenario === 'missing-upstream') process.exit(2);
  process.stdout.write('origin/release\\n');
  process.exit(0);
}
if (args === 'rev-parse --verify @{upstream}^{commit}') {
  process.stdout.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n');
  process.exit(0);
}
if (args === 'rev-parse --verify refs/tags/v1.2.3^{commit}') {
  if (scenario === 'missing-tag') process.exit(2);
  if (scenario === 'wrong-tag') {
    process.stdout.write('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n');
    process.exit(0);
  }
  process.stdout.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n');
  process.exit(0);
}
process.stderr.write('unexpected fake git args: ' + args + '\\n');
process.exit(3);
`);
  fs.chmodSync(fakeGitPath, 0o755);
  return { fakeBinDir, fixtureRoot };
}

function runGuard({ fakeBinDir, fixtureRoot, scenario }) {
  return childProcess.spawnSync(
    process.execPath,
    [path.join(fixtureRoot, 'scripts', 'prepublish-guard.cjs')],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_GIT_SCENARIO: scenario,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ''}`
      }
    }
  );
}

test('prepublish guard requires clean exact upstream and tag proof', () => {
  const fixture = createGuardFixture();
  try {
    const result = runGuard({ ...fixture, scenario: 'success' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /HEAD matches origin\/release and v1\.2\.3/);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('prepublish guard fails closed when upstream proof is missing', () => {
  const fixture = createGuardFixture();
  try {
    const result = runGuard({ ...fixture, scenario: 'missing-upstream' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot prove the current branch upstream/);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('prepublish guard requires the exact package tag at HEAD', () => {
  const fixture = createGuardFixture();
  try {
    const missing = runGuard({ ...fixture, scenario: 'missing-tag' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Cannot prove exact tag v1\.2\.3/);

    const wrong = runGuard({ ...fixture, scenario: 'wrong-tag' });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /Tag v1\.2\.3 does not point to HEAD/);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});
