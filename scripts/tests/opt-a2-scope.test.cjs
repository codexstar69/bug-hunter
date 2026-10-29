const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const test = require('node:test');
const { makeSandbox, readJson, resolveSkillScript, runJson, runRaw, writeJson } = require('./test-utils.cjs');
const { buildAdaptivePolicy } = require('../adaptive-policy.cjs');
const { buildRetrievalPlan } = require('../retrieval-planner.cjs');
const { normalizeRunFiles } = require('../state-store.cjs');
const { runJsonScript } = require('../process-runner.cjs');
const { validateArtifactValue } = require('../schema-runtime.cjs');

function source(root, relative, content = 'export const value = true;\n') {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function triageInternals(mockFs = fs) {
  const filename = resolveSkillScript('triage.cjs');
  const code = fs.readFileSync(filename, 'utf8');
  const localRequire = createRequire(filename);
  const context = { module: { exports: {} }, require: (name) => {
    if (name === 'fs') return mockFs;
    if (name === './source-config.cjs' && mockFs !== fs) return { ...localRequire(name), isSupportedSourceFile: () => true };
    return localRequire(name);
  }, process, Buffer, console };
  vm.runInNewContext(`${code.slice(0, code.lastIndexOf('\ntry {'))}\nmodule.exports = { walkDir, computeFileBudget, scan };`, context, { filename });
  return context.module.exports;
}

test('a2 index handles prototype-named functions and keeps graph queries and lean metadata', () => {
  const root = makeSandbox('a2-symbols-');
  const definitions = source(root, 'definitions.js', 'function toString() {}\nfunction constructor() {}\nfunction __proto__() {}\n');
  const caller = source(root, 'caller.js', "require('./definitions'); toString(); constructor(); __proto__();\n");
  const files = path.join(root, 'files.json');
  const indexPath = path.join(root, 'index.json');
  writeJson(files, [definitions, caller]);
  runJson(process.execPath, [resolveSkillScript('code-index.cjs'), 'build', indexPath, files, root]);
  const index = readJson(indexPath);
  assert.deepEqual(index.files[definitions].symbols, ['__proto__', 'constructor', 'toString']);
  assert.ok(index.metrics.callEdges > 0);
  for (const key of ['callGraph', 'symbolDefinitions']) assert.equal(Object.hasOwn(index, key), false);
  for (const key of ['importsRaw', 'calls']) assert.equal(Object.hasOwn(index.files[caller], key), false);
  assert.equal(index.files[caller].bytes, fs.statSync(caller).size);
  assert.equal(fs.readFileSync(indexPath, 'utf8').trim().split('\n').length, 1);
  const deps = runJson(process.execPath, [resolveSkillScript('code-index.cjs'), 'deps', indexPath, caller]);
  assert.deepEqual(deps.dependencies, [definitions]);
  writeJson(files, [caller]);
  assert.deepEqual(new Set(runJson(process.execPath, [resolveSkillScript('code-index.cjs'), 'query', indexPath, files]).selected), new Set([caller, definitions]));
});

test('a2 retrieval resolves repoRoot and ignores inherited path metadata', () => {
  const root = makeSandbox('a2-retrieval-');
  const file = source(root, 'main.js', 'function constructor() {}');
  const index = { repoRoot: root, files: { 'main.js': { symbols: ['constructor'], dependencies: ['constructor'], bytes: 80 } } };
  index.files['main.js'].riskHint = 'constructor';
  const plan = buildRetrievalPlan({ index, hypotheses: [{ file: 'main.js', symbols: ['constructor'] }] });
  assert.equal(plan.selected[0].file, file);
  assert.equal(plan.selected[0].estimatedTokens, 20);
  assert.equal(plan.selected[0].score, 100);
  assert.equal(plan.selected[0].symbols[0].name, 'constructor');
  const inherited = Object.create({ [file]: { bytes: 999999, dependencies: [] } });
  const inheritedPlan = buildRetrievalPlan({ index: { repoRoot: root, files: inherited }, hypotheses: [{ file }] });
  assert.notEqual(inheritedPlan.selected[0].estimatedTokens, 250000);
});

test('a2 risk uses path identifiers and module imports before directory demotion', () => {
  const root = makeSandbox('a2-risk-');
  const fixtures = {
    'src/capital.js': 'const author = true;',
    'src/feedback.js': 'const feedback = true;',
    'src/rapid-render.js': 'const rapid = true;',
    'src/lexer.js': 'const tokens = [];',
    'scripts/authHandler.js': 'const author = true;',
    'src/entry.js': "const jwt = require('jsonwebtoken');",
    'src/persistence.js': "const pg = require('pg');",
    'z-auth.js': 'export function authenticate() {}'
  };
  const files = Object.entries(fixtures).map(([name, content]) => source(root, name, content));
  const filesPath = path.join(root, 'files.json');
  const indexPath = path.join(root, 'index.json');
  writeJson(filesPath, files);
  runJson(process.execPath, [resolveSkillScript('code-index.cjs'), 'build', indexPath, filesPath, root]);
  const index = readJson(indexPath);
  for (const name of ['capital', 'feedback', 'rapid-render', 'lexer']) {
    const meta = index.files[path.join(root, `src/${name}.js`)];
    assert.equal(meta.riskHint, 'medium', name);
    assert.deepEqual(meta.trustBoundaries, [], name);
  }
  assert.equal(index.files[path.join(root, 'z-auth.js')].riskHint, 'critical');
  assert.deepEqual(index.files[path.join(root, 'src/entry.js')].trustBoundaries, ['auth']);
  assert.deepEqual(index.files[path.join(root, 'src/persistence.js')].trustBoundaries, ['data-store']);
  const triage = runJson(process.execPath, [resolveSkillScript('triage.cjs'), 'scan', root]);
  assert.ok(triage.riskMap.critical.includes('scripts/authHandler.js'));
});

test('a2 triage preserves file manifests across 200 files and excludes mixed-domain tests', () => {
  const root = makeSandbox('a2-manifest-');
  for (let i = 0; i < 200; i += 1) source(root, `src/plain-${i}.js`);
  const before = runJson(process.execPath, [resolveSkillScript('triage.cjs'), 'scan', root]);
  assert.equal(before.totalFiles, 200);
  assert.equal(before.scanOrder.length, 200);
  source(root, 'scripts/auth.js');
  const after = runJson(process.execPath, [resolveSkillScript('triage.cjs'), 'scan', root]);
  assert.equal(after.totalFiles, 201);
  assert.equal(after.scanOrder.length, 201);
  assert.equal(after.scanOrder[0], 'scripts/auth.js');
  assert.ok(after.scanOrder.every((file) => fs.statSync(path.join(root, file)).isFile()));
  assert.equal(normalizeRunFiles(after.scanOrder.map((file) => path.join(root, file)), root).length, 201);
  assert.ok(after.domainSummaries.length > 0);
  source(root, 'src/main.test.js');
  const mixed = runJson(process.execPath, [resolveSkillScript('triage.cjs'), 'scan', root]);
  assert.deepEqual(mixed.scanOrder, after.scanOrder);
  assert.equal(mixed.domainFileLists.src.includes('src/main.test.js'), false);
});

test('a2 triage plans scannable token chunks and ignores generated output', () => {
  const root = makeSandbox('a2-generated-');
  for (let i = 0; i < 10; i += 1) source(root, `src/plain-${i}.js`);
  for (let i = 0; i < 40; i += 1) source(root, `src/plain-${i}.test.js`, 'x'.repeat(10000));
  for (const [name, header] of [
    ['scripts/generated-schema-validators.cjs', '// Generated by generator. Do not edit.\n'],
    ['src/client.js', '/* @generated */\n'],
    ['src/output.py', '# Code generated by generator. DO NOT EDIT.\n'],
    ['src/bundle.min.js', ''],
    ['pnpm-lock.yaml', '']
  ]) source(root, name, header + 'x'.repeat(200000));
  const triage = runJson(process.execPath, [resolveSkillScript('triage.cjs'), 'scan', root]);
  assert.equal(triage.scannableFiles, 10);
  assert.equal(triage.strategy, 'small');
  assert.equal(triage.needsLoop, false);
  assert.equal(triage.plannedChunkCount, 1);
  assert.equal(triage.estimatedSourceTokens, 70);
});

test('a2 triage walk is iterative and reports read and depth coverage limits', () => {
  const count = 130000;
  const entry = (name, directory = false) => ({ name, isDirectory: () => directory, isFile: () => !directory });
  const entries = Array.from({ length: count }, (_, i) => entry(`file-${i}.js`));
  const mockFs = Object.create(fs);
  mockFs.readdirSync = (dir) => dir === '/mock' ? [entry('src', true)] : entries;
  const { walkDir } = triageInternals(mockFs);
  assert.equal(walkDir('/mock', 20, 0).length, count);
  const limitations = [];
  walkDir('/mock', 0, 0, limitations);
  assert.equal(limitations[0].reason, 'max-depth');
  mockFs.readdirSync = () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; };
  const denied = [];
  triageInternals(mockFs).walkDir('/mock', 20, 0, denied);
  assert.equal(denied[0].reason, 'directory-read-failed');
  assert.equal(denied[0].code, 'EACCES');
});

