'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = '.bug-hunter-install-manifest.json';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-hunter-opt-e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(home);
  fs.copyFileSync(path.join(ROOT, 'bin/bug-hunter'), path.join(source, 'bin/bug-hunter'));
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: '@example/bug-hunter', version: '1.0.0', engines: { node: '>=22' },
    files: ['bin/', 'scripts/', 'SKILL.md']
  }));
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: bug-hunter\n---\n');
  fs.writeFileSync(path.join(source, 'scripts/run-bug-hunter.cjs'), "'use strict';\n");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  const run = (...args) => childProcess.spawnSync(process.execPath,
    [path.join(source, 'bin/bug-hunter'), ...args], { encoding: 'utf8', env });
  const target = path.join(home, '.agents/skills/bug-hunter');
  const install = (dir = target) => {
    const result = run('install', '--path', dir, '--skip-doctor');
    assert.equal(result.status, 0, result.stderr);
    return dir;
  };
  return { root, source, home, env, run, target, install };
}

test('global agent destinations match official discovery paths and OpenCode respects XDG', (t) => {
  const f = fixture(t);
  const destinations = {
    'claude-code': '.claude/skills/bug-hunter', codex: '.agents/skills/bug-hunter',
    agents: '.agents/skills/bug-hunter', cursor: '.cursor/skills/bug-hunter',
    kiro: '.kiro/skills/bug-hunter', copilot: '.copilot/skills/bug-hunter',
    windsurf: '.codeium/windsurf/skills/bug-hunter',
    opencode: '.config/opencode/skills/bug-hunter', droid: '.factory/skills/bug-hunter'
  };
  for (const [agent, destination] of Object.entries(destinations)) {
    const result = f.run('install', '--agent', agent, '--skip-doctor');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(f.home, destination, MANIFEST)), agent);
  }
  f.env.XDG_CONFIG_HOME = path.join(f.home, 'custom-config');
  assert.equal(f.run('install', '--agent', 'opencode', '--skip-doctor').status, 0);
  assert.ok(fs.existsSync(path.join(f.env.XDG_CONFIG_HOME, 'opencode/skills/bug-hunter', MANIFEST)));
  delete f.env.XDG_CONFIG_HOME;
  assert.equal(f.run('doctor', '--agent', 'opencode').status, 0);
});

test('bare doctor fails with no install and checks later targets after a healthy copy', (t) => {
  const f = fixture(t);
  const empty = f.run('doctor');
  assert.equal(empty.status, 1);
  assert.doesNotMatch(empty.stdout, /Ready to hunt bugs/);
  f.install(path.join(f.home, '.claude/skills/bug-hunter'));
  const later = f.install(path.join(f.home, '.factory/skills/bug-hunter'));
  fs.writeFileSync(path.join(later, 'scripts/run-bug-hunter.cjs'), 'invalid javascript {');
  const result = f.run('doctor');
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /droid/);
  assert.match(result.stderr, /content mismatch.*scripts\/run-bug-hunter\.cjs/);
});

test('doctor verifies SHA-256 digests even when running from the corrupted installed copy', (t) => {
  const f = fixture(t);
  f.install();
  const manifestPath = path.join(f.target, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const script = 'scripts/run-bug-hunter.cjs';
  assert.equal(manifest.fileDigests[script], crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(f.source, script))).digest('hex'));
  fs.writeFileSync(path.join(f.target, script), 'invalid javascript {');
  const installedDoctor = childProcess.spawnSync(process.execPath,
    [path.join(f.target, 'bin/bug-hunter'), 'doctor'], { encoding: 'utf8', env: f.env });
  assert.equal(installedDoctor.status, 1);
  assert.match(installedDoctor.stderr, /content mismatch/);
  // Updating the local manifest must not hide differences from the CLI package.
  manifest.fileDigests[script] = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(f.target, script))).digest('hex');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(f.run('doctor', '--path', f.target).status, 1);
  f.install();
  fs.rmSync(path.join(f.target, script));
  assert.equal(f.run('doctor', '--path', f.target).status, 1);
});

