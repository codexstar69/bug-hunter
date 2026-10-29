'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-hunter-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts/prepublish-guard.cjs'),
    path.join(root, 'scripts/prepublish-guard.cjs'));
  fs.mkdirSync(path.join(root, 'scripts/tests'));
  fs.copyFileSync(path.join(ROOT, 'scripts/tests/prepublish-guard.test.cjs'),
    path.join(root, 'scripts/tests/prepublish-guard.test.cjs'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@example/bug-hunter-release-fixture', version: '1.2.3',
    scripts: { prepublishOnly: 'node scripts/prepublish-guard.cjs',
      prepack: 'node --test scripts/tests/prepublish-guard.test.cjs' }
  }));
  const git = (...args) => {
    const result = childProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
  const run = (args = [], env = {}) => childProcess.spawnSync(process.execPath,
    [path.join(root, 'scripts/prepublish-guard.cjs'), ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_dry_run: '', ...env }
    });
  return { root, run, git };
}

test('prepublish permits a clean untagged dry run but requires binding for real publication', (t) => {
  const f = fixture(t);
  const dry = f.run(['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run/);
  assert.equal(f.run([], { npm_config_dry_run: 'true', npm_lifecycle_event: 'prepublishOnly' }).status, 0);
  assert.equal(f.run([], { npm_config_dry_run: 'true', npm_lifecycle_event: 'prepack' }).status, 1);
  const real = f.run();
  assert.equal(real.status, 1);
  assert.match(real.stderr, /upstream/);
  assert.match(real.stderr, /exact tag v1\.2\.3/);
  fs.writeFileSync(path.join(f.root, 'CLAUDE.md'), 'local guidance\n');
  const dirty = f.run(['--dry-run']);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /CLAUDE\.md/);
});

test('prepublish explains an untracked-only blocker without weakening the release guard', (t) => {
  const f = fixture(t);
  f.git('remote', 'add', 'origin', 'https://example.com/test.git');
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  f.git('config', 'branch.' + childProcess.execFileSync('git', ['branch', '--show-current'],
    { cwd: f.root, encoding: 'utf8' }).trim() + '.remote', 'origin');
  f.git('config', 'branch.' + childProcess.execFileSync('git', ['branch', '--show-current'],
    { cwd: f.root, encoding: 'utf8' }).trim() + '.merge', 'refs/heads/main');
  f.git('tag', 'v1.2.3');
  assert.equal(f.run().status, 0);
  fs.writeFileSync(path.join(f.root, 'CLAUDE.md'), 'local guidance\n');
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\?\? CLAUDE\.md/);
  assert.match(result.stderr, /Only untracked local files block/);
  assert.match(result.stderr, /reproducible release checkout/);
  assert.match(result.stderr, /clean release checkout|move local-only files/);
});

test('npm publish --dry-run propagates dry-run mode to the prepublish lifecycle', (t) => {
  const f = fixture(t);
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-hunter-npm-dry-run-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const env = { ...process.env, npm_config_cache: cache, npm_config_dry_run: '' };
  delete env.NPM_TOKEN;
  delete env.NODE_AUTH_TOKEN;
  const result = childProcess.spawnSync('npm', ['publish', '--dry-run', '--access', 'public',
    '--provenance', '--registry=https://registry.npmjs.org'], {
    cwd: f.root, env, encoding: 'utf8', timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /HEAD verified for dry-run/);
});

test('workflows gate packed consumers, constrain real dispatches, and check registry provenance', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /node-version: \[22, 24\]/);
  assert.match(ci, /BUG_HUNTER_PACKED_SMOKE: '1'/);
  const publish = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  assert.match(publish, /workflow_dispatch:[\s\S]*dry_run:[\s\S]*default: true/);
  assert.match(publish, /group: publish-\$\{\{ github.event.release.tag_name \|\| github.ref_name \}\}/);
  assert.match(publish, /if: github.event_name == 'release' \|\| startsWith\(github.ref, 'refs\/tags\/'\)/);
  assert.match(publish, /!inputs.dry_run && !startsWith\(github.ref, 'refs\/tags\/'\)/);
  assert.match(publish, /npm publish --dry-run --access public --provenance/);
  assert.match(publish, /npm view .* version dist.attestations --json/);
  assert.match(publish, /https:\/\/slsa.dev\/provenance\/v1/);
  assert.doesNotMatch(publish, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});

test('post-publish verification rejects missing provenance and wrong versions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-hunter-attestations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
  const script = workflow.match(/node -e '([\s\S]*?)' "\$RUNNER_TEMP\/published.json"/)[1];
  const file = path.join(root, 'published.json');
  const attestation = { url: 'https://registry.npmjs.org/-/npm/v1/attestations/example',
    provenance: { predicateType: 'https://slsa.dev/provenance/v1' } };
  for (const [data, expected] of [
    [{ version: '1.2.3', 'dist.attestations': attestation }, 0],
    [{ version: '1.2.2', 'dist.attestations': attestation }, 1],
    [{ version: '1.2.3' }, 1],
    [{ version: '1.2.3', 'dist.attestations': { url: attestation.url } }, 1]
  ]) {
    fs.writeFileSync(file, JSON.stringify(data));
    const result = childProcess.spawnSync(process.execPath, ['-e', script, file], {
      env: { ...process.env, PACKAGE_VERSION: '1.2.3' }, encoding: 'utf8'
    });
    assert.equal(result.status, expected, result.stderr);
  }
});
