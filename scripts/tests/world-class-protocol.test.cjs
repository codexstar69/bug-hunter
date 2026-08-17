const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  matchFindings,
  scoreSuite,
  validatePublicManifest
} = require('../benchmark-suite.cjs');
const { buildAdaptivePolicy } = require('../adaptive-policy.cjs');
const { detectPlan, redactOutput, runPlan, validatePlan } = require('../hybrid-verifier.cjs');
const { getEntry, hashDescriptor, pruneCache, putEntry } = require('../evidence-cache.cjs');
const { buildRetrievalPlan } = require('../retrieval-planner.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const benchmarkRoot = path.join(projectRoot, 'evals', 'benchmark');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('public benchmark manifest contains no private labels and is hash-bound', () => {
  const manifestPath = path.join(benchmarkRoot, 'public-manifest.json');
  const manifest = readJson(manifestPath);
  const labels = readJson(path.join(benchmarkRoot, 'private-labels.json'));
  const validation = validatePublicManifest(manifest);
  assert.deepEqual(validation, { ok: true, errors: [] });
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
  assert.equal(labels.publicManifestSha256, actualHash);
  assert.equal(JSON.stringify(manifest).includes('keywordGroups'), false);
  assert.equal(JSON.stringify(manifest).includes('labelId'), false);
});

test('golden benchmark reports precision, recall, cost, calibration, and repeat stability', () => {
  const manifestPath = path.join(benchmarkRoot, 'public-manifest.json');
  const report = scoreSuite({
    manifest: readJson(manifestPath),
    labels: readJson(path.join(benchmarkRoot, 'private-labels.json')),
    runs: readJson(path.join(benchmarkRoot, 'golden-runs.json')),
    manifestPath
  });
  assert.equal(report.ok, true);
  assert.equal(report.aggregate.precision, 1);
  assert.equal(report.aggregate.recall, 1);
  assert.equal(report.aggregate.repeatStability.meanJaccard, 1);
  assert.equal(report.aggregate.falsePositivesPerKloc, 0);
  assert.equal(report.aggregate.medianTokensPerTruePositive > 0, true);
  assert.equal(report.aggregate.expectedCalibrationError < 0.1, true);
  assert.deepEqual(report.gate.failed, []);
});

test('benchmark gate fails a noisy run and matching is one-to-one', () => {
  const manifestPath = path.join(benchmarkRoot, 'public-manifest.json');
  const runs = readJson(path.join(benchmarkRoot, 'golden-runs.json'));
  runs.runs[0].findings.push({
    bugId: 'NOISE-1',
    file: 'src/routes.js',
    lines: '1',
    severity: 'Critical',
    category: 'security',
    claim: 'Generic security concern.',
    evidence: 'No reachable evidence.',
    runtimeTrigger: 'Unknown.',
    crossReferences: ['src/routes.js:1'],
    confidenceScore: 99
  });
  const report = scoreSuite({
    manifest: readJson(manifestPath),
    labels: readJson(path.join(benchmarkRoot, 'private-labels.json')),
    runs,
    manifestPath
  });
  assert.equal(report.ok, false);
  assert.equal(report.aggregate.falsePositives, 1);
  assert.equal(report.aggregate.precision < 1, true);

  const matching = matchFindings([
    runs.runs[0].findings[0],
    { ...runs.runs[0].findings[0], bugId: 'DUPLICATE' }
  ], readJson(path.join(benchmarkRoot, 'private-labels.json')).cases[0].findings);
  assert.equal(matching.matches.length, 1);
  assert.equal(matching.unmatchedFindingIndexes.length, 1);
});