test('doctor checks legacy managed manifests against package contents', (t) => {
  const f = fixture(t);
  f.install();
  const manifestPath = path.join(f.target, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.manifestVersion = 1;
  delete manifest.fileDigests;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(f.run('doctor', '--path', f.target).status, 0);
  fs.appendFileSync(path.join(f.target, 'SKILL.md'), 'modified');
  assert.equal(f.run('doctor', '--path', f.target).status, 1);
});

test('doctor accepts complete unmanaged installs with a versioned warning and rejects corruption', (t) => {
  const f = fixture(t);
  f.install();
  fs.rmSync(path.join(f.target, MANIFEST));
  const result = f.run('doctor', '--path', f.target);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unmanaged.*v1\.0\.0/i);
  fs.appendFileSync(path.join(f.target, 'SKILL.md'), 'modified');
  assert.equal(f.run('doctor', '--path', f.target).status, 1);
});

test('doctor resolves linked installs within HOME, reports metadata as JSON, and rejects external links', (t) => {
  const f = fixture(t);
  f.install();
  const linked = path.join(f.home, '.cursor/skills/bug-hunter');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(f.target, linked, 'dir');
  const result = f.run('doctor', '--agent', 'cursor', '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.installs[0].realpath, fs.realpathSync(f.target));
  assert.equal(report.installs[0].linkedTo, fs.realpathSync(f.target));
  assert.equal(report.installs[0].version, '1.0.0');
  assert.equal(report.installs[0].managed, true);
  fs.rmSync(linked);
  const outside = f.install(path.join(f.root, 'outside'));
  fs.symlinkSync(outside, linked, 'dir');
  assert.equal(f.run('doctor', '--agent', 'cursor').status, 1);
  fs.rmSync(linked);
  fs.symlinkSync(path.join(f.home, 'missing'), linked, 'dir');
  assert.equal(f.run('doctor', '--agent', 'cursor').status, 1);
});

test('doctor reports stale and legacy copies without deleting them', (t) => {
  const f = fixture(t);
  f.install();
  for (const legacy of ['.codex', '.opencode', '.windsurf']) {
    const dir = f.install(path.join(f.home, legacy, 'skills/bug-hunter'));
    const result = f.run('doctor');
    assert.match(result.stdout, new RegExp(`legacy.*${legacy.slice(1)}`, 'i'));
    assert.ok(fs.existsSync(path.join(dir, MANIFEST)));
  }
  const manifestPath = path.join(f.target, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.packageVersion = '0.9.0';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const stale = f.run('doctor', '--agent', 'agents', '--json');
  assert.equal(stale.status, 1);
  assert.match(JSON.parse(stale.stdout).installs[0].error, /Installed version 0\.9\.0 is not current/);
});

for (const kind of ['file', 'directory']) {
  test(`installer rejects unmanaged ${kind} links overlapping runtime paths without external writes`, (t) => {
    const f = fixture(t);
    f.install();
    fs.rmSync(path.join(f.target, MANIFEST));
    const external = path.join(f.home, 'external');
    fs.mkdirSync(external);
    const script = path.join(external, 'run-bug-hunter.cjs');
    fs.writeFileSync(script, 'preserve external file\n');
    const link = path.join(f.target,
      kind === 'file' ? 'scripts/run-bug-hunter.cjs' : 'scripts');
    fs.rmSync(link, { recursive: true });
    fs.symlinkSync(kind === 'file' ? script : external, link, kind === 'file' ? 'file' : 'dir');
    const result = f.run('install', '--path', f.target, '--skip-doctor');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /destination overlaps a symbolic link/);
    assert.equal(fs.readFileSync(script, 'utf8'), 'preserve external file\n');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ['bug-hunter']);
  });
}


test('legacy stale copies warn without failing active installs and aliases are skipped', (t) => {
  const f = fixture(t);
  f.install();
  const activeWindsurf = f.install(path.join(f.home, '.codeium/windsurf/skills/bug-hunter'));
  for (const [agent, legacyName] of [['codex', '.codex'], ['windsurf', '.windsurf']]) {
    const legacyPath = f.install(path.join(f.home, legacyName, 'skills/bug-hunter'));
    const manifestPath = path.join(legacyPath, MANIFEST);
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.packageVersion = '0.9.0';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    for (const args of [[], ['--agent', agent]]) {
      const result = f.run('doctor', ...args);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`review and remove ${legacyPath}`));
      assert.doesNotMatch(result.stderr, /Reinstall/);
      assert.equal((result.stdout.match(/current and complete/g) || []).length, args.length ? 1 : 2);
    }
  }
  const legacyPath = path.join(f.home, '.windsurf/skills/bug-hunter');
  fs.rmSync(legacyPath, { recursive: true });
  fs.symlinkSync(activeWindsurf, legacyPath, 'dir');
  const report = JSON.parse(f.run('doctor', '--agent', 'windsurf', '--json').stdout);
  assert.equal(report.ok, true);
  assert.equal(report.installs.length, 1);
});

