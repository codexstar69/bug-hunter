const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  readJson,
  resolveSkillScript,
  runJson,
  runRaw,
  shellQuote,
  writeJson
} = require('./test-utils.cjs');

function writeRefereeArtifact({ filePath, verdicts }) {
  writeJson(filePath, verdicts.map((verdict) => {
    return {
      bugId: verdict.bugId,
      verdict: verdict.verdict || 'REAL_BUG',
      trueSeverity: verdict.trueSeverity || 'Critical',
      confidenceScore: verdict.confidenceScore ?? 95,
      confidenceLabel: verdict.confidenceLabel || 'high',
      verificationMode: 'INDEPENDENTLY_VERIFIED',
      analysisSummary: verdict.analysisSummary || `Validated ${verdict.bugId}.`
    };
  }));
}

function runJsonAllowFailure(cmd, args, options = {}) {
  const result = runRaw(cmd, args, options);
  return {
    result,
    value: JSON.parse(String(result.stdout || '').trim())
  };
}

test('run-bug-hunter preflight selects available backend by priority', () => {
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const result = runJson('node', [
    runner,
    'preflight',
    '--skill-dir',
    skillDir,
    '--available-backends',
    'teams,local-sequential'
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.backend.selected, 'teams');
});

test('run-bug-hunter preflight tolerates missing optional code-index helper', () => {
  const sandbox = makeSandbox('run-bug-hunter-preflight-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const optionalSkillDir = path.join(sandbox, 'skill');
  const scriptsDir = path.join(optionalSkillDir, 'scripts');
  const schemasDir = path.join(optionalSkillDir, 'schemas');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(schemasDir, { recursive: true });

  for (const fileName of [
    'shared.cjs',
    'source-config.cjs',
    'run-bug-hunter.cjs',
    'bug-hunter-state.cjs',
    'process-runner.cjs',
    'state-store.cjs',
    'artifact-planner.cjs',
    'chunk-scheduler.cjs',
    'benchmark-suite.cjs',
    'adaptive-policy.cjs',
    'hybrid-verifier.cjs',
    'evidence-cache.cjs',
    'retrieval-planner.cjs',
    'payload-guard.cjs',
    'schema-validate.cjs',
    'schema-runtime.cjs',
    'generated-schema-validators.cjs',
    'schema-catalog.cjs',
    'render-report.cjs',
    'fix-lock.cjs',
    'doc-lookup.cjs',
    'context7-api.cjs',
    'delta-mode.cjs',
    'pr-scope.cjs'
  ]) {
    fs.copyFileSync(resolveSkillScript(fileName), path.join(scriptsDir, fileName));
  }
  for (const fileName of [
    'findings.schema.json',
    'skeptic.schema.json',
    'referee.schema.json',
    'coverage.schema.json',
    'benchmark-report.schema.json',
    'adaptive-plan.schema.json',
    'verification-report.schema.json',
    'retrieval-plan.schema.json',
    'fix-report.schema.json',
    'fix-plan.schema.json',
    'fix-strategy.schema.json',
    'fixer-scope.schema.json',
    'recon.schema.json',
    'shared.schema.json'
  ]) {
    fs.copyFileSync(
      resolveSkillScript('..', 'schemas', fileName),
      path.join(schemasDir, fileName)
    );
  }

  // Copy bundled skill SKILL.md files
  const skillNames = [
    'hunter', 'skeptic', 'referee', 'fixer', 'recon', 'doc-lookup',
    'threat-model-generation', 'commit-security-scan', 'security-review',
    'vulnerability-validation'
  ];
  for (const name of skillNames) {
    const destDir = path.join(optionalSkillDir, 'skills', name);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '..', '..', 'skills', name, 'SKILL.md'),
      path.join(destDir, 'SKILL.md')
    );
  }

  const result = runJson('node', [
    path.join(scriptsDir, 'run-bug-hunter.cjs'),
    'preflight',
    '--skill-dir',
    optionalSkillDir
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('triage promotes low-only source files into the scan order', () => {
  const sandbox = makeSandbox('triage-low-only-');
  const triage = resolveSkillScript('triage.cjs');
  const scriptsDir = path.join(sandbox, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, 'a.cjs'), 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'b.cjs'), 'module.exports = 2;\n', 'utf8');

  const result = runJson('node', [triage, 'scan', sandbox]);
  assert.equal(result.totalFiles, 2);
  assert.equal(result.scannableFiles, 2);
  assert.deepEqual(result.scanOrder, ['scripts/a.cjs', 'scripts/b.cjs']);
});

test('run-bug-hunter run executes chunk loop with retry and journal', () => {
  const sandbox = makeSandbox('run-bug-hunter-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.claude', 'bug-hunter-state.json');
  const journalPath = path.join(sandbox, '.claude', 'bug-hunter-run.log');
  const attemptsFile = path.join(sandbox, 'attempts.json');

  const sourceA = path.join(sandbox, 'src', 'a.ts');
  const sourceB = path.join(sandbox, 'src', 'b.ts');
  fs.mkdirSync(path.dirname(sourceA), { recursive: true });
  fs.writeFileSync(sourceA, 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(sourceB, 'export const b = 2;\n', 'utf8');
  writeJson(filesJsonPath, [sourceA, sourceB]);

  const flakyWorker = resolveSkillScript('tests', 'fixtures', 'flaky-worker.cjs');
  const workerTemplate = [
    'node',
    shellQuote(flakyWorker),
    '--chunk-id',
    '{chunkId}',
    '--scan-files-json',
    '{scanFilesJson}',
    '--findings-json',
    '{findingsJson}',
    '--attempts-file',
    shellQuote(attemptsFile)
  ].join(' ');

  const result = runJson('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath,
    '--mode',
    'extended',
    '--chunk-size',
    '1',
    '--worker-cmd',
    workerTemplate,
    '--timeout-ms',
    '5000',
    '--max-retries',
    '1',
    '--backoff-ms',
    '10',
    '--journal-path',
    journalPath
  ], {
    cwd: sandbox
  });

  assert.equal(result.ok, true);
  assert.equal(result.status.chunkStatus.done, 2);
  assert.equal(result.status.metrics.findingsUnique >= 2, true);

  const attempts = readJson(attemptsFile);
  assert.equal(attempts['chunk-1'], 2);
  assert.equal(attempts['chunk-2'], 2);

  const journal = fs.readFileSync(journalPath, 'utf8');
  assert.match(journal, /attempt-start/);
  assert.match(journal, /retry-backoff/);
  assert.match(journal, /chunk-done/);
});

test('run-bug-hunter integrates index+delta, fact cards, consistency pass, and fix plan', () => {
  const sandbox = makeSandbox('run-bug-hunter-delta-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const changedFilesJsonPath = path.join(sandbox, 'changed-files.json');
  const statePath = path.join(sandbox, '.claude', 'bug-hunter-state.json');
  const journalPath = path.join(sandbox, '.claude', 'bug-hunter-run.log');
  const seenFilesPath = path.join(sandbox, 'seen-files.json');
  const consistencyReportPath = path.join(sandbox, '.claude', 'bug-hunter-consistency.json');
  const fixPlanPath = path.join(sandbox, '.claude', 'bug-hunter-fix-plan.json');
  const strategyPath = path.join(sandbox, '.claude', 'bug-hunter-fix-strategy.json');
  const strategyMarkdownPath = path.join(sandbox, '.claude', 'bug-hunter-fix-strategy.md');
  const factsPath = path.join(sandbox, '.claude', 'bug-hunter-facts.json');
  const coveragePath = path.join(sandbox, '.claude', 'coverage.json');
  const coverageMarkdownPath = path.join(sandbox, '.claude', 'coverage.md');
  const refereePath = path.join(sandbox, '.claude', 'referee.json');

  const changedFile = path.join(sandbox, 'src', 'feature', 'changed.ts');
  const depFile = path.join(sandbox, 'src', 'feature', 'dep.ts');
  const overlayFile = path.join(sandbox, 'src', 'api', 'admin-route.ts');
  fs.mkdirSync(path.dirname(changedFile), { recursive: true });
  fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
  fs.writeFileSync(changedFile, "import { dep } from './dep';\nexport const value = dep();\n", 'utf8');
  fs.writeFileSync(depFile, 'export function dep() { return 1; }\n', 'utf8');
  fs.writeFileSync(overlayFile, 'export function handler(req) { return req.body; }\n', 'utf8');

  writeJson(filesJsonPath, [changedFile, depFile, overlayFile]);
  writeJson(changedFilesJsonPath, [changedFile]);
  writeRefereeArtifact({
    filePath: refereePath,
    verdicts: ['BUG-chunk-1', 'BUG-chunk-2', 'BUG-chunk-3'].map((bugId) => {
      return {
        bugId,
        confidenceScore: 60,
        confidenceLabel: 'low'
      };
    })
  });

  const worker = resolveSkillScript('tests', 'fixtures', 'low-confidence-worker.cjs');
  const workerTemplate = [
    'node',
    shellQuote(worker),
    '--chunk-id',
    '{chunkId}',
    '--scan-files-json',
    '{scanFilesJson}',
    '--findings-json',
    '{findingsJson}',
    '--facts-json',
    '{factsJson}',
    '--seen-files',
    shellQuote(seenFilesPath),
    '--confidence',
    '60'
  ].join(' ');

  const result = runJson('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--changed-files-json',
    changedFilesJsonPath,
    '--state',
    statePath,
    '--mode',
    'extended',
    '--chunk-size',
    '1',
    '--worker-cmd',
    workerTemplate,
    '--referee-path',
    refereePath,
    '--timeout-ms',
    '5000',
    '--max-retries',
    '1',
    '--backoff-ms',
    '10',
    '--journal-path',
    journalPath,
    '--consistency-report',
    consistencyReportPath,
    '--fix-plan-path',
    fixPlanPath,
    '--strategy-path',
    strategyPath,
    '--strategy-markdown-path',
    strategyMarkdownPath,
    '--facts-path',
    factsPath,
    '--coverage-path',
    coveragePath,
    '--coverage-markdown-path',
    coverageMarkdownPath,
    '--use-index',
    'true',
    '--delta-mode',
    'true',
    '--delta-hops',
    '1',
    '--expand-on-low-confidence',
    'true',
    '--confidence-threshold',
    '75',
    '--canary-size',
    '1'
  ], {
    cwd: sandbox
  });

  assert.equal(result.ok, true);
  assert.equal(result.deltaMode, true);
  assert.equal(result.deltaSummary.selectedCount >= 2, true);
  assert.equal(fs.existsSync(consistencyReportPath), true);
  assert.equal(fs.existsSync(fixPlanPath), true);
  assert.equal(fs.existsSync(strategyPath), true);
  assert.equal(fs.existsSync(strategyMarkdownPath), true);
  assert.equal(fs.existsSync(factsPath), true);
  assert.equal(fs.existsSync(coveragePath), true);
  assert.equal(fs.existsSync(coverageMarkdownPath), true);

  const seenFiles = readJson(seenFilesPath);
  assert.equal(seenFiles.includes(overlayFile), true);

  const state = readJson(statePath);
  assert.equal(Object.keys(state.factCards || {}).length >= 3, true);
  assert.equal(state.metrics.lowConfidenceFindings >= 1, true);
  assert.equal(state.bugLedger.every((entry) => typeof entry.confidenceScore === 'number'), true);

  const consistency = readJson(consistencyReportPath);
  assert.equal(consistency.lowConfidenceFindings >= 1, true);

  const fixPlan = readJson(fixPlanPath);
  assert.equal(fixPlan.totals.manualReview >= 1, true);

  const fixStrategy = readJson(strategyPath);
  assert.equal(fixStrategy.summary.manualReview >= 1, true);
  assert.equal(Array.isArray(fixStrategy.clusters), true);

  const strategyMarkdown = fs.readFileSync(strategyMarkdownPath, 'utf8');
  assert.match(strategyMarkdown, /# Fix Strategy/);

  const coverage = readJson(coveragePath);
  assert.equal(coverage.status, 'COMPLETE');
  assert.equal(Array.isArray(coverage.files), true);
  assert.equal(Array.isArray(coverage.bugs), true);
});

test('run-bug-hunter builds canary fix subset from high-confidence findings', () => {
  const sandbox = makeSandbox('run-bug-hunter-canary-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.claude', 'bug-hunter-state.json');
  const fixPlanPath = path.join(sandbox, '.claude', 'bug-hunter-fix-plan.json');
  const refereePath = path.join(sandbox, '.claude', 'referee.json');

  const fileA = path.join(sandbox, 'src', 'a.ts');
  const fileB = path.join(sandbox, 'src', 'b.ts');
  fs.mkdirSync(path.dirname(fileA), { recursive: true });
  fs.writeFileSync(fileA, 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(fileB, 'export const b = 2;\n', 'utf8');
  writeJson(filesJsonPath, [fileA, fileB]);
  writeRefereeArtifact({
    filePath: refereePath,
    verdicts: ['BUG-chunk-1', 'BUG-chunk-2'].map((bugId) => {
      return { bugId, confidenceScore: 92 };
    })
  });

  const worker = resolveSkillScript('tests', 'fixtures', 'low-confidence-worker.cjs');
  const workerTemplate = [
    'node',
    shellQuote(worker),
    '--chunk-id',
    '{chunkId}',
    '--scan-files-json',
    '{scanFilesJson}',
    '--findings-json',
    '{findingsJson}',
    '--facts-json',
    '{factsJson}',
    '--confidence',
    '92'
  ].join(' ');

  runJson('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath,
    '--mode',
    'extended',
    '--chunk-size',
    '1',
    '--worker-cmd',
    workerTemplate,
    '--referee-path',
    refereePath,
    '--timeout-ms',
    '5000',
    '--confidence-threshold',
    '75',
    '--fix-plan-path',
    fixPlanPath,
    '--canary-size',
    '1'
  ], {
    cwd: sandbox
  });

  const fixPlan = readJson(fixPlanPath);
  assert.equal(fixPlan.totals.eligible >= 1, true);
  assert.equal(fixPlan.totals.canary, 1);
});

test('run-bug-hunter excludes non-autofix strategy findings from the executable fix plan', () => {
  const sandbox = makeSandbox('run-bug-hunter-strategy-gate-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.claude', 'bug-hunter-state.json');
  const fixPlanPath = path.join(sandbox, '.claude', 'bug-hunter-fix-plan.json');
  const refereePath = path.join(sandbox, '.claude', 'referee.json');
  const workerPath = path.join(sandbox, 'worker.cjs');

  const fileA = path.join(sandbox, 'src', 'architecture.ts');
  fs.mkdirSync(path.dirname(fileA), { recursive: true });
  fs.writeFileSync(fileA, 'export const architecture = true;\n', 'utf8');
  writeJson(filesJsonPath, [fileA]);
  writeRefereeArtifact({
    filePath: refereePath,
    verdicts: [{ bugId: 'BUG-ARCH', confidenceScore: 98 }]
  });

  fs.writeFileSync(workerPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const findingsPath = process.argv[process.argv.indexOf('--findings-json') + 1];",
    "const scanPath = process.argv[process.argv.indexOf('--scan-files-json') + 1];",
    "const scanFiles = JSON.parse(fs.readFileSync(scanPath, 'utf8'));",
    "fs.writeFileSync(findingsPath, JSON.stringify([{ bugId: 'BUG-ARCH', severity: 'Critical', category: 'logic', file: scanFiles[0], lines: '1', claim: 'architecture contract violation in orchestration flow', evidence: scanFiles[0] + ':1 architecture evidence', runtimeTrigger: 'Run the orchestrator on this file', crossReferences: ['Single file'], confidenceScore: 98, confidenceLabel: 'high', stride: 'N/A', cwe: 'N/A' }], null, 2));"
  ].join('\n'), 'utf8');

  runJson('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath,
    '--mode',
    'extended',
    '--chunk-size',
    '1',
    '--worker-cmd',
    `node ${shellQuote(workerPath)} --chunk-id {chunkId} --scan-files-json {scanFilesJson} --findings-json {findingsJson}`,
    '--referee-path',
    refereePath,
    '--timeout-ms',
    '5000',
    '--confidence-threshold',
    '75',
    '--fix-plan-path',
    fixPlanPath,
    '--canary-size',
    '1'
  ], {
    cwd: sandbox
  });

  const fixPlan = readJson(fixPlanPath);
  assert.equal(fixPlan.totals.eligible, 0);
  assert.equal(fixPlan.totals.canary, 0);
  assert.equal(fixPlan.totals.rollout, 0);
});

test('run-bug-hunter downgrades conflicting findings to manual review before fix-plan execution', () => {
  const sandbox = makeSandbox('run-bug-hunter-conflicts-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.claude', 'bug-hunter-state.json');
  const fixPlanPath = path.join(sandbox, '.claude', 'bug-hunter-fix-plan.json');
  const consistencyPath = path.join(sandbox, '.claude', 'consistency.json');
  const refereePath = path.join(sandbox, '.claude', 'referee.json');
  const workerPath = path.join(sandbox, 'worker.cjs');

  const fileA = path.join(sandbox, 'src', 'conflict.ts');
  fs.mkdirSync(path.dirname(fileA), { recursive: true });
  fs.writeFileSync(fileA, 'export const conflict = true;\n', 'utf8');
  writeJson(filesJsonPath, [fileA]);
  writeRefereeArtifact({
    filePath: refereePath,
    verdicts: [
      { bugId: 'BUG-1', confidenceScore: 97 },
      { bugId: 'BUG-2', confidenceScore: 96 }
    ]
  });

  fs.writeFileSync(workerPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const findingsPath = process.argv[process.argv.indexOf('--findings-json') + 1];",
    "const scanPath = process.argv[process.argv.indexOf('--scan-files-json') + 1];",
    "const scanFiles = JSON.parse(fs.readFileSync(scanPath, 'utf8'));",
    "fs.writeFileSync(findingsPath, JSON.stringify([",
    "  { bugId: 'BUG-1', severity: 'Critical', category: 'logic', file: scanFiles[0], lines: '1', claim: 'first conflicting claim', evidence: scanFiles[0] + ':1 first', runtimeTrigger: 'Trigger first', crossReferences: ['Single file'], confidenceScore: 97, confidenceLabel: 'high', stride: 'N/A', cwe: 'N/A' },",
    "  { bugId: 'BUG-2', severity: 'Critical', category: 'logic', file: scanFiles[0], lines: '1', claim: 'second conflicting claim', evidence: scanFiles[0] + ':1 second', runtimeTrigger: 'Trigger second', crossReferences: ['Single file'], confidenceScore: 96, confidenceLabel: 'high', stride: 'N/A', cwe: 'N/A' }",
    "], null, 2));"
  ].join('\n'), 'utf8');

  runJson('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath,
    '--mode',
    'extended',
    '--chunk-size',
    '1',
    '--worker-cmd',
    `node ${shellQuote(workerPath)} --chunk-id {chunkId} --scan-files-json {scanFilesJson} --findings-json {findingsJson}`,
    '--referee-path',
    refereePath,
    '--timeout-ms',
    '5000',
    '--confidence-threshold',
    '75',
    '--fix-plan-path',
    fixPlanPath,
    '--consistency-report',
    consistencyPath,
    '--canary-size',
    '1'
  ], {
    cwd: sandbox
  });

  const consistency = readJson(consistencyPath);
  assert.equal(consistency.conflicts.length >= 1, true);

  const fixPlan = readJson(fixPlanPath);
  assert.equal(fixPlan.totals.eligible, 0);
  assert.equal(fixPlan.totals.manualReview, 2);
});

