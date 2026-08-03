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
    ['auth.js', 'Critical', 'SQL injection through concatenated query'],
    ['auth.js', 'Critical', 'Hardcoded JWT secret permits token forgery'],
    ['auth.js', 'Medium', 'Admin role truthy authorization check'],
    ['users.js', 'Medium', 'Pagination off-by-one offset skips first page'],
    ['users.js', 'Low', 'Delete error is swallowed and success returned'],
    ['users.js', 'Medium', 'bcrypt password lacks non-string type validation']
  ].map(([file, severity, claim], index) => {
    return {
      bugId: `BUG-${index + 1}`,
      file,
      severity,
      claim,
      evidence: claim,
      runtimeTrigger: claim,
      category: 'logic'
    };
  });
}

test('fixture evaluator scores the hidden benchmark deterministically', () => {
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
