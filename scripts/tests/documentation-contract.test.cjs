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

test('runtime markdown references existing internal files', () => {
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

test('README preserves substantial product and security topic coverage', () => {
  const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
  const skepticSkill = fs.readFileSync(
    path.join(projectRoot, 'skills', 'skeptic', 'SKILL.md'),
    'utf8'
  );
  const requiredHeadings = [
    '## Why adversarial AI code review',
    '## How the code-audit pipeline works',
    '## Hunter, Skeptic, and Referee',
    '## Core code-analysis capabilities',
    '## Security vulnerability classification',
    '## STRIDE threat modeling',
    '## Dependency CVE scanning',
    '## Pull-request and changed-code review',
    '## Strategic fix planning and safe remediation',
    '## Structured JSON for CI/CD',
    '## Output files',
    '## Supported languages and frameworks',
    '## Skill argument reference',
    '## Project architecture'
  ];
  const requiredImages = [
    'hero.png',
    'pipeline-overview.png',
    'adversarial-debate.png',
    'doc-verify-fix-plan.png',
    'security-finding-card.png',
    '2026-03-12-security-pack.png',
    '2026-03-12-fix-plan-rollout.png',
    '2026-03-12-machine-readable-artifacts.png',
    '2026-03-12-pr-review-flow.png'
  ];
  const missingHeadings = requiredHeadings.filter((heading) => {
    return !readme.includes(heading);
  });
  const imageElements = [...readme.matchAll(
    /<img\s+[^>]*src="([^"]+)"[^>]*alt="([^"]+)"[^>]*>/g
  )].map((match) => {
    return { source: match[1], alt: match[2] };
  });
  const documentationImages = imageElements.flatMap((imageElement) => {
    const pathMatch = imageElement.source.match(/\/docs\/images\/([^?#]+)$/);
    if (!pathMatch) {
      return [];
    }
    return [{
      ...imageElement,
      imageName: pathMatch[1]
    }];
  });
  const missingImages = requiredImages.filter((imageName) => {
    return !documentationImages.some((imageElement) => {
      return imageElement.imageName === imageName &&
        imageElement.alt.trim().length > 0 &&
        fs.existsSync(path.join(projectRoot, 'docs', 'images', imageName));
    });
  });
  const mutableDocumentationImages = documentationImages.filter((imageElement) => {
    return !/\/[a-f0-9]{40}\/docs\/images\//.test(imageElement.source);
  });
  const restorationWordCount = readme.trim().split(/\s+/).length;
  const hardExclusionSection = skepticSkill.match(
    /### Hard exclusions[\s\S]*?(?=\nFormat:)/
  );
  assert.notEqual(hardExclusionSection, null);
  const hardExclusionCount = [
    ...hardExclusionSection[0].matchAll(/^\d+\.\s/gm)
  ].length;

  assert.deepEqual(missingHeadings, []);
  assert.deepEqual(missingImages, []);
  assert.deepEqual(mutableDocumentationImages, []);
  assert.equal(restorationWordCount >= 4000, true);
  assert.match(readme, new RegExp(`${String(hardExclusionCount)} hard exclusions`));
  assert.match(readme, /CVSS 3\.1/);
  assert.match(readme, /Context Hub[\s\S]*Context7/);
  assert.match(readme, /security code scanner/);
  assert.match(readme, /static-analysis assistant/);
  assert.match(readme, /npm, pnpm, Yarn, or Bun lockfiles/);
  assert.doesNotMatch(
    readme,
    /dependency (?:audit|CVE scanning)[\s\S]{0,160}(?:pip|cargo|govulncheck)/i
  );

  const scanReportExample = readme.match(
    /## Structured JSON for CI\/CD[\s\S]*?```json\n(\{[\s\S]*?\})\n```/
  );
  assert.notEqual(scanReportExample, null);
  const validation = validateArtifactValue({
    artifactName: 'scan-report',
    value: JSON.parse(scanReportExample[1])
  });
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.ok, true);
});

test('focused onboarding guides are declared in the runtime allowlist', () => {
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

test('current-source commands and canonical Hunter output stay accurate', () => {
  const commandDocuments = [
    'README.md',
    'docs/getting-started.md',
    'docs/agent-installation.md',
    'docs/troubleshooting.md',
    'llms.txt'
  ];
  const staleCommands = commandDocuments.filter((relativePath) => {
    const content = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    return /npx --yes @codexstar\/bug-hunter/.test(content);
  });
  const hunterSkill = fs.readFileSync(
    path.join(projectRoot, 'skills', 'hunter', 'SKILL.md'),
    'utf8'
  );
  const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');

  assert.deepEqual(staleCommands, []);
  assert.match(readme, /## TL;DR/);
  assert.match(readme, /## Choose your agent/);
  assert.match(readme, /main\.tar\.gz install --agent codex/);
  assert.match(readme, /main\.tar\.gz doctor --agent codex/);
  assert.doesNotMatch(hunterSkill, /\*\*TOTAL FINDINGS:/);
  assert.doesNotMatch(hunterSkill, /\*\*FILES SCANNED:/);
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

test('shipped agent-facing guidance contains no legacy task prompt residue', () => {
  const freshnessDocuments = [
    ...onboardingDocuments,
    'llms.txt',
    'llms-full.txt',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'skills/README.md',
    'modes/dispatch.md',
    'templates/subagent-wrapper.md',
    'agents/openai.yaml'
  ];
  const forbidden = [
    /can we do that so everything is end to end seamless/i,
    /you removed a lot of content that helped rank/i,
    /launch parallel agnents/i,
    /BUG-7, BUG-20, and BUG-41/,
    /3\.1\.1 publishing\s+is pending/i
  ];
  const stale = freshnessDocuments.flatMap((relativePath) => {
    const content = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    return forbidden.flatMap((pattern) => {
      return pattern.test(content) ? [`${relativePath} -> ${pattern}`] : [];
    });
  });
  assert.deepEqual(stale, []);
});

test('agent references describe the current measurable artifacts and defaults', () => {
  const llms = fs.readFileSync(path.join(projectRoot, 'llms.txt'), 'utf8');
  const llmsFull = fs.readFileSync(path.join(projectRoot, 'llms-full.txt'), 'utf8');
  const howItWorks = fs.readFileSync(
    path.join(projectRoot, 'docs', 'how-it-works.md'),
    'utf8'
  );
  const combined = `${llms}\n${llmsFull}\n${howItWorks}`;

  for (const artifact of [
    'adaptive-plan.json',
    'retrieval-plan.json',
    'verification-report.json',
    'benchmark-report.json'
  ]) {
    assert.match(combined, new RegExp(artifact.replace('.', '\\.')));
  }
  assert.match(llms, /single-pass/i);
  assert.match(llms, /--loop/);
  assert.doesNotMatch(llms, /loop mode is the default/i);
  assert.match(llmsFull, /fast/);
  assert.match(llmsFull, /balanced/);
  assert.match(llmsFull, /assurance/);
  assert.match(llmsFull, /content-addressed/i);
  assert.match(llmsFull, /hybrid verification/i);
});

test('evaluation prompts track the current protocol instead of historical behavior', () => {
  const evalPath = path.join(projectRoot, 'evals', 'evals.json');
  const evals = JSON.parse(fs.readFileSync(evalPath, 'utf8'));
  const serialized = JSON.stringify(evals);
  const evalText = evals.evals.map((entry) => {
    return `${entry.prompt}\n${entry.expected_output}\n${entry.assertions.map((item) => item.text).join('\n')}`;
  }).join('\n');

  assert.equal(evals.skill_name, 'bug-hunter');
  assert.equal(Array.isArray(evals.evals), true);
  assert.equal(evals.evals.length >= 35, true);
  assert.doesNotMatch(serialized, /\.bug-hunter\/findings\.json/);
  assert.doesNotMatch(serialized, /Loop mode is the default/i);
  assert.match(evalText, /adaptive-plan\.json/);
  assert.match(evalText, /retrieval-plan\.json/);
  assert.match(evalText, /content-addressed|evidence cache/i);
  assert.match(evalText, /hybrid verification/i);
  assert.match(evalText, /source hashes|source identity/i);
  assert.match(evalText, /quality:world-class/);
});

test('contributor and security guidance protect measurable protocol invariants', () => {
  const contributing = fs.readFileSync(path.join(projectRoot, 'CONTRIBUTING.md'), 'utf8');
  const security = fs.readFileSync(path.join(projectRoot, 'SECURITY.md'), 'utf8');
  const skillsReadme = fs.readFileSync(path.join(projectRoot, 'skills', 'README.md'), 'utf8');

  assert.match(contributing, /pnpm quality:world-class/);
  assert.match(contributing, /benchmark/i);
  assert.match(contributing, /source-integrity|source identity/i);
  assert.match(security, /evidence-cache|evidence cache/i);
  assert.match(security, /hybrid-verifier|hybrid verifier/i);
  assert.match(security, /source-integrity|source identity/i);
  assert.match(skillsReadme, /canonical role instructions/i);
  assert.match(skillsReadme, /generated/i);
});
