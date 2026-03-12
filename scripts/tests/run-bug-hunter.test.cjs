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
  writeJson
} = require('./test-utils.cjs');

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
    'run-bug-hunter.cjs',
    'bug-hunter-state.cjs',
    'payload-guard.cjs',
    'schema-validate.cjs',
    'schema-runtime.cjs',
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
    'fix-report.schema.json',
    'fix-plan.schema.json',
    'fix-strategy.schema.json',
    'recon.schema.json',
    'shared.schema.json'
  ]) {
    fs.copyFileSync(
      resolveSkillScript('..', 'schemas', fileName),
      path.join(schemasDir, fileName)
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
    flakyWorker,
    '--chunk-id',
    '{chunkId}',
    '--scan-files-json',
    '{scanFilesJson}',
    '--findings-json',
    '{findingsJson}',
    '--attempts-file',
    attemptsFile
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

  const worker = resolveSkillScript('tests', 'fixtures', 'low-confidence-worker.cjs');
  const workerTemplate = [
    'node',
    worker,
    '--chunk-id',
    '{chunkId}',
    '--scan-files-json',
    '{scanFilesJson}',
    '--findings-json',
    '{findingsJson}',
    '--facts-json',
    '{factsJson}',
    '--seen-files',
    seenFilesPath,
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

  const fileA = path.join(sandbox, 'src', 'a.ts');
  const fileB = path.join(sandbox, 'src', 'b.ts');
  fs.mkdirSync(path.dirname(fileA), { recursive: true });
  fs.writeFileSync(fileA, 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(fileB, 'export const b = 2;\n', 'utf8');
  writeJson(filesJsonPath, [fileA, fileB]);

  const worker = resolveSkillScript('tests', 'fixtures', 'low-confidence-worker.cjs');
  const workerTemplate = [
    'node',
    worker,
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
  const workerPath = path.join(sandbox, 'worker.cjs');

  const fileA = path.join(sandbox, 'src', 'architecture.ts');
  fs.mkdirSync(path.dirname(fileA), { recursive: true });
  fs.writeFileSync(fileA, 'export const architecture = true;\n', 'utf8');
  writeJson(filesJsonPath, [fileA]);

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
    `node ${workerPath} --chunk-id {chunkId} --scan-files-json {scanFilesJson} --findings-json {findingsJson}`,
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
  const workerPath = path.join(sandbox, 'worker.cjs');

  const fileA = path.join(sandbox, 'src', 'conflict.ts');
  fs.mkdirSync(path.dirname(fileA), { recursive: true });
  fs.writeFileSync(fileA, 'export const conflict = true;\n', 'utf8');
  writeJson(filesJsonPath, [fileA]);

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
    `node ${workerPath} --chunk-id {chunkId} --scan-files-json {scanFilesJson} --findings-json {findingsJson}`,
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
    workerPath,
    '--chunk-id',
    '{chunkId}',
    '--scan-files-json',
    '{scanFilesJson}',
    '--findings-json',
    '{findingsJson}',
    '--seen-files',
    seenFilesPath,
    '--changed-file',
    changedFile
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
    workerPath,
    '--chunk-id',
    '{chunkId}',
    '--findings-json',
    '{findingsJson}',
    '--attempts-file',
    attemptsFile
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
  assert.match(journal, /\$\[0\]\.claim is required/);
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
    workerPath,
    '--chunk-id',
    '{chunkId}',
    '--findings-json',
    '{findingsJson}',
    '--attempts-file',
    attemptsFile
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
    workerPath,
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

  assert.equal(result.ok, true);
  const state = readJson(statePath);
  assert.equal(state.chunks[0].status, 'failed');
  assert.equal(fs.existsSync(fixPlanPath), false);
  assert.equal(fs.existsSync(strategyPath), false);
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
    workerPath,
    '--output-path',
    '{outputPath}',
    '--attempts-file',
    attemptsFile
  ].join(' ');

  const renderTemplate = [
    'node',
    path.join(skillDir, 'scripts', 'render-report.cjs'),
    'skeptic',
    '{outputPath}',
    '>',
    '{renderOutputPath}'
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
  assert.match(journal, /\$\[0\]\.analysisSummary is required/);

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
      expectedError: '\\$\\[0\\]\\.trueSeverity is required'
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
      expectedError: '\\$\\.base_commit is required'
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
      workerPath,
      '--output-path',
      '{outputPath}',
      '--attempts-file',
      attemptsFile
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
