const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('canonical SKILL stays compact, single-pass by default, and progressively loaded', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /No flags means \*\*scan-only \+ single-pass\*\*/);
  assert.match(skill, /LOOP_MODE=false/);
  assert.match(skill, /--loop.*LOOP_MODE=true/);
  assert.doesNotMatch(skill, /LOOP_MODE=true\s*\(default\)/i);
  assert.doesNotMatch(skill, /remove `?--no-loop`? to enable/i);
  assert.match(skill, /Calibration examples are \*\*progressive\*\*/);
  assert.doesNotMatch(skill, /skills\/hunter\/SKILL\.md` \+ `skills\/hunter\/examples\.md/);
  assert.doesNotMatch(skill, /skills\/skeptic\/SKILL\.md` \+ `skills\/skeptic\/examples\.md/);
});

// Normal orchestrator reads, once per file. Renderer-only role/wrapper reads,
// optional calibration, and opt-in protocols are not silently charged to every
// delegated mode. Local execution loads its four roles progressively.
const delegated = (mode) => ['SKILL.md', `modes/${mode}.md`, 'modes/dispatch.md'];
const modeLoads = {
  core: { files: ['SKILL.md'], budget: 18200 },
  'single-file': { files: delegated('single-file'), budget: 24500 },
  small: { files: delegated('small'), budget: 26400 },
  parallel: { files: delegated('parallel'), budget: 27800 },
  extended: { files: delegated('extended'), budget: 27000 },
  scaled: { files: delegated('scaled'), budget: 27400 },
  'large-codebase': { files: delegated('large-codebase'), budget: 29900 },
  'local-sequential': {
    files: ['SKILL.md', 'modes/local-sequential.md', ...['recon', 'hunter', 'skeptic', 'referee']
      .map((role) => `skills/${role}/SKILL.md`)],
    budget: 47200
  },
  'small+loop': { files: [...delegated('small'), 'modes/loop.md'], budget: 31100 },
  'small+generic-loop': {
    files: [...delegated('small'), 'modes/loop-generic.md', 'modes/loop.md'], budget: 31300
  },
  'small+fix': { files: [...delegated('small'), 'modes/fix-pipeline.md'], budget: 44500 },
  'small+fix-loop': {
    files: [...delegated('small'), 'modes/fix-loop.md', 'modes/loop.md', 'modes/fix-pipeline.md'],
    budget: 50300
  }
};

function modeBytes(files, extraBytes = {}) {
  return [...new Set(files)].map((file) => ({
    file, bytes: Buffer.byteLength(read(file)) + (extraBytes[file] || 0)
  }));
}

test('per-mode instruction byte budgets bound the actual progressively loaded files', () => {
  for (const [mode, { files, budget }] of Object.entries(modeLoads)) {
    const breakdown = modeBytes(files);
    const total = breakdown.reduce((sum, entry) => sum + entry.bytes, 0);
    assert.ok(total <= budget, `${mode}: ${total} bytes > ${budget} bytes\n` +
      breakdown.map((entry) => `${entry.file}: ${entry.bytes} bytes`).join('\n'));
  }
});

test('mode byte budgets reject 3000 bytes of growth in any loaded file', () => {
  for (const [mode, { files, budget }] of Object.entries(modeLoads)) {
    for (const file of files) {
      const total = modeBytes(files, { [file]: 3000 }).reduce((sum, entry) => sum + entry.bytes, 0);
      assert.ok(total > budget, `${mode}: 3000 bytes in ${file} must exceed its budget`);
    }
  }
});