for (const digests of [undefined, {}, 'corrupt', { 'SKILL.md': 'bad' }]) {
  test(`installer repairs v2 manifests with ${JSON.stringify(digests)} digests`, (t) => {
    const f = fixture(t);
    f.install();
    const manifestPath = path.join(f.target, MANIFEST);
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.fileDigests = digests;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.equal(f.run('doctor', '--path', f.target).status, 1);
    fs.appendFileSync(path.join(f.target, 'SKILL.md'), 'corruption');
    f.install();
    assert.equal(f.run('doctor', '--path', f.target).status, 0);
    const repaired = JSON.parse(fs.readFileSync(manifestPath));
    assert.equal(Object.keys(repaired.fileDigests).length, repaired.managedFiles.length);
  });
}

test('auto-detection distinguishes Codex config from the shared agents config', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, '.codex'));
  const codex = f.run('install', '--skip-doctor');
  assert.equal(codex.status, 0, codex.stderr);
  assert.match(codex.stdout, /Agent:   codex/);
  fs.rmSync(path.join(f.home, '.codex'), { recursive: true });
  const agents = f.run('install', '--skip-doctor');
  assert.equal(agents.status, 0, agents.stderr);
  assert.match(agents.stdout, /Agent:   agents/);
});

test('doctor deduplicates shared targets and hashes package source once', (t) => {
  const f = fixture(t);
  f.install();
  f.install(path.join(f.home, '.factory/skills/bug-hunter'));
  const trace = path.join(f.root, 'reads.jsonl');
  const preload = path.join(f.root, 'trace.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const read = fs.readFileSync;
    fs.readFileSync = function(file, options) {
      if (typeof file === 'string' && [${JSON.stringify(f.source + path.sep)}, ${JSON.stringify(fs.realpathSync(f.source) + path.sep)}].some((prefix) => file.startsWith(prefix)) && options === undefined) {
        fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(file) + '\\n');
      }
      return read.apply(this, arguments);
    };
  `);
  f.env.NODE_OPTIONS = `--require=${preload}`;
  const result = f.run('doctor', '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.installs.filter((row) => row.path === f.target).length, 1);
  assert.equal(report.installs.filter((row) => row.status === 'ok').length, 2);
  const reads = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(reads.length, 4);
  assert.equal(new Set(reads).size, reads.length);
});

for (const kind of ['missing', 'directory', 'external-symlink']) {
  test(`doctor validates ${kind} package.json before reading it`, (t) => {
    const f = fixture(t);
    f.install();
    const installed = path.join(f.target, 'package.json');
    fs.rmSync(installed);
    if (kind === 'directory') fs.mkdirSync(installed);
    if (kind === 'external-symlink') {
      const external = path.join(f.root, 'external-package.json');
      fs.writeFileSync(external, 'not JSON and must never be parsed');
      fs.symlinkSync(external, installed);
    }
    const result = f.run('doctor', '--path', f.target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, kind === 'missing' ? /runtime file is missing: package.json/ : /must be a regular file: package.json/);
    assert.doesNotMatch(result.stderr, /ENOENT|Unexpected token/);
  });
}

test('doctor permits a custom path link outside HOME while home agent links stay contained', (t) => {
  const f = fixture(t);
  const outside = f.install(path.join(f.root, 'outside'));
  const custom = path.join(f.root, 'custom');
  fs.symlinkSync(outside, custom, 'dir');
  assert.equal(f.run('doctor', '--path', custom).status, 0);
  const agent = path.join(f.home, '.cursor/skills/bug-hunter');
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.symlinkSync(outside, agent, 'dir');
  const result = f.run('doctor', '--agent', 'cursor');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must resolve within HOME/);
});
