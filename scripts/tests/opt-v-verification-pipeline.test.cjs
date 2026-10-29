const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { shellQuote } = require('./test-utils.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const runner = path.join(projectRoot, 'scripts', 'run-bug-hunter.cjs');
const pnpmVersion = childProcess.execFileSync('pnpm', ['--version'], { cwd: os.tmpdir(), encoding: 'utf8' }).trim();

for (const source of ['supplied', 'automatic', 'absent', 'empty', 'invalid']) {
  for (const requiredPlan of [false, true]) {
    const kinds = ['supplied', 'automatic'].includes(source) ? ['required', 'optional', 'passing'] : ['none'];
    for (const kind of kinds) {
      test(`pipeline ${source} plan, ${kind} check, verification-required=${requiredPlan}`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-v-pipeline-'));
        try {
          const repo = path.join(root, 'repo');
          fs.mkdirSync(repo);
          const sourcePath = path.join(repo, 'source.js');
          const filesPath = path.join(root, 'files.json');
          const workerPath = path.join(root, 'worker.cjs');
          fs.writeFileSync(sourcePath, 'module.exports = 1;\n');
          fs.writeFileSync(filesPath, JSON.stringify([sourcePath]));
          fs.writeFileSync(workerPath, "require('node:fs').writeFileSync(process.argv[2], '[]');\n");
          const init = childProcess.spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
          assert.equal(init.status, 0, init.stderr);
          const commit = childProcess.spawnSync('git', ['-c', 'user.name=Verifier Test',
            '-c', 'user.email=verifier@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
            'commit', '--allow-empty', '-qm', 'fixture'], { cwd: repo, encoding: 'utf8' });
          assert.equal(commit.status, 0, commit.stderr);
          const args = [runner, 'run', '--skill-dir', projectRoot, '--files-json', filesPath,
            '--state', path.join(root, 'state.json'), '--run-id', `opt-v-${source}-${kind}-${requiredPlan}`,
            '--worker-cmd', `${shellQuote(process.execPath)} ${shellQuote(workerPath)} {findingsJson}`,
            '--verification-required', String(requiredPlan), '--evidence-cache', 'false',
            '--max-retries', '0', '--backoff-ms', '0'];
          const exitCode = kind === 'passing' ? 0 : 7;
          if (source === 'automatic') {
            fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
              packageManager: `pnpm@${pnpmVersion}`,
              scripts: { [kind === 'optional' ? 'lint' : 'test']: `node -e "process.exit(${exitCode})"` }
            }));
            args.push('--auto-verify', 'true');
          } else if (source !== 'absent') {
            const planPath = path.join(root, 'plan.json');
            fs.writeFileSync(planPath, JSON.stringify({
              schemaVersion: source === 'invalid' ? 2 : 1,
              checks: source === 'empty' ? [] : [{
                id: 'check', kind: 'test', cwd: '.', required: kind === 'required',
                command: [process.execPath, '-e', `process.exit(${exitCode})`]
              }]
            }));
            args.push('--verification-plan', planPath);
          }
          const result = childProcess.spawnSync(process.execPath, args, {
            cwd: repo, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024
          });
          const failed = kind === 'required' || source === 'invalid'
            || (requiredPlan && ['absent', 'empty'].includes(source));
          assert.equal(result.status, failed ? 1 : 0, result.stderr || result.stdout);
          if (requiredPlan && ['absent', 'empty'].includes(source)) {
            assert.match(result.stderr, /Verification is required/);
          } else {
            const value = JSON.parse(result.stdout);
            assert.equal(value.ok, !failed);
            if (source !== 'absent') {
              const report = JSON.parse(fs.readFileSync(value.verificationReportPath));
              assert.equal(report.ok, !failed);
              assert.equal(report.summary.requiredFailures, kind === 'required' ? 1 : 0);
              if (failed) assert.equal(value.fixPlanPath, null);
            }
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}
