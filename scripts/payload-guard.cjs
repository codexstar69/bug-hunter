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

const ARTIFACT_BY_ROLE = {
  recon: 'recon', 'triage-hunter': 'findings', hunter: 'findings',
  skeptic: 'skeptic', referee: 'referee', fixer: 'fix-report'
};

const ROLE_DESCRIPTIONS = {
  recon: 'Map architecture, technology, and trust boundaries.',
  'triage-hunter': 'Scout assigned source for evidence-backed bugs.',
  hunter: 'Find evidence-backed behavioral bugs in assigned source.',
  skeptic: 'Challenge the assigned findings against current evidence.',
  referee: 'Independently decide the assigned findings.',
  fixer: 'Fix only the approved bugs within the immutable scope.'
};

const INSTALLED_SKILL_ROOT = fs.realpathSync(path.resolve(__dirname, '..'));

function shellPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || /["`$\\\r\n\0]/.test(value)) {
    throw new Error(`${label} must be a non-empty path without shell metacharacters`);
  }
  return value;
}

function containedOutput(value, repositoryRoot) {
  // Check the resolved path too: a relative value inherits the working directory.
  const output = shellPath(path.resolve(shellPath(value, 'outputFilePath/outputPath')),
    'resolved outputFilePath/outputPath');
  const root = fs.realpathSync(repositoryRoot);
  const contains = (candidate) => {
    const relative = path.relative(root, candidate);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!contains(output)) throw new Error('Output path escapes repository root');
  // Resolve the nearest existing ancestor, including an existing output symlink.
  let ancestor = output;
  const suffix = [];
  while (true) {
    try {
      const real = fs.realpathSync(ancestor);
      if (!contains(path.resolve(real, ...suffix))) throw new Error('Output path escapes repository root');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling symlink must not become an output path later.
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Output path contains a dangling symlink');
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  return output;
}

function render(role, payload) {
  const result = validate(role, payload);
  if (!result.ok) {
    throw new Error(result.errors.join('; '));
  }
  const artifact = ARTIFACT_BY_ROLE[role];
  if (payload.outputSchema.artifact !== artifact) {
    throw new Error(`Role ${role} requires outputSchema artifact ${artifact}`);
  }
  shellPath(payload.skillDir, 'skillDir');
  if (fs.realpathSync(payload.skillDir) !== INSTALLED_SKILL_ROOT) {
    throw new Error('skillDir must resolve to the installed package root');
  }
  shellPath(INSTALLED_SKILL_ROOT, 'installed skill root');
  const skillRole = role === 'triage-hunter' ? 'hunter' : role;
  const roleText = fs.readFileSync(path.join(INSTALLED_SKILL_ROOT, 'skills', skillRole, 'SKILL.md'), 'utf8');
  let wrapper = fs.readFileSync(path.join(INSTALLED_SKILL_ROOT, 'templates', 'subagent-wrapper.md'), 'utf8');
  const start = wrapper.indexOf('## Context\n');
  const end = wrapper.indexOf('\n---\n\n## Variable Reference (orchestrator)');
  if (start < 0 || end < start) {
    throw new Error('Wrapper is missing its task/variable-reference boundaries');
  }
  wrapper = wrapper.slice(start, end);
  if (role !== 'fixer') {
    wrapper = wrapper.replace(/## Worktree Isolation Rules[^\n]*\n[\s\S]*?(?=## Your Assignment)/, '');
    wrapper = wrapper.replace(/\*\*Validated Fixer scope manifest[^\n]*\n[\s\S]*?(?=---END ASSIGNMENT---)/, '');
  }
  const outputPath = payload.outputFilePath ?? payload.outputPath ??
    path.resolve('.bug-hunter', `${artifact === 'findings' ? 'hunter-findings' : artifact}.json`);
  const resolvedOutput = containedOutput(outputPath, process.cwd());
  const files = payload.targetFiles || [...new Set((payload.bugs || payload.findings || []).map((bug) => bug.file))];
  const phaseContext = {};
  for (const key of ['bugs', 'findings', 'skepticResults', 'phaseSpecificContext',
    'adaptivePlan', 'retrievalPlan', 'verificationPlan', 'cachedFacts']) {
    if (key in payload) phaseContext[key] = payload[key];
  }
  const json = (value) => JSON.stringify(value, null, 2);
  const values = {
    ROLE_NAME: role,
    ROLE_DESCRIPTION: ROLE_DESCRIPTIONS[role],
    PROMPT_CONTENT: roleText,
    TARGET_DESCRIPTION: json(payload.targetDescription ?? files),
    SKILL_DIR: INSTALLED_SKILL_ROOT,
    FILE_LIST: json(files),
    RISK_MAP: json(payload.riskMap ?? {}),
    TECH_STACK: json(payload.techStack ?? {}),
    PHASE_SPECIFIC_CONTEXT: json(phaseContext),
    SCOPE_MANIFEST_PATH: json(payload.scopeManifest ?? null),
    COMMIT_ALLOWED: String(payload.commitAllowed === true),
    WORKTREE_RULES: json(payload.worktreeRules ?? null),
    OUTPUT_FILE_PATH: resolvedOutput,
    OUTPUT_ARTIFACT: artifact
  };
  // Replace only template tokens, once. Role text and evidence may themselves
  // contain braces or replacement metacharacters and must stay byte-for-byte.
  return wrapper.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (token, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown wrapper placeholder: ${token}`);
    return values[key];
  }).trimEnd() + '\n';
}

function boundaryPairs(index, triage) {
  if (!index.reverseDependencies || !triage.domainFileLists) {
    throw new Error('boundary-pairs requires index.reverseDependencies and triage.domainFileLists');
  }
  const domainByFile = new Map();
  for (const [domain, files] of Object.entries(triage.domainFileLists)) {
    for (const file of files) domainByFile.set(path.resolve(file), domain);
  }
  const pairs = new Map();
  for (const [dependency, dependents] of Object.entries(index.reverseDependencies)) {
    for (const dependent of dependents) {
      const left = domainByFile.get(path.resolve(dependency));
      const right = domainByFile.get(path.resolve(dependent));
      if (!left || !right || left === right) continue;
      const domains = [left, right].sort();
      const key = JSON.stringify(domains);
      if (!pairs.has(key)) pairs.set(key, { domains, files: new Set() });
      pairs.get(key).files.add(dependency);
      pairs.get(key).files.add(dependent);
    }
  }
  return [...pairs.keys()].sort().map((key) => pairs.get(key)).map((pair) => ({
    domains: pair.domains, files: [...pair.files].sort()
  }));
}

function lineRange(value) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(value));
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start
    ? [start, end] : null;
}

function dedupBoundaries(findings, reviewed) {
  if (!Array.isArray(findings) || !Array.isArray(reviewed)) {
    throw new Error('dedup-boundaries inputs must be arrays');
  }
  const result = { findings: [], reused: [] };
  // Overlap plus category is not defect identity: two different bugs can share
  // a range. A verdict is reused only for the same claim.
  const claimKey = (row) => typeof row.claim === 'string'
    ? row.claim.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : '';
  for (const finding of findings) {
    const range = lineRange(finding.lines);
    const matches = reviewed.filter((prior) => {
      const previous = lineRange(prior.lines);
      return range && previous && finding.file && prior.file && finding.category &&
        path.resolve(finding.file) === path.resolve(prior.file) &&
        finding.category === prior.category &&
        claimKey(finding) !== '' && claimKey(finding) === claimKey(prior) &&
        range[0] <= previous[1] && previous[0] <= range[1] &&
        ['REAL_BUG', 'NOT_A_BUG', 'MANUAL_REVIEW'].includes(prior.verdict);
    });
    // Ambiguous overlaps stay in the review queue. Preserve the observation
    // when a unique reviewed identity can be reused; never silently drop it.
    const prior = matches.length === 1 ? matches[0] : null;
    const referee = prior && Object.fromEntries([
      'verdict', 'trueSeverity', 'confidenceScore', 'confidenceLabel',
      'verificationMode', 'analysisSummary', 'suggestedFix'
    ].filter((key) => key in prior).map((key) => [key, prior[key]]));
    if (referee) referee.bugId = finding.bugId;
    if (prior && validateArtifactValue({ artifactName: 'findings', value: [finding] }).ok &&
        validateArtifactValue({ artifactName: 'referee', value: [referee] }).ok) {
      result.reused.push({ finding, existingBugId: prior.bugId, verdict: prior.verdict, referee });
    } else {
      result.findings.push(finding);
    }
  }
  return result;
}

function mergeFindings(artifactPaths) {
  if (!Array.isArray(artifactPaths) || artifactPaths.some((file) => typeof file !== 'string')) {
    throw new Error('merge-findings requires an array of artifact file paths');
  }
  const findings = artifactPaths.flatMap((file) => {
    const rows = readPayload(file);
    const checked = validateArtifactValue({ artifactName: 'findings', value: rows });
    if (!checked.ok) throw new Error(`${file}: ${checked.errors.join('; ')}`);
    return rows;
  });
  if (new Set(findings.map((row) => row.bugId)).size !== findings.length) {
    throw new Error('Chunk findings need unique bugIds before merging');
  }
  return findings;
}

function writeOutput(outputPath, value) {
  if (!outputPath) throw new Error('An --out <file> is required');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, value, 'utf8');
}

function usage() {
  console.error('Usage:');
  console.error('  payload-guard.cjs validate <role> <payloadJsonPath>');
  console.error('  payload-guard.cjs generate <role> [outputJsonPath]');
  console.error('  payload-guard.cjs render <role> <payloadJsonPath> --out <taskFile>');
  console.error('  payload-guard.cjs merge-findings <artifactPathsJsonPath> --out <file>');
  console.error('  payload-guard.cjs boundary-pairs <indexJsonPath> <triageJsonPath> --out <file>');
  console.error('  payload-guard.cjs dedup-boundaries <findingsJsonPath> <reviewedJsonPath> --out <file>');
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

  if ('worktreeRules' in payload && typeof payload.worktreeRules !== 'string') {
    errors.push('worktreeRules must be a string containing descriptive worktree data');
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
  const [command, role, payloadJsonPath, ...options] = process.argv.slice(2);

  if (command === 'merge-findings') {
    if (!role || payloadJsonPath !== '--out' || options.length !== 1 || !options[0]) {
      usage();
      process.exit(1);
    }
    const outputPath = path.resolve(options[0]);
    const findings = mergeFindings(readPayload(role));
    writeOutput(outputPath, JSON.stringify(findings, null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, outputPath, findings: findings.length }));
    return;
  }

  if (['render', 'boundary-pairs', 'dedup-boundaries'].includes(command)) {
    if (!role || !payloadJsonPath || options.length !== 2 || options[0] !== '--out' || !options[1]) {
      usage();
      process.exit(1);
    }
    const outputPath = path.resolve(options[1]);
    const value = command === 'render'
      ? render(role, readPayload(payloadJsonPath))
      : JSON.stringify(command === 'boundary-pairs'
        ? boundaryPairs(readPayload(role), readPayload(payloadJsonPath))
        : dedupBoundaries(readPayload(role), readPayload(payloadJsonPath)), null, 2) + '\n';
    if (command === 'dedup-boundaries') {
      const prepared = JSON.parse(value);
      writeOutput(path.join(path.dirname(outputPath), 'reused-findings.json'),
        JSON.stringify(prepared.reused.map((row) => row.finding), null, 2) + '\n');
      writeOutput(path.join(path.dirname(outputPath), 'reused-referee.json'),
        JSON.stringify(prepared.reused.map((row) => row.referee), null, 2) + '\n');
    }
    writeOutput(outputPath, value);
    console.log(JSON.stringify({ ok: true, outputPath, bytes: Buffer.byteLength(value) }));
    return;
  }

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