test('adaptive policy escalates low recall and security scope while controlling token cost', () => {
  const plan = buildAdaptivePolicy({
    triage: {
      totalFiles: 180,
      scannableFiles: 160,
      avgTokens: 14000,
      riskMap: {
        critical: ['src/auth.ts', 'src/admin.ts'],
        high: Array.from({ length: 20 }, (_, index) => `src/api-${index}.ts`),
        medium: [],
        low: [],
        'context-only': []
      },
      domains: [{}, {}, {}]
    },
    benchmarkReport: {
      aggregate: {
        precision: 0.88,
        recall: 0.72,
        severityWeightedRecall: 0.7,
        medianTokensPerTruePositive: 70000,
        repeatStability: { meanJaccard: 0.75 },
        expectedCalibrationError: 0.18
      }
    },
    requestedProfile: 'auto',
    securityReview: true
  });
  assert.equal(plan.profile, 'assurance');
  assert.equal(plan.budgetPolicy.deltaHops >= 4, true);
  assert.equal(plan.budgetPolicy.maxSourceTokens <= 28000, true);
  assert.equal(plan.reviewerPolicy.skepticPasses >= 3, true);
  assert.equal(plan.verificationPolicy.kinds.includes('security-static'), true);
  assert.equal(plan.modelPolicy.deepReasoningForCriticalAndDisputed, true);
});

test('adaptive policy selects fast profile for a small low-risk high-precision target', () => {
  const plan = buildAdaptivePolicy({
    triage: {
      totalFiles: 6,
      scannableFiles: 6,
      avgTokens: 1000,
      riskMap: { critical: [], high: [], medium: ['src/a.js'], low: [], 'context-only': [] },
      domains: []
    },
    benchmarkReport: { aggregate: { precision: 0.98, recall: 0.95 } },
    requestedProfile: 'auto',
    securityReview: false
  });
  assert.equal(plan.profile, 'fast');
  assert.equal(plan.budgetPolicy.maxSourceTokens, 32000);
  assert.equal(plan.reviewerPolicy.independentlyVerifyCritical, true);
});

test('hybrid verifier uses argv execution, fails closed on required checks, and maps evidence', () => {
  const repo = makeTemp('bug-hunter-verifier-');
  fs.writeFileSync(path.join(repo, 'pass.cjs'), "console.log('ok');\n", 'utf8');
  fs.writeFileSync(path.join(repo, 'fail.cjs'), "console.error('bad'); process.exit(2);\n", 'utf8');
  const plan = {
    schemaVersion: 1,
    checks: [
      {
        id: 'pass',
        kind: 'test',
        command: [process.execPath, 'pass.cjs', '; touch should-not-exist'],
        cwd: '.',
        timeoutMs: 5000,
        required: true,
        findingIds: ['BUG-1'],
        confidenceOnPass: 4
      },
      {
        id: 'fail',
        kind: 'static',
        command: [process.execPath, 'fail.cjs'],
        cwd: '.',
        timeoutMs: 5000,
        required: true,
        findingIds: ['BUG-1'],
        confidenceOnFail: -20
      }
    ]
  };
  const report = runPlan({ repoRoot: repo, plan, totalBudgetMs: 10000 });
  assert.equal(report.ok, false);
  assert.equal(report.summary.requiredFailures, 1);
  assert.equal(report.checks[0].status, 'PASS');
  assert.equal(report.checks[1].status, 'FAIL');
  assert.equal(fs.existsSync(path.join(repo, 'should-not-exist')), false);
  assert.equal(report.findingEvidence[0].confidenceDelta, -16);
});

test('hybrid verifier rejects shell strings and repository escapes', () => {
  const repo = makeTemp('bug-hunter-verifier-invalid-');
  const outside = makeTemp('bug-hunter-verifier-outside-');
  let validation = validatePlan({
    repoRoot: fs.realpathSync(repo),
    plan: { schemaVersion: 1, checks: [{ id: 'shell', kind: 'test', command: 'echo unsafe', cwd: '.' }] }
  });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(' '), /argv array/);

  validation = validatePlan({
    repoRoot: fs.realpathSync(repo),
    plan: { schemaVersion: 1, checks: [{ id: 'escape', kind: 'test', command: [process.execPath, '-e', ''], cwd: outside }] }
  });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(' '), /escapes repository root/);
});

