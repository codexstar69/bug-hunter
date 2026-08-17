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
  const lineCount = skill.split('\n').length;

  assert.equal(lineCount <= 500, true, `SKILL.md has ${lineCount} lines; keep the control plane <= 500`);
  assert.match(skill, /No flags means \*\*scan-only \+ single-pass\*\*/);
  assert.match(skill, /LOOP_MODE=false/);
  assert.match(skill, /--loop.*LOOP_MODE=true/);
  assert.doesNotMatch(skill, /LOOP_MODE=true\s*\(default\)/i);
  assert.doesNotMatch(skill, /remove `?--no-loop`? to enable/i);
  assert.match(skill, /Calibration examples are \*\*progressive\*\*/);
  assert.doesNotMatch(skill, /skills\/hunter\/SKILL\.md` \+ `skills\/hunter\/examples\.md/);
  assert.doesNotMatch(skill, /skills\/skeptic\/SKILL\.md` \+ `skills\/skeptic\/examples\.md/);
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
