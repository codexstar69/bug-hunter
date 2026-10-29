const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { candidateScore, compareReports, gateReport, matchFindings, recordRun, scoreSuite,
  validatePublicManifest } = require('../benchmark-suite.cjs');
const { validateArtifactValue } = require('../schema-runtime.cjs');

const root = path.resolve(__dirname, '../..');
const benchmarkRoot = path.join(root, 'evals/benchmark');
const manifestPath = path.join(benchmarkRoot, 'public-manifest.json');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = (value) => structuredClone(value);
function inputs() {
  return { manifest: read(manifestPath), labels: read(path.join(benchmarkRoot, 'private-labels.json')),
    runs: read(path.join(benchmarkRoot, 'golden-runs.json')), manifestPath };
}
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-d-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function isolatedCorpus(t) {
  const directory = temp(t);
  fs.cpSync(benchmarkRoot, path.join(directory, 'benchmark'), { recursive: true });
  fs.cpSync(path.join(root, 'evals/corpus'), path.join(directory, 'corpus'), { recursive: true });
  const copiedManifest = path.join(directory, 'benchmark/public-manifest.json');
  const manifest = read(copiedManifest);
  const labels = read(path.join(directory, 'benchmark/private-labels.json'));
  const source = path.resolve(path.dirname(copiedManifest), manifest.cases[0].root, manifest.cases[0].sourceFiles[0]);
  return { manifest, labels, manifestPath: copiedManifest, source };
}
function noisyFinding(finding) {
  return { ...finding, bugId: 'NOISE', lines: '1', claim: 'The connection is never closed.',
    evidence: 'A handle is allocated and discarded.', runtimeTrigger: 'A request opens a connection.' };
}

test('corpus files exist, are hash-bound, contain physical label lines, and mirror the de-leaked fixture', () => {
  const { manifest, labels } = inputs();
  assert.equal(validatePublicManifest(manifest, { manifestPath, labels }).ok, true);
  assert.equal(manifest.cases.length, 5);
  assert.equal(labels.cases.flatMap((entry) => entry.findings).length, 9);
  for (const entry of manifest.cases) {
    for (const file of entry.sourceFiles) {
      const source = path.resolve(benchmarkRoot, entry.root, file);
      assert.equal(digest(source), entry.sha256[file]);
      assert.doesNotMatch(fs.readFileSync(source, 'utf8'), /BUG\s*\d+|Should be|silently swallowed/i);
    }
    for (const label of labels.cases.find((item) => item.id === entry.id).findings) {
      const source = fs.readFileSync(path.resolve(benchmarkRoot, entry.root, label.file), 'utf8').trimEnd().split('\n');
      const numbers = label.lines.split('-').map(Number);
      assert.ok(numbers.at(-1) <= source.length, label.labelId);
      assert.ok(source.slice(numbers[0] - 1, numbers.at(-1)).some((line) => line.trim()), label.labelId);
    }
  }
  for (const file of manifest.cases.at(-1).sourceFiles) {
    assert.equal(fs.readFileSync(path.join(root, 'test-fixture', file), 'utf8'),
      fs.readFileSync(path.join(root, 'evals/corpus/fixture-js-express', file), 'utf8'));
  }
});

test('validate-public rejects missing files and hash drift', (t) => {
  const fixture = isolatedCorpus(t);
  fs.appendFileSync(fixture.source, '\n');
  assert.match(validatePublicManifest(fixture.manifest, fixture).errors.join('\n'), /digest mismatch/);
  fs.unlinkSync(fixture.source);
  assert.match(validatePublicManifest(fixture.manifest, fixture).errors.join('\n'), /cannot read/);
});

test('validate-public rejects mechanism keyword and answer leaks even after rehashing', (t) => {
  const fixture = isolatedCorpus(t);
  fs.appendFileSync(fixture.source, `\n// ${fixture.labels.cases[0].findings[0].keywordGroups[0][0]}\n`);
  const entry = fixture.manifest.cases[0];
  entry.sha256[entry.sourceFiles[0]] = digest(fixture.source);
  assert.match(validatePublicManifest(fixture.manifest, fixture).errors.join('\n'), /keyword leak/);
  fs.appendFileSync(fixture.source, '// BUG 72: Should be denied\n');
  entry.sha256[entry.sourceFiles[0]] = digest(fixture.source);
  assert.match(validatePublicManifest(fixture.manifest, fixture).errors.join('\n'), /answer comment leak/);
});

