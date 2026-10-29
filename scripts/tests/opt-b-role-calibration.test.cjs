const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { validateArtifactValue } = require('../schema-runtime.cjs');
const { buildFixPlan, selectRefereeAuthorizedFindings } = require('../artifact-planner.cjs');

const root = path.resolve(__dirname, '..', '..');
const roles = ['hunter', 'skeptic', 'referee', 'recon', 'fixer'];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const skill = (role) => read(`skills/${role}/SKILL.md`);
const schema = (name) => JSON.parse(read(`schemas/${name}.schema.json`));

function markdownFiles(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return markdownFiles(relative);
    return entry.isFile() && entry.name.endsWith('.md') ? [relative] : [];
  });
}

function checkShippedInstructions(source, file) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  assert.doesNotMatch(frontmatter, /^\s*(?:prompt|["']prompt["'])\s*:/m, file);
  assert.doesNotMatch(source, /agnents/i, file);
}

function checkEnumLiterals(source, file) {
  const enums = {
    severity: schema('shared').$defs.severity.enum,
    trueSeverity: schema('shared').$defs.severity.enum,
    response: schema('skeptic').items.properties.response.enum,
    verdict: file.includes('/skeptic/')
      ? schema('skeptic').items.properties.response.enum
      : schema('referee').items.properties.verdict.enum
  };
  let checked = 0;
  const check = (key, value) => {
    assert.ok(enums[key].includes(value), `${file}: invalid ${key} literal ${JSON.stringify(value)}`);
    checked += 1;
  };
  for (const match of source.matchAll(/["']?(trueSeverity|severity|response|verdict)["']?\s*:\s*["']([^"'\n]+)["']/g)) {
    check(match[1], match[2]);
  }
  for (const match of source.matchAll(/(?:\*\*)?(Verdict|VERDICT|Severity)(?:\*\*)?:\s*(?:\*\*)?`?([^`|\n*]+)`?/g)) {
    check(match[1] === 'Severity' ? 'severity' : 'verdict', match[2].trim());
  }
  for (const match of source.matchAll(/^## Example \d+: (ACCEPT[^—\n]*|DISPROVE[^—\n]*|MANUAL[ _]REVIEW[^—\n]*)\s*—/gm)) {
    check('verdict', match[1].trim());
  }
  for (const match of source.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    if (/^(?:ACCEPT|DISPROVE|MANUAL[ _]REVIEW|REAL[ _]BUG|NOT[ _]A[ _]BUG)(?:\b|_)/.test(match[1])) {
      check(/^(?:ACCEPT|DISPROVE)/.test(match[1]) ? 'response' : 'verdict', match[1]);
    }
  }
  return checked;
}

function rubric(source) {
  return source.match(/## Severity rubric\n\n((?:- \*\*\w+\*\*:[^\n]+\n?)+)/)?.[1].trim();
}

function referee(overrides = {}) {
  return {
    bugId: 'BUG-1', verdict: 'REAL_BUG', trueSeverity: 'High',
    confidenceScore: 92, confidenceLabel: 'high', verificationMode: 'INDEPENDENTLY_VERIFIED',
    analysisSummary: 'High: common valid input crashes; src/profile.ts:8 dereferences null.',
    ...overrides
  };
}

function finding(overrides = {}) {
  return {
    bugId: 'BUG-1', severity: 'High', category: 'api-contract', file: 'src/profile.ts', lines: '8',
    claim: 'Missing profile crashes the caller.', evidence: 'src/profile.ts:8 profile.name',
    runtimeTrigger: 'Open a valid account with no profile.', crossReferences: ['src/client.ts:4'],
    confidenceScore: 92, confidenceLabel: 'high', stride: 'N/A', cwe: 'N/A', ...overrides
  };
}

test('opt-b: Hunter and Referee use the same complete schema severity rubric', () => {
  const hunter = rubric(skill('hunter'));
  assert.ok(hunter, 'Hunter must define a severity rubric');
  assert.equal(hunter, rubric(skill('referee')));
  assert.deepEqual([...hunter.matchAll(/^- \*\*(\w+)\*\*:/gm)].map((match) => match[1]), schema('shared').$defs.severity.enum);
  assert.match(hunter, /High[^\n]*authenticated privilege escalation[^\n]*normal concurrent load[^\n]*common valid input/i);
  assert.match(skill('referee'), /rubric line.*analysisSummary/);
});

test('opt-b: settled exclusions require checked code and preserve risky behavioral cases', () => {
  const source = skill('skeptic');
  assert.match(source, /Settled false-positive classes/);
  assert.doesNotMatch(source, /auto-dismiss|zero-analysis|Do not re-read code|trusted input\)/);
  assert.match(source, /checked precondition or defensive mechanism/);
  assert.match(source, /counterEvidence[^\n]*file:line/);
  assert.match(source, /otherwise[^\n]*MANUAL_REVIEW/i);
  for (const pattern of [/data races are not excluded/i, /log (?:injection|spoofing)/i, /path-only SSRF/i,
    /ReDoS/, /Environment variables and CLI flags/, /server-side.*check/]) {
    assert.match(source, pattern);
  }
  assert.doesNotMatch(source, />1s|> ?1 ?second|Go is memory.safe|server enforces auth/);
  for (const pattern of [/Log injection\/spoofing:[^\n]*encoding[^\n]*consumer[^\n]*trust boundary/,
    /Path-only SSRF:[^\n]*redirects[^\n]*credentials[^\n]*endpoints/,
    /ReDoS:[^\n]*input bounds[^\n]*latency\/concurrency/,
    /Environment variables and CLI flags:[^\n]*who supplies[^\n]*tenant\/job\/CI/,
    /server-side authorization check[^\n]*exact operation and principal/]) assert.match(source, pattern);
  assert.match(source, /memory-corruption exploits[^\n]*bounds-check panics[^\n]*nil dereferences/);
});

test('opt-b: DISPROVE requires counter-evidence while uncertainty remains representable', () => {
  const base = { bugId: 'BUG-1', analysisSummary: 'Need to trace the publisher.' };
  for (const response of ['ACCEPT', 'MANUAL_REVIEW']) {
    assert.equal(validateArtifactValue({ artifactName: 'skeptic', value: [{ ...base, response }] }).ok, true);
  }
  for (const counterEvidence of [undefined, '', '   ', 'The framework protects it.']) {
    const value = [{ ...base, response: 'DISPROVE', ...(counterEvidence === undefined ? {} : { counterEvidence }) }];
    assert.equal(validateArtifactValue({ artifactName: 'skeptic', value }).ok, false);
  }
  assert.equal(validateArtifactValue({ artifactName: 'skeptic', value: [{ ...base, response: 'DISPROVE', counterEvidence: 'src/auth.ts:12 rejects non-admins.' }] }).ok, true);
  // Framework routing paths are valid citations.
  for (const citation of ['app/api/users/[id]/route.ts:12', 'app/(marketing)/page.tsx:4',
    'src/routes/+page.svelte:9', 'app/routes/$slug.tsx:3', '.github/workflows/ci.yml:10', '.eslintrc.json:5']) {
    const value = [{ ...base, response: 'DISPROVE', counterEvidence: `${citation} checks ownership first.` }];
    assert.equal(validateArtifactValue({ artifactName: 'skeptic', value }).ok, true, citation);
  }
  const clock = [{ ...base, response: 'DISPROVE', counterEvidence: 'The timeout at 12:00 resets it.' }];
  assert.equal(validateArtifactValue({ artifactName: 'skeptic', value: clock }).ok, false);
});

test('opt-b: confidence semantics are shared once and labels follow score bands', () => {
  const calibration = read('skills/hunter/confidence.md');
  assert.match(calibration, /estimated probability.*REAL_BUG.*severity/);
  assert.match(calibration, /90/);
  assert.match(calibration, /75/);
  for (const role of ['hunter', 'skeptic', 'referee']) {
    assert.match(skill(role), /\$SKILL_DIR\/skills\/hunter\/confidence\.md/);
  }
  // Bands are calibration guidance, not a schema gate: a label/score mismatch must not
  // reject an otherwise valid artifact (Fixer only acts on REAL_BUG verdicts).
  for (const artifactName of ['findings', 'referee']) {
    const base = artifactName === 'findings' ? finding() : referee();
    for (const [confidenceScore, confidenceLabel] of [[0, 'low'], [70, 'medium'], [85, 'high'], [80, 'high']]) {
      const result = validateArtifactValue({ artifactName, value: [{ ...base, confidenceScore, confidenceLabel }] });
      assert.equal(result.ok, true, `${artifactName} ${confidenceScore}: ${result.errors.join('; ')}`);
    }
  }
  assert.match(calibration, /high.*>= 85.*medium.*>= 70.*low.*< 70/s);
  const { confidenceLabel, ...unlabelled } = finding();
  assert.equal(validateArtifactValue({ artifactName: 'findings', value: [unlabelled] }).ok, true);
});

test('opt-b: uncertainty has a Referee path and never becomes confirmation by incentive or presentation', () => {
  for (const role of ['hunter', 'skeptic']) {
    assert.doesNotMatch(skill(role), /\bpoints\b|penalty|expected value|safer to ACCEPT|When in doubt.*ACCEPT/i);
  }
  const source = skill('referee');
  assert.doesNotMatch(source, /Whose.*(?:specific|concrete)|quotes.*beat|flip to REAL/);
  for (const response of schema('skeptic').items.properties.response.enum) {
    assert.match(source, new RegExp('`' + response + '`[^\n]*Tier 1'));
  }
  assert.match(source, /Tier 2[^\n]*quote check/);
  assert.match(source, /cannot.*(?:defensive|counter-evidence)[^\n]*MANUAL_REVIEW/);
  assert.match(source, /checked causal chain/);
});

test('opt-b: unresolved dismissal re-checks cannot enter the Fixer queue', () => {
  assert.match(skill('referee'), /MANUAL_REVIEW[^\n]*confidenceScore[^\n]*74/);
  const unresolved = referee({ verdict: 'MANUAL_REVIEW', confidenceScore: 74, confidenceLabel: 'medium' });
  assert.equal(validateArtifactValue({ artifactName: 'referee', value: [unresolved] }).ok, true);
  const authorized = selectRefereeAuthorizedFindings({ bugLedger: [finding()], authorization: { verdicts: [unresolved] } });
  const plan = buildFixPlan({ bugLedger: authorized, confidenceThreshold: 75, canarySize: 1 });
  assert.deepEqual(authorized, []);
  assert.equal(plan.totals.eligible, 0);
});

test('opt-b: Hunter security sweep requires input, trigger and observable harm', () => {
  const source = skill('hunter');
  const sweep = source.match(/### Phase 3:([\s\S]*?)### Phase 3b:/)?.[1] || '';
  for (const name of ['JWT/session', 'Content-Type/size limits', 'non-expiring tokens', 'stack traces', 'rate limiting', 'CSRF', 'open redirects']) assert.ok(sweep.includes(name), name);
  assert.match(sweep, /attacker input.*observable harm.*runtimeTrigger/);
  assert.match(sweep, /settled false-positive/);
  assert.match(sweep, /hardening/);
});

test('opt-b: shipped Markdown rejects operator prompt frontmatter and misspelled instructions', () => {
  // modes/ carry documentation frontmatter (title/description/prompt) by convention;
  // role context (skills, templates, generated prompts) must not.
  for (const directory of ['skills', 'templates', 'prompts']) {
    for (const file of markdownFiles(directory)) checkShippedInstructions(read(file), file);
  }
  for (const source of ['---\nprompt: |\n  do work\n---\n', '---\n"prompt": test\n---\n', 'launch parallel agnents']) {
    assert.throws(() => checkShippedInstructions(source, 'mutation.md'));
  }
});

test('opt-b: role and example verdict/severity literals belong to schema enums', () => {
  let checked = 0;
  for (const role of roles) {
    for (const file of markdownFiles(`skills/${role}`)) checked += checkEnumLiterals(read(file), file);
  }
  assert.ok(checked >= 20, `Only ${checked} literals checked`);
  for (const [file, source] of [['skills/skeptic/examples.md', '**Verdict:** `ACCEPT (LOW CONFIDENCE)`'],
    ['skills/hunter/examples.md', '"severity": "Severe"'], ['skills/referee/SKILL.md', '**VERDICT: REAL BUG**']]) {
    assert.throws(() => checkEnumLiterals(source, file));
  }
});

test('opt-b: role JSON examples validate and include nullable-contract and Go-race controls', () => {
  for (const role of roles) {
    for (const file of markdownFiles(`skills/${role}`)) {
      for (const block of read(file).matchAll(/```json\n([\s\S]*?)\n```/g)) {
        const value = JSON.parse(block[1]);
        const artifactName = { hunter: 'findings', fixer: 'fix-report' }[role] || role;
        const validation = validateArtifactValue({ artifactName, value });
        assert.equal(validation.ok, true, `${file}: ${validation.errors.join('; ')}`);
      }
    }
  }
  for (const role of ['hunter', 'skeptic']) {
    const examples = read(`skills/${role}/examples.md`);
    assert.match(examples, /nullable/i);
    assert.match(examples, /sync\.Mutex|sync\.Map/);
    assert.doesNotMatch(examples, /Points:|cannot find.*accept/i);
  }
  const examples = read('skills/skeptic/examples.md');
  for (const name of ['nullable', 'Go map']) {
    const section = examples.match(new RegExp('## [^\\n]*' + name + '[\\s\\S]*?(?=\\n## |$)', 'i'))?.[0] || '';
    assert.match(section, /"response": "ACCEPT"/);
    assert.match(section, /"response": "DISPROVE"/);
  }
});

test('opt-b: report scope permits reading callers, guards, config and tests as evidence', () => {
  const rule = 'Report only findings in assigned files. You may READ other repository files (callers, guards, config, tests) as evidence; this does not expand report scope.';
  for (const role of ['hunter', 'skeptic', 'referee']) assert.ok(skill(role).includes(rule), role);
  assert.doesNotMatch(skill('hunter'), /don't investigate|Only analyze files/);
  assert.doesNotMatch(skill('skeptic'), /Only read referenced files/);
});

test('opt-b: Recon enriches triage without reclassifying and isolates discovery fallback', () => {
  const source = skill('recon');
  assert.match(source, /triage\.json/);
  assert.match(source, /Do not reclassify/);
  assert.match(source, /riskMap\['context-only'\].*contextOnly/);
  assert.match(source, /no file-level riskMap[^\n]*empty/);
  assert.match(source, /absent or invalid[^\n]*discovery-fallback\.md/);
  assert.doesNotMatch(source, /fd -e|find <target>|Glob\(|average_lines_per_file|> 200/);
  const fallback = read('skills/recon/discovery-fallback.md');
  assert.match(fallback, /scripts\/triage\.cjs/);
  assert.match(fallback, /source-config\.cjs/);
  assert.doesNotMatch(fallback, /fd -e|\*\.\{ts|\.tsx?\b.*\.jsx?\b/);
  const example = JSON.parse([...source.matchAll(/```json\n([\s\S]*?)\n```/g)][0][1]);
  const triage = { riskMap: { critical: ['src/api/admin.ts'], high: ['src/services/payment.ts'], medium: ['src/lib/parse.ts'], 'context-only': ['src/api/admin.test.ts'] } };
  for (const [field, tier] of [['critical', 'critical'], ['high', 'high'], ['medium', 'medium'], ['contextOnly', 'context-only']]) {
    assert.deepEqual(example[field], triage.riskMap[tier]);
  }
});

test('opt-b: conditional guidance loads only for adaptive context or confirmed security', () => {
  assert.match(skill('hunter'), /Only when[^\n]*adaptive[^\n]*retrieval[^\n]*adaptive-context\.md/);
  assert.doesNotMatch(skill('hunter'), /Cached facts are hints bound/);
  assert.match(read('skills/hunter/adaptive-context.md'), /source hashes/);
  assert.match(skill('referee'), /Only when[^\n]*security[^\n]*REAL_BUG[^\n]*security-enrichment\.md/);
  assert.doesNotMatch(skill('referee'), /CVSS:3\.1\/|AV=Attack Vector/);
  const security = read('skills/referee/security-enrichment.md');
  assert.match(security, /analysisSummary/);
  assert.match(security, /suggestedFix/);
  assert.match(security, /CVSS:3\.1\//);
});

test('opt-b: always-loaded role byte budget does not grow', () => {
  const baseline = { hunter: 10331, skeptic: 9211, referee: 7619, recon: 6838, fixer: 7018 };
  let before = 0;
  let after = 0;
  for (const role of roles) {
    before += baseline[role];
    after += Buffer.byteLength(skill(role));
    if (['hunter', 'referee', 'recon'].includes(role)) assert.ok(Buffer.byteLength(skill(role)) < baseline[role], role);
  }
  for (const role of ['hunter', 'skeptic', 'referee']) {
    assert.ok(Buffer.byteLength(skill(role)) + Buffer.byteLength(read('skills/hunter/confidence.md')) <= baseline[role], `${role} including shared calibration`);
  }
  assert.ok(after <= before, `${before} B -> ${after} B`);
  const allMarkdownBytes = roles.flatMap((role) => markdownFiles(`skills/${role}`))
    .reduce((total, file) => total + Buffer.byteLength(read(file)), 0);
  assert.ok(allMarkdownBytes <= 50387, `Owned Markdown including references: 50387 B -> ${allMarkdownBytes} B`);
});
