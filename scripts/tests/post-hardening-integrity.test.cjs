const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { createRequire } = require('node:module');

const { normalizeRunFiles } = require('../state-store.cjs');
const {
  makeSandbox,
  readJson,
  resolveSkillScript,
  runRaw,
  shellQuote,
  writeJson
} = require('./test-utils.cjs');

function writeWorker(filePath, lines) {
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function parseJsonOutput(result) {
  const output = String(result.stdout || '').trim();
  return output ? JSON.parse(output) : {};
}

function loadRunInternals() {
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const source = fs.readFileSync(runner, 'utf8').replace(/^#!.*\n/, '');
  const withoutMain = source.replace(
    /\nmain\(\)\.catch\([\s\S]*$/,
    '\nmodule.exports = { buildCoverageArtifact, toCoverageStatus };\n'
  );
  const localRequire = createRequire(runner);
  const testModule = { exports: {} };
  const evaluate = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    withoutMain
  );
  evaluate(localRequire, testModule, testModule.exports, runner, path.dirname(runner));
  return testModule.exports;
}

test('resume rejects source drift after a worker integrity failure', () => {
  const sandbox = makeSandbox('post-hardening-resume-drift-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const source = path.join(sandbox, 'source.js');
  const filesPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.bug-hunter', 'state.json');
  const mutatingWorker = path.join(sandbox, 'mutating-worker.cjs');
  const cleanWorker = path.join(sandbox, 'clean-worker.cjs');
  const cleanWorkerAttempts = path.join(sandbox, 'clean-worker-attempts.txt');

  fs.writeFileSync(source, 'export const value = 1;\n', 'utf8');
  writeJson(filesPath, [source]);
  writeWorker(mutatingWorker, [
    "const fs = require('fs');",
    "const args = process.argv;",
    "const output = args[args.indexOf('--findings-json') + 1];",
    "fs.writeFileSync(output, '[]');",
    `fs.appendFileSync(${JSON.stringify(source)}, 'export const changed = 2;\\n');`
  ]);
  writeWorker(cleanWorker, [
    "const fs = require('fs');",
    "const args = process.argv;",
    "const output = args[args.indexOf('--findings-json') + 1];",
    `fs.writeFileSync(${JSON.stringify(cleanWorkerAttempts)}, 'executed');`,
    "fs.writeFileSync(output, '[]');"
  ]);

  const baseArgs = [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesPath,
    '--state',
    statePath,
    '--max-retries',
    '1',
    '--backoff-ms',
    '0'
  ];
  const first = runRaw('node', [
    ...baseArgs,
    '--run-id',
    'resume-source-drift',
    '--worker-cmd',
    `node ${shellQuote(mutatingWorker)} --findings-json {findingsJson}`
  ], { cwd: sandbox });

  assert.notEqual(first.status, 0);
  const firstOutput = parseJsonOutput(first);
  assert.equal(firstOutput.ok, false);
  const failedState = readJson(statePath);
  assert.equal(failedState.chunks[0].status, 'failed');

  const resumed = runRaw('node', [
    ...baseArgs,
    '--resume',
    'resume-source-drift',
    '--worker-cmd',
    `node ${shellQuote(cleanWorker)} --findings-json {findingsJson}`
  ], { cwd: sandbox });

  assert.notEqual(resumed.status, 0);
  const resumedOutput = parseJsonOutput(resumed);
  assert.equal(resumedOutput.ok, false);
  assert.equal(resumedOutput.status.chunkStatus.failed, 1);
  assert.equal(fs.existsSync(cleanWorkerAttempts), false);
  const finalState = readJson(statePath);
  assert.equal(finalState.fileStates[source].status, 'failed');
  assert.match(finalState.chunks[0].lastError, /changed|drift|integrity/i);
});

test('coverage never derives done status from a chunk when file evidence is pending', () => {
  const { buildCoverageArtifact } = loadRunInternals();
  const coverage = buildCoverageArtifact({
    state: {
      chunks: [
        {
          id: 'chunk-1',
          status: 'done',
          files: ['src/pending.js']
        }
      ],
      fileStates: {
        'src/pending.js': {
          status: 'pending'
        }
      },
      bugLedger: []
    },
    fixPlan: null
  });

  assert.equal(coverage.status, 'IN_PROGRESS');
  assert.deepEqual(coverage.files, [
    {
      path: 'src/pending.js',
      status: 'pending'
    }
  ]);
});

test('root containment accepts valid in-repository dot-dot-prefixed names', () => {
  const sandbox = makeSandbox('post-hardening-dotdot-name-');
  const source = path.join(sandbox, '..valid-source.js');
  fs.writeFileSync(source, 'export const valid = true;\n', 'utf8');

  assert.deepEqual(
    normalizeRunFiles([source], sandbox),
    [fs.realpathSync(source)]
  );
});