test('run-bug-hunter respects configured delta hops during low-confidence expansion', () => {
  const sandbox = makeSandbox('run-bug-hunter-delta-hops-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const changedFilesJsonPath = path.join(sandbox, 'changed-files.json');
  const statePath = path.join(sandbox, '.claude', 'bug-hunter-state.json');
  const seenFilesPath = path.join(sandbox, 'seen-files.json');
  const workerPath = path.join(sandbox, 'worker.cjs');
  const changedFile = path.join(sandbox, 'src', 'a.ts');
  const neighborFile = path.join(sandbox, 'src', 'b.ts');
  const twoHopFile = path.join(sandbox, 'src', 'c.ts');

  fs.mkdirSync(path.dirname(changedFile), { recursive: true });
  fs.writeFileSync(changedFile, "import { b } from './b';\nexport const a = b();\n", 'utf8');
  fs.writeFileSync(neighborFile, "import { c } from './c';\nexport function b() { return c(); }\n", 'utf8');
  fs.writeFileSync(twoHopFile, 'export function c() { return 1; }\n', 'utf8');

  writeJson(filesJsonPath, [changedFile, neighborFile, twoHopFile]);
  writeJson(changedFilesJsonPath, [changedFile]);

  fs.writeFileSync(workerPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const seenPath = process.argv[process.argv.indexOf('--seen-files') + 1];",
    "const changedPath = process.argv[process.argv.indexOf('--changed-file') + 1];",
    "const scanPath = process.argv[process.argv.indexOf('--scan-files-json') + 1];",
    "const findingsPath = process.argv[process.argv.indexOf('--findings-json') + 1];",
    "const scan = JSON.parse(fs.readFileSync(scanPath, 'utf8'));",
    'let seen = [];',
    "if (fs.existsSync(seenPath)) seen = JSON.parse(fs.readFileSync(seenPath, 'utf8'));",
    'seen.push(scan);',
    "fs.writeFileSync(seenPath, JSON.stringify(seen));",
    "const findings = scan[0] === changedPath ? [{ bugId: 'BUG-inline', severity: 'Low', category: 'logic', file: scan[0], lines: '1', claim: 'low confidence', evidence: scan[0] + ':1 inline evidence', runtimeTrigger: 'Load the changed file', crossReferences: ['Single file'], confidenceScore: 60 }] : [];",
    "fs.writeFileSync(findingsPath, JSON.stringify(findings));"
  ].join('\n'), 'utf8');

  const workerTemplate = [
    'node',
    shellQuote(workerPath),
    '--chunk-id',
    '{chunkId}',
    '--scan-files-json',
    '{scanFilesJson}',
    '--findings-json',
    '{findingsJson}',
    '--seen-files',
    shellQuote(seenFilesPath),
    '--changed-file',
    shellQuote(changedFile)
  ].join(' ');

  const result = runJson('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--changed-files-json',
    changedFilesJsonPath,
    '--state',
    statePath,
    '--mode',
    'extended',
    '--chunk-size',
    '1',
    '--worker-cmd',
    workerTemplate,
    '--use-index',
    'true',
    '--delta-mode',
    'true',
    '--delta-hops',
    '1',
    '--expand-on-low-confidence',
    'true',
    '--confidence-threshold',
    '75'
  ], {
    cwd: sandbox
  });

  assert.equal(result.ok, true);
  const seenFiles = readJson(seenFilesPath).flat();
  assert.equal(seenFiles.includes(twoHopFile), false);
});

