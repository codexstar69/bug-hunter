const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  resolveSkillScript,
  runRaw,
  writeJson
} = require('./test-utils.cjs');

test('render-report renders a markdown summary from findings and referee JSON', () => {
  const sandbox = makeSandbox('render-report-');
  const script = resolveSkillScript('render-report.cjs');
  const findingsPath = path.join(sandbox, 'findings.json');
  const refereePath = path.join(sandbox, 'referee.json');

  writeJson(findingsPath, [
    {
      bugId: 'BUG-1',
      severity: 'Critical',
      category: 'security',
      file: 'src/api.ts',
      lines: '10-12',
      claim: 'User input reaches an unsafe sink',
      evidence: 'src/api.ts:10-12 ...',
      runtimeTrigger: 'POST /api with attacker input',
      crossReferences: ['Single file'],
      confidenceScore: 90
    }
  ]);

  writeJson(refereePath, [
    {
      bugId: 'BUG-1',
      verdict: 'REAL_BUG',
      trueSeverity: 'Critical',
      confidenceScore: 91,
      confidenceLabel: 'high',
      verificationMode: 'INDEPENDENTLY_VERIFIED',
      analysisSummary: 'Confirmed by tracing the sink.'
    }
  ]);

  const result = runRaw('node', [script, 'report', findingsPath, refereePath], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /# Bug Hunter Report/);
  assert.match(result.stdout, /BUG-1 \| Critical \| src\/api.ts/);
  assert.match(result.stdout, /Confirmed by tracing the sink/);
});

test('render-report renders coverage markdown from coverage JSON', () => {
  const sandbox = makeSandbox('render-coverage-');
  const script = resolveSkillScript('render-report.cjs');
  const coveragePath = path.join(sandbox, 'coverage.json');

  writeJson(coveragePath, {
    schemaVersion: 1,
    iteration: 2,
    status: 'COMPLETE',
    files: [{ path: 'src/a.ts', status: 'done' }],
    bugs: [{ bugId: 'BUG-1', severity: 'Low', file: 'src/a.ts', claim: 'example' }],
    fixes: [{ bugId: 'BUG-1', status: 'MANUAL_REVIEW' }]
  });

  const result = runRaw('node', [script, 'coverage', coveragePath], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /# Bug Hunter Coverage/);
  assert.match(result.stdout, /done \| src\/a.ts/);
  assert.match(result.stdout, /BUG-1 \| Low \| src\/a.ts \| example/);
});

test('render-report renders a markdown summary from fix-report JSON', () => {
  const sandbox = makeSandbox('render-fix-report-');
  const script = resolveSkillScript('render-report.cjs');
  const fixReportPath = path.join(sandbox, 'fix-report.json');

  writeJson(fixReportPath, {
    version: '3.0.0',
    fix_branch: 'bug-hunter-fix-20260311-200000',
    base_commit: 'abc123',
    dry_run: false,
    circuit_breaker_tripped: false,
    phase2_timeout_hit: false,
    fixes: [
      {
        bugId: 'BUG-1',
        severity: 'CRITICAL',
        status: 'FIXED',
        files: ['src/a.ts'],
        lines: '10-12',
        commit: 'def456',
        description: 'Parameterized the query.'
      }
    ],
    verification: {
      baseline_pass: 10,
      baseline_fail: 1,
      flaky_tests: 0,
      final_pass: 11,
      final_fail: 0,
      new_failures: 0,
      resolved_failures: 1,
      typecheck_pass: true,
      build_pass: true,
      fixer_bugs_found: 0
    },
    summary: {
      total_confirmed: 1,
      eligible: 1,
      manual_review: 0,
      fixed: 1,
      fix_reverted: 0,
      fix_failed: 0,
      skipped: 0,
      fixer_bug: 0,
      partial: 0
    }
  });

  const result = runRaw('node', [script, 'fix-report', fixReportPath], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /# Fix Report/);
  assert.match(result.stdout, /BUG-1 \| FIXED \| CRITICAL/);
  assert.match(result.stdout, /Parameterized the query/);
});

test('render-report renders a markdown summary from fix-strategy JSON', () => {
  const sandbox = makeSandbox('render-fix-strategy-');
  const script = resolveSkillScript('render-report.cjs');
  const fixStrategyPath = path.join(sandbox, 'fix-strategy.json');

  writeJson(fixStrategyPath, {
    version: '3.1.0',
    generatedAt: '2026-03-12T00:00:00.000Z',
    confidenceThreshold: 75,
    summary: {
      confirmed: 2,
      safeAutofix: 1,
      manualReview: 1,
      largerRefactor: 0,
      architecturalRemediation: 0,
      canaryCandidates: 1,
      rolloutCandidates: 0
    },
    clusters: [
      {
        clusterId: 'cluster-1',
        strategy: 'safe-autofix',
        executionStage: 'canary',
        autofixEligible: true,
        bugIds: ['BUG-1'],
        files: ['src/a.ts'],
        maxSeverity: 'CRITICAL',
        summary: '1 bug(s) in src classified as safe-autofix.',
        recommendedAction: 'Proceed through the guarded fix pipeline with canary verification and rollback safety.',
        reasons: ['Finding is localized enough for a guarded surgical fix.']
      }
    ]
  });

  const result = runRaw('node', [script, 'fix-strategy', fixStrategyPath], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /# Fix Strategy/);
  assert.match(result.stdout, /cluster-1 \| safe-autofix \| canary/);
  assert.match(result.stdout, /guarded fix pipeline/);
});