test('validate-public rejects source traversal and symlink escapes', (t) => {
  const fixture = isolatedCorpus(t);
  const external = path.join(path.dirname(path.dirname(fixture.manifestPath)), 'outside.js');
  fs.writeFileSync(external, 'module.exports = 1;\n');
  fs.unlinkSync(fixture.source);
  fs.symlinkSync(external, fixture.source);
  assert.match(validatePublicManifest(fixture.manifest, fixture).errors.join('\n'), /escapes case root/);
  fixture.manifest.cases[0].sourceFiles[0] = '../outside.js';
  assert.match(validatePublicManifest(fixture.manifest, fixture).errors.join('\n'), /invalid source file path/);
});

test('keyword-stuffed findings at line 9999, wrong files, mechanisms, and severities cannot match', () => {
  const { runs, labels } = inputs();
  for (let index = 0; index < 3; index += 1) {
    const finding = runs.runs[index * 2].findings[0];
    const label = labels.cases[index].findings[0];
    const stuffed = label.keywordGroups.map((group) => group[0]).join(' ');
    assert.equal(candidateScore({ ...finding, lines: '9999', claim: stuffed }, label), 0);
    assert.equal(candidateScore({ ...finding, file: `different/${finding.file}` }, label), 0);
    assert.equal(candidateScore({ ...finding, file: `/tmp/${finding.file}` }, label), 0);
    assert.equal(candidateScore({ ...finding, claim: 'A handle leaks.', evidence: 'No handle is closed.',
      runtimeTrigger: 'A request allocates a handle.', crossReferences: [stuffed] }, label), 0);
    assert.equal(candidateScore({ ...finding, claim: 'A handle leaks.', evidence: 'No handle is closed.',
      runtimeTrigger: 'A request allocates a handle.' }, { ...label, minimumKeywordGroupRatio: 0 }), 0);
    assert.equal(candidateScore({ ...finding, severity: index === 1 ? 'Critical' : 'Low' }, label), 0);
  }
});

test('golden overlapping ranges and small tolerance match, while malformed canonical findings fail', () => {
  const data = inputs();
  assert.equal(scoreSuite(data).aggregate.recall, 1);
  const finding = data.runs.runs[0].findings[0];
  const label = data.labels.cases[0].findings[0];
  const [start, end] = label.lines.split('-').map(Number);
  assert.ok(candidateScore({ ...finding, lines: String(end + 5) }, label) >= 0.7);
  assert.equal(candidateScore({ ...finding, lines: String(end + 6) }, label), 0);
  assert.equal(candidateScore({ ...finding, lines: String(start + 1) }, { ...label, lineTolerance: 0 }) >= 0.7, true);
  for (const field of ['evidence', 'runtimeTrigger', 'crossReferences', 'confidenceScore', 'stride', 'cwe']) {
    const invalid = clone(data);
    delete invalid.runs.runs[0].findings[0][field];
    assert.equal(scoreSuite(invalid).validation.ok, false, field);
    assert.equal(candidateScore(invalid.runs.runs[0].findings[0], label), 0, field);
  }
  for (const lines of ['0', '8-2', '42-ish', '-1', '1-9999999999999999999999']) {
    const invalid = clone(data);
    invalid.runs.runs[0].findings[0].lines = lines;
    assert.equal(scoreSuite(invalid).validation.ok, false, lines);
  }
});

test('one-to-one matching retains label-ID stability across valid paraphrases', () => {
  const { runs, labels } = inputs();
  const finding = runs.runs[0].findings[0];
  const matching = matchFindings([finding, { ...finding, bugId: 'duplicate' }], labels.cases[0].findings);
  assert.equal(matching.matches.length, 1);
  assert.equal(matching.unmatchedFindingIndexes.length, 1);
  const report = scoreSuite(inputs());
  assert.deepEqual(report.runs[0].matchedLabelIds, report.runs[1].matchedLabelIds);
  assert.equal(report.aggregate.repeatStability.meanJaccard, 1);
});