test('run-bug-hunter retries malformed findings and records schema errors in the journal', () => {
  const sandbox = makeSandbox('run-bug-hunter-invalid-findings-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.claude', 'bug-hunter-state.json');
  const journalPath = path.join(sandbox, '.claude', 'bug-hunter-run.log');
  const attemptsFile = path.join(sandbox, 'attempts.json');

  const sourceFile = path.join(sandbox, 'src', 'a.ts');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'export const a = 1;\n', 'utf8');
  writeJson(filesJsonPath, [sourceFile]);

  const workerPath = path.join(sandbox, 'invalid-then-valid-worker.cjs');
  fs.writeFileSync(workerPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const path = require('path');",
    "const args = process.argv;",
    "const chunkId = args[args.indexOf('--chunk-id') + 1];",
    "const findingsPath = args[args.indexOf('--findings-json') + 1];",
    "const attemptsPath = args[args.indexOf('--attempts-file') + 1];",
    'let attempts = {};',
    "if (fs.existsSync(attemptsPath)) attempts = JSON.parse(fs.readFileSync(attemptsPath, 'utf8'));",
    "attempts[chunkId] = (attempts[chunkId] || 0) + 1;",
    "fs.mkdirSync(path.dirname(attemptsPath), { recursive: true });",
    "fs.writeFileSync(attemptsPath, JSON.stringify(attempts, null, 2));",
    "const payload = attempts[chunkId] === 1",
    "  ? [{ bugId: 'BUG-1', severity: 'Low', category: 'logic', file: 'src/a.ts', lines: '1', evidence: 'src/a.ts:1 evidence', runtimeTrigger: 'Call a()', crossReferences: ['Single file'], confidenceScore: 60 }]",
    "  : [{ bugId: 'BUG-1', severity: 'Low', category: 'logic', file: 'src/a.ts', lines: '1', claim: 'valid after retry', evidence: 'src/a.ts:1 evidence', runtimeTrigger: 'Call a()', crossReferences: ['Single file'], confidenceScore: 60 }];",
    "fs.writeFileSync(findingsPath, JSON.stringify(payload, null, 2));"
  ].join('\n'), 'utf8');

  const workerTemplate = [
    'node',
    shellQuote(workerPath),
    '--chunk-id',
    '{chunkId}',
    '--findings-json',
    '{findingsJson}',
    '--attempts-file',
    shellQuote(attemptsFile)
  ].join(' ');

  const result = runJson('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath,
    '--chunk-size',
    '1',
    '--worker-cmd',
    workerTemplate,
    '--timeout-ms',
    '5000',
    '--max-retries',
    '1',
    '--backoff-ms',
    '10',
    '--journal-path',
    journalPath
  ], {
    cwd: sandbox
  });

  assert.equal(result.ok, true);
  const attempts = readJson(attemptsFile);
  assert.equal(attempts['chunk-1'], 2);
  const journal = fs.readFileSync(journalPath, 'utf8');
  assert.match(journal, /attempt-post-check-failed/);
  assert.match(journal, /(?:\$\[0\]\.claim is required|\/0 must have required property 'claim')/);
});

