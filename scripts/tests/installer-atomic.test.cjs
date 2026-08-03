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

function runDoctor({ sourceRoot, targetRoot, homeRoot }) {
  return childProcess.spawnSync(
    process.execPath,
    [
      path.join(sourceRoot, 'bin', 'bug-hunter'),
      'doctor',
      '--path',
      targetRoot
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: homeRoot ? { ...process.env, HOME: homeRoot } : process.env
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

test('doctor verifies the installed runtime and ignores user-owned files', () => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const sandboxRoot = path.join(
    TEST_ROOT,
    `installer-doctor-${process.pid}-${crypto.randomUUID()}`
  );
  const sourceRoot = path.join(sandboxRoot, 'source');
  const targetRoot = path.join(sandboxRoot, 'installed', 'bug-hunter');

  try {
    createPackageSource(sourceRoot);
    const installResult = runInstall({ sourceRoot, targetRoot });
    assert.equal(installResult.status, 0, installResult.stderr);
    writeFile({
      filePath: path.join(targetRoot, 'user-notes.md'),
      contents: 'not managed by bug-hunter\n'
    });

    const doctorResult = runDoctor({ sourceRoot, targetRoot });
    assert.equal(doctorResult.status, 0, doctorResult.stderr);
    assert.match(
      doctorResult.stdout,
      /\[ok\] Bug Hunter runtime v1\.0\.0 is current and complete/
    );
    assert.match(doctorResult.stdout, /Ready to hunt bugs/);
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('doctor fails closed for missing and outdated install manifests', () => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const sandboxRoot = path.join(
    TEST_ROOT,
    `installer-doctor-invalid-${process.pid}-${crypto.randomUUID()}`
  );
  const sourceRoot = path.join(sandboxRoot, 'source');
  const targetRoot = path.join(sandboxRoot, 'installed', 'bug-hunter');
  const manifestPath = path.join(targetRoot, '.bug-hunter-install-manifest.json');

  try {
    createPackageSource(sourceRoot);
    const installResult = runInstall({ sourceRoot, targetRoot });
    assert.equal(installResult.status, 0, installResult.stderr);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.packageVersion = '0.9.0';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const outdatedResult = runDoctor({ sourceRoot, targetRoot });
    assert.equal(outdatedResult.status, 1);
    assert.match(outdatedResult.stderr, /Installed version 0\.9\.0 is not current/);
    assert.match(outdatedResult.stderr, /Reinstall Bug Hunter/);

    fs.rmSync(manifestPath);
    const missingResult = runDoctor({ sourceRoot, targetRoot });
    assert.equal(missingResult.status, 1);
    assert.match(missingResult.stderr, /Install manifest is missing/);
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('doctor resolves an explicit agent under an isolated home directory', () => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const sandboxRoot = path.join(
    TEST_ROOT,
    `installer-doctor-agent-${process.pid}-${crypto.randomUUID()}`
  );
  const sourceRoot = path.join(sandboxRoot, 'source');
  const homeRoot = path.join(sandboxRoot, 'home');
  const targetRoot = path.join(homeRoot, '.agents', 'skills', 'bug-hunter');

  try {
    createPackageSource(sourceRoot);
    const installResult = childProcess.spawnSync(
      process.execPath,
      [
        path.join(sourceRoot, 'bin', 'bug-hunter'),
        'install',
        '--agent',
        'agents',
        '--skip-doctor'
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: { ...process.env, HOME: homeRoot }
      }
    );
    assert.equal(installResult.status, 0, installResult.stderr);

    const doctorResult = childProcess.spawnSync(
      process.execPath,
      [
        path.join(sourceRoot, 'bin', 'bug-hunter'),
        'doctor',
        '--agent',
        'agents'
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: { ...process.env, HOME: homeRoot }
      }
    );
    assert.equal(doctorResult.status, 0, doctorResult.stderr);
    assert.match(
      doctorResult.stdout,
      /\[ok\] Bug Hunter runtime v1\.0\.0 is current and complete/
    );
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});
