const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { detectPlan, runPlan, validatePlan } = require('../hybrid-verifier.cjs');
const { validateArtifactValue } = require('../schema-runtime.cjs');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-v-verifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function check(overrides = {}) {
  return {
    id: 'test', kind: 'test', cwd: '.', required: true,
    command: [process.execPath, '-e', 'void 0'], ...overrides
  };
}

function plan(...checks) {
  return { schemaVersion: 1, checks };
}

function assertReport(report) {
  const validation = validateArtifactValue({ artifactName: 'verification-report', value: report });
  assert.equal(validation.ok, true, validation.errors.join('; '));
}

test('verifier canonicalizes aliased roots and still rejects symlink and sibling escapes', async (t) => {
  const root = sandbox(t);
  const repo = path.join(root, 'repo');
  const alias = path.join(root, 'alias');
  const sibling = path.join(root, 'repo-sibling');
  fs.mkdirSync(path.join(repo, 'nested'), { recursive: true });
  fs.mkdirSync(sibling);
  fs.symlinkSync(repo, alias, 'junction');
  fs.symlinkSync(sibling, path.join(repo, 'escape'), 'junction');
  for (const cwd of ['.', 'nested', path.join(alias, 'nested')]) {
    const validation = validatePlan({ repoRoot: alias, plan: plan(check({ cwd })) });
    assert.equal(validation.ok, true, validation.errors.join('; '));
    assert.equal(validation.normalizedChecks[0].cwd, fs.realpathSync(path.resolve(alias, cwd)));
  }
  for (const cwd of ['escape', '../repo-sibling', sibling]) {
    const validation = validatePlan({ repoRoot: alias, plan: plan(check({ cwd })) });
    assert.equal(validation.ok, false);
    assert.match(validation.errors.join('; '), /escapes repository root/);
  }
  const report = await runPlan({ repoRoot: alias, plan: plan(check()) });
  assert.equal(report.ok, true);
  assert.equal(report.repositoryRoot, fs.realpathSync(repo));
  assertReport(report);
});

test('verifier retains bounded head and tail of both streams without failing a verbose passing check', async (t) => {
  const repoRoot = sandbox(t);
  const maxOutputBytes = 65536;
  const report = await runPlan({
    repoRoot, maxOutputBytes,
    plan: plan(check({ command: [process.execPath, '-e', `
      console.log('STDOUT_HEAD'); console.error('STDERR_HEAD');
      for (let i = 0; i < 4000; i++) {
        console.log('ok ' + i + ' ' + 'x'.repeat(80));
        console.error('diagnostic ' + i + ' ' + 'y'.repeat(80));
      }
      console.log('STDOUT_TAIL'); console.error('STDERR_TAIL');
    `] }))
  });
  assert.equal(report.ok, true);
  assert.equal(report.checks[0].status, 'PASS');
  assert.equal(report.checks[0].errorCode, null);
  assert.equal(report.checks[0].outputTruncated, true);
  for (const stream of ['stdout', 'stderr']) {
    assert.ok(Buffer.byteLength(report.checks[0][stream]) <= maxOutputBytes);
    assert.match(report.checks[0][stream], new RegExp(`${stream.toUpperCase()}_HEAD`));
    assert.match(report.checks[0][stream], new RegExp(`${stream.toUpperCase()}_TAIL`));
  }
  assertReport(report);
});