test('legacy fixture evaluator uses canonical one-to-one location matching', () => {
  const { evaluate } = require('../../evals/evaluate-fixture.cjs');
  const benchmark = read(path.join(root, 'evals/expected-findings.json'));
  const findings = clone(inputs().runs.runs.at(-1).findings);
  findings.forEach((finding) => { finding.lines = '9999'; });
  const result = evaluate({ findings, benchmark });
  assert.equal(result.matched, 0);
  assert.equal(result.falsePositives, 6);
  const first = inputs().runs.runs.at(-1).findings[0];
  assert.equal(evaluate({ findings: [first, { ...first, bugId: 'duplicate' }], benchmark }).matched, 1);
});

test('missing token, cost, duration, and emission telemetry remains unknown and fails the gate', () => {
  for (const field of ['inputTokens', 'outputTokens', 'durationMs', 'costUsd']) {
    const data = inputs();
    delete data.runs.runs[0][field];
    const report = scoreSuite(data);
    assert.equal(report.validation.ok, true);
    assert.equal(report.runs[0][field], null);
    assert.equal(report.ok, false);
    assert.equal(gateReport(JSON.parse(JSON.stringify(report))).ok, false);
    assert.equal(validateArtifactValue({ artifactName: 'benchmark-report', value: report }).ok, true);
    const totalField = field.endsWith('Tokens') ? 'totalTokens' : field === 'costUsd' ? 'totalCostUsd' : 'totalDurationMs';
    assert.equal(report.aggregate[totalField], null);
  }
  const data = inputs();
  data.runs.runs[0].inputTokens = '9000';
  assert.equal(scoreSuite(data).validation.ok, false);
  const report = scoreSuite(inputs());
  assert.equal(report.runs.at(-1).timeToFirstTruePositiveMs, null);
});

test('total efficiency charges expensive clean controls and zero-TP runs', () => {
  const data = inputs();
  const original = scoreSuite(data);
  data.runs.runs.filter((run) => run.caseId === 'clean-python-api').forEach((run) => { run.inputTokens = 10_000_000; });
  const report = scoreSuite(data);
  assert.equal(report.aggregate.medianTokensPerTruePositive, original.aggregate.medianTokensPerTruePositive);
  assert.ok(report.aggregate.tokensPerTruePositive > 1_000_000);
  assert.equal(report.aggregate.tokensPerTruePositive,
    report.runs.reduce((sum, run) => sum + run.totalTokens, 0) / report.aggregate.truePositives);
  assert.equal(report.gate.failed.includes('maxTokensPerTruePositive'), true);
  assert.equal(report.ok, false);
});

test('coverage must name the real case file count and repeat identities must be unique', () => {
  const data = inputs();
  data.runs.runs[0].coverage = { filesDone: 0, filesTotal: 0 };
  assert.equal(scoreSuite(data).validation.ok, false);
  const duplicate = inputs();
  duplicate.runs.runs[1].repeat = 1;
  assert.match(scoreSuite(duplicate).validation.errors.join('\n'), /duplicate repeat/);
});

test('pooled severity recall and per-profile gates prevent clean-case and cross-profile dilution', () => {
  const data = inputs();
  const fastRuns = clone(data.runs.runs).map((run) => ({ ...run, profile: 'fast', runId: `fast-${run.runId}`, findings: [] }));
  data.runs.runs.push(...fastRuns);
  data.manifest.requiredProfiles.push('fast');
  const report = scoreSuite(data);
  assert.equal(report.aggregate.severityWeightedRecall, 0.5);
  assert.equal(report.aggregate.byProfile.fast.recall, 0);
  assert.equal(report.gate.failed.includes('profile:fast:minRecall'), true);
  assert.equal(report.gate.failed.includes('profile:fast:measured:totalTokens'), false);
});

