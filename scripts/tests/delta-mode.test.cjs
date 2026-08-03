const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  resolveSkillScript,
  runJson,
  writeJson
} = require('./test-utils.cjs');

test('delta-mode selects changed scope and returns expansion overlays', () => {
  const sandbox = makeSandbox('delta-mode-');
  const codeIndex = resolveSkillScript('code-index.cjs');
  const deltaMode = resolveSkillScript('delta-mode.cjs');
  const filesJson = path.join(sandbox, 'files.json');
  const indexPath = path.join(sandbox, 'index.json');
  const changedJson = path.join(sandbox, 'changed.json');

  const changedFile = path.join(sandbox, 'src', 'feature', 'changed.ts');
  const depFile = path.join(sandbox, 'src', 'feature', 'dep.ts');
  const criticalOverlay = path.join(sandbox, 'src', 'api', 'admin-route.ts');
  fs.mkdirSync(path.dirname(changedFile), { recursive: true });
  fs.mkdirSync(path.dirname(criticalOverlay), { recursive: true });
  fs.writeFileSync(changedFile, "import { dep } from './dep';\nexport const value = dep();\n", 'utf8');
  fs.writeFileSync(depFile, 'export function dep() { return 1; }\n', 'utf8');
  fs.writeFileSync(criticalOverlay, 'export function handler(req) { return req.body; }\n', 'utf8');

  writeJson(filesJson, [changedFile, depFile, criticalOverlay]);
  runJson('node', [codeIndex, 'build', indexPath, filesJson, sandbox]);
  writeJson(changedJson, [changedFile]);

  const selected = runJson('node', [deltaMode, 'select', indexPath, changedJson, '1']);
  assert.equal(selected.ok, true);
  assert.equal(selected.selected.includes(changedFile), true);
  assert.equal(selected.selected.includes(depFile), true);
  assert.equal(selected.expansionCandidates.includes(criticalOverlay), true);

  const alreadySelectedJson = path.join(sandbox, 'selected.json');
  const lowFilesJson = path.join(sandbox, 'low-files.json');
  writeJson(alreadySelectedJson, selected.selected);
  writeJson(lowFilesJson, [changedFile]);
  const expansion = runJson('node', [deltaMode, 'expand', indexPath, lowFilesJson, alreadySelectedJson, '1']);
  assert.equal(expansion.ok, true);
  assert.equal(expansion.overlayOnly.includes(criticalOverlay), true);
});

test('delta-mode preserves unindexed changes and validates hop bounds', () => {
  const sandbox = makeSandbox('delta-mode-unindexed-');
  const deltaMode = resolveSkillScript('delta-mode.cjs');
  const indexPath = path.join(sandbox, 'index.json');
  const changedJson = path.join(sandbox, 'changed.json');
  const unindexedFile = path.join(sandbox, 'src', 'new-file.ts');

  writeJson(indexPath, {
    files: {},
    reverseDependencies: {}
  });
  writeJson(changedJson, [unindexedFile]);

  const selected = runJson(
    'node',
    [deltaMode, 'select', indexPath, changedJson, '0']
  );
  assert.equal(selected.hops, 0);
  assert.deepEqual(selected.selected, [unindexedFile]);
  assert.deepEqual(selected.unindexedChanged, [unindexedFile]);

  ['-1', '1.5', 'NaN', '101'].map((hops) => {
    return assert.throws(() => {
      runJson('node', [deltaMode, 'select', indexPath, changedJson, hops]);
    });
  });
});
