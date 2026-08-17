const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { resolveSkillScript } = require('./test-utils.cjs');

test('package.json ships the bundled local security skills', () => {
  const packageJson = require(resolveSkillScript('..', 'package.json'));
  assert.equal(Array.isArray(packageJson.files), true);
  assert.equal(packageJson.files.includes('skills/'), true);
  assert.equal(packageJson.scripts.postinstall, undefined);
});

test('bundled local security skills exist with SKILL.md entrypoints', () => {
  const skillNames = [
    'commit-security-scan',
    'security-review',
    'threat-model-generation',
    'vulnerability-validation'
  ];

  for (const skillName of skillNames) {
    const skillPath = resolveSkillScript('..', 'skills', skillName, 'SKILL.md');
    assert.equal(fs.existsSync(skillPath), true, `${skillName} should exist`);
    const contents = fs.readFileSync(skillPath, 'utf8');
    assert.match(contents, /^---/);
    assert.match(contents, /name:/);
    assert.match(contents, /description:/);
  }
});

test('CI uses supported Node releases and installs the locked toolchain', () => {
  const workflow = fs.readFileSync(
    resolveSkillScript('..', '.github', 'workflows', 'ci.yml'),
    'utf8'
  );
  assert.match(workflow, /node-version: \[22, 24\]/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /actions\/checkout@v7/);
  assert.match(workflow, /pnpm\/action-setup@v6/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.doesNotMatch(workflow, /node-version: \[(?:18|20)/);
});

test('publish workflow is release-only, provenance-bound, and quality-gated', () => {
  const workflow = fs.readFileSync(
    resolveSkillScript('..', '.github', 'workflows', 'publish.yml'),
    'utf8'
  );
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  assert.match(workflow, /node scripts\/prepublish-guard\.cjs/);
  assert.match(workflow, /npm publish --access public/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /actions\/checkout@v7/);
  assert.match(workflow, /pnpm\/action-setup@v6/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /refs\/remotes\/origin\/main/);
  assert.match(workflow, /pnpm check:generated/);
  assert.match(workflow, /pnpm test/);
  assert.match(workflow, /pnpm benchmark:gate/);
  assert.match(workflow, /node scripts\/run-bug-hunter\.cjs preflight --skill-dir \./);
  assert.match(workflow, /pnpm verify:package/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
});
