#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  createSchemaRef,
  validateArtifactValue,
  validateSchemaRef
} = require('./schema-runtime.cjs');

const REQUIRED_BY_ROLE = {
  recon: ['skillDir', 'targetFiles', 'outputSchema'],
  'triage-hunter': ['skillDir', 'targetFiles', 'techStack', 'outputSchema'],
  hunter: ['skillDir', 'targetFiles', 'riskMap', 'techStack', 'outputSchema'],
  skeptic: ['skillDir', 'bugs', 'techStack', 'outputSchema'],
  referee: ['skillDir', 'findings', 'skepticResults', 'outputSchema'],
  fixer: [
    'skillDir',
    'bugs',
    'techStack',
    'scopeManifest',
    'commitAllowed',
    'outputSchema'
  ]
};

const TEMPLATES = {
  recon: {
    skillDir: '/absolute/path/to/bug-hunter',
    targetFiles: ['src/example.ts'],
    outputSchema: createSchemaRef('recon')
  },
  'triage-hunter': {
    skillDir: '/absolute/path/to/bug-hunter',
    targetFiles: ['src/example.ts'],
    techStack: { framework: '', auth: '', database: '', dependencies: [] },
    outputSchema: createSchemaRef('findings')
  },
  hunter: {
    skillDir: '/absolute/path/to/bug-hunter',
    targetFiles: ['src/example.ts'],
    riskMap: { critical: [], high: [], medium: [], contextOnly: [] },
    techStack: { framework: '', auth: '', database: '', dependencies: [] },
    outputSchema: createSchemaRef('findings')
  },
  skeptic: {
    skillDir: '/absolute/path/to/bug-hunter',
    bugs: [
      {
        bugId: 'BUG-1',
        severity: 'Critical|High|Medium|Low',
        file: 'src/example.ts',
        lines: '10-15',
        claim: 'One-sentence description of the bug',
        evidence: 'Exact code quote from the file',
        runtimeTrigger: 'Specific scenario that triggers this bug',
        crossReferences: 'Other files involved, or "Single file"'
      }
    ],
    techStack: { framework: '', auth: '', database: '', dependencies: [] },
    outputSchema: createSchemaRef('skeptic')
  },
  referee: {
    skillDir: '/absolute/path/to/bug-hunter',
    findings: [{
      bugId: 'BUG-1',
      severity: 'Critical',
      category: 'security',
      file: 'src/example.ts',
      lines: '10-15',
      claim: 'One-sentence description of the bug',
      evidence: 'Exact code quote from the file',
      runtimeTrigger: 'Specific scenario that triggers this bug',
      crossReferences: ['Single file'],
      confidenceScore: 92
    }],
    skepticResults: { accepted: ['BUG-1'], disproved: [], details: [] },
    outputSchema: createSchemaRef('referee')
  },
  fixer: {
    skillDir: '/absolute/path/to/bug-hunter',
    bugs: [
      {
        bugId: 'BUG-1',
        severity: 'Critical|High|Medium|Low',
        file: 'src/example.ts',
        lines: '10-15',
        description: 'What is wrong',
        suggestedFix: 'How to fix it'
      }
    ],
    techStack: { framework: '', auth: '', database: '', dependencies: [] },
    scopeManifest: {
      schemaVersion: 1,
      runId: 'run-1',
      repositoryRoot: '/absolute/path/to/repository',
      baseCommit: 'full-base-commit',
      approvedBugIds: ['BUG-1'],
      approvedFiles: ['/absolute/path/to/repository/src/example.ts']
    },
    commitAllowed: false,
    outputSchema: createSchemaRef('fix-report')
  }
};

function usage() {
  console.error('Usage:');
  console.error('  payload-guard.cjs validate <role> <payloadJsonPath>');
  console.error('  payload-guard.cjs generate <role> [outputJsonPath]');
  console.error('');
  console.error('Roles: ' + Object.keys(REQUIRED_BY_ROLE).join(', '));
}

function readPayload(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function validate(role, payload) {
  const errors = [];
  const required = REQUIRED_BY_ROLE[role];
  if (!required) {
    return {
      ok: false,
      errors: [`Unknown role: ${role}`]
    };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      errors: ['Payload must be a JSON object']
    };
  }

  for (const field of required) {
    if (!(field in payload)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if ('skillDir' in payload) {
    if (typeof payload.skillDir !== 'string' || payload.skillDir.trim() === '') {
      errors.push('skillDir must be a non-empty string');
    } else if (!path.isAbsolute(payload.skillDir)) {
      errors.push('skillDir must be an absolute path');
    }
  }

  if ('targetFiles' in payload && !isNonEmptyArray(payload.targetFiles)) {
    errors.push('targetFiles must be a non-empty array');
  }

  if ('bugs' in payload && !isNonEmptyArray(payload.bugs)) {
    errors.push('bugs must be a non-empty array');
  }

  if ('findings' in payload && !isNonEmptyArray(payload.findings)) {
    errors.push('findings must be a non-empty array');
  }

  if ('skepticResults' in payload) {
    if (!payload.skepticResults || typeof payload.skepticResults !== 'object') {
      errors.push('skepticResults must be an object');
    }
  }

  if ('outputSchema' in payload) {
    const schemaValidation = validateSchemaRef(payload.outputSchema);
    errors.push(...schemaValidation.errors);
  }

  if ('commitAllowed' in payload && typeof payload.commitAllowed !== 'boolean') {
    errors.push('commitAllowed must be a boolean');
  }

  if ('scopeManifest' in payload) {
    const scopeValidation = validateArtifactValue({
      artifactName: 'fixer-scope',
      value: payload.scopeManifest
    });
    errors.push(...scopeValidation.errors.map((error) => {
      return `scopeManifest: ${error}`;
    }));
    if (scopeValidation.ok && Array.isArray(payload.bugs)) {
      const approvedBugIds = new Set(payload.scopeManifest.approvedBugIds);
      const approvedFiles = new Set(payload.scopeManifest.approvedFiles);
      payload.bugs.map((bug, index) => {
        if (!approvedBugIds.has(bug?.bugId)) {
          errors.push(`bugs[${index}].bugId is outside scopeManifest`);
        }
        if (!approvedFiles.has(bug?.file)) {
          errors.push(`bugs[${index}].file is outside scopeManifest`);
        }
        return bug;
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function main() {
  const [command, role, payloadJsonPath] = process.argv.slice(2);

  if (command === 'generate') {
    if (!role) {
      usage();
      process.exit(1);
    }
    const template = TEMPLATES[role];
    if (!template) {
      console.error(`Unknown role: ${role}. Available: ${Object.keys(TEMPLATES).join(', ')}`);
      process.exit(1);
    }
    const output = JSON.stringify(template, null, 2);
    if (payloadJsonPath) {
      const dir = path.dirname(payloadJsonPath);
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(payloadJsonPath, output + '\n', 'utf8');
      console.log(JSON.stringify({ ok: true, role, outputPath: payloadJsonPath }));
    } else {
      console.log(output);
    }
    return;
  }

  if (command === 'validate') {
    if (!role || !payloadJsonPath) {
      usage();
      process.exit(1);
    }
    const payload = readPayload(payloadJsonPath);
    const result = validate(role, payload);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exit(1);
    }
    return;
  }

  usage();
  process.exit(1);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
