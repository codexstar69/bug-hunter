const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  readJson,
  resolveSkillScript,
  runRaw
} = require('./test-utils.cjs');

function writeExecutable({ filePath, source }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#!${process.execPath}\n${source}\n`, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function createScannerFixtures({ binDir, packageName }) {
  const auditPayload = {
    vulnerabilities: {
      [packageName]: {
        severity: 'critical',
        range: '<1.0.0',
        via: [{ title: 'fixture advisory', cve: 'CVE-FIXTURE' }],
        fixAvailable: { version: '1.0.0' }
      }
    }
  };

  writeExecutable({
    filePath: path.join(binDir, 'npm'),
    source: `process.stdout.write(${JSON.stringify(JSON.stringify(auditPayload))});`
  });
  writeExecutable({
    filePath: path.join(binDir, 'rg'),
    source: [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.DEP_SCAN_ARGV_LOG, JSON.stringify(process.argv.slice(2)));",
      "process.exit(Number(process.env.FAKE_RG_STATUS || '1'));"
    ].join('\n')
  });
}

test('dep-scan passes target and package patterns as inert argv values', () => {
  const sandbox = makeSandbox('dep-scan-argv-');
  const depScan = resolveSkillScript('dep-scan.cjs');
  const packageName = 'bad";touch package-injected;#';
  const targetDir = path.join(sandbox, 'target";touch target-injected;#');
  const binDir = path.join(sandbox, 'fixture-bin');
  const outputPath = path.join(sandbox, 'dep-findings.json');
  const argvLog = path.join(sandbox, 'rg-argv.json');

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'package-lock.json'), '{}\n', 'utf8');
    createScannerFixtures({ binDir, packageName });

    const result = runRaw(process.execPath, [depScan, '--target', targetDir, '--output', outputPath], {
      env: {
        ...process.env,
        DEP_SCAN_ARGV_LOG: argvLog,
        PATH: binDir
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(targetDir, 'target-injected')), false);
    assert.equal(fs.existsSync(path.join(targetDir, 'package-injected')), false);

    const rgArgs = readJson(argvLog);
    assert.equal(rgArgs.includes(targetDir), true);
    assert.equal(rgArgs.some((arg) => {
      return arg.includes(packageName);
    }), true);

    const output = readJson(outputPath);
    assert.equal(output.findings[0].reachability, 'NOT_REACHABLE');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('dep-scan keeps reachability analysis failures distinct from no matches', () => {
  const sandbox = makeSandbox('dep-scan-unknown-');
  const depScan = resolveSkillScript('dep-scan.cjs');
  const targetDir = path.join(sandbox, 'target');
  const binDir = path.join(sandbox, 'fixture-bin');
  const outputPath = path.join(sandbox, 'dep-findings.json');

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'package-lock.json'), '{}\n', 'utf8');
    createScannerFixtures({ binDir, packageName: 'fixture-package' });

    const result = runRaw(process.execPath, [depScan, '--target', targetDir, '--output', outputPath], {
      env: {
        ...process.env,
        DEP_SCAN_ARGV_LOG: path.join(sandbox, 'rg-argv.json'),
        FAKE_RG_STATUS: '2',
        PATH: binDir
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const output = readJson(outputPath);
    assert.equal(output.findings[0].reachability, 'UNKNOWN');
    assert.match(output.findings[0].evidence, /rg failed with status 2/);
    assert.equal(output.summary.not_reachable, 0);
    assert.equal(output.summary.reachability_unknown, 1);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('dep-scan reports unsupported ecosystem parsers instead of clean results', () => {
  const sandbox = makeSandbox('dep-scan-unsupported-');
  const depScan = resolveSkillScript('dep-scan.cjs');
  const targetDir = path.join(sandbox, 'target');
  const outputPath = path.join(sandbox, 'dep-findings.json');

  fs.mkdirSync(targetDir, { recursive: true });
  ['requirements.txt', 'go.sum', 'Cargo.lock'].map((fileName) => {
    fs.writeFileSync(path.join(targetDir, fileName), '\n', 'utf8');
    return fileName;
  });

  const result = runRaw(
    process.execPath,
    [depScan, '--target', targetDir, '--output', outputPath],
    {
      env: {
        ...process.env,
        PATH: path.join(sandbox, 'empty-bin')
      }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const output = readJson(outputPath);
  assert.equal(output.findings.length, 0);
  assert.deepEqual(
    output.scanner_statuses.map((scanner) => {
      return scanner.status;
    }),
    [
      'scanner-unsupported',
      'scanner-unsupported',
      'scanner-unsupported'
    ]
  );
  assert.equal(output.scan_errors.every((error) => {
    return error.reason.startsWith('scanner-unsupported:');
  }), true);
});