test('hybrid verifier detects package scripts without inventing unavailable checks', () => {
  const repo = makeTemp('bug-hunter-verifier-detect-');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    packageManager: 'pnpm@10.0.0',
    scripts: { test: 'node --test', build: 'node build.cjs' }
  }), 'utf8');
  const plan = detectPlan(repo);
  assert.deepEqual(plan.checks.map((entry) => entry.id), ['test', 'build']);
  assert.deepEqual(plan.checks[0].command, ['pnpm', 'run', 'test', '--if-present']);
});



test('hybrid verifier strips ambient secrets, rejects sensitive env injection, and redacts output', () => {
  const repo = makeTemp('bug-hunter-verifier-secrets-');
  const prior = process.env.BUG_HUNTER_TEST_SECRET;
  process.env.BUG_HUNTER_TEST_SECRET = 'super-sensitive-value';
  try {
    const plan = {
      schemaVersion: 1,
      checks: [{
        id: 'environment',
        kind: 'custom',
        command: [process.execPath, '-e', "console.log(process.env.BUG_HUNTER_TEST_SECRET || 'absent')"],
        cwd: '.',
        required: true
      }]
    };
    const report = runPlan({ repoRoot: repo, plan, totalBudgetMs: 5000 });
    assert.equal(report.ok, true);
    assert.match(report.checks[0].stdout, /absent/);
    assert.doesNotMatch(report.checks[0].stdout, /super-sensitive-value/);
    const invalid = validatePlan({
      repoRoot: repo,
      plan: {
        schemaVersion: 1,
        checks: [{
          id: 'secret-env',
          kind: 'custom',
          command: [process.execPath, '-e', 'void 0'],
          cwd: '.',
          env: { API_TOKEN: 'do-not-copy' }
        }]
      }
    });
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.join(' '), /sensitive/);
    assert.equal(redactOutput('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: [REDACTED]');
  } finally {
    if (prior === undefined) delete process.env.BUG_HUNTER_TEST_SECRET;
    else process.env.BUG_HUNTER_TEST_SECRET = prior;
  }
});