test('a2 triage chunk strategy is independent of directory enumeration order', () => {
  const root = makeSandbox('a2-order-');
  for (let i = 0; i < 23; i += 1) source(root, `plain-${i}.js`, 'x'.repeat(i === 0 ? 150000 : 4000));
  const scan = triageInternals().scan;
  const forward = scan(root, {});
  const mockFs = Object.create(fs);
  mockFs.readdirSync = (...args) => fs.readdirSync(...args).reverse();
  const reverse = triageInternals(mockFs).scan(root, {});
  assert.equal(forward.strategy, reverse.strategy);
  assert.equal(forward.fileBudget, reverse.fileBudget);
  assert.equal(forward.plannedChunkCount, reverse.plannedChunkCount);
});

test('a2 actual triage feeds domain risk and avgTokensPerFile into adaptive policy', () => {
  const root = makeSandbox('a2-policy-');
  for (let i = 0; i < 201; i += 1) source(root, `auth/entry-${i}.js`, 'x'.repeat(52000));
  const triage = runJson(process.execPath, [resolveSkillScript('triage.cjs'), 'scan', root], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(triage.riskMap, undefined);
  const plan = buildAdaptivePolicy({ triage });
  assert.notEqual(plan.profile, 'fast');
  assert.equal(plan.inputs.triage.critical, 201);
  assert.equal(plan.inputs.triage.averageTokens, 13000);
  assert.ok(plan.budgetPolicy.maxSourceTokens < 48000);
  assert.ok(plan.reasons.includes('bounded context for unusually large source files'));
  assert.equal(buildAdaptivePolicy({ triage: { avgTokens: 14000 } }).inputs.triage.averageTokens, 14000);
});

test('a2 assurance preserves all Referee coverage for critical and security runs', () => {
  for (const securityReview of [false, true]) {
    const plan = buildAdaptivePolicy({ triage: { riskMap: { critical: ['auth.js'] } }, requestedProfile: 'assurance', securityReview });
    assert.equal(plan.reviewerPolicy.refereeMode, 'all');
    assert.equal(validateArtifactValue({ artifactName: 'adaptive-plan', value: plan }).ok, true);
    plan.reviewerPolicy.refereeMode = 'unknown-mode';
    assert.equal(validateArtifactValue({ artifactName: 'adaptive-plan', value: plan }).ok, false);
  }
});

test('a2 delta select bounds overlay output and expansion retains dependency neighbors', () => {
  const root = makeSandbox('a2-delta-');
  const seed = path.join(root, 'seed.js');
  const neighbors = Array.from({ length: 4 }, (_, i) => path.join(root, `neighbor-${i}.js`));
  const files = Object.fromEntries(Array.from({ length: 15000 }, (_, i) => [path.join(root, `auth/${String(i).padStart(5, '0')}-${'x'.repeat(100)}.js`), { riskHint: 'critical' }]));
  files[seed] = { dependencies: neighbors };
  for (const neighbor of neighbors) files[neighbor] = {};
  const indexPath = path.join(root, 'index.json');
  const seedsPath = path.join(root, 'seeds.json');
  const selectedPath = path.join(root, 'selected.json');
  writeJson(indexPath, { files, reverseDependencies: {} });
  writeJson(seedsPath, [seed]);
  writeJson(selectedPath, [seed]);
  const result = runRaw(process.execPath, [resolveSkillScript('delta-mode.cjs'), 'select', indexPath, seedsPath, '0'], { maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, String(result.error || result.stderr));
  assert.ok(Buffer.byteLength(result.stdout) < 10000);
  assert.equal(JSON.parse(result.stdout).expansionCandidatesCount, 15000);
  assert.equal(runJsonScript(resolveSkillScript('delta-mode.cjs'), ['select', indexPath, seedsPath, '0']).expansionCandidatesCount, 15000);
  const expansion = runJson(process.execPath, [resolveSkillScript('delta-mode.cjs'), 'expand', indexPath, seedsPath, selectedPath, '1'], { maxBuffer: 16 * 1024 * 1024 });
  assert.notEqual(expansion.prioritized[0], neighbors[0]);
  for (const neighbor of neighbors) assert.ok(expansion.prioritized.slice(0, 16).includes(neighbor));
});
