const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getKnownArtifacts,
  validateArtifactValue
} = require('../schema-runtime.cjs');

test('schema runtime enforces conditional experiment requirements', () => {
  const result = validateArtifactValue({
    artifactName: 'experiment',
    value: {
      type: 'config',
      name: 'latency',
      metric: {
        name: 'duration',
        direction: 'lower'
      },
      maxIterations: 3
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => {
    return error.includes('segment') && error.includes('required');
  }), true);
});

test('schema runtime validates schema-valued additionalProperties', () => {
  const result = validateArtifactValue({
    artifactName: 'experiment',
    value: {
      type: 'result',
      segment: 1,
      status: 'keep',
      durationMs: 10,
      secondaryMetrics: {
        throughput: 'fast'
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => {
    return error.includes('secondaryMetrics') && error.includes('number');
  }), true);
});

test('schema runtime exposes generated validators for every artifact', () => {
  assert.deepEqual(getKnownArtifacts().sort(), [
    'adaptive-plan',
    'benchmark-report',
    'coverage',
    'experiment',
    'findings',
    'fix-plan',
    'fix-report',
    'fix-strategy',
    'fixer-scope',
    'recon',
    'referee',
    'retrieval-plan',
    'scan-report',
    'skeptic',
    'verification-report'
  ]);

  const scopeResult = validateArtifactValue({
    artifactName: 'fixer-scope',
    value: {
      schemaVersion: 1,
      runId: 'run-1',
      repositoryRoot: '/repo',
      baseCommit: 'abc123',
      approvedBugIds: ['BUG-1'],
      approvedFiles: ['src/a.ts']
    }
  });
  assert.equal(scopeResult.ok, true);
});
