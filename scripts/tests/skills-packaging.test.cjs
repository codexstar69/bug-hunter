const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { resolveSkillScript } = require('./test-utils.cjs');

test('package.json ships the bundled local security skills', () => {
  const packageJson = require(resolveSkillScript('..', 'package.json'));
  assert.equal(Array.isArray(packageJson.files), true);
  assert.equal(packageJson.files.includes('skills/'), true);
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
