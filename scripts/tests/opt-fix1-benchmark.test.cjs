const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { gateReport, matchFindings, scoreSuite } = require('../benchmark-suite.cjs');

const root = path.resolve(__dirname, '../..');
const benchmarkRoot = path.join(root, 'evals/benchmark');
const read = (file) => JSON.parse(fs.readFileSync(path.join(benchmarkRoot, file), 'utf8'));
function report() {
  return scoreSuite({ manifest: read('public-manifest.json'), labels: read('private-labels.json'),
    runs: read('golden-runs.json'), manifestPath: path.join(benchmarkRoot, 'public-manifest.json') });
}

test('D1: a verify-only hardcoded JWT secret finding matches the fixture label', () => {
  const label = read('private-labels.json').cases.find((entry) => entry.id === 'fixture-js-express')
    .findings.find((entry) => entry.labelId === 'fixture-hardcoded-jwt-secret');
  const lines = fs.readFileSync(path.join(root, 'evals/corpus/fixture-js-express/auth.js'), 'utf8').split('\n');
  const line = String(lines.findIndex((value) => value.includes('jwt.verify(')) + 1);
  const finding = { bugId: 'VERIFY-ONLY', file: 'auth.js', lines: line, severity: 'High', category: 'security',
    claim: 'Hardcoded JWT secret allows token forgery.', evidence: 'jwt.verify uses a publicly known JWT secret.',
    runtimeTrigger: 'An attacker submits a forged token.', confidenceScore: 95,
    crossReferences: [`auth.js:${line}`], stride: 'Spoofing', cwe: 'CWE-321' };
  const matching = matchFindings([finding], [label]);
  assert.equal(matching.matches.length, 1);
  assert.deepEqual(matching.unmatchedFindingIndexes, []);
  assert.deepEqual(matching.unmatchedLabelIndexes, []);
});

test('D2: fixture update and delete handlers reject a different authenticated owner', async () => {
  for (const directory of ['test-fixture', 'evals/corpus/fixture-js-express']) {
    const handlers = new Map();
    const router = Object.fromEntries(['get', 'put', 'delete', 'post'].map((method) => [method,
      (route, ...callbacks) => handlers.set(`${method} ${route}`, callbacks.at(-1))]));
    let queries = 0;
    const dependencies = { express: { Router: () => router }, bcrypt: {},
      './auth': { requireAuth: () => {} }, './db': { query: async () => { queries += 1; return {}; } } };
    vm.runInNewContext(fs.readFileSync(path.join(root, directory, 'users.js'), 'utf8'), {
      require: (id) => dependencies[id], module: { exports: {} }
    });
    for (const method of ['put', 'delete']) {
      queries = 0;
      let status = 200;
      const response = { status: (code) => { status = code; return response; }, json: () => {} };
      await handlers.get(`${method} /:id`)({ params: { id: 'other' }, user: { id: 'owner' },
        body: { name: 'Changed', email: 'changed@example.com' } }, response);
      assert.equal(status, 403, `${directory} ${method}`);
      assert.equal(queries, 0, `${directory} ${method}`);
      await handlers.get(`${method} /:id`)({ params: { id: '7' }, user: { id: 7 },
        body: { name: 'Changed', email: 'changed@example.com' } }, response);
      assert.equal(queries, 1, `${directory} ${method} owner`);
    }
  }
});

test('D3: standalone gate recomputes aggregates from scored runs', (t) => {
  const value = report();
  assert.equal(value.ok, true);
  for (const run of value.runs) {
    run.truePositives = 0;
    run.falseNegatives = run.matchedLabelIds.length + run.missingLabelIds.length;
    run.recall = 0;
    run.f1 = 0;
    run.matchedWeight = 0;
    run.severityWeightedRecall = 0;
    run.matchedLabelIds = [];
    run.matches = [];
  }
  assert.equal(value.aggregate.recall, 1);
  assert.equal(gateReport(value).ok, false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fix1-benchmark-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'report.json');
  fs.writeFileSync(file, JSON.stringify(value));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/benchmark-suite.cjs'),
    'gate', '--report', file], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

test('D4: corpus sources have no blank line padding', () => {
  for (const entry of read('public-manifest.json').cases) {
    for (const file of entry.sourceFiles) {
      const source = fs.readFileSync(path.resolve(benchmarkRoot, entry.root, file), 'utf8');
      assert.doesNotMatch(source, /\n[\t ]*\n[\t ]*\n/, `${entry.id}/${file}`);
    }
  }
});

test('D4: golden and replayed finding locations reference physical corpus lines', () => {
  const cases = new Map(read('public-manifest.json').cases.map((entry) => [entry.id, entry]));
  for (const filename of ['golden-runs.json', 'recorded/runs.json']) {
    for (const run of read(filename).runs) {
      const entry = cases.get(run.caseId);
      for (const finding of run.findings) {
        for (const location of [`${finding.file}:${finding.lines}`, ...finding.crossReferences]) {
          const [, file, start, end = start] = location.match(/^(.+):(\d+)(?:-(\d+))?$/);
          const source = fs.readFileSync(path.resolve(benchmarkRoot, entry.root, file), 'utf8').trimEnd().split('\n');
          assert.ok(Number(start) > 0 && Number(start) <= Number(end) && Number(end) <= source.length,
            `${filename}/${run.runId} ${location}`);
        }
      }
    }
  }
});