test('mode references resolve stable canonical SKILL section names', () => {
  const headings = new Set([...read('SKILL.md').matchAll(/^#{1,6}\s+(?:\d+\.\s+)?(.+)$/gm)]
    .map((match) => match[1]));
  const files = ['SKILL.md', ...fs.readdirSync(path.join(projectRoot, 'modes'))
    .filter((name) => name.endsWith('.md')).map((name) => `modes/${name}`),
    'skills/doc-lookup/SKILL.md', 'skills/hunter/SKILL.md'];
  let references = 0;
  for (const file of files) {
    const content = read(file);
    assert.doesNotMatch(content, /\b[Ss]teps?\s+\d+(?:[^\n]*\bin SKILL\.md)?/,
      `${file} must use section names, including local phase references`);
    for (const match of content.matchAll(/`SKILL\.md › ([^`]+)`/g)) {
      references += 1;
      assert.ok(headings.has(match[1]), `${file}: missing SKILL.md section ${match[1]}`);
    }
    assert.doesNotMatch(content, /(?:section|step)\s+\d+[^\n]*SKILL\.md/i);
    assert.doesNotMatch(content, /\b(?:in|per) SKILL\.md\b/, 'use a named SKILL.md section');
  }
  assert.ok(references >= 15, 'section checks must cover mode routing references');
});

test('loop and dispatch guidance preserve the compact shared control-plane contract', () => {
  for (const name of fs.readdirSync(path.join(projectRoot, 'modes')).filter((file) => file.endsWith('.md'))) {
    const content = read(`modes/${name}`);
    assert.doesNotMatch(content, /node scripts\//, name);
    assert.doesNotMatch(content, /doc-lookup\/SKILL\.md/, name);
    assert.doesNotMatch(content, /--max-iterations\s+10\b|MAX_LOOP_ITERATIONS`?\s*=\s*10\b/, name);
    for (const init of content.matchAll(/node "\$SKILL_DIR\/scripts\/bug-hunter-state\.cjs" init[^\n]+/g)) {
      assert.match(init[0], /"\$SOURCE_TOKEN_BUDGET" true$/, name);
    }
  }
  const loop = read('modes/loop.md');
  assert.match(loop, /--max-iterations "\$MAX_LOOP_ITERATIONS"/);
  assert.match(loop, /max\(12, min\(200, ceil\(SCANNABLE_FILES \/ max\(FILE_BUDGET, 1\)\) \+ 8\)\)/);
  assert.match(loop, /reuse.*recon\.json.*skip Recon/);
  assert.match(read('modes/fix-loop.md'), /modes\/loop\.md/);
  assert.match(read('modes/loop-generic.md'), /modes\/loop\.md/);
  assert.ok(Buffer.byteLength(loop) < 5000);
  const local = read('modes/local-sequential.md');
  assert.doesNotMatch(local, /FILE_BUDGET=40|top 15|REAL BUG \/ NOT A BUG|EV =/);
  const large = read('modes/large-codebase.md');
  assert.match(large, /one Recon per run/);
  assert.match(large, /Zero findings:[^\n]*skip Skeptic and Referee/);
  assert.ok(large.indexOf('dedup-boundaries') < large.indexOf('Dispatch Skeptic and Referee only'));
  assert.match(large, /boundary-pairs/);
  assert.doesNotMatch(large, /--fast|Extended.mode|extended\.md/);
  assert.doesNotMatch(read('modes/scaled.md'), /Extended mode|extended\.md/);
  assert.match(read('modes/dispatch.md'), /Read <abs task path> and follow it/);
  assert.doesNotMatch(read('SKILL.md'), /evals\/evaluate-fixture|pnpm quality:world-class|## Self-test/);
});

test('canonical SKILL exposes current measurable and security routing contracts', () => {
  const skill = read('SKILL.md');

  for (const reference of [
    'docs/precision-protocol.md',
    'docs/world-class-protocol.md',
    'modes/dispatch.md',
    'modes/fix-pipeline.md',
    'skills/commit-security-scan/SKILL.md',
    'skills/security-review/SKILL.md',
    'skills/threat-model-generation/SKILL.md',
    'skills/vulnerability-validation/SKILL.md'
  ]) {
    assert.match(skill, new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const artifact of [
    'adaptive-plan.json',
    'retrieval-plan.json',
    'verification-report.json',
    'benchmark-report.json',
    'fixer-scope.json'
  ]) {
    assert.match(skill, new RegExp(artifact.replace('.', '\\.')));
  }

  assert.match(skill, /content-addressed|exact source/i);
  assert.match(skill, /Required verification failure prevents Fixer authorization/i);
  assert.match(skill, /worker may report findings only for its exact assigned source files/i);
  assert.match(skill, /parent chunk marked done cannot\s+manufacture file completion/i);
});

test('current agent-facing files do not resurrect historical runtime defaults', () => {
  const currentGuidance = [
    'SKILL.md',
    'llms.txt',
    'llms-full.txt',
    'docs/getting-started.md',
    'docs/usage-guide.md',
    'docs/how-it-works.md',
    'docs/cli-reference.md',
    'docs/troubleshooting.md'
  ].map(read).join('\n');

  assert.doesNotMatch(currentGuidance, /Loop mode is the default/i);
  assert.doesNotMatch(currentGuidance, /every \/bug-hunter invocation iterates/i);
  assert.doesNotMatch(currentGuidance, /\.bug-hunter\/findings\.json/);
  assert.doesNotMatch(currentGuidance, /3\.1\.1 publishing\s+is pending/i);
  assert.match(currentGuidance, /hunter-findings\.json/);
  assert.match(currentGuidance, /single-pass/i);
});

test('README distinguishes exact current source from a potentially lagging npm release', () => {
  const readme = read('README.md');
  const sourceCommand = 'npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent codex';
  const npmCommand = 'npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter install --agent codex';
  const sourceIndex = readme.indexOf(sourceCommand);
  const npmIndex = readme.indexOf(npmCommand);

  assert.match(readme, /exact current GitHub source documented here/i);
  assert.match(readme, /latest published npm release[\s\S]{0,100}may lag current GitHub source/i);
  assert.equal(sourceIndex >= 0, true);
  assert.equal(npmIndex > sourceIndex, true);
});
