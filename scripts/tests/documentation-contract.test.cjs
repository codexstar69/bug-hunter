const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { validateArtifactValue } = require('../schema-runtime.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');

function markdownFiles(directoryPath) {
  return fs.readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      return markdownFiles(entryPath);
    }
    return entry.name.endsWith('.md') ? [entryPath] : [];
  });
}

test('runtime markdown references tracked internal files', () => {
  const documentPaths = [
    path.join(projectRoot, 'SKILL.md'),
    path.join(projectRoot, 'README.md'),
    ...markdownFiles(path.join(projectRoot, 'modes')),
    ...markdownFiles(path.join(projectRoot, 'skills')),
    ...markdownFiles(path.join(projectRoot, 'templates'))
  ];
  const missing = documentPaths.flatMap((documentPath) => {
    const content = fs.readFileSync(documentPath, 'utf8');
    const references = [...content.matchAll(
      /(?:SKILL_DIR\/|\$SKILL_DIR\/|@)?((?:skills|modes|schemas|scripts|templates)\/[a-zA-Z0-9._/-]+)/g
    )].map((match) => {
      return match[1].replace(/[.,:;)]+$/, '');
    }).filter((reference) => {
      return !reference.includes('..') && reference !== 'skills/bug-hunter';
    });
    return [...new Set(references)].filter((reference) => {
      return !fs.existsSync(path.join(projectRoot, reference));
    }).map((reference) => {
      return `${path.relative(projectRoot, documentPath)} -> ${reference}`;
    });
  });

  assert.deepEqual(missing, []);
});

test('every delegated mode uses the tracked dispatch contract', () => {
  const delegatedModes = [
    'extended.md',
    'parallel.md',
    'scaled.md',
    'single-file.md',
    'small.md'
  ];
  assert.equal(fs.existsSync(path.join(projectRoot, 'modes', 'dispatch.md')), true);
  delegatedModes.map((modeName) => {
    const content = fs.readFileSync(path.join(projectRoot, 'modes', modeName), 'utf8');
    assert.match(content, /dispatch\.md/);
    assert.doesNotMatch(content, /_dispatch\.md/);
    return modeName;
  });
});

test('documented Fixer JSON validates against the fix-report schema', () => {
  const fixerSkill = fs.readFileSync(
    path.join(projectRoot, 'skills', 'fixer', 'SKILL.md'),
    'utf8'
  );
  const exampleMatch = fixerSkill.match(/```json\n(\{[\s\S]*?\})\n```/);
  assert.notEqual(exampleMatch, null);
  const result = validateArtifactValue({
    artifactName: 'fix-report',
    value: JSON.parse(exampleMatch[1])
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});
