const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  resolveSkillScript,
  runRaw
} = require('./test-utils.cjs');

function writeChub({ sandbox, source }) {
  const chubPath = path.join(sandbox, 'chub');
  fs.writeFileSync(chubPath, source, 'utf8');
  fs.chmodSync(chubPath, 0o755);
  return chubPath;
}

function commandEnvironment(sandbox) {
  return {
    ...process.env,
    PATH: `${sandbox}${path.delimiter}${process.env.PATH || ''}`
  };
}

test('doc-lookup passes chub arguments without a shell', () => {
  const sandbox = makeSandbox('doc-lookup-args-');
  const script = resolveSkillScript('doc-lookup.cjs');
  writeChub({
    sandbox,
    source: `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--help') {
  process.exit(0);
}
if (args[0] === 'get') {
  process.stdout.write('Verified documentation content: ' + JSON.stringify(args) + ' '.repeat(60));
  process.exit(0);
}
process.exit(1);
`
  });

  const result = runRaw(
    'node',
    [script, 'get', 'safe/id;echo-not-run', 'specific question', '--source', 'chub'],
    {
      encoding: 'utf8',
      env: commandEnvironment(sandbox)
    }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /safe\/id;echo-not-run/);
  assert.match(result.stdout, /\["get","safe\/id;echo-not-run"\]/);
});

test('doc-lookup returns failure status when every forced source fails', () => {
  const sandbox = makeSandbox('doc-lookup-failure-');
  const script = resolveSkillScript('doc-lookup.cjs');
  writeChub({
    sandbox,
    source: `#!/usr/bin/env node
if (process.argv[2] === '--help') {
  process.exit(0);
}
process.stderr.write('lookup failed');
process.exit(1);
`
  });

  const result = runRaw(
    'node',
    [script, 'get', 'missing/library', 'specific question', '--source', 'chub'],
    {
      encoding: 'utf8',
      env: commandEnvironment(sandbox)
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /No chub docs found/);
});

test('doc-lookup rejects oversized chub output without printing it', () => {
  const sandbox = makeSandbox('doc-lookup-limit-');
  const script = resolveSkillScript('doc-lookup.cjs');
  writeChub({
    sandbox,
    source: `#!/usr/bin/env node
if (process.argv[2] === '--help') {
  process.exit(0);
}
process.stdout.write('x'.repeat(1024 * 1024 + 1));
`
  });

  const result = runRaw(
    'node',
    [script, 'get', 'large/library', 'specific question', '--source', 'chub'],
    {
      encoding: 'utf8',
      env: commandEnvironment(sandbox)
    }
  );

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.length < 1000, true);
  assert.match(result.stdout, /No chub docs found/);
});
