const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  resolveSkillScript,
  runJson,
  runRaw
} = require('./test-utils.cjs');

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

test('pr-scope resolves the current PR via gh metadata', () => {
  const sandbox = makeSandbox('pr-scope-current-');
  const script = resolveSkillScript('pr-scope.cjs');
  const ghPath = path.join(sandbox, 'gh-mock.cjs');

  writeExecutable(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ number: 42, title: 'Fix auth flow', headRefName: 'feature/auth', baseRefName: 'main', url: 'https://example.test/pr/42' }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'diff') {
  process.stdout.write('src/auth.ts\\nsrc/session.ts\\n');
  process.exit(0);
}
process.exit(1);
`);

  const result = runJson('node', [script, 'resolve', 'current', '--repo-root', sandbox, '--gh-bin', ghPath]);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'gh');
  assert.equal(result.pr.number, 42);
  assert.deepEqual(result.changedFiles, ['src/auth.ts', 'src/session.ts']);
});

test('pr-scope falls back to git when current PR metadata is unavailable', () => {
  const sandbox = makeSandbox('pr-scope-fallback-');
  const script = resolveSkillScript('pr-scope.cjs');
  const ghPath = path.join(sandbox, 'gh-fail.cjs');
  const gitPath = path.join(sandbox, 'git-mock.cjs');

  writeExecutable(ghPath, `#!/usr/bin/env node
process.stderr.write('gh unavailable');
process.exit(1);
`);

  writeExecutable(gitPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') {
  process.stdout.write('feature/local\\n');
  process.exit(0);
}
if (args[0] === 'diff') {
  process.stdout.write('src/local.ts\\n');
  process.exit(0);
}
process.exit(1);
`);

  const result = runJson('node', [
    script,
    'resolve',
    'current',
    '--repo-root',
    sandbox,
    '--gh-bin',
    ghPath,
    '--git-bin',
    gitPath,
    '--base',
    'develop'
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'git');
  assert.equal(result.pr.headRefName, 'feature/local');
  assert.equal(result.pr.baseRefName, 'develop');
  assert.deepEqual(result.changedFiles, ['src/local.ts']);
});

test('pr-scope resolves the most recent PR via gh list + diff', () => {
  const sandbox = makeSandbox('pr-scope-recent-');
  const script = resolveSkillScript('pr-scope.cjs');
  const ghPath = path.join(sandbox, 'gh-recent.cjs');

  writeExecutable(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{ number: 7, title: 'Recent PR', headRefName: 'feature/recent', baseRefName: 'main', url: 'https://example.test/pr/7' }]));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'diff') {
  process.stdout.write('src/recent.ts\\n');
  process.exit(0);
}
process.exit(1);
`);

  const result = runJson('node', [script, 'resolve', 'recent', '--repo-root', sandbox, '--gh-bin', ghPath]);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'gh');
  assert.equal(result.pr.number, 7);
  assert.deepEqual(result.changedFiles, ['src/recent.ts']);
});

test('pr-scope uses the discovered default branch for current-branch fallback', () => {
  const sandbox = makeSandbox('pr-scope-default-branch-');
  const script = resolveSkillScript('pr-scope.cjs');
  const ghPath = path.join(sandbox, 'gh-fail.cjs');
  const gitPath = path.join(sandbox, 'git-default.cjs');

  writeExecutable(ghPath, `#!/usr/bin/env node
process.stderr.write('gh unavailable');
process.exit(1);
`);

  writeExecutable(gitPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
  process.stdout.write('feature/local\\n');
  process.exit(0);
}
if (args[0] === 'symbolic-ref') {
  process.stdout.write('refs/remotes/origin/trunk\\n');
  process.exit(0);
}
if (args[0] === 'diff' && args[2] === 'origin/trunk...feature/local') {
  process.stdout.write('src/from-trunk.ts\\n');
  process.exit(0);
}
process.stderr.write('unexpected command: ' + args.join(' '));
process.exit(1);
`);

  const result = runJson('node', [
    script,
    'resolve',
    'current',
    '--repo-root',
    sandbox,
    '--gh-bin',
    ghPath,
    '--git-bin',
    gitPath
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'git');
  assert.equal(result.pr.baseRefName, 'trunk');
  assert.deepEqual(result.changedFiles, ['src/from-trunk.ts']);
});

test('pr-scope fails current-branch fallback when no trustworthy base branch is available', () => {
  const sandbox = makeSandbox('pr-scope-no-base-');
  const script = resolveSkillScript('pr-scope.cjs');
  const ghPath = path.join(sandbox, 'gh-fail.cjs');
  const gitPath = path.join(sandbox, 'git-partial.cjs');

  writeExecutable(ghPath, `#!/usr/bin/env node
process.stderr.write('gh unavailable');
process.exit(1);
`);

  writeExecutable(gitPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
  process.stdout.write('feature/local\\n');
  process.exit(0);
}
process.stderr.write('missing default branch');
process.exit(1);
`);

  const result = runRaw('node', [
    script,
    'resolve',
    'current',
    '--repo-root',
    sandbox,
    '--gh-bin',
    ghPath,
    '--git-bin',
    gitPath
  ], {
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout || ''}${result.stderr || ''}`, /base branch|default branch|missing default branch/i);
});

test('pr-scope fails for numbered PRs when gh metadata cannot be resolved', () => {
  const sandbox = makeSandbox('pr-scope-numbered-');
  const script = resolveSkillScript('pr-scope.cjs');
  const ghPath = path.join(sandbox, 'gh-fail.cjs');

  writeExecutable(ghPath, `#!/usr/bin/env node
process.stderr.write('not found');
process.exit(1);
`);

  const result = runRaw('node', [script, 'resolve', '123', '--repo-root', sandbox, '--gh-bin', ghPath], {
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout || ''}${result.stderr || ''}`, /not found/);
});
