'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

test('packed artifact installs, upgrades, passes doctor and runs its own preflight', {
  skip: process.env.BUG_HUNTER_PACKED_SMOKE !== '1'
    ? 'Run with BUG_HUNTER_PACKED_SMOKE=1 (CI runs this on Node 22 and 24)' : false,
  timeout: 120000
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-hunter-packed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const prefix = path.join(home, 'prefix');
  fs.mkdirSync(prefix, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    PNPM_HOME: path.join(home, '.local/share/pnpm'),
    COREPACK_HOME: path.join(home, '.cache/corepack'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    npm_config_cache: path.join(home, '.npm'), BUG_HUNTER_PACKED_SMOKE: '0' };
  // Do not inherit host-specific package/agent configuration into the consumer fixture.
  delete env.CODEX_HOME;
  delete env.npm_config_userconfig;
  delete env.NPM_CONFIG_USERCONFIG;
  const run = (command, args, cwd = root) => {
    const result = childProcess.spawnSync(command, args, {
      cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024
    });
    assert.equal(result.status, 0,
      `${command} ${args.join(' ')}: ${result.error || ''}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  // CI already ran generated checks and tests. Skipping prepack avoids recursive tests.
  run('pnpm', ['--config.ignore-scripts=true', 'pack', '--pack-destination', root], ROOT);
  const tarballs = fs.readdirSync(root).filter((file) => file.endsWith('.tgz'));
  assert.equal(tarballs.length, 1);
  fs.writeFileSync(path.join(prefix, 'package.json'), '{"private":true}\n');
  run('pnpm', ['--dir', prefix, 'add', path.join(root, tarballs[0]), '--ignore-scripts',
    '--offline', '--store-dir', path.join(root, 'store')]);
  const cli = path.join(prefix, 'node_modules/.bin/bug-hunter');
  run(cli, ['install', '--agent', 'agents']);
  const installed = path.join(home, '.agents/skills/bug-hunter');
  const notes = path.join(installed, 'user-notes.md');
  fs.writeFileSync(notes, 'keep consumer notes\n');
  run(cli, ['install', '--agent', 'agents']);
  assert.equal(fs.readFileSync(notes, 'utf8'), 'keep consumer notes\n');
  // Execute both commands from the installed runtime, never the source checkout.
  const doctor = run(process.execPath, [path.join(installed, 'bin/bug-hunter'), 'doctor']);
  assert.match(doctor, /Ready to hunt bugs/);
  const preflight = run(process.execPath, [path.join(installed, 'scripts/run-bug-hunter.cjs'),
    'preflight', '--skill-dir', installed]);
  assert.ok(preflight.trim(), 'installed preflight should produce a report');
  fs.writeFileSync(path.join(installed, 'scripts/run-bug-hunter.cjs'), 'invalid javascript {');
  const corrupted = childProcess.spawnSync(process.execPath,
    [path.join(installed, 'bin/bug-hunter'), 'doctor'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(corrupted.status, 1, corrupted.stdout + corrupted.stderr);
  assert.match(corrupted.stderr, /content mismatch/);
});
