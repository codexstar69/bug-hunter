const assert = require('node:assert/strict');
const fs = require('fs');
const test = require('node:test');

const { resolveSkillScript } = require('./test-utils.cjs');

test('main SKILL routes into bundled local security skills', () => {
  const skillDoc = fs.readFileSync(resolveSkillScript('..', 'SKILL.md'), 'utf8');

  assert.match(skillDoc, /skills\/commit-security-scan\/SKILL\.md/);
  assert.match(skillDoc, /skills\/security-review\/SKILL\.md/);
  assert.match(skillDoc, /skills\/threat-model-generation\/SKILL\.md/);
  assert.match(skillDoc, /skills\/vulnerability-validation\/SKILL\.md/);

  assert.match(skillDoc, /--pr-security/);
  assert.match(skillDoc, /--security-review/);
  assert.match(skillDoc, /--validate-security/);
});

test('README documents the integrated enterprise security pack flows', () => {
  const readme = fs.readFileSync(resolveSkillScript('..', 'README.md'), 'utf8');

  assert.match(readme, /PR-focused security review routes into `commit-security-scan`/);
  assert.match(readme, /`--threat-model` routes into `threat-model-generation`/);
  assert.match(readme, /enterprise\/full security review routes into `security-review`/);
  assert.match(readme, /`--pr-security`/);
  assert.match(readme, /`--security-review`/);
  assert.match(readme, /`--validate-security`/);
});
