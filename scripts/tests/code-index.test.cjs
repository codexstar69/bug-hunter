const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  writeJson,
  resolveSkillScript,
  runJson
} = require('./test-utils.cjs');

test('code-index build captures symbols, call graph, boundaries, and query scope', () => {
  const sandbox = makeSandbox('code-index-');
  const codeIndex = resolveSkillScript('code-index.cjs');
  const filesJson = path.join(sandbox, 'files.json');
  const indexPath = path.join(sandbox, 'index.json');

  const routeFile = path.join(sandbox, 'src', 'routes', 'user-route.ts');
  const serviceFile = path.join(sandbox, 'src', 'routes', 'service.ts');
  const authFile = path.join(sandbox, 'src', 'lib', 'auth.ts');
  fs.mkdirSync(path.dirname(routeFile), { recursive: true });
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(routeFile, [
    "import { loadUser } from './service';",
    'export function handler(req) {',
    '  return loadUser(req);',
    '}'
  ].join('\n'), 'utf8');
  fs.writeFileSync(serviceFile, [
    "import { verifyToken } from '../lib/auth';",
    'export function loadUser(req) {',
    '  return verifyToken(req.token);',
    '}'
  ].join('\n'), 'utf8');
  fs.writeFileSync(authFile, [
    'export function verifyToken(token) {',
    '  return Boolean(token);',
    '}'
  ].join('\n'), 'utf8');

  writeJson(filesJson, [routeFile, serviceFile, authFile]);
  const buildResult = runJson('node', [codeIndex, 'build', indexPath, filesJson, sandbox]);
  assert.equal(buildResult.ok, true);
  assert.equal(buildResult.metrics.filesIndexed, 3);
  assert.equal(buildResult.metrics.symbolsIndexed > 0, true);
  assert.equal(buildResult.metrics.callEdges > 0, true);
  assert.equal(buildResult.metrics.trustBoundaryFiles >= 1, true);

  const seedJson = path.join(sandbox, 'seed.json');
  writeJson(seedJson, [routeFile]);
  const queryResult = runJson('node', [codeIndex, 'query', indexPath, seedJson, '1']);
  assert.equal(queryResult.ok, true);
  assert.equal(queryResult.selected.includes(routeFile), true);
  assert.equal(queryResult.selected.includes(serviceFile), true);
  assert.equal(queryResult.trustBoundaryFiles.includes(routeFile), true);
});

test('code-index query-bugs cleans up temp seed files after failures', () => {
  const sandbox = makeSandbox('code-index-query-bugs-');
  const codeIndex = resolveSkillScript('code-index.cjs');
  const bugsJson = path.join(sandbox, 'bugs.json');
  const missingIndexPath = path.join(sandbox, 'missing-index.json');
  const sourceFile = path.join(sandbox, 'src', 'feature.ts');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'export const feature = true;\n', 'utf8');
  writeJson(bugsJson, [{ bugId: 'BUG-1', file: sourceFile }]);

  const result = require('./test-utils.cjs').runRaw('node', [codeIndex, 'query-bugs', missingIndexPath, bugsJson, '1']);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(sandbox, '.seed-files.tmp.json')), false);
});

test('code-index resolves side-effect JavaScript and relative Python imports', () => {
  const sandbox = makeSandbox('code-index-imports-');
  const codeIndex = resolveSkillScript('code-index.cjs');
  const filesJson = path.join(sandbox, 'files.json');
  const indexPath = path.join(sandbox, 'index.json');
  const entryFile = path.join(sandbox, 'src', 'entry.js');
  const setupFile = path.join(sandbox, 'src', 'setup.js');
  const moduleFile = path.join(sandbox, 'pkg', 'sub', 'module.py');
  const siblingFile = path.join(sandbox, 'pkg', 'sub', 'sibling.py');
  const sharedFile = path.join(sandbox, 'pkg', 'shared.py');

  try {
    [
      [entryFile, "import './setup.js';\n"],
      [setupFile, 'globalThis.ready = true;\n'],
      [moduleFile, 'from .sibling import run\nfrom ..shared import value\n'],
      [siblingFile, 'def run():\n    return True\n'],
      [sharedFile, 'value = True\n']
    ].map(([filePath, content]) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
      return filePath;
    });

    writeJson(filesJson, [entryFile, setupFile, moduleFile, siblingFile, sharedFile]);
    const buildResult = runJson('node', [codeIndex, 'build', indexPath, filesJson, sandbox]);
    assert.equal(buildResult.ok, true);

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.deepEqual(index.files[entryFile].dependencies, [setupFile]);
    assert.deepEqual(index.files[moduleFile].dependencies, [sharedFile, siblingFile].sort());
    assert.deepEqual(index.files[moduleFile].unresolvedDependencies, []);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