test('gate recomputes aggregates and thresholds rather than trusting stored results', (t) => {
  const report = scoreSuite(inputs());
  report.aggregate.recall = 0;
  assert.equal(report.ok, true);
  assert.equal(gateReport(report).ok, true);
  report.runs[0].coverage = 0;
  assert.equal(gateReport(report).ok, false);
  const file = path.join(temp(t), 'report.json');
  write(file, report);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/benchmark-suite.cjs'), 'gate', '--report', file], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

test('evidenceKind is required and schema-valid for synthetic, replayed, and live reports', () => {
  for (const evidenceKind of ['synthetic', 'replayed', 'live']) {
    const data = inputs();
    data.runs.evidenceKind = evidenceKind;
    const report = scoreSuite(data);
    assert.equal(report.evidenceKind, evidenceKind);
    assert.equal(validateArtifactValue({ artifactName: 'benchmark-report', value: report }).ok, true);
    delete report.evidenceKind;
    assert.equal(validateArtifactValue({ artifactName: 'benchmark-report', value: report }).ok, false);
  }
  const data = inputs();
  delete data.runs.evidenceKind;
  assert.equal(scoreSuite(data).validation.ok, false);
});

function scanArtifacts(t) {
  const directory = temp(t);
  const artifactDir = path.join(directory, '.bug-hunter');
  fs.mkdirSync(artifactDir);
  const finding = clone(inputs().runs.runs[0].findings[0]);
  delete finding.emittedAtMs;
  const verdict = { bugId: finding.bugId, verdict: 'REAL_BUG', trueSeverity: 'Medium', confidenceScore: 87,
    confidenceLabel: 'high', verificationMode: 'EVIDENCE_BASED', analysisSummary: 'Reached by an authenticated member.' };
  const scan = { schemaVersion: 1, runId: 'scan-1', generatedAt: '2026-10-29T00:00:00.000Z', mode: 'scan-only', target: '.',
    filesScanned: 3, threatModelLoaded: false, dependencies: { status: 'not-applicable' },
    counts: { findings: 1, confirmed: 1, dismissed: 0, manualReview: 0, unreviewed: 0 },
    confirmed: [{ id: finding.bugId, finding, verdict }], dismissed: [], manualReview: [], unreviewed: [] };
  write(path.join(artifactDir, 'findings.json'), [finding]);
  write(path.join(artifactDir, 'referee.json'), [verdict]);
  write(path.join(artifactDir, 'scan-report.json'), scan);
  return { directory, artifactDir, scan };
}

test('record imports canonical artifacts, Referee severity/confidence, measured usage, and source digests', (t) => {
  const fixture = scanArtifacts(t);
  write(path.join(fixture.artifactDir, 'telemetry.json'), { usage: { input_tokens: 120, output_tokens: 30,
    cache_read_input_tokens: 40, cache_creation_input_tokens: 10 }, total_cost_usd: 0.01, duration_ms: 2000,
    model: 'recording-test', agent: 'test', skillGitSha: '3be6973' });
  const recording = recordRun({ runDir: fixture.directory, caseId: 'auth-boundary-js' });
  assert.equal(recording.evidenceKind, 'replayed');
  const run = recording.runs[0];
  assert.equal(run.findings[0].severity, 'Medium');
  assert.equal(run.findings[0].confidenceScore, 87);
  assert.equal(run.inputTokens, 170);
  assert.equal(run.outputTokens, 30);
  assert.equal(run.costUsd, 0.01);
  assert.equal(run.durationMs, 2000);
  assert.equal(recording.scores[0].truePositives, 1);
  assert.equal(run.artifactSha256['scan-report.json'], digest(path.join(fixture.artifactDir, 'scan-report.json')));
  assert.deepEqual(recording.provenance.caseHashes['auth-boundary-js'], inputs().manifest.cases[0].sha256);
});

test('record preserves unknown telemetry and rejects artifact inconsistencies', (t) => {
  const fixture = scanArtifacts(t);
  const recording = recordRun({ runDir: fixture.artifactDir, caseId: 'auth-boundary-js' });
  assert.equal(recording.runs[0].inputTokens, null);
  assert.equal(recording.runs[0].durationMs, null);
  assert.equal(recording.runs[0].costUsd, null);
  assert.deepEqual(recordRun({ runDir: fixture.artifactDir, caseId: 'auth-boundary-js' }), recording);
  fixture.scan.confirmed[0].verdict.trueSeverity = 'Critical';
  write(path.join(fixture.artifactDir, 'scan-report.json'), fixture.scan);
  assert.throws(() => recordRun({ runDir: fixture.directory, caseId: 'auth-boundary-js' }), /verdict mismatch/);
});

test('record CLI appends distinct repeats, rejects duplicates, and never invokes an agent', (t) => {
  const fixture = scanArtifacts(t);
  const output = path.join(fixture.directory, 'runs.json');
  const args = [path.join(root, 'scripts/benchmark-suite.cjs'), 'record', '--run-dir', fixture.directory,
    '--case', 'auth-boundary-js', '--output', output, '--evidence-kind', 'synthetic'];
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [...args, '--repeat', '2'], { encoding: 'utf8' }).status, 0);
  assert.equal(read(output).runs.length, 2);
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
  assert.equal(read(output).runs.length, 2);
});

