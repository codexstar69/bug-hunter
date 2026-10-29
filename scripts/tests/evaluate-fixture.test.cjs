const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  runJson,
  runRaw,
  writeJson
} = require('./test-utils.cjs');

function benchmarkFindings() {
  return [
    ['auth.js', '8-10', 'Critical', 'security', 'SQL injection through concatenated query'],
    ['auth.js', '16', 'High', 'security', 'Hardcoded JWT secret permits token forgery'],
    ['auth.js', '32-37', 'High', 'logic', 'Admin role truthy authorization check'],
    ['users.js', '8-12', 'Medium', 'logic', 'Pagination off-by-one offset skips first page'],
    ['users.js', '16-23', 'Medium', 'error-handling', 'Delete error is swallowed and success returned'],
    ['users.js', '39-44', 'High', 'type-safety', 'bcrypt password lacks non-string type validation']
  ].map(([file, lines, severity, category, claim], index) => ({
    bugId: `BUG-${index + 1}`, file, lines, severity, category, claim,
    evidence: claim, runtimeTrigger: claim, confidenceScore: 95,
    crossReferences: [`${file}:${lines}`],
    ...(category === 'security' ? { stride: 'Tampering', cwe: 'CWE-20' } : {})
  }));
}

test('fixture evaluator scores the calibration benchmark deterministically', () => {
  const sandbox = makeSandbox('evaluate-fixture-pass-');
  const script = path.resolve(__dirname, '..', '..', 'evals', 'evaluate-fixture.cjs');
  const findingsPath = path.join(sandbox, 'findings.json');
  writeJson(findingsPath, benchmarkFindings());

  const result = runJson('node', [script, findingsPath]);
  assert.equal(result.ok, true);
  assert.equal(result.expected, 6);
  assert.equal(result.matched, 6);
  assert.equal(result.falsePositives, 0);
  assert.equal(result.recall, 1);
  const labels = require('../../evals/benchmark/private-labels.json').cases
    .find((entry) => entry.id === 'fixture-js-express').findings;
  for (const match of result.matches) {
    const label = labels.find((entry) => entry.labelId === match.expectationId);
    assert.equal(benchmarkFindings()[match.findingIndex].severity, label.severity, label.labelId);
  }
});

test('fixture evaluator fails when an expected bug is missing', () => {
  const sandbox = makeSandbox('evaluate-fixture-fail-');
  const script = path.resolve(__dirname, '..', '..', 'evals', 'evaluate-fixture.cjs');
  const findingsPath = path.join(sandbox, 'findings.json');
  writeJson(findingsPath, benchmarkFindings().slice(0, 5));

  const result = runRaw('node', [script, findingsPath], {
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, ['fixture-bcrypt-input-type']);
});