test('verifier handles small byte limits, multibyte output, expected exits and unavailable executables', async (t) => {
  const report = await runPlan({
    repoRoot: sandbox(t), maxOutputBytes: 31,
    plan: plan(
      check({ id: 'utf8', command: [process.execPath, '-e', "console.log('🧪'.repeat(2000))"] }),
      check({ id: 'expected', command: [process.execPath, '-e', 'process.exit(7)'], expectedExitCodes: [7] }),
      check({ id: 'missing', command: [path.join(os.tmpdir(), 'opt-v-nonexistent-executable')], required: false })
    )
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((entry) => entry.status), ['PASS', 'PASS', 'UNAVAILABLE']);
  assert.ok(Buffer.byteLength(report.checks[0].stdout) <= 31);
  assert.equal(report.checks[0].outputTruncated, true);
  assertReport(report);
});

for (const mode of ['resistant-tree', 'inherited-pipes', 'closed-pipes', 'output-flood']) {
  test(`verifier deadline reaps ${mode} and enforces the total plan budget`, {
    skip: process.platform === 'win32', timeout: 15000
  }, async (t) => {
    const repoRoot = sandbox(t);
    const pidFile = path.join(repoRoot, 'pids.jsonl');
    const fixture = path.join(repoRoot, 'tree.cjs');
    fs.writeFileSync(fixture, `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const [mode, pidFile, depth = '0'] = process.argv.slice(2);
      process.on('SIGTERM', () => {});
      fs.appendFileSync(pidFile, JSON.stringify(process.pid) + '\\n');
      if (Number(depth) < 2) {
        const child = spawn(process.execPath, [__filename, mode, pidFile, String(Number(depth) + 1)], {
          stdio: mode === 'closed-pipes' ? 'ignore' : ['ignore', 'inherit', 'inherit']
        });
        if (mode === 'inherited-pipes' || mode === 'closed-pipes') child.unref();
      }
      if ((mode === 'inherited-pipes' || mode === 'closed-pipes') && Number(depth) === 0) {
        setTimeout(() => process.exit(0), 100);
      } else if (mode === 'output-flood') {
        setInterval(() => process.stdout.write('x'.repeat(65536)), 5);
      } else {
        setInterval(() => {}, 1000);
      }
    `);
    // An outer watchdog bounds the old synchronous implementation too; the after
    // hook cleans recorded descendants even when the deadline assertion fails.
    const probe = path.join(repoRoot, 'probe.cjs');
    fs.writeFileSync(probe, `
      const fs = require('node:fs');
      const { runPlan } = require(${JSON.stringify(path.resolve(__dirname, '..', 'hybrid-verifier.cjs'))});
      const timer = setTimeout(() => {
        for (const pid of fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8').trim().split('\\n').map(Number)) {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      }, 4500);
      (async () => {
        const started = Date.now();
        const report = await runPlan({ repoRoot: __dirname, totalBudgetMs: 1000, maxOutputBytes: 1024,
          plan: ${JSON.stringify(plan(
            check({ command: [process.execPath, fixture, mode, pidFile], timeoutMs: 10000 }),
            check({ id: 'after-deadline' })
          ))}
        });
        clearTimeout(timer);
        console.log(JSON.stringify({ report, elapsedMs: Date.now() - started }));
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    const result = childProcess.spawnSync(process.execPath, [probe], {
      encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536
    });
    const pids = fs.existsSync(pidFile)
      ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number) : [];
    t.after(() => {
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const { report, elapsedMs } = JSON.parse(result.stdout);
    assert.ok(pids.length >= 3, `expected child and two descendants, got ${pids}`);
    assert.ok(elapsedMs < 3500, `deadline took ${elapsedMs} ms`);
    assert.equal(report.ok, false);
    assert.equal(report.checks[0].status, 'TIMEOUT');
    assert.equal(report.checks[1].status, 'SKIPPED_BUDGET');
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `process ${pid} survived verification`);
    }
    assertReport(report);
  });
}

for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
  test(`detected ${manager} commands execute existing scripts without forwarding manager flags`, async (t) => {
    const repoRoot = sandbox(t);
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
      packageManager: `${manager}@1.0.0`, scripts: { test: 'node record.cjs' }
    }));
    fs.writeFileSync(path.join(repoRoot, 'manager.cjs'), `
      const fs = require('node:fs');
      const { spawnSync } = require('node:child_process');
      const [manager, ...args] = process.argv.slice(2);
      fs.writeFileSync('manager-argv.json', JSON.stringify({ manager, args }));
      const result = spawnSync(process.execPath, ['record.cjs', ...args.slice(2)], { stdio: 'inherit' });
      process.exit(result.status ?? 1);
    `);
    fs.writeFileSync(path.join(repoRoot, 'record.cjs'), `
      require('node:fs').writeFileSync('script-argv.json', JSON.stringify(process.argv.slice(2)));
    `);
    const detected = detectPlan(repoRoot);
    assert.deepEqual(detected.checks.map((entry) => entry.id), ['test']);
    const report = await runPlan({
      repoRoot, plan: {
        ...detected,
        checks: detected.checks.map((entry) => ({
          ...entry, command: [process.execPath, 'manager.cjs', ...entry.command]
        }))
      }
    });
    assert.equal(report.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repoRoot, 'manager-argv.json'))), {
      manager, args: ['run', 'test']
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repoRoot, 'script-argv.json'))), []);
  });
}

test('a detected pnpm Node test command passes with the real package manager', async (t) => {
  const repoRoot = sandbox(t);
  const version = childProcess.execFileSync('pnpm', ['--version'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
    packageManager: `pnpm@${version}`, scripts: { test: 'node --test sample.test.cjs' }
  }));
  fs.writeFileSync(path.join(repoRoot, 'sample.test.cjs'), "require('node:test')('fixture', () => {});\n");
  const report = await runPlan({ repoRoot, plan: detectPlan(repoRoot), totalBudgetMs: 20000 });
  assert.equal(report.ok, true, report.checks[0].stderr);
  assert.equal(report.checks[0].status, 'PASS');
});


test('verifier passes when an exited leader leaves a short-lived closed-pipe descendant', {
  skip: process.platform === 'win32', timeout: 10000
}, async (t) => {
  const repoRoot = sandbox(t);
  const pidFile = path.join(repoRoot, 'child.pid');
  const report = await runPlan({ repoRoot, totalBudgetMs: 5000,
    plan: plan(check({ timeoutMs: 3000, command: [process.execPath, '-e', `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      child.unref();
      process.exit(0);
    `] })) });
  assert.equal(report.checks[0].status, 'PASS');
  assert.equal(report.checks[0].exitCode, 0);
  // Settled on the drained group, not the 3000 ms check deadline (loose bound for loaded CI hosts).
  assert.ok(report.checks[0].durationMs < 2900, `group took ${report.checks[0].durationMs} ms to drain`);
  assert.throws(() => process.kill(Number(fs.readFileSync(pidFile)), 0), { code: 'ESRCH' });
  assertReport(report);
});

test('a check left less than the minimum run window is skipped for budget, not timed out', {
  skip: process.platform === 'win32', timeout: 10000
}, async (t) => {
  const repoRoot = sandbox(t);
  const marker = path.join(repoRoot, 'running');
  const totalBudgetMs = 1000;
  // Only Date is mocked: the first check's settle lands 2 ms before the plan
  // deadline, as when libuv's cached loop time trails the wall clock under load.
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const advance = setInterval(() => {
    if (!fs.existsSync(marker)) return;
    clearInterval(advance);
    t.mock.timers.tick(totalBudgetMs - 2);
  }, 5);
  t.after(() => clearInterval(advance));
  const report = await runPlan({ repoRoot, totalBudgetMs,
    plan: plan(
      check({ id: 'first', timeoutMs: 5000, command: [process.execPath, '-e', `
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, '');
        setTimeout(() => process.exit(0), 200);
      `] }),
      check({ id: 'second' })
    ) });
  assert.equal(report.checks[0].status, 'PASS');
  assert.equal(report.checks[1].status, 'SKIPPED_BUDGET');
  assert.equal(report.ok, false);
  assertReport(report);
});

test('verifier keeps waiting when a draining group answers EPERM (macOS zombie members)', {
  skip: process.platform === 'win32', timeout: 10000
}, async (t) => {
  const repoRoot = sandbox(t);
  const realKill = process.kill;
  let epermProbes = 0;
  process.kill = function kill(pid, signal) {
    if (pid < 0 && signal === 0 && epermProbes < 3) {
      epermProbes += 1;
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    }
    return realKill.call(process, pid, signal);
  };
  t.after(() => { process.kill = realKill; });
  const report = await runPlan({ repoRoot, totalBudgetMs: 5000,
    plan: plan(check({ timeoutMs: 3000, command: [process.execPath, '-e', 'process.exit(0)'] })) });
  assert.equal(epermProbes, 3);
  assert.equal(report.checks[0].status, 'PASS');
  assert.equal(report.checks[0].errorCode, null);
  assertReport(report);
});

test('verifier timeout does not retain a successful pre-timeout leader exit code', {
  skip: process.platform === 'win32', timeout: 10000
}, async (t) => {
  const repoRoot = sandbox(t);
  const report = await runPlan({ repoRoot, totalBudgetMs: 1000,
    plan: plan(check({ timeoutMs: 500, command: [process.execPath, '-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      child.unref();
      process.exit(0);
    `] })) });
  assert.equal(report.checks[0].status, 'TIMEOUT');
  assert.equal(report.checks[0].exitCode, null);
  assert.equal(report.checks[0].signal, null);
  assertReport(report);
});

test('verifier reserves escalation and settle time within the total plan wall', {
  skip: process.platform === 'win32', timeout: 10000
}, async (t) => {
  const totalBudgetMs = 500;
  const report = await runPlan({ repoRoot: sandbox(t), totalBudgetMs,
    plan: plan(check({ timeoutMs: 10000, command: [process.execPath, '-e', `
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `] }), check({ id: 'after-budget' })) });
  assert.equal(report.checks[0].status, 'TIMEOUT');
  assert.equal(report.checks[1].status, 'SKIPPED_BUDGET');
  // Timer dispatch can be delayed by the OS; the implementation reserves its
  // 25 ms cleanup interval rather than adding kill grace beyond this wall.
  assert.ok(report.summary.durationMs <= totalBudgetMs + 100,
    `plan exceeded its ${totalBudgetMs} ms budget: ${report.summary.durationMs} ms`);
  assertReport(report);
});