test('run-bug-hunter clears stale findings artifacts before retrying a chunk', () => {
  const sandbox = makeSandbox('run-bug-hunter-stale-artifact-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.claude', 'bug-hunter-state.json');
  const journalPath = path.join(sandbox, '.claude', 'bug-hunter-run.log');
  const attemptsFile = path.join(sandbox, 'attempts.json');
  const sourceFile = path.join(sandbox, 'src', 'a.ts');

  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'export const a = 1;\n', 'utf8');
  writeJson(filesJsonPath, [sourceFile]);

  const workerPath = path.join(sandbox, 'stale-artifact-worker.cjs');
  fs.writeFileSync(workerPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const path = require('path');",
    "const args = process.argv;",
    "const chunkId = args[args.indexOf('--chunk-id') + 1];",
    "const findingsPath = args[args.indexOf('--findings-json') + 1];",
    "const attemptsPath = args[args.indexOf('--attempts-file') + 1];",
    'let attempts = {};',
    "if (fs.existsSync(attemptsPath)) attempts = JSON.parse(fs.readFileSync(attemptsPath, 'utf8'));",
    "attempts[chunkId] = (attempts[chunkId] || 0) + 1;",
    "fs.mkdirSync(path.dirname(attemptsPath), { recursive: true });",
    "fs.writeFileSync(attemptsPath, JSON.stringify(attempts, null, 2));",
    'if (attempts[chunkId] === 1) {',
    "  fs.writeFileSync(findingsPath, JSON.stringify([{ bugId: 'BUG-stale', severity: 'Low', category: 'logic', file: 'src/a.ts', lines: '1', claim: 'stale artifact', evidence: 'src/a.ts:1 evidence', runtimeTrigger: 'Call a()', crossReferences: ['Single file'], confidenceScore: 60 }], null, 2));",
    '  process.exit(1);',
    '}',
    'process.exit(0);'
  ].join('\n'), 'utf8');

  const workerTemplate = [
    'node',
    shellQuote(workerPath),
    '--chunk-id',
    '{chunkId}',
    '--findings-json',
    '{findingsJson}',
    '--attempts-file',
    shellQuote(attemptsFile)
  ].join(' ');

  const { result: commandResult, value: result } = runJsonAllowFailure('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath,
    '--chunk-size',
    '1',
    '--worker-cmd',
    workerTemplate,
    '--timeout-ms',
    '5000',
    '--max-retries',
    '1',
    '--backoff-ms',
    '10',
    '--journal-path',
    journalPath
  ], {
    cwd: sandbox
  });

  assert.notEqual(commandResult.status, 0);
  assert.equal(result.ok, false);
  const attempts = readJson(attemptsFile);
  assert.equal(attempts['chunk-1'], 2);
  const state = readJson(statePath);
  assert.equal(state.chunks[0].status, 'failed');
});

