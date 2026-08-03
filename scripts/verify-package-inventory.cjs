#!/usr/bin/env node

const childProcess = require('child_process');
const path = require('path');

const MAX_TARBALL_BYTES = 2 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 5 * 1024 * 1024;
const FORBIDDEN_PREFIXES = [
  'docs/images/',
  'docs/plans/',
  'evals/',
  'plans/',
  'scripts/tests/',
  'schemas/examples/',
  'test-fixture/'
];

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const result = childProcess.spawnSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30000
    }
  );
  if (result.error) {
    throw new Error(`npm pack inventory failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'npm pack inventory failed').trim());
  }
  const [inventory] = JSON.parse(result.stdout);
  if (!inventory || !Array.isArray(inventory.files)) {
    throw new Error('npm pack did not return a file inventory');
  }
  const forbidden = inventory.files.map((entry) => {
    return entry.path;
  }).filter((filePath) => {
    return FORBIDDEN_PREFIXES.some((prefix) => {
      return filePath.startsWith(prefix);
    });
  });
  const errors = [
    ...(inventory.size > MAX_TARBALL_BYTES
      ? [`tarball ${inventory.size} bytes exceeds ${MAX_TARBALL_BYTES}`]
      : []),
    ...(inventory.unpackedSize > MAX_UNPACKED_BYTES
      ? [`unpacked package ${inventory.unpackedSize} bytes exceeds ${MAX_UNPACKED_BYTES}`]
      : []),
    ...(forbidden.length > 0
      ? [`forbidden package files: ${forbidden.join(', ')}`]
      : [])
  ];
  const report = {
    ok: errors.length === 0,
    fileCount: inventory.files.length,
    tarballBytes: inventory.size,
    unpackedBytes: inventory.unpackedSize,
    limits: {
      tarballBytes: MAX_TARBALL_BYTES,
      unpackedBytes: MAX_UNPACKED_BYTES
    },
    forbidden,
    errors
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
