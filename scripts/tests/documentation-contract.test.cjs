const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { validateArtifactValue } = require('../schema-runtime.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const onboardingDocuments = [
  'README.md',
  'docs/getting-started.md',
  'docs/agent-installation.md',
  'docs/usage-guide.md',
  'docs/cli-reference.md',
  'docs/how-it-works.md',
  'docs/troubleshooting.md'
];

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

function markdownAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

test('onboarding documents have reproducible frontmatter and valid local links', () => {
  const missingFrontmatter = onboardingDocuments.filter((relativePath) => {
    const content = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    return !/^---\ntitle: .+\ndescription: [>|]/.test(content) ||
      !/\nprompt: \|\n/.test(content);
  });
  assert.deepEqual(missingFrontmatter, []);

  const brokenLinks = onboardingDocuments.flatMap((relativePath) => {
    const documentPath = path.join(projectRoot, relativePath);
    const content = fs.readFileSync(documentPath, 'utf8');
    return [...content.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)]
      .map((match) => {
        return match[1];
      })
      .filter((target) => {
        return !/^(?:https?:|mailto:)/.test(target);
      })
      .flatMap((target) => {
        const [rawPath, rawAnchor] = target.split('#');
        const targetPath = rawPath ?
          path.resolve(path.dirname(documentPath), rawPath) :
          documentPath;
        if (!fs.existsSync(targetPath)) {
          return [`${relativePath} -> ${target}`];
        }
        if (!rawAnchor || !targetPath.endsWith('.md')) {
          return [];
        }
        const targetContent = fs.readFileSync(targetPath, 'utf8');
        const anchors = [...targetContent.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => {
          return markdownAnchor(match[1]);
        });
        return anchors.includes(rawAnchor) ? [] : [`${relativePath} -> ${target}`];
      });
  });
  assert.deepEqual(brokenLinks, []);
});

test('README keeps terminal, agent, safety, and capability boundaries accurate', () => {
  const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
  assert.match(readme, /The default run only scans and reports/);
  assert.match(readme, /Scans are started through your coding agent/);
  assert.match(
    readme,
    /Use the bug-hunter skill to scan this repository\. Do not edit files\./
  );
  assert.match(readme, /Other ecosystems return `scanner-unsupported`/);
  assert.match(readme, /source repository[\s\S]*test-fixture\//);
  assert.doesNotMatch(readme, /\.bug-hunter\/findings\.json/);
  assert.doesNotMatch(readme, /\b\d+\s+tests?\s+pass(?:ing|ed)?\b/i);
});

test('focused onboarding guides ship in the runtime package', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
  );
  const expectedDocuments = onboardingDocuments.filter((relativePath) => {
    return relativePath.startsWith('docs/');
  });
  assert.deepEqual(
    expectedDocuments.filter((relativePath) => {
      return !packageJson.files.includes(relativePath);
    }),
    []
  );
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