test('run-bug-hunter handles worker paths containing spaces', () => {
  const sandbox = makeSandbox('run-bug-hunter-space-path-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.claude', 'bug-hunter-state.json');
  const workerPath = path.join(sandbox, 'worker script.cjs');
  const sourceFile = path.join(sandbox, 'src', 'dir with space', 'a.ts');

  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'export const a = 1;\n', 'utf8');
  writeJson(filesJsonPath, [sourceFile]);

  fs.writeFileSync(workerPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const args = process.argv;",
    "const findingsPath = args[args.indexOf('--findings-json') + 1];",
    "const scanFilesJson = args[args.indexOf('--scan-files-json') + 1];",
    "const scanFiles = JSON.parse(fs.readFileSync(scanFilesJson, 'utf8'));",
    "fs.writeFileSync(findingsPath, JSON.stringify([{ bugId: 'BUG-space', severity: 'Low', category: 'logic', file: scanFiles[0], lines: '1', claim: 'space path works', evidence: scanFiles[0] + ':1 evidence', runtimeTrigger: 'Call a()', crossReferences: ['Single file'], confidenceScore: 60 }], null, 2));"
  ].join('\n'), 'utf8');

  const workerTemplate = [
    'node',
    shellQuote(workerPath),
    '--chunk-id',
    '{chunkId}',
    '--scan-files-json',
    '{scanFilesJson}',
    '--findings-json',
    '{findingsJson}'
  ].join(' ');

  const result = runJson('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath,
    '--chunk-size',
    '1',
    '--worker-cmd',
    workerTemplate,
    '--timeout-ms',
    '5000'
  ], {
    cwd: sandbox
  });

  assert.equal(result.ok, true);
});

test('run-bug-hunter skips fix strategy and fix plan emission when chunks fail', () => {
  const sandbox = makeSandbox('run-bug-hunter-failed-chunks-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.claude', 'bug-hunter-state.json');
  const fixPlanPath = path.join(sandbox, '.claude', 'bug-hunter-fix-plan.json');
  const strategyPath = path.join(sandbox, '.claude', 'bug-hunter-fix-strategy.json');
  const workerPath = path.join(sandbox, 'always-fail-worker.cjs');
  const sourceFile = path.join(sandbox, 'src', 'a.ts');

  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'export const a = 1;\n', 'utf8');
  writeJson(filesJsonPath, [sourceFile]);

  fs.writeFileSync(workerPath, '#!/usr/bin/env node\nprocess.exit(1);\n', 'utf8');

  const { result: commandResult, value: result } = runJsonAllowFailure('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath,
    '--chunk-size',
    '1',
    '--worker-cmd',
    `node ${workerPath}`,
    '--timeout-ms',
    '5000',
    '--max-retries',
    '1',
    '--fix-plan-path',
    fixPlanPath,
    '--strategy-path',
    strategyPath
  ], {
    cwd: sandbox
  });

  assert.notEqual(commandResult.status, 0);
  assert.equal(result.ok, false);
  const state = readJson(statePath);
  assert.equal(state.chunks[0].status, 'failed');
  assert.equal(fs.existsSync(fixPlanPath), false);
  assert.equal(fs.existsSync(strategyPath), false);
});

