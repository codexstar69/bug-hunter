const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeSandbox, runRaw, writeJson } = require('./test-utils.cjs');
const { reclaimDeadLinkLock } = require('../link-lock.cjs');
const { runPlan } = require('../hybrid-verifier.cjs');
const { createSchemaRef } = require('../schema-runtime.cjs');

const root = path.resolve(__dirname, '../..');

function deadPid() {
  return childProcess.spawnSync(process.execPath, ['-e', '']).pid;
}

function owner(pid) {
  return { pid, host: os.hostname(), token: crypto.randomUUID() };
}

function writeRecord(lock, record) {
  const file = `${lock}.${record.token}.tmp`;
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

function publish(lock, record) {
  fs.linkSync(writeRecord(lock, record), lock);
  return record;
}

function lockToken(lock) {
  return JSON.parse(fs.readFileSync(lock, 'utf8')).token;
}

test('a stale reclaimer never removes the generation a faster reclaimer published', () => {
  const lock = path.join(makeSandbox('fix2-lock-race-'), 'state.json.lock.gate');
  const dead = publish(lock, owner(deadPid()));
  // A and B both inspected the dead owner; A wins and publishes its own gate.
  assert.equal(reclaimDeadLinkLock(lock, dead), 'reclaimed');
  assert.equal(fs.existsSync(lock), false);
  const live = publish(lock, owner(process.pid));
  // B resumes with its stale view of the dead generation.
  assert.equal(reclaimDeadLinkLock(lock, dead), 'retry');
  assert.equal(lockToken(lock), live.token);
  assert.deepEqual(fs.readdirSync(path.dirname(lock)).sort(),
    [path.basename(lock), `${path.basename(lock)}.${live.token}.tmp`].sort());
});

test('a dead owner record left behind a newer generation is cleared without touching the gate', () => {
  const lock = path.join(makeSandbox('fix2-lock-generation-'), '.capacity-lock');
  // The owner died after removing its gate but before removing its record.
  const dead = owner(deadPid());
  const record = writeRecord(lock, dead);
  const live = publish(lock, owner(process.pid));
  assert.equal(reclaimDeadLinkLock(lock, dead), 'reclaimed');
  assert.equal(lockToken(lock), live.token);
  assert.equal(fs.existsSync(record), false);
});

test('a reclaimer killed mid-claim is claimed in turn, and a live claimer reports busy', () => {
  const lock = path.join(makeSandbox('fix2-lock-claim-'), 'state.json.lock.gate');
  const base = path.basename(lock);
  const dead = publish(lock, owner(deadPid()));
  fs.renameSync(`${lock}.${dead.token}.tmp`, path.join(path.dirname(lock), `${base}.${dead.token}.claim.${deadPid()}`));
  assert.equal(reclaimDeadLinkLock(lock, dead), 'reclaimed');
  assert.deepEqual(fs.readdirSync(path.dirname(lock)), []);

  const stuck = publish(lock, owner(deadPid()));
  fs.renameSync(`${lock}.${stuck.token}.tmp`, path.join(path.dirname(lock), `${base}.${stuck.token}.claim.${process.ppid}`));
  assert.equal(reclaimDeadLinkLock(lock, stuck), 'busy');
  assert.equal(lockToken(lock), stuck.token);
});

test('a stale lock without its owner record fails clearly and malformed tokens are rejected', () => {
  const lock = path.join(makeSandbox('fix2-lock-orphan-'), 'state.json.lock.gate');
  const dead = owner(deadPid());
  fs.writeFileSync(lock, JSON.stringify(dead));
  assert.throws(() => reclaimDeadLinkLock(lock, dead), /no owner record/);
  assert.throws(() => reclaimDeadLinkLock(lock, { ...dead, token: '../../escape' }), /Malformed lock owner record/);
  assert.equal(fs.existsSync(lock), true);
});

function keyBlock(lines) {
  const body = Array.from({ length: lines }, (_, i) => `KEYBODY${String(i).padStart(5, '0')}${'Q'.repeat(52)}`);
  return ['-----BEGIN PRIVATE KEY-----', ...body, '-----END PRIVATE KEY-----'].join('\n');
}

async function capture(t, script) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fix2-redact-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const report = await runPlan({
    repoRoot, maxOutputBytes: 65536,
    plan: { schemaVersion: 1, checks: [{
      id: 'leak', kind: 'test', cwd: '.', required: true,
      command: [process.execPath, '-e', script]
    }] }
  });
  return report.checks[0];
}

