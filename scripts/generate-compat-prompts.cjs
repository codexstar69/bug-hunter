#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const promptDir = path.join(projectRoot, 'prompts');
const promptSources = Object.freeze({
  recon: 'skills/recon/SKILL.md',
  hunter: 'skills/hunter/SKILL.md',
  skeptic: 'skills/skeptic/SKILL.md',
  referee: 'skills/referee/SKILL.md',
  fixer: 'skills/fixer/SKILL.md',
  'doc-lookup': 'skills/doc-lookup/SKILL.md',
  'threat-model': 'skills/threat-model-generation/SKILL.md'
});

function generatedPrompt({ promptName, sourcePath }) {
  const source = fs.readFileSync(path.join(projectRoot, sourcePath), 'utf8').trim();
  return [
    `<!-- Generated from ${sourcePath} by scripts/generate-compat-prompts.cjs. -->`,
    source,
    ''
  ].join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const stale = Object.entries(promptSources).filter(([promptName, sourcePath]) => {
    const targetPath = path.join(promptDir, `${promptName}.md`);
    const expected = generatedPrompt({ promptName, sourcePath });
    if (checkOnly) {
      const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
      return current !== expected;
    }
    fs.writeFileSync(targetPath, expected, 'utf8');
    return false;
  });

  if (stale.length > 0) {
    throw new Error(`Compatibility prompts are stale: ${stale.map(([name]) => {
      return `prompts/${name}.md`;
    }).join(', ')}`);
  }
  console.log(checkOnly
    ? 'Compatibility prompts are current.'
    : `Generated ${Object.keys(promptSources).length} compatibility prompts.`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