test('run-bug-hunter requires a worker before creating run state', () => {
  const sandbox = makeSandbox('run-bug-hunter-worker-preflight-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.bug-hunter', 'state.json');
  writeJson(filesJsonPath, []);

  const result = runRaw('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath
  ], {
    cwd: sandbox,
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout || ''}${result.stderr || ''}`, /--worker-cmd is required/);
  assert.equal(fs.existsSync(statePath), false);
});

test('run-bug-hunter accepts zero retries as exactly one attempt', () => {
  const sandbox = makeSandbox('run-bug-hunter-zero-retries-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.bug-hunter', 'state.json');
  const attemptsPath = path.join(sandbox, 'attempts.txt');
  const sourcePath = path.join(sandbox, 'source.ts');
  const workerPath = path.join(sandbox, 'worker.cjs');
  fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
  writeJson(filesJsonPath, [sourcePath]);
  fs.writeFileSync(workerPath, [
    "const fs = require('fs');",
    `const attemptsPath = ${JSON.stringify(attemptsPath)};`,
    "const attempts = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, 'utf8')) : 0;",
    "fs.writeFileSync(attemptsPath, String(attempts + 1));",
    'process.exit(1);'
  ].join('\n'), 'utf8');

  const { result: commandResult, value: result } = runJsonAllowFailure('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath,
    '--worker-cmd',
    `node ${shellQuote(workerPath)}`,
    '--max-retries',
    '0',
    '--backoff-ms',
    '0'
  ], {
    cwd: sandbox
  });

  assert.notEqual(commandResult.status, 0);
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(attemptsPath, 'utf8'), '1');
});

test('run-bug-hunter resumes only the matching explicit run identity', () => {
  const sandbox = makeSandbox('run-bug-hunter-resume-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.bug-hunter', 'state.json');
  const attemptsPath = path.join(sandbox, 'attempts.txt');
  const sourcePath = path.join(sandbox, 'source.ts');
  const workerPath = path.join(sandbox, 'worker.cjs');
  fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
  writeJson(filesJsonPath, [sourcePath]);
  fs.writeFileSync(workerPath, [
    "const fs = require('fs');",
    "const args = process.argv;",
    "const findingsPath = args[args.indexOf('--findings-json') + 1];",
    `const attemptsPath = ${JSON.stringify(attemptsPath)};`,
    "const attempts = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(attemptsPath, String(attempts));",
    'if (attempts <= 2) process.exit(1);',
    "fs.writeFileSync(findingsPath, JSON.stringify([{ bugId: 'BUG-resume', severity: 'Low', category: 'logic', file: 'source.ts', lines: '1', claim: 'resume succeeds', evidence: 'source.ts:1 evidence', runtimeTrigger: 'Run worker', crossReferences: ['Single file'], confidenceScore: 90 }]));"
  ].join('\n'), 'utf8');
  const baseArgs = [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath,
    '--worker-cmd',
    `node ${shellQuote(workerPath)} --findings-json {findingsJson}`,
    '--max-retries',
    '1',
    '--backoff-ms',
    '0'
  ];

  const firstRun = runJsonAllowFailure('node', [...baseArgs, '--run-id', 'resume-test'], {
    cwd: sandbox
  });
  assert.notEqual(firstRun.result.status, 0);
  assert.equal(firstRun.value.ok, false);

  const resumed = runJson('node', [...baseArgs, '--resume', 'resume-test'], {
    cwd: sandbox
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.runId, 'resume-test');
  assert.equal(fs.readFileSync(attemptsPath, 'utf8'), '3');

  fs.writeFileSync(sourcePath, 'export const changed = 2;\n', 'utf8');
  const mismatch = runRaw('node', [...baseArgs, '--resume', 'resume-test', '--mode', 'small'], {
    cwd: sandbox,
    encoding: 'utf8'
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(`${mismatch.stdout || ''}${mismatch.stderr || ''}`, /Resume fingerprint mismatch/);
});

test('run-bug-hunter uses only REAL_BUG Referee verdicts and assigned bucket stages', () => {
  const sandbox = makeSandbox('run-bug-hunter-referee-gate-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const filesJsonPath = path.join(sandbox, 'files.json');
  const statePath = path.join(sandbox, '.bug-hunter', 'state.json');
  const refereePath = path.join(sandbox, '.bug-hunter', 'referee.json');
  const planPath = path.join(sandbox, '.bug-hunter', 'fix-plan.json');
  const strategyPath = path.join(sandbox, '.bug-hunter', 'fix-strategy.json');
  const sourcePaths = ['a.ts', 'b.ts'].map((name) => path.join(sandbox, name));
  sourcePaths.map((sourcePath) => {
    fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
    return sourcePath;
  });
  writeJson(filesJsonPath, sourcePaths);
  writeRefereeArtifact({
    filePath: refereePath,
    verdicts: [
      { bugId: 'BUG-chunk-1', confidenceScore: 99 },
      { bugId: 'BUG-chunk-2', verdict: 'NOT_A_BUG', confidenceScore: 99 }
    ]
  });
  const worker = resolveSkillScript('tests', 'fixtures', 'low-confidence-worker.cjs');

  const result = runJson('node', [
    runner,
    'run',
    '--skill-dir',
    skillDir,
    '--files-json',
    filesJsonPath,
    '--state',
    statePath,
    '--chunk-size',
    '1',
    '--worker-cmd',
    `node ${shellQuote(worker)} --chunk-id {chunkId} --scan-files-json {scanFilesJson} --findings-json {findingsJson} --confidence 99`,
    '--referee-path',
    refereePath,
    '--fix-plan-path',
    planPath,
    '--strategy-path',
    strategyPath,
    '--canary-size',
    '1'
  ], {
    cwd: sandbox
  });

  assert.equal(result.ok, true);
  const plan = readJson(planPath);
  assert.deepEqual(plan.canary.map((entry) => entry.bugId), ['BUG-chunk-1']);
  assert.equal(plan.canary[0].executionStage, 'canary');
  assert.deepEqual(plan.rollout, []);
  assert.deepEqual(plan.manualReview, []);
  const strategy = readJson(strategyPath);
  assert.equal(strategy.summary.confirmed, 1);
  assert.equal(strategy.clusters[0].executionStage, 'canary');
  const fixerScope = readJson(result.fixerScopePath);
  assert.equal(fixerScope.runId, result.runId);
  assert.deepEqual(fixerScope.approvedBugIds, ['BUG-chunk-1']);
  assert.deepEqual(fixerScope.approvedFiles, [sourcePaths[0]]);
});

test('run-bug-hunter reports missing executables and output limits without hanging', () => {
  const sandbox = makeSandbox('run-bug-hunter-process-errors-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const outputPath = path.join(sandbox, 'skeptic.json');
  const missing = runRaw('node', [
    runner,
    'phase',
    '--skill-dir',
    skillDir,
    '--artifact',
    'skeptic',
    '--output-path',
    outputPath,
    '--worker-cmd',
    'bug-hunter-definitely-missing-executable',
    '--max-retries',
    '0'
  ], {
    cwd: sandbox,
    encoding: 'utf8'
  });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout || ''}${missing.stderr || ''}`, /ENOENT|spawn/);

  const noisyWorkerPath = path.join(sandbox, 'noisy-worker.cjs');
  const journalPath = path.join(sandbox, 'noisy.log');
  fs.writeFileSync(noisyWorkerPath, "process.stdout.write('x'.repeat(4096));\n", 'utf8');
  const noisy = runRaw('node', [
    runner,
    'phase',
    '--skill-dir',
    skillDir,
    '--artifact',
    'skeptic',
    '--output-path',
    outputPath,
    '--worker-cmd',
    `node ${shellQuote(noisyWorkerPath)}`,
    '--max-output-bytes',
    '128',
    '--max-retries',
    '0',
    '--kill-grace-ms',
    '50',
    '--journal-path',
    journalPath
  ], {
    cwd: sandbox,
    encoding: 'utf8'
  });
  assert.notEqual(noisy.status, 0);
  assert.match(fs.readFileSync(journalPath, 'utf8'), /outputLimitHit.*true|output exceeded 128 bytes/i);
});

