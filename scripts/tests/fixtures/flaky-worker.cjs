#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const options = {};
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      index += 1;
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      options[key] = 'true';
      index += 1;
      continue;
    }
    options[key] = value;
    index += 2;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const chunkId = options['chunk-id'] || 'chunk';
const attemptsFile = options['attempts-file'];
const findingsJson = options['findings-json'];
const scanFilesJson = options['scan-files-json'];

if (!attemptsFile) {
  console.error('attempts-file is required');
  process.exit(1);
}

const attemptsPath = path.resolve(attemptsFile);
let attempts = {};
if (fs.existsSync(attemptsPath)) {
  attempts = JSON.parse(fs.readFileSync(attemptsPath, 'utf8'));
}
attempts[chunkId] = (attempts[chunkId] || 0) + 1;
fs.mkdirSync(path.dirname(attemptsPath), { recursive: true });
fs.writeFileSync(attemptsPath, `${JSON.stringify(attempts, null, 2)}\n`, 'utf8');

if (attempts[chunkId] === 1) {
  console.error(`intentional failure on first attempt for ${chunkId}`);
  process.exit(1);
}

if (findingsJson) {
  if (!scanFilesJson) {
    console.error('scan-files-json is required when findings-json is provided');
    process.exit(1);
  }
  const scanFiles = JSON.parse(fs.readFileSync(path.resolve(scanFilesJson), 'utf8'));
  const assignedFile = scanFiles[0];
  if (!assignedFile) {
    console.error(`no assigned source file for ${chunkId}`);
    process.exit(1);
  }
  const payload = [
    {
      bugId: `BUG-${chunkId}`,
      severity: 'Medium',
      category: 'logic',
      file: assignedFile,
      lines: '1',
      claim: `retry-success-${chunkId}`,
      evidence: `${assignedFile}:1 retry success evidence`,
      runtimeTrigger: `Retry attempt for ${chunkId}`,
      crossReferences: ['Single file'],
      confidenceScore: 88
    }
  ];
  fs.writeFileSync(findingsJson, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