test('record rejects malformed telemetry and scan findings not in the selected case', (t) => {
  const fixture = scanArtifacts(t);
  const telemetry = path.join(fixture.artifactDir, 'telemetry.json');
  write(telemetry, { inputTokens: '120' });
  assert.throws(() => recordRun({ runDir: fixture.directory, caseId: 'auth-boundary-js' }), /invalid telemetry/);
  fs.unlinkSync(telemetry);
  const findings = read(path.join(fixture.artifactDir, 'findings.json'));
  findings[0].file = 'different/src/routes.js';
  fixture.scan.confirmed[0].finding = findings[0];
  write(path.join(fixture.artifactDir, 'findings.json'), findings);
  write(path.join(fixture.artifactDir, 'scan-report.json'), fixture.scan);
  assert.throws(() => recordRun({ runDir: fixture.directory, caseId: 'auth-boundary-js' }), /outside case/);
});

test('compare reports per-label lost High hits, new hits, and new or removed false positives', () => {
  const data = inputs();
  const baseline = scoreSuite(data);
  data.runs.runs[0].findings = [];
  const candidate = scoreSuite(data);
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.lost, ['AUTH-001']);
  assert.equal(comparison.failed.includes('lost:AUTH-001'), true);
  const improved = compareReports(candidate, baseline);
  assert.equal(improved.ok, true);
  assert.deepEqual(improved.newlyFound, ['AUTH-001']);
  const noisy = inputs();
  noisy.runs.runs[0].findings.push(noisyFinding(noisy.runs.runs[0].findings[0]));
  const noisyReport = scoreSuite(noisy);
  const noiseDelta = compareReports(baseline, noisyReport);
  assert.equal(noiseDelta.newFalsePositives.length, 1);
  assert.equal(noiseDelta.failed.includes('regressed:precision'), true);
  assert.equal(compareReports(noisyReport, baseline).removedFalsePositives.length, 1);
  noisy.runs.runs[0].findings.at(-1).claim = 'A differently worded connection claim.';
  assert.equal(compareReports(noisyReport, scoreSuite(noisy)).newFalsePositives.length, 0);
});

test('compare has deterministic paired bootstrap intervals and catches efficiency regressions', () => {
  const data = inputs();
  const baseline = scoreSuite(data);
  data.runs.runs.forEach((run) => { run.inputTokens *= 1.25; run.outputTokens *= 1.25; run.durationMs *= 1.25; });
  const candidate = scoreSuite(data);
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.ok, false);
  assert.equal(comparison.failed.includes('regressed:tokensPerTruePositive'), true);
  assert.equal(comparison.failed.includes('regressed:p95DurationMs'), true);
  assert.deepEqual(compareReports(baseline, candidate), comparison);
  assert.equal(comparison.confidenceIntervals.method, 'paired-case-bootstrap');
  assert.equal(comparison.confidenceIntervals.caseCount, 5);
  for (const metric of ['precision', 'recall']) {
    assert.equal(comparison.confidenceIntervals[metric].baseline.estimate, 1);
    assert.equal(comparison.confidenceIntervals[metric].delta.estimate, 0);
    assert.equal(comparison.confidenceIntervals[metric].delta.lower, 0);
  }
  candidate.runs.pop();
  assert.throws(() => compareReports(baseline, candidate), /paired cases/);
});

test('recorded CI runs score identically on replay and golden runs remain synthetic scorer tests', () => {
  const data = inputs();
  data.runs = read(path.join(benchmarkRoot, 'recorded/runs.json'));
  const first = scoreSuite(data);
  const second = scoreSuite(data);
  assert.equal(first.ok, true);
  assert.deepEqual(first.aggregate, second.aggregate);
  assert.equal(first.aggregate.recall < 1, true);
  assert.equal(first.evidenceKind, 'synthetic');
  assert.equal(inputs().runs.evidenceKind, 'synthetic');
});