test('run-bug-hunter timeout stops the worker process group', {
  skip: process.platform === 'win32'
}, () => {
  const sandbox = makeSandbox('run-bug-hunter-process-group-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const workerPath = path.join(sandbox, 'worker.cjs');
  const descendantPath = path.join(sandbox, 'descendant.cjs');
  const workerPidPath = path.join(sandbox, 'worker.pid');
  const descendantPidPath = path.join(sandbox, 'descendant.pid');
  const outputPath = path.join(sandbox, 'skeptic.json');
  fs.writeFileSync(descendantPath, [
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);'
  ].join('\n'), 'utf8');
  fs.writeFileSync(workerPath, [
    "const childProcess = require('child_process');",
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(workerPidPath)}, String(process.pid));`,
    `const child = childProcess.spawn(process.execPath, [${JSON.stringify(descendantPath)}], { stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);'
  ].join('\n'), 'utf8');

  const result = runRaw('node', [
    runner,
    'phase',
    '--skill-dir',
    skillDir,
    '--artifact',
    'skeptic',
    '--output-path',
    outputPath,
    '--worker-cmd',
    `node ${shellQuote(workerPath)}`,
    '--timeout-ms',
    '100',
    '--kill-grace-ms',
    '100',
    '--max-retries',
    '0'
  ], {
    cwd: sandbox,
    encoding: 'utf8',
    timeout: 5000
  });

  assert.notEqual(result.status, 0);
  const pids = [workerPidPath, descendantPidPath].map((pidPath) => {
    return Number(fs.readFileSync(pidPath, 'utf8'));
  });
  pids.map((pid) => {
    assert.throws(() => {
      process.kill(pid, 0);
    }, (error) => {
      return error && error.code === 'ESRCH';
    });
    return pid;
  });
});

