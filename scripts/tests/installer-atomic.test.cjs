'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const TEST_ROOT = path.join(REPOSITORY_ROOT, 'tmp');

function writeFile({ filePath, contents, mode }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  if (mode) {
    fs.chmodSync(filePath, mode);
  }
}

function createPackageSource(sourceRoot) {
  const packageJson = {
    name: '@example/bug-hunter-fixture',
    version: '1.0.0',
    type: 'commonjs',
    engines: { node: '>=22.0.0' },
    files: ['bin/', 'scripts/', 'runtime/', 'SKILL.md']
  };

  writeFile({
    filePath: path.join(sourceRoot, 'package.json'),
    contents: `${JSON.stringify(packageJson, null, 2)}\n`
  });
  writeFile({
    filePath: path.join(sourceRoot, 'SKILL.md'),
    contents: '---\nname: bug-hunter-fixture\ndescription: fixture\n---\n'
  });
  fs.mkdirSync(path.join(sourceRoot, 'bin'), { recursive: true });
  fs.copyFileSync(
    path.join(REPOSITORY_ROOT, 'bin', 'bug-hunter'),
    path.join(sourceRoot, 'bin', 'bug-hunter')
  );
  fs.chmodSync(path.join(sourceRoot, 'bin', 'bug-hunter'), 0o755);
  writeFile({
    filePath: path.join(sourceRoot, 'scripts', 'run-bug-hunter.cjs'),
    contents: "'use strict';\n"
  });
  writeFile({
    filePath: path.join(sourceRoot, 'runtime', 'obsolete.txt'),
    contents: 'old managed file\n'
  });
}

function runInstall({ sourceRoot, targetRoot }) {
  return childProcess.spawnSync(
    process.execPath,
    [
      path.join(sourceRoot, 'bin', 'bug-hunter'),
      'install',
      '--path',
      targetRoot,
      '--skip-doctor'
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8'
    }
  );
}

test('installer atomically upgrades managed files and preserves user files', () => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const sandboxRoot = path.join(
    TEST_ROOT,
    `installer-atomic-${process.pid}-${crypto.randomUUID()}`
  );
  const sourceRoot = path.join(sandboxRoot, 'source');
  const targetRoot = path.join(sandboxRoot, 'installed', 'bug-hunter');

  try {
    createPackageSource(sourceRoot);
    const firstInstall = runInstall({ sourceRoot, targetRoot });
    assert.equal(firstInstall.status, 0, firstInstall.stderr);
    assert.equal(fs.existsSync(path.join(targetRoot, 'runtime', 'obsolete.txt')), true);

    writeFile({
      filePath: path.join(targetRoot, 'user-notes.md'),
      contents: 'keep this user file\n'
    });
    fs.rmSync(path.join(sourceRoot, 'runtime', 'obsolete.txt'));
    writeFile({
      filePath: path.join(sourceRoot, 'runtime', 'current.txt'),
      contents: 'new managed file\n'
    });

    const secondInstall = runInstall({ sourceRoot, targetRoot });
    assert.equal(secondInstall.status, 0, secondInstall.stderr);
    assert.equal(fs.existsSync(path.join(targetRoot, 'runtime', 'obsolete.txt')), false);
    assert.equal(
      fs.readFileSync(path.join(targetRoot, 'runtime', 'current.txt'), 'utf8'),
      'new managed file\n'
    );
    assert.equal(
      fs.readFileSync(path.join(targetRoot, 'user-notes.md'), 'utf8'),
      'keep this user file\n'
    );

    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(targetRoot, '.bug-hunter-install-manifest.json'),
        'utf8'
      )
    );
    assert.equal(manifest.managedFiles.includes('runtime/current.txt'), true);
    assert.equal(manifest.managedFiles.includes('runtime/obsolete.txt'), false);
    assert.equal(manifest.managedFiles.includes('user-notes.md'), false);
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('failed staged validation leaves the prior install unchanged and cleans staging', () => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const sandboxRoot = path.join(
    TEST_ROOT,
    `installer-rollback-${process.pid}-${crypto.randomUUID()}`
  );
  const sourceRoot = path.join(sandboxRoot, 'source');
  const installParent = path.join(sandboxRoot, 'installed');
  const targetRoot = path.join(installParent, 'bug-hunter');

  try {
    createPackageSource(sourceRoot);
    const firstInstall = runInstall({ sourceRoot, targetRoot });
    assert.equal(firstInstall.status, 0, firstInstall.stderr);
    const manifestBefore = fs.readFileSync(
      path.join(targetRoot, '.bug-hunter-install-manifest.json'),
      'utf8'
    );

    fs.rmSync(path.join(sourceRoot, 'scripts', 'run-bug-hunter.cjs'));
    const failedInstall = runInstall({ sourceRoot, targetRoot });
    assert.equal(failedInstall.status, 1);
    assert.match(failedInstall.stderr, /Runtime allowlist|missing required file/);
    assert.equal(
      fs.readFileSync(path.join(targetRoot, '.bug-hunter-install-manifest.json'), 'utf8'),
      manifestBefore
    );

    const leftovers = fs.readdirSync(installParent).filter((entry) => {
      return entry.startsWith('.bug-hunter.staging-') ||
        entry.startsWith('.bug-hunter.backup-');
    });
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});