test('evidence cache rejects symlink shards that escape its root', () => {
  const cacheRoot = makeTemp('bug-hunter-cache-symlink-');
  const outside = makeTemp('bug-hunter-cache-outside-');
  const descriptor = { protocolVersion: '4.0.0', sourceHashes: { a: 'b' } };
  const key = hashDescriptor(descriptor);
  try {
    fs.symlinkSync(outside, path.join(cacheRoot, key.slice(0, 2)), 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
    throw error;
  }
  assert.throws(() => putEntry(cacheRoot, descriptor, { facts: [] }), /symbolic link|escaped/);
});

test('content-addressed evidence cache is deterministic, exact-match only, and capacity bounded', () => {
  const cacheRoot = makeTemp('bug-hunter-cache-');
  const descriptor = {
    protocolVersion: '4.0.0',
    analyzer: 'fact-card-v1',
    sourceHashes: { 'src/a.js': 'abc' },
    hypothesis: 'authorization boundary'
  };
  const key = hashDescriptor(descriptor);
  assert.equal(key, hashDescriptor({
    hypothesis: 'authorization boundary',
    sourceHashes: { 'src/a.js': 'abc' },
    analyzer: 'fact-card-v1',
    protocolVersion: '4.0.0'
  }));
  const put = putEntry(cacheRoot, descriptor, { facts: ['a'] }, { maxEntries: 2, maxBytes: 100000, maxAgeDays: 30 });
  assert.equal(put.key, key);
  assert.deepEqual(getEntry(cacheRoot, key).value, { facts: ['a'] });
  assert.equal(getEntry(cacheRoot, hashDescriptor({ ...descriptor, hypothesis: 'different' })).hit, false);

  putEntry(cacheRoot, { ...descriptor, hypothesis: 'b' }, { facts: ['b'] }, { maxEntries: 2, maxBytes: 100000, maxAgeDays: 30 });
  putEntry(cacheRoot, { ...descriptor, hypothesis: 'c' }, { facts: ['c'] }, { maxEntries: 2, maxBytes: 100000, maxAgeDays: 30 });
  const pruned = pruneCache(cacheRoot, { maxEntries: 2, maxBytes: 100000, maxAgeDays: 30 });
  assert.equal(pruned.remainingEntries <= 2, true);
});

test('retrieval planner keeps direct hypotheses, adds graph context, and respects budget for optional files', () => {
  const root = makeTemp('bug-hunter-retrieval-');
  const direct = path.join(root, 'src', 'route.js');
  const dependency = path.join(root, 'src', 'auth.js');
  const optional = path.join(root, 'src', 'large.js');
  fs.mkdirSync(path.dirname(direct), { recursive: true });
  fs.writeFileSync(direct, 'x'.repeat(4000), 'utf8');
  fs.writeFileSync(dependency, 'x'.repeat(4000), 'utf8');
  fs.writeFileSync(optional, 'x'.repeat(200000), 'utf8');
  const plan = buildRetrievalPlan({
    index: {
      files: {
        [direct]: {
          relativePath: 'src/route.js',
          riskHint: 'critical',
          dependencies: [dependency, optional],
          trustBoundaries: ['external-input'],
          symbols: [
            { name: 'adminRoute', kind: 'function', exported: true, lineStart: 10, lineEnd: 25 },
            { name: 'helper', kind: 'function', exported: false, lineStart: 30, lineEnd: 35 }
          ]
        },
        [dependency]: { relativePath: 'src/auth.js', riskHint: 'high', dependencies: [], symbols: [] },
        [optional]: { relativePath: 'src/large.js', riskHint: 'low', dependencies: [], symbols: [] }
      }
    },
    hypotheses: [{
      bugId: 'BUG-1',
      file: direct,
      claim: 'adminRoute misses authorization',
      crossReferences: [`${dependency}:1-10`]
    }],
    maxTokens: 3000,
    maxFiles: 3,
    dependencyHops: 1
  });
  assert.equal(plan.selected.some((entry) => entry.file === direct && entry.mandatory), true);
  assert.equal(plan.selected.some((entry) => entry.file === dependency), true);
  assert.equal(plan.omitted.some((entry) => entry.file === optional && entry.reason === 'token-budget'), true);
  assert.equal(plan.selected.find((entry) => entry.file === direct).symbols[0].name, 'adminRoute');
});

test('world-class canonical schemas are valid JSON and declare strict artifacts', () => {
  for (const fileName of [
    'benchmark-report.schema.json',
    'adaptive-plan.schema.json',
    'verification-report.schema.json',
    'retrieval-plan.schema.json'
  ]) {
    const schema = readJson(path.join(projectRoot, 'schemas', fileName));
    assert.equal(schema.schemaVersion, 1);
    assert.equal(typeof schema.artifact, 'string');
    assert.equal(schema.additionalProperties, false);
  }
});

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function initGitRepo(repoRoot) {
  const childProcess = require('node:child_process');
  const run = (args) => {
    const result = childProcess.spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(String(result.stderr || result.stdout || `git ${args.join(' ')} failed`));
    }
  };
  run(['init']);
  run(['config', 'user.email', 'world-class-test@example.invalid']);
  run(['config', 'user.name', 'World Class Test']);
  run(['add', '--', '.']);
  run(['commit', '-m', 'fixture']);
}