test('verifier output redacts a private key whose BEGIN line falls in the dropped middle', async (t) => {
  const block = keyBlock(700);
  const result = await capture(t, `process.stdout.write('a'.repeat(70000) + '\\n' + ${JSON.stringify(block)} + '\\n' + 'b'.repeat(2000) + '\\n')`);
  assert.equal(result.outputTruncated, true);
  assert.doesNotMatch(result.stdout, /KEYBODY/);
  assert.match(result.stdout, /\[REDACTED_PRIVATE_KEY\]/);
});

test('verifier output redacts a private key whose END line falls in the dropped middle', async (t) => {
  const block = keyBlock(1600);
  const result = await capture(t, `process.stdout.write('a'.repeat(100) + '\\n' + ${JSON.stringify(block)} + '\\n' + 'z'.repeat(80000) + '\\n')`);
  assert.equal(result.outputTruncated, true);
  assert.doesNotMatch(result.stdout, /KEYBODY/);
});

test('a rendered output path with quotes and separators stays one shell argument', { skip: process.platform === 'win32' }, () => {
  const sandbox = makeSandbox('fix2-render-quote-');
  const output = path.join(sandbox, 'missing', "out';touch PWNED; echo '.json");
  const payload = path.join(sandbox, 'payload.json');
  const task = path.join(sandbox, 'task.md');
  writeJson(payload, { skillDir: root, targetFiles: ['src/a.js'], riskMap: {}, techStack: {},
    outputSchema: createSchemaRef('findings'), outputFilePath: output });
  const rendered = runRaw('node', [path.join(root, 'scripts/payload-guard.cjs'), 'render', 'hunter', payload, '--out', task]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const line = fs.readFileSync(task, 'utf8').split('\n')
    .find((candidate) => candidate.startsWith('node ') && candidate.includes('schema-validate.cjs'));
  assert.ok(line, 'rendered task has the validation command');
  const argv = childProcess.spawnSync('bash', ['-c', line.replace(/^node /, "printf '%s\\n' ")], { cwd: sandbox, encoding: 'utf8' });
  assert.equal(argv.status, 0, argv.stderr);
  assert.deepEqual(argv.stdout.trimEnd().split('\n').slice(1), ['findings', output]);
  assert.equal(fs.existsSync(path.join(sandbox, 'PWNED')), false);
});

test('render rejects a relative output path whose working directory carries shell syntax', { skip: process.platform === 'win32' }, () => {
  const sandbox = makeSandbox('fix2-render-cwd-');
  const repo = path.join(sandbox, 'repo-$(touch PWNED)');
  fs.mkdirSync(repo);
  const payload = path.join(sandbox, 'payload.json');
  const task = path.join(sandbox, 'task.md');
  writeJson(payload, { skillDir: root, targetFiles: ['src/a.js'], riskMap: {}, techStack: {},
    outputSchema: createSchemaRef('findings'), outputFilePath: '.bug-hunter/result.json' });
  const rendered = runRaw('node', [path.join(root, 'scripts/payload-guard.cjs'), 'render', 'hunter', payload, '--out', task], { cwd: repo });
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /resolved outputFilePath\/outputPath must be a non-empty path without shell metacharacters/);
  assert.equal(fs.existsSync(task), false);
});

test('boundary dedup never copies a verdict onto a different claim in an overlapping range', () => {
  const sandbox = makeSandbox('fix2-dedup-claim-');
  // `logic` keeps the observation schema-valid, so only the claim decides reuse.
  const finding = { bugId: 'BOUNDARY-1', severity: 'Critical', category: 'logic', file: 'src/a.js',
    lines: '12-14', claim: 'Refund total skips the discount line', evidence: 'src/a.js:12',
    runtimeTrigger: 'Refund a discounted order', crossReferences: ['Single file'], confidenceScore: 90 };
  const dismissed = { ...finding, bugId: 'DOMAIN-1', lines: '10-15', claim: 'Order lookup ignores the tenant id',
    verdict: 'NOT_A_BUG', trueSeverity: 'High', confidenceLabel: 'high',
    verificationMode: 'EVIDENCE_BASED', analysisSummary: 'Lookup is scoped by tenant.' };
  const findings = path.join(sandbox, 'findings.json');
  const ledger = path.join(sandbox, 'reviewed.json');
  const output = path.join(sandbox, 'dispatch.json');
  writeJson(findings, [finding]);
  writeJson(ledger, [dismissed]);
  const guard = path.join(root, 'scripts/payload-guard.cjs');
  assert.equal(runRaw('node', [guard, 'dedup-boundaries', findings, ledger, '--out', output]).status, 0);
  let dispatch = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(dispatch.findings.map((row) => row.bugId), ['BOUNDARY-1']);
  assert.deepEqual(dispatch.reused, []);
  // The same claim, worded with different case and punctuation, is still reused.
  writeJson(ledger, [{ ...dismissed, claim: 'REFUND total skips the discount-line.' }]);
  assert.equal(runRaw('node', [guard, 'dedup-boundaries', findings, ledger, '--out', output]).status, 0);
  dispatch = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(dispatch.reused.map((row) => row.existingBugId), ['DOMAIN-1']);
});

