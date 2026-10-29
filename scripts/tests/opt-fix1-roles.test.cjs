const assert = require('node:assert/strict');
const test = require('node:test');
const { validateArtifactValue } = require('../schema-runtime.cjs');

test('B1: only DISPROVE requires a source path and line in counterEvidence', () => {
  const check = (response, counterEvidence) => validateArtifactValue({ artifactName: 'skeptic',
    value: [{ bugId: 'BUG-1', response, analysisSummary: 'Reviewed the claim.', counterEvidence }] }).ok;
  for (const response of ['ACCEPT', 'MANUAL_REVIEW']) {
    assert.equal(check(response, 'The timing remains uncertain.'), true, response);
  }
  for (const value of ['timeout at 12:00', 'http://localhost:8080', 'https://example.com:443',
    'https://example.com/file.js:12', 'auth:12', 'file.js:0']) {
    assert.equal(check('DISPROVE', value), false, value);
  }
  for (const value of ['src/auth.ts:12 rejects non-admins.', 'auth.js:4 is guarded.',
    './src/route.test.js:25-30 handles the case.']) {
    assert.equal(check('DISPROVE', value), true, value);
  }
});