function runRunner(repoRoot, args) {
  const result = require('node:child_process').spawnSync(
    process.execPath,
    [path.join(projectRoot, 'scripts', 'run-bug-hunter.cjs'), ...args],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  const stdout = String(result.stdout || '').trim();
  return {
    result,
    value: stdout ? JSON.parse(stdout) : null
  };
}

test('schema runtime exposes validators for all world-class artifacts', () => {
  const { validateArtifactValue } = require('../schema-runtime.cjs');
  const manifestPath = path.join(benchmarkRoot, 'public-manifest.json');
  const benchmark = scoreSuite({
    manifest: readJson(manifestPath),
    labels: readJson(path.join(benchmarkRoot, 'private-labels.json')),
    runs: readJson(path.join(benchmarkRoot, 'golden-runs.json')),
    manifestPath
  });
  const adaptive = buildAdaptivePolicy({
    triage: readJson(path.join(benchmarkRoot, 'triage-sample.json')),
    benchmarkReport: benchmark,
    requestedProfile: 'balanced',
    securityReview: false
  });
  const verification = runPlan({
    repoRoot: projectRoot,
    plan: readJson(path.join(benchmarkRoot, 'verification-plan.json')),
    totalBudgetMs: 10000
  });
  const retrieval = buildRetrievalPlan({
    index: readJson(path.join(benchmarkRoot, 'index-sample.json')),
    hypotheses: readJson(path.join(benchmarkRoot, 'hypotheses-sample.json')),
    maxTokens: 12000,
    maxFiles: 5,
    dependencyHops: 1
  });
  for (const [artifactName, value] of [
    ['benchmark-report', benchmark],
    ['adaptive-plan', adaptive],
    ['verification-report', verification],
    ['retrieval-plan', retrieval]
  ]) {
    const validation = validateArtifactValue({ artifactName, value });
    assert.equal(validation.ok, true, `${artifactName}: ${validation.errors.join('; ')}`);
  }
});

test('runner integrates adaptive policy, retrieval, verification, and exact evidence-cache reuse', () => {
  const repo = makeTemp('bug-hunter-world-class-runner-');
  const source = path.join(repo, 'src', 'service.js');
  const filesPath = path.join(repo, 'files.json');
  const triagePath = path.join(repo, 'triage.json');
  const hypothesesPath = path.join(repo, 'hypotheses.json');
  const verificationPlanPath = path.join(repo, 'verification-plan.json');
  const workerPath = path.join(repo, 'worker.cjs');
  const workerLogPath = path.join(repo, 'worker-log.jsonl');
  const cachePath = path.join(repo, '.bug-hunter', 'shared-evidence-cache');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'export function service(value) { return value; }\n', 'utf8');
  fs.writeFileSync(filesPath, `${JSON.stringify([source])}\n`, 'utf8');
  fs.writeFileSync(triagePath, `${JSON.stringify({
    totalFiles: 1,
    scannableFiles: 1,
    avgTokens: 20,
    riskMap: { critical: [], high: [], medium: ['src/service.js'], low: [], 'context-only': [] },
    domains: []
  })}\n`, 'utf8');
  fs.writeFileSync(hypothesesPath, `${JSON.stringify([{
    id: 'HYP-1',
    file: source,
    claim: 'Check the service boundary.',
    symbols: ['service']
  }])}\n`, 'utf8');
  fs.writeFileSync(verificationPlanPath, `${JSON.stringify({
    schemaVersion: 1,
    checks: [{
      id: 'runtime',
      kind: 'test',
      command: [process.execPath, '-e', 'process.exit(0)'],
      cwd: '.',
      timeoutMs: 5000,
      required: true,
      findingIds: []
    }]
  })}\n`, 'utf8');
  fs.writeFileSync(workerPath, [
    "const fs = require('fs');",
    "const args = process.argv;",
    "const get = (name) => args[args.indexOf(name) + 1];",
    "const findings = get('--findings');",
    "const facts = get('--facts');",
    "const cached = get('--cached');",
    "const adaptive = get('--adaptive');",
    "const retrieval = get('--retrieval');",
    "const log = get('--log');",
    "if (!fs.existsSync(adaptive) || !fs.existsSync(retrieval) || !fs.existsSync(cached)) process.exit(3);",
    "const cachedValue = JSON.parse(fs.readFileSync(cached, 'utf8'));",
    "fs.appendFileSync(log, JSON.stringify({ cached: Object.keys(cachedValue).length > 0 }) + '\\n');",
    "fs.writeFileSync(findings, '[]');",
    "fs.writeFileSync(facts, JSON.stringify({ apiContracts: ['service(value)'], authAssumptions: [], invariants: ['returns input'] }));"
  ].join('\n'), 'utf8');
  initGitRepo(repo);

  const common = [
    'run',
    '--skill-dir', projectRoot,
    '--files-json', filesPath,
    '--triage-path', triagePath,
    '--hypotheses-json', hypothesesPath,
    '--adaptive-profile', 'auto',
    '--use-index', 'true',
    '--verification-plan', verificationPlanPath,
    '--verification-required', 'true',
    '--evidence-cache-dir', cachePath,
    '--max-retries', '0',
    '--backoff-ms', '0',
    '--worker-cmd', [
      process.execPath,
      shellQuote(workerPath),
      '--findings', '{findingsJson}',
      '--facts', '{factsJson}',
      '--cached', '{cachedFactsJson}',
      '--adaptive', '{adaptivePlanJson}',
      '--retrieval', '{retrievalPlanJson}',
      '--log', shellQuote(workerLogPath)
    ].join(' ')
  ];

  const first = runRunner(repo, [
    ...common,
    '--run-id', 'world-class-1',
    '--state', path.join(repo, '.bug-hunter', 'run-1', 'state.json')
  ]);
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(first.value.ok, true);
  assert.equal(first.value.verification.requiredFailures, 0);
  assert.equal(fs.existsSync(first.value.adaptivePlanPath), true);
  assert.equal(fs.existsSync(first.value.retrievalPlanPath), true);
  assert.equal(fs.existsSync(first.value.verificationReportPath), true);

  const profileMismatch = runRunner(repo, [
    ...common,
    '--resume', 'world-class-1',
    '--state', path.join(repo, '.bug-hunter', 'run-1', 'state.json'),
    '--adaptive-profile', 'assurance'
  ]);
  assert.notEqual(profileMismatch.result.status, 0);
  assert.match(String(profileMismatch.result.stderr || ''), /Resume fingerprint mismatch/);

  const secondState = path.join(repo, '.bug-hunter', 'run-2', 'state.json');
  const second = runRunner(repo, [
    ...common,
    '--run-id', 'world-class-2',
    '--state', secondState
  ]);
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(second.value.ok, true);
  const journal = fs.readFileSync(path.join(path.dirname(secondState), 'run.log'), 'utf8');
  assert.match(journal, /evidence-cache-hit/);
  const workerLog = fs.readFileSync(workerLogPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(workerLog.map((entry) => entry.cached), [false, true]);
});

test('runner fails closed when required hybrid verification fails', () => {
  const repo = makeTemp('bug-hunter-world-class-verification-fail-');
  const source = path.join(repo, 'source.js');
  const filesPath = path.join(repo, 'files.json');
  const workerPath = path.join(repo, 'worker.cjs');
  const verificationPlanPath = path.join(repo, 'verification-plan.json');
  fs.writeFileSync(source, 'export const value = 1;\n', 'utf8');
  fs.writeFileSync(filesPath, `${JSON.stringify([source])}\n`, 'utf8');
  fs.writeFileSync(workerPath, [
    "const fs = require('fs');",
    "const args = process.argv;",
    "fs.writeFileSync(args[args.indexOf('--findings') + 1], '[]');"
  ].join('\n'), 'utf8');
  fs.writeFileSync(verificationPlanPath, `${JSON.stringify({
    schemaVersion: 1,
    checks: [{
      id: 'required-failure',
      kind: 'test',
      command: [process.execPath, '-e', 'process.exit(7)'],
      cwd: '.',
      timeoutMs: 5000,
      required: true,
      findingIds: []
    }]
  })}\n`, 'utf8');
  initGitRepo(repo);

  const statePath = path.join(repo, '.bug-hunter', 'state.json');
  const run = runRunner(repo, [
    'run',
    '--skill-dir', projectRoot,
    '--files-json', filesPath,
    '--state', statePath,
    '--run-id', 'required-verification-failure',
    '--worker-cmd', `${process.execPath} ${shellQuote(workerPath)} --findings {findingsJson}`,
    '--verification-plan', verificationPlanPath,
    '--verification-required', 'true',
    '--evidence-cache', 'false',
    '--max-retries', '0',
    '--backoff-ms', '0'
  ]);
  assert.notEqual(run.result.status, 0);
  assert.equal(run.value.ok, false);
  assert.equal(run.value.verification.requiredFailures, 1);
  assert.equal(run.value.fixPlanPath, null);
  assert.equal(fs.existsSync(run.value.verificationReportPath), true);
});