test('run-bug-hunter fails fast on unknown placeholders in worker templates', () => {
  const sandbox = makeSandbox('run-bug-hunter-bad-template-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const outputPath = path.join(sandbox, '.bug-hunter', 'skeptic.json');

  const result = runRaw('node', [
    runner,
    'phase',
    '--skill-dir',
    skillDir,
    '--phase-name',
    'skeptic-phase',
    '--artifact',
    'skeptic',
    '--output-path',
    outputPath,
    '--worker-cmd',
    'node fake-worker --output-path {outputPath} --missing {unknownPlaceholder}',
    '--timeout-ms',
    '5000'
  ], {
    cwd: sandbox,
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout || ''}${result.stderr || ''}`, /Unknown template placeholder|unknownPlaceholder/);
});

test('run-bug-hunter phase retries invalid skeptic output and renders a markdown companion', () => {
  const sandbox = makeSandbox('run-bug-hunter-phase-skeptic-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');
  const outputPath = path.join(sandbox, '.bug-hunter', 'skeptic.json');
  const renderOutputPath = path.join(sandbox, '.bug-hunter', 'skeptic.md');
  const journalPath = path.join(sandbox, '.bug-hunter', 'phase.log');
  const attemptsFile = path.join(sandbox, 'attempts.json');
  const workerPath = path.join(sandbox, 'skeptic-worker.cjs');

  fs.writeFileSync(workerPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const path = require('path');",
    "const args = process.argv;",
    "const outputPath = args[args.indexOf('--output-path') + 1];",
    "const attemptsPath = args[args.indexOf('--attempts-file') + 1];",
    'let attempts = {};',
    "if (fs.existsSync(attemptsPath)) attempts = JSON.parse(fs.readFileSync(attemptsPath, 'utf8'));",
    "attempts.skeptic = (attempts.skeptic || 0) + 1;",
    "fs.mkdirSync(path.dirname(attemptsPath), { recursive: true });",
    "fs.writeFileSync(attemptsPath, JSON.stringify(attempts, null, 2));",
    "const payload = attempts.skeptic === 1",
    "  ? [{ bugId: 'BUG-1', response: 'ACCEPT' }]",
    "  : [{ bugId: 'BUG-1', response: 'ACCEPT', analysisSummary: 'Validated on retry.' }];",
    "fs.mkdirSync(path.dirname(outputPath), { recursive: true });",
    "fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));"
  ].join('\n'), 'utf8');

  const workerTemplate = [
    'node',
    shellQuote(workerPath),
    '--output-path',
    '{outputPath}',
    '--attempts-file',
    shellQuote(attemptsFile)
  ].join(' ');

  const renderTemplate = [
    'node',
    shellQuote(path.join(skillDir, 'scripts', 'render-report.cjs')),
    'skeptic',
    '{outputPath}'
  ].join(' ');

  const result = runJson('node', [
    runner,
    'phase',
    '--skill-dir',
    skillDir,
    '--phase-name',
    'skeptic-phase',
    '--artifact',
    'skeptic',
    '--output-path',
    outputPath,
    '--render-output-path',
    renderOutputPath,
    '--worker-cmd',
    workerTemplate,
    '--render-cmd',
    renderTemplate,
    '--timeout-ms',
    '5000',
    '--max-retries',
    '1',
    '--backoff-ms',
    '10',
    '--journal-path',
    journalPath
  ], {
    cwd: sandbox
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifact, 'skeptic');
  assert.equal(fs.existsSync(outputPath), true);
  assert.equal(fs.existsSync(renderOutputPath), true);

  const attempts = readJson(attemptsFile);
  assert.equal(attempts.skeptic, 2);

  const journal = fs.readFileSync(journalPath, 'utf8');
  assert.match(journal, /attempt-post-check-failed/);
  assert.match(
    journal,
    /(?:\$\[0\]\.analysisSummary is required|\/0 must have required property 'analysisSummary')/
  );

  const rendered = fs.readFileSync(renderOutputPath, 'utf8');
  assert.match(rendered, /# Skeptic Review/);
  assert.match(rendered, /Validated on retry/);
});

test('run-bug-hunter phase validates referee and fix-report artifacts', () => {
  const sandbox = makeSandbox('run-bug-hunter-phase-multi-');
  const runner = resolveSkillScript('run-bug-hunter.cjs');
  const skillDir = path.resolve(__dirname, '..', '..');

  const phases = [
    {
      artifact: 'referee',
      invalidBody: "[{\"bugId\":\"BUG-1\",\"verdict\":\"REAL_BUG\"}]",
      validBody: JSON.stringify([
        {
          bugId: 'BUG-1',
          verdict: 'REAL_BUG',
          trueSeverity: 'Critical',
          confidenceScore: 99,
          confidenceLabel: 'high',
          verificationMode: 'INDEPENDENTLY_VERIFIED',
          analysisSummary: 'Confirmed on retry.'
        }
      ], null, 2),
      expectedError: 'trueSeverity'
    },
    {
      artifact: 'fix-report',
      invalidBody: JSON.stringify({
        version: '3.0.4',
        fix_branch: 'bug-hunter-fix-branch'
      }, null, 2),
      validBody: JSON.stringify({
        version: '3.0.4',
        fix_branch: 'bug-hunter-fix-branch',
        base_commit: 'abc123',
        dry_run: false,
        circuit_breaker_tripped: false,
        phase2_timeout_hit: false,
        fixes: [],
        verification: {
          baseline_pass: 1,
          baseline_fail: 0,
          flaky_tests: 0,
          final_pass: 1,
          final_fail: 0,
          new_failures: 0,
          resolved_failures: 0,
          typecheck_pass: true,
          build_pass: true,
          fixer_bugs_found: 0
        },
        summary: {
          total_confirmed: 0,
          eligible: 0,
          manual_review: 0,
          fixed: 0,
          fix_reverted: 0,
          fix_failed: 0,
          skipped: 0,
          fixer_bug: 0,
          partial: 0
        }
      }, null, 2),
      expectedError: 'base_commit'
    }
  ];

  phases.forEach((phase) => {
    const outputPath = path.join(sandbox, '.bug-hunter', `${phase.artifact}.json`);
    const journalPath = path.join(sandbox, '.bug-hunter', `${phase.artifact}.log`);
    const attemptsFile = path.join(sandbox, `${phase.artifact}-attempts.json`);
    const workerPath = path.join(sandbox, `${phase.artifact}-worker.cjs`);

    fs.writeFileSync(workerPath, [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const path = require('path');",
      "const args = process.argv;",
      "const outputPath = args[args.indexOf('--output-path') + 1];",
      "const attemptsPath = args[args.indexOf('--attempts-file') + 1];",
      'let attempts = 0;',
      "if (fs.existsSync(attemptsPath)) attempts = Number(fs.readFileSync(attemptsPath, 'utf8'));",
      'attempts += 1;',
      "fs.mkdirSync(path.dirname(attemptsPath), { recursive: true });",
      "fs.writeFileSync(attemptsPath, String(attempts));",
      `const invalidBody = ${JSON.stringify(phase.invalidBody)};`,
      `const validBody = ${JSON.stringify(phase.validBody)};`,
      "fs.mkdirSync(path.dirname(outputPath), { recursive: true });",
      "fs.writeFileSync(outputPath, attempts === 1 ? invalidBody : validBody);"
    ].join('\n'), 'utf8');

    const workerTemplate = [
      'node',
      shellQuote(workerPath),
      '--output-path',
      '{outputPath}',
      '--attempts-file',
      shellQuote(attemptsFile)
    ].join(' ');

    const result = runJson('node', [
      runner,
      'phase',
      '--skill-dir',
      skillDir,
      '--phase-name',
      `${phase.artifact}-phase`,
      '--artifact',
      phase.artifact,
      '--output-path',
      outputPath,
      '--worker-cmd',
      workerTemplate,
      '--timeout-ms',
      '5000',
      '--max-retries',
      '1',
      '--backoff-ms',
      '10',
      '--journal-path',
      journalPath
    ], {
      cwd: sandbox
    });

    assert.equal(result.ok, true);
    assert.equal(result.artifact, phase.artifact);
    assert.equal(fs.existsSync(outputPath), true);

    const journal = fs.readFileSync(journalPath, 'utf8');
    assert.match(journal, /attempt-post-check-failed/);
    assert.match(journal, new RegExp(phase.expectedError));
  });
});