function redactWhole(text, chunkSize) {
  const { streamingRedactor } = require('../hybrid-verifier.cjs');
  const redactor = streamingRedactor();
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) out += redactor.push(bytes.subarray(offset, offset + chunkSize));
  return out + redactor.flush();
}

test('an overlong line is never cut inside a key delimiter or a secret assignment', () => {
  const secrets = [
    ' password = S3CRETVALUE9,details=x ',
    ' Authorization: Bearer S3CRETVALUE9 ',
    ' -----BEGIN RSA PRIVATE KEY-----\\nS3CRETVALUE9\\n-----END RSA PRIVATE KEY----- '
  ];
  for (const secret of secrets) {
    // Sweep the secret across every position around the forced cut.
    for (let shift = 0; shift < 600; shift += 1) {
      const text = 'x'.repeat(65536 - shift) + secret + 'y'.repeat(shift);
      for (const chunkSize of [text.length, 4096]) {
        assert.doesNotMatch(redactWhole(text, chunkSize), /S3CRETVALUE9|RETVALUE9|VALUE9/, `${secret.trim().slice(0, 12)} shift ${shift}`);
      }
    }
  }
});

test('a secret value longer than the cut window is suppressed to its terminator', () => {
  const out = redactWhole(`password=${'V'.repeat(200000)} after`, 8192);
  assert.doesNotMatch(out, /VVVV/);
  assert.match(out, /password=\[REDACTED\] after$/);
  // Multibyte text split across chunks survives intact.
  assert.equal(redactWhole('é'.repeat(70000), 4097), 'é'.repeat(70000));
});

test('a secret at the start of an overlong line always makes progress and stays redacted', () => {
  // Run in a child with a watchdog: a cut that consumes nothing loops forever.
  const probe = `
    const { streamingRedactor } = require(${JSON.stringify(path.join(root, 'scripts/hybrid-verifier.cjs'))});
    const inputs = [
      'password' + ' '.repeat(248) + 'x'.repeat(70000),
      'password=' + 'V'.repeat(246) + ' ' + 'x'.repeat(65536),
      'password = ' + 'S'.repeat(70000),
      '-----BEGIN PRIVATE KEY-----' + 'S'.repeat(70000) + '-----END PRIVATE KEY----- tail',
      'key=-----BEGIN PRIVATE KEY-----' + 'S'.repeat(70000),
      'sk-' + 'a'.repeat(252) + ' ' + 'b'.repeat(70000)
    ];
    const outputs = inputs.map((text) => {
      const redactor = streamingRedactor();
      return redactor.push(Buffer.from(text)) + redactor.flush();
    });
    process.stdout.write(JSON.stringify(outputs.map((out) => ({ length: out.length, leaked: /SSSS|VVVV/.test(out), head: out.slice(0, 40) }))));
  `;
  const result = childProcess.spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.signal, null, 'redactor did not finish');
  assert.equal(result.status, 0, result.stderr);
  const outputs = JSON.parse(result.stdout);
  for (const [index, out] of outputs.entries()) assert.equal(out.leaked, false, `input ${index}`);
  assert.equal(outputs[0].length, 70256);
  assert.match(outputs[2].head, /^password = \[REDACTED\]$/);
  assert.match(outputs[3].head, /^\[REDACTED_PRIVATE_KEY\] tail$/);
});

test('a keyword that straddles a forced cut is not split', () => {
  // Two 65,536-byte chunks put the forced cut at 130,816 characters.
  const filler = 'x'.repeat(140000);
  for (const secret of ['password = S3CRETVALUE9,', 'Authorization: Bearer S3CRETVALUE9 ', '-----BEGIN RSA PRIVATE KEY-----\\nS3CRETVALUE9\\n-----END RSA PRIVATE KEY-----']) {
    for (let position = 130790; position < 130830; position += 1) {
      const text = filler.slice(0, position) + secret + filler.slice(position);
      assert.doesNotMatch(redactWhole(text, 65536), /S3CRET|CRETVALUE|VALUE9/, `${secret.slice(0, 10)} at ${position}`);
    }
  }
});
