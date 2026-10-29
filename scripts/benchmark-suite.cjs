#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { validateArtifactValue } = require('./schema-runtime.cjs');

const BENCHMARK_ROOT = path.resolve(__dirname, '..', 'evals', 'benchmark');
const EVIDENCE_KINDS = new Set(['synthetic', 'replayed', 'live']);

const SEVERITY_RANK = Object.freeze({ Low: 0, Medium: 1, High: 2, Critical: 3 });
const SEVERITY_WEIGHT = Object.freeze({ Low: 1, Medium: 2, High: 4, Critical: 8 });
const FORBIDDEN_PUBLIC_KEYS = new Set([
  'expected',
  'labels',
  'findings',
  'bugIds',
  'keywordGroups',
  'runtimeTrigger',
  'claim',
  'evidence'
]);

function usage() {
  console.error('Usage:');
  console.error('  benchmark-suite.cjs score --manifest <public.json> --labels <private.json> --runs <runs.json> [--output <report.json>]');
  console.error('  benchmark-suite.cjs gate --report <report.json>');
  console.error('  benchmark-suite.cjs validate-public --manifest <public.json>');
  console.error('  benchmark-suite.cjs record --run-dir <directory> --case <id> --profile <profile> --repeat <n> --output <runs.json> [--manifest <public.json>] [--labels <private.json>] [--telemetry <usage.json>] [--evidence-kind live|replayed|synthetic]');
  console.error('  benchmark-suite.cjs compare --baseline <report.json> --candidate <report.json> [--output <comparison.json>]');
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${token} requires a value`);
    }
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function ratio(numerator, denominator, emptyValue = 1) {
  return denominator === 0 ? emptyValue : numerator / denominator;
}

function percentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * clamp(quantile, 0, 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function fileMatches(actual, expected) {
  const left = normalizePath(actual);
  const right = normalizePath(expected);
  return Boolean(left && right && left === right && isRelativeFile(left));
}

function parseLineRange(value) {
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(value || '').trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}

function isRelativeFile(value) {
  return typeof value === 'string' && value.length > 0 && !path.posix.isAbsolute(value)
    && !/^[A-Za-z]:/.test(value) && !value.split('/').some((part) => part === '..' || part === '.' || !part);
}

function findingErrors(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return ['finding must be an object'];
  const { emittedAtMs, ...canonical } = finding;
  const errors = validateArtifactValue({ artifactName: 'findings', value: [canonical] }).errors;
  if (!isRelativeFile(normalizePath(finding.file))) errors.push('file must be case-relative without traversal');
  if (!parseLineRange(finding.lines)) errors.push('lines must be a positive ordered line range');
  if (emittedAtMs !== undefined && !isMeasurement(emittedAtMs)) errors.push('emittedAtMs must be nonnegative');
  return errors;
}

function isMeasurement(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function measurement(value) {
  return isMeasurement(value) ? value : null;
}

function lineOverlapScore(actual, expected) {
  const left = parseLineRange(actual);
  const right = parseLineRange(expected);
  if (!right) return 1;
  if (!left) return 0;
  const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start) + 1);
  const span = Math.max(left.end, right.end) - Math.min(left.start, right.start) + 1;
  return span <= 0 ? 0 : overlap / span;
}

function findingText(finding) {
  return [
    finding.claim,
    finding.evidence,
    finding.runtimeTrigger
  ].filter((value) => typeof value === 'string').join(' ').toLowerCase();
}

function keywordScore(finding, label) {
  const groups = Array.isArray(label.keywordGroups) ? label.keywordGroups : [];
  if (groups.length === 0) return 1;
  const text = findingText(finding);
  const matchedGroups = groups.filter((group) => {
    return Array.isArray(group) && group.some((keyword) => text.includes(String(keyword).toLowerCase()));
  }).length;
  return matchedGroups / groups.length;
}

function severityScore(actual, expected) {
  if (!expected) return 1;
  const left = SEVERITY_RANK[actual];
  const right = SEVERITY_RANK[expected];
  if (!Number.isInteger(left) || !Number.isInteger(right)) return 0;
  return 1 - (Math.abs(left - right) / 3);
}

function candidateScore(finding, label) {
  if (findingErrors(finding).length > 0) return 0;
  if (!fileMatches(finding.file, label.file)) return 0;
  const actualRange = parseLineRange(finding.lines);
  const expectedRange = parseLineRange(label.lines);
  const tolerance = Number.isSafeInteger(label.lineTolerance) && label.lineTolerance >= 0 && label.lineTolerance <= 10
    ? label.lineTolerance : 5;
  if (!expectedRange || actualRange.end < expectedRange.start - tolerance
    || actualRange.start > expectedRange.end + tolerance) return 0;
  if (Math.abs(SEVERITY_RANK[finding.severity] - SEVERITY_RANK[label.severity]) > 1) return 0;
  const category = !label.category || finding.category === label.category ? 1 : 0;
  const keywords = keywordScore(finding, label);
  const groups = Array.isArray(label.keywordGroups) ? label.keywordGroups : [];
  if (groups.length === 0 || keywords < 1) return 0;
  const lines = lineOverlapScore(finding.lines, label.lines);
  const severity = severityScore(finding.severity, label.severity);
  return (0.4) + (0.15 * category) + (0.3 * keywords) + (0.1 * lines) + (0.05 * severity);
}

function matchFindings(findings, labels, minimumScore = 0.7) {
  const candidates = [];
  findings.forEach((finding, findingIndex) => {
    labels.forEach((label, labelIndex) => {
      const score = candidateScore(finding, label);
      if (score >= minimumScore) {
        candidates.push({ findingIndex, labelIndex, score });
      }
    });
  });
  candidates.sort((a, b) => b.score - a.score
    || a.findingIndex - b.findingIndex
    || a.labelIndex - b.labelIndex);

  const usedFindings = new Set();
  const usedLabels = new Set();
  const matches = [];
  for (const candidate of candidates) {
    if (usedFindings.has(candidate.findingIndex) || usedLabels.has(candidate.labelIndex)) continue;
    usedFindings.add(candidate.findingIndex);
    usedLabels.add(candidate.labelIndex);
    matches.push({
      ...candidate,
      finding: findings[candidate.findingIndex],
      label: labels[candidate.labelIndex]
    });
  }
  return {
    matches,
    unmatchedFindingIndexes: findings.map((_, index) => index).filter((index) => !usedFindings.has(index)),
    unmatchedLabelIndexes: labels.map((_, index) => index).filter((index) => !usedLabels.has(index))
  };
}

function fingerprintFinding(finding) {
  return [
    normalizePath(finding.file),
    String(finding.lines || '').replace(/\s+/g, ''),
    String(finding.category || '').toLowerCase()
  ].join('|');
}

function jaccard(leftValues, rightValues) {
  const left = new Set(leftValues);
  const right = new Set(rightValues);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / union.size;
}

function calibrationMetrics(outcomes) {
  if (outcomes.length === 0) {
    return { brierScore: 0, expectedCalibrationError: 0, bins: [] };
  }
  const bins = Array.from({ length: 10 }, (_, index) => ({
    min: index / 10,
    max: (index + 1) / 10,
    count: 0,
    confidenceTotal: 0,
    correctTotal: 0
  }));
  let brierTotal = 0;
  for (const outcome of outcomes) {
    const confidence = clamp(finiteNumber(outcome.confidence, 50) / 100, 0, 1);
    const correct = outcome.correct ? 1 : 0;
    brierTotal += (confidence - correct) ** 2;
    const binIndex = Math.min(9, Math.floor(confidence * 10));
    const bin = bins[binIndex];
    bin.count += 1;
    bin.confidenceTotal += confidence;
    bin.correctTotal += correct;
  }
  let ece = 0;
  const renderedBins = bins.filter((bin) => bin.count > 0).map((bin) => {
    const averageConfidence = bin.confidenceTotal / bin.count;
    const accuracy = bin.correctTotal / bin.count;
    ece += (bin.count / outcomes.length) * Math.abs(accuracy - averageConfidence);
    return {
      min: bin.min,
      max: bin.max,
      count: bin.count,
      averageConfidence,
      accuracy
    };
  });
  return {
    brierScore: brierTotal / outcomes.length,
    expectedCalibrationError: ece,
    bins: renderedBins
  };
}

function validatePublicManifest(manifest, { manifestPath = path.join(BENCHMARK_ROOT, 'public-manifest.json'), labels } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['public manifest must be a JSON object'] };
  }
  if (manifest.schemaVersion !== 1) errors.push('public manifest schemaVersion must equal 1');
  if (!String(manifest.suiteId || '').trim()) errors.push('public manifest suiteId is required');
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    errors.push('public manifest cases must be a non-empty array');
    return { ok: false, errors };
  }
  const ids = new Set();
  if (!labels) {
    try {
      labels = readJson(path.join(path.dirname(manifestPath), 'private-labels.json'));
    } catch (error) {
      errors.push(`cannot load calibration labels for leak check: ${error.message}`);
    }
  }
  if (!Array.isArray(labels?.cases)) errors.push('calibration labels require a cases array for leak checks');
  const privateById = new Map((Array.isArray(labels?.cases) ? labels.cases : []).filter(Boolean).map((entry) => [entry.id, entry]));
  const visit = (value, location) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${location}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) {
        errors.push(`public manifest leaks private key ${location}.${key}`);
      }
      visit(child, `${location}.${key}`);
    }
  };
  visit(manifest.cases || [], '$.cases');
  const requiredRepeats = Number(manifest.requiredRepeats ?? 1);
  if (!Number.isSafeInteger(requiredRepeats) || requiredRepeats < 1 || requiredRepeats > 100) {
    errors.push('public manifest requiredRepeats must be an integer from 1 to 100');
  }
  if (manifest.requiredProfiles !== undefined
    && (!Array.isArray(manifest.requiredProfiles)
      || manifest.requiredProfiles.length === 0
      || manifest.requiredProfiles.some((profile) => !String(profile || '').trim()))) {
    errors.push('public manifest requiredProfiles must be a non-empty array of profile names');
  }
  for (const entry of manifest.cases || []) {
    if (!entry || typeof entry !== 'object') {
      errors.push('every public case must be an object');
      continue;
    }
    const id = String(entry.id || '').trim();
    if (!id) errors.push('every public case requires an id');
    if (ids.has(id)) errors.push(`duplicate public case id: ${id}`);
    ids.add(id);
    const kloc = finiteNumber(entry.kloc, -1);
    if (kloc < 0) errors.push(`case ${id || '<unknown>'} requires nonnegative kloc`);
    if (!Array.isArray(entry.sourceFiles) || entry.sourceFiles.length === 0) {
      errors.push(`case ${id || '<unknown>'} requires a non-empty sourceFiles array`);
      continue;
    }
    if (typeof entry.root !== 'string' || !entry.root || path.isAbsolute(entry.root)) {
      errors.push(`case ${id} requires a relative root`);
      continue;
    }
    const root = path.resolve(path.dirname(manifestPath), entry.root);
    const relativeRoot = path.relative(path.resolve(path.dirname(manifestPath), '..'), root);
    if (relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) {
      errors.push(`case ${id} root escapes corpus parent`);
      continue;
    }
    for (const sourceFile of entry.sourceFiles) {
      if (!isRelativeFile(sourceFile)) {
        errors.push(`case ${id} has an invalid source file path`);
        continue;
      }
      const digest = entry.sha256?.[sourceFile];
      if (!/^[a-f0-9]{64}$/.test(digest || '')) errors.push(`case ${id} missing sha256 for ${sourceFile}`);
      try {
        const filePath = path.resolve(root, sourceFile);
        const relative = path.relative(fs.realpathSync(root), fs.realpathSync(filePath));
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('source escapes case root');
        const content = fs.readFileSync(filePath);
        if (sha256Buffer(content) !== digest) errors.push(`case ${id} digest mismatch: ${sourceFile}`);
        const source = content.toString('utf8');
        if (/\bBUG\s*\d+|\bshould be\b|silently swallowed/i.test(source)) {
          errors.push(`case ${id} answer comment leak: ${sourceFile}`);
        }
        const privateFindings = privateById.get(id)?.findings;
        for (const label of Array.isArray(privateFindings) ? privateFindings : []) {
          for (const keyword of (Array.isArray(label?.keywordGroups) ? label.keywordGroups : []).flat()) {
            if (source.toLowerCase().includes(String(keyword).toLowerCase())) {
              errors.push(`case ${id} keyword leak for ${label.labelId}: ${sourceFile}`);
            }
          }
        }
      } catch (error) {
        errors.push(`case ${id} cannot read ${sourceFile}: ${error.message}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateInputs({ manifest, labels, runs, manifestPath }) {
  const publicValidation = validatePublicManifest(manifest, { manifestPath, labels });
  const errors = [...publicValidation.errors];
  if (!publicValidation.ok) return publicValidation;
  if (!labels || labels.schemaVersion !== 1 || !Array.isArray(labels.cases)) {
    errors.push('private labels must use schemaVersion 1 and contain a cases array');
  }
  if (!runs || runs.schemaVersion !== 1 || !Array.isArray(runs.runs)) {
    errors.push('runs must use schemaVersion 1 and contain a runs array');
  }
  if (!manifest || !Array.isArray(manifest.cases) || !Array.isArray(labels?.cases) || !Array.isArray(runs?.runs)) {
    return { ok: false, errors };
  }
  if (labels && labels.suiteId !== manifest.suiteId) errors.push('private labels suiteId does not match public manifest');
  if (runs && runs.suiteId !== manifest.suiteId) errors.push('runs suiteId does not match public manifest');
  if (!EVIDENCE_KINDS.has(runs?.evidenceKind)) errors.push('runs evidenceKind must be synthetic, replayed, or live');
  if (manifestPath && labels) {
    const actual = sha256File(manifestPath);
    if (!/^[a-f0-9]{64}$/.test(String(labels.publicManifestSha256 || ''))) {
      errors.push('private labels must contain publicManifestSha256');
    } else if (actual !== labels.publicManifestSha256) {
      errors.push(`private labels are bound to public manifest ${labels.publicManifestSha256}, got ${actual}`);
    }
  }
  const publicIds = new Set((manifest.cases || []).map((entry) => entry.id));
  const labelIds = new Set(labels.cases.filter(Boolean).map((entry) => entry.id));
  const seenPrivateLabelIds = new Set();
  for (const privateCase of labels && labels.cases || []) {
    if (!privateCase || !Array.isArray(privateCase.findings)) {
      errors.push(`private case ${privateCase?.id || '<unknown>'} findings must be an array`);
      continue;
    }
    for (const label of privateCase.findings) {
      if (!label || typeof label !== 'object') {
        errors.push(`private case ${privateCase.id} labels must be objects`);
        continue;
      }
      const labelId = String(label.labelId || '').trim();
      if (!labelId) errors.push(`private case ${privateCase.id || '<unknown>'} has a finding without labelId`);
      if (seenPrivateLabelIds.has(labelId)) errors.push(`duplicate private labelId: ${labelId}`);
      seenPrivateLabelIds.add(labelId);
      if (!String(label.file || '').trim()) errors.push(`private label ${labelId || '<unknown>'} requires file`);
      if (!String(label.category || '').trim()) errors.push(`private label ${labelId || '<unknown>'} requires category`);
      const publicCase = (manifest.cases || []).find((entry) => entry.id === privateCase.id);
      if (!publicCase?.sourceFiles.includes(label.file)) errors.push(`private label ${labelId} file is not a case source`);
      if (!parseLineRange(label.lines)) errors.push(`private label ${labelId} requires lines`);
      if (!Array.isArray(label.keywordGroups) || label.keywordGroups.length === 0
        || label.keywordGroups.some((group) => !Array.isArray(group) || group.length === 0
          || group.some((keyword) => typeof keyword !== 'string' || !keyword.trim()))) {
        errors.push(`private label ${labelId} requires mechanism keywordGroups`);
      }
      if (label.lineTolerance !== undefined && (!Number.isSafeInteger(label.lineTolerance)
        || label.lineTolerance < 0 || label.lineTolerance > 10)) errors.push(`private label ${labelId} invalid lineTolerance`);
      if (!Object.prototype.hasOwnProperty.call(SEVERITY_RANK, label.severity)) {
        errors.push(`private label ${labelId || '<unknown>'} has invalid severity`);
      }
    }
  }
  for (const id of publicIds) {
    if (!labelIds.has(id)) errors.push(`private labels missing public case: ${id}`);
  }
  for (const id of labelIds) {
    if (!publicIds.has(id)) errors.push(`private labels contain unknown public case: ${id}`);
  }
  const seenRunIds = new Set();
  const repeatCoverage = new Map();
  for (const run of runs && runs.runs || []) {
    if (!run || typeof run !== 'object') {
      errors.push('every run must be an object');
      continue;
    }
    const runId = String(run.runId || '').trim();
    if (!runId) errors.push('every run requires runId');
    if (seenRunIds.has(runId)) errors.push(`duplicate runId: ${runId}`);
    seenRunIds.add(runId);
    if (!publicIds.has(run.caseId)) errors.push(`run ${runId || '<unknown>'} references unknown case ${run.caseId}`);
    if (!Array.isArray(run.findings)) {
      errors.push(`run ${runId || '<unknown>'} findings must be an array`);
    } else {
      for (const finding of run.findings) {
        errors.push(...findingErrors(finding).map((error) => `run ${runId}: ${error}`));
      }
    }
    const repeat = Number(run.repeat);
    if (!Number.isSafeInteger(repeat) || repeat < 1) errors.push(`run ${runId || '<unknown>'} repeat must be a positive integer`);
    for (const field of ['inputTokens', 'outputTokens', 'durationMs', 'costUsd']) {
      if (run[field] !== undefined && run[field] !== null && !isMeasurement(run[field])) {
        errors.push(`run ${runId || '<unknown>'} ${field} must be nonnegative or null (unknown)`);
      }
    }
    const coverage = run.coverage || {};
    const filesDone = Number(coverage.filesDone);
    const filesTotal = Number(coverage.filesTotal);
    const publicCase = manifest.cases.find((entry) => entry.id === run.caseId);
    if (!Number.isSafeInteger(filesDone) || !Number.isSafeInteger(filesTotal)
      || filesDone < 0 || filesTotal < 0 || filesDone > filesTotal) {
      errors.push(`run ${runId || '<unknown>'} has invalid coverage counts`);
    }
    if (publicCase && filesTotal !== publicCase.sourceFiles.length) errors.push(`run ${runId} coverage filesTotal differs from case source count`);
    const profile = String(run.profile || 'default');
    const key = `${run.caseId}|${profile}`;
    const repeats = repeatCoverage.get(key) || new Set();
    if (repeats.has(repeat)) errors.push(`duplicate repeat ${repeat} for ${key}`);
    repeats.add(repeat);
    repeatCoverage.set(key, repeats);
  }
  const requiredProfiles = Array.isArray(manifest.requiredProfiles)
    ? manifest.requiredProfiles.map(String)
    : [...new Set((runs && runs.runs || []).map((run) => String(run.profile || 'default')))];
  const requiredRepeats = Number.isSafeInteger(Number(manifest.requiredRepeats))
    ? Number(manifest.requiredRepeats)
    : 1;
  for (const caseId of publicIds) {
    for (const profile of requiredProfiles) {
      const repeats = repeatCoverage.get(`${caseId}|${profile}`) || new Set();
      if (repeats.size < requiredRepeats) {
        errors.push(`case ${caseId} profile ${profile} requires ${requiredRepeats} unique repeat(s), got ${repeats.size}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function scoreRun({ run, publicCase, privateCase, matchThreshold }) {
  const findings = Array.isArray(run.findings) ? run.findings : [];
  const labels = Array.isArray(privateCase.findings) ? privateCase.findings : [];
  const matching = matchFindings(findings, labels, matchThreshold);
  const truePositives = matching.matches.length;
  const falsePositives = matching.unmatchedFindingIndexes.length;
  const falseNegatives = matching.unmatchedLabelIndexes.length;
  const precision = ratio(truePositives, truePositives + falsePositives, 1);
  const recall = ratio(truePositives, truePositives + falseNegatives, 1);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const expectedWeight = labels.reduce((sum, label) => sum + (SEVERITY_WEIGHT[label.severity] || 1), 0);
  const matchedWeight = matching.matches.reduce((sum, match) => sum + (SEVERITY_WEIGHT[match.label.severity] || 1), 0);
  const severityWeightedRecall = ratio(matchedWeight, expectedWeight, 1);
  const severityErrors = matching.matches.map((match) => {
    const actual = SEVERITY_RANK[match.finding.severity];
    const expected = SEVERITY_RANK[match.label.severity];
    return Number.isInteger(actual) && Number.isInteger(expected) ? Math.abs(actual - expected) : 3;
  });
  const matchedByFinding = new Map(matching.matches.map((match) => [match.findingIndex, match]));
  const calibrationSamples = findings.map((finding, index) => ({
    confidence: clamp(finiteNumber(finding.confidenceScore, 50), 0, 100),
    correct: matchedByFinding.has(index)
  }));
  const calibration = calibrationMetrics(calibrationSamples);
  const inputTokens = measurement(run.inputTokens);
  const outputTokens = measurement(run.outputTokens);
  const tokens = inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
  const durationMs = measurement(run.durationMs);
  const costUsd = measurement(run.costUsd);
  const completedFiles = Math.max(0, finiteNumber(run.coverage && run.coverage.filesDone));
  const totalFiles = Math.max(0, finiteNumber(run.coverage && run.coverage.filesTotal));
  const coverage = ratio(completedFiles, totalFiles, totalFiles === 0 ? 1 : 0);
  const matchedEmissionTimes = matching.matches
    .map((match) => measurement(match.finding.emittedAtMs))
    .filter(Number.isFinite);

  return {
    runId: run.runId,
    caseId: run.caseId,
    profile: String(run.profile || 'default'),
    repeat: Number.isInteger(run.repeat) ? run.repeat : 1,
    kloc: finiteNumber(publicCase.kloc),
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    severityWeightedRecall,
    expectedWeight,
    matchedWeight,
    severityExactAccuracy: ratio(severityErrors.filter((error) => error === 0).length, severityErrors.length, 1),
    meanSeverityRankError: severityErrors.length === 0
      ? 0
      : severityErrors.reduce((sum, value) => sum + value, 0) / severityErrors.length,
    calibration,
    calibrationSamples,
    coverage,
    inputTokens,
    outputTokens,
    totalTokens: tokens,
    durationMs,
    costUsd,
    tokensPerTruePositive: truePositives > 0 && tokens !== null ? tokens / truePositives : null,
    costPerTruePositiveUsd: truePositives > 0 && costUsd !== null ? costUsd / truePositives : null,
    timeToFirstTruePositiveMs: matchedEmissionTimes.length > 0 ? Math.min(...matchedEmissionTimes) : null,
    matchedLabelIds: matching.matches.map((match) => match.label.labelId).sort(),
    falsePositiveFingerprints: matching.unmatchedFindingIndexes.map((index) => fingerprintFinding(findings[index])).sort(),
    missingLabelIds: matching.unmatchedLabelIndexes.map((index) => labels[index].labelId).sort(),
    matches: matching.matches.map((match) => ({
      labelId: match.label.labelId,
      findingIndex: match.findingIndex,
      score: match.score
    }))
  };
}

function aggregateClassMetrics(scoredRuns, privateCases) {
  const classTotals = new Map();
  const labelsByCase = new Map(privateCases.map((entry) => [entry.id, entry]));
  for (const run of scoredRuns) {
    const privateCase = labelsByCase.get(run.caseId);
    const matched = new Set(run.matchedLabelIds);
    for (const label of privateCase?.findings || []) {
      const category = String(label.category || 'unknown');
      const bucket = classTotals.get(category) || { expected: 0, matched: 0 };
      bucket.expected += 1;
      if (matched.has(label.labelId)) bucket.matched += 1;
      classTotals.set(category, bucket);
    }
  }
  return Object.fromEntries([...classTotals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, value]) => {
    return [category, {
      ...value,
      recall: ratio(value.matched, value.expected, 1)
    }];
  }));
}

function repeatStability(scoredRuns) {
  const groups = new Map();
  for (const run of scoredRuns) {
    const key = `${run.profile}|${run.caseId}`;
    const values = groups.get(key) || [];
    values.push(run);
    groups.set(key, values);
  }
  const pairScores = [];
  const details = [];
  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;
    const scores = [];
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const leftSet = [...group[left].matchedLabelIds, ...group[left].falsePositiveFingerprints.map((value) => `fp:${value}`)];
        const rightSet = [...group[right].matchedLabelIds, ...group[right].falsePositiveFingerprints.map((value) => `fp:${value}`)];
        const score = jaccard(leftSet, rightSet);
        scores.push(score);
        pairScores.push(score);
      }
    }
    details.push({
      group: key,
      repeats: group.length,
      pairCount: scores.length,
      meanJaccard: scores.reduce((sum, value) => sum + value, 0) / scores.length,
      minJaccard: Math.min(...scores)
    });
  }
  return {
    groupCount: details.length,
    pairCount: pairScores.length,
    meanJaccard: pairScores.length === 0 ? 1 : pairScores.reduce((sum, value) => sum + value, 0) / pairScores.length,
    minimumJaccard: pairScores.length === 0 ? 1 : Math.min(...pairScores),
    groups: details
  };
}

function buildAggregate({ scoredRuns, privateCases, includeProfiles = true }) {
  const totals = scoredRuns.reduce((state, run) => {
    state.truePositives += run.truePositives;
    state.falsePositives += run.falsePositives;
    state.falseNegatives += run.falseNegatives;
    state.kloc += run.kloc;
    state.tokens = state.tokens === null || run.totalTokens === null ? null : state.tokens + run.totalTokens;
    state.durationMs = state.durationMs === null || run.durationMs === null ? null : state.durationMs + run.durationMs;
    state.costUsd = state.costUsd === null || run.costUsd === null ? null : state.costUsd + run.costUsd;
    state.expectedWeight += run.expectedWeight;
    state.matchedWeight += run.matchedWeight;
    return state;
  }, {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    kloc: 0,
    tokens: 0,
    durationMs: 0,
    costUsd: 0,
    expectedWeight: 0,
    matchedWeight: 0
  });
  const precision = ratio(totals.truePositives, totals.truePositives + totals.falsePositives, 1);
  const recall = ratio(totals.truePositives, totals.truePositives + totals.falseNegatives, 1);
  const calibrationOutcomes = scoredRuns.flatMap((run) => run.calibrationSamples || []);
  const calibration = calibrationMetrics(calibrationOutcomes);
  const tokenPerTpValues = scoredRuns.map((run) => run.tokensPerTruePositive).filter(Number.isFinite);
  const costPerTpValues = scoredRuns.map((run) => run.costPerTruePositiveUsd).filter(Number.isFinite);
  const durations = scoredRuns.map((run) => run.durationMs);
  const stability = repeatStability(scoredRuns);
  return {
    runCount: scoredRuns.length,
    caseCount: new Set(scoredRuns.map((run) => run.caseId)).size,
    truePositives: totals.truePositives,
    falsePositives: totals.falsePositives,
    falseNegatives: totals.falseNegatives,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    macroPrecision: scoredRuns.length === 0 ? 1 : scoredRuns.reduce((sum, run) => sum + run.precision, 0) / scoredRuns.length,
    macroRecall: scoredRuns.length === 0 ? 1 : scoredRuns.reduce((sum, run) => sum + run.recall, 0) / scoredRuns.length,
    macroF1: scoredRuns.length === 0 ? 1 : scoredRuns.reduce((sum, run) => sum + run.f1, 0) / scoredRuns.length,
    severityWeightedRecall: ratio(totals.matchedWeight, totals.expectedWeight, 1),
    severityExactAccuracy: scoredRuns.length === 0
      ? 1
      : scoredRuns.reduce((sum, run) => sum + run.severityExactAccuracy, 0) / scoredRuns.length,
    meanSeverityRankError: scoredRuns.length === 0
      ? 0
      : scoredRuns.reduce((sum, run) => sum + run.meanSeverityRankError, 0) / scoredRuns.length,
    coverage: scoredRuns.length === 0 ? 1 : scoredRuns.reduce((sum, run) => sum + run.coverage, 0) / scoredRuns.length,
    falsePositivesPerKloc: totals.kloc > 0 ? totals.falsePositives / totals.kloc : totals.falsePositives,
    totalTokens: totals.tokens,
    totalDurationMs: totals.durationMs,
    totalCostUsd: totals.costUsd,
    tokensPerTruePositive: totals.tokens !== null && totals.truePositives > 0 ? totals.tokens / totals.truePositives : null,
    costPerTruePositiveUsd: totals.costUsd !== null && totals.truePositives > 0 ? totals.costUsd / totals.truePositives : null,
    medianTokensPerTruePositive: totals.tokens === null ? null : percentile(tokenPerTpValues, 0.5),
    p95TokensPerTruePositive: totals.tokens === null ? null : percentile(tokenPerTpValues, 0.95),
    medianCostPerTruePositiveUsd: totals.costUsd === null ? null : percentile(costPerTpValues, 0.5),
    p95DurationMs: totals.durationMs === null ? null : percentile(durations, 0.95),
    telemetry: Object.fromEntries(['totalTokens', 'durationMs', 'costUsd'].map((field) => [field, {
      status: scoredRuns.every((run) => run[field] !== null) ? 'measured' : 'unknown',
      measuredRuns: scoredRuns.filter((run) => run[field] !== null).length,
      totalRuns: scoredRuns.length
    }])),
    expectedCalibrationError: calibration.expectedCalibrationError,
    brierScore: calibration.brierScore,
    pooledCalibration: calibration,
    repeatStability: stability,
    byCategory: aggregateClassMetrics(scoredRuns, privateCases),
    ...(includeProfiles ? { byProfile: Object.fromEntries([...new Set(scoredRuns.map((run) => run.profile))].sort().map((profile) => [
      profile, buildAggregate({ scoredRuns: scoredRuns.filter((run) => run.profile === profile), privateCases, includeProfiles: false })
    ])) } : {})
  };
}

function evaluateGate(aggregate, thresholds = {}) {
  const checks = [
    ['minPrecision', aggregate.precision, finiteNumber(thresholds.minPrecision, 0.9), 'min'],
    ['minRecall', aggregate.recall, finiteNumber(thresholds.minRecall, 0.8), 'min'],
    ['minF1', aggregate.f1, finiteNumber(thresholds.minF1, 0.85), 'min'],
    ['minSeverityWeightedRecall', aggregate.severityWeightedRecall, finiteNumber(thresholds.minSeverityWeightedRecall, 0.85), 'min'],
    ['minCoverage', aggregate.coverage, finiteNumber(thresholds.minCoverage, 1), 'min'],
    ['minRepeatStability', aggregate.repeatStability.meanJaccard, finiteNumber(thresholds.minRepeatStability, 0.85), 'min'],
    ['maxFalsePositivesPerKloc', aggregate.falsePositivesPerKloc, finiteNumber(thresholds.maxFalsePositivesPerKloc, 0.25), 'max'],
    ['maxTokensPerTruePositive', aggregate.tokensPerTruePositive, finiteNumber(thresholds.maxTokensPerTruePositive ?? thresholds.maxMedianTokensPerTruePositive, 50000), 'max'],
    ['maxP95DurationMs', aggregate.p95DurationMs, finiteNumber(thresholds.maxP95DurationMs, 300000), 'max'],
    ['maxExpectedCalibrationError', aggregate.expectedCalibrationError, finiteNumber(thresholds.maxExpectedCalibrationError, 0.2), 'max'],
    ['maxMeanSeverityRankError', aggregate.meanSeverityRankError, finiteNumber(thresholds.maxMeanSeverityRankError, 0.5), 'max']
  ].map(([name, actual, threshold, direction]) => {
    const passed = Number.isFinite(actual) && (direction === 'min' ? actual >= threshold : actual <= threshold);
    return { name, direction, actual, threshold, passed };
  });
  if (thresholds.maxMedianCostPerTruePositiveUsd !== undefined) {
    checks.push({
      name: 'maxMedianCostPerTruePositiveUsd',
      direction: 'max',
      actual: aggregate.costPerTruePositiveUsd,
      threshold: finiteNumber(thresholds.maxMedianCostPerTruePositiveUsd),
      passed: Number.isFinite(aggregate.costPerTruePositiveUsd)
        && aggregate.costPerTruePositiveUsd <= finiteNumber(thresholds.maxMedianCostPerTruePositiveUsd)
    });
  }
  for (const field of ['totalTokens', 'totalDurationMs', 'totalCostUsd']) {
    checks.push({ name: `measured:${field}`, direction: 'min', actual: Number.isFinite(aggregate[field]) ? 1 : 0, threshold: 1,
      passed: Number.isFinite(aggregate[field]) });
  }
  for (const [profile, metrics] of Object.entries(aggregate.byProfile || {})) {
    const gate = evaluateGate(metrics, thresholds);
    checks.push(...gate.checks.map((check) => ({ ...check, name: `profile:${profile}:${check.name}` })));
  }
  return {
    ok: checks.every((check) => check.passed),
    checks,
    failed: checks.filter((check) => !check.passed).map((check) => check.name)
  };
}

function scoreSuite({ manifest, labels, runs, manifestPath }) {
  const validation = validateInputs({ manifest, labels, runs, manifestPath });
  if (!validation.ok) {
    return {
      schemaVersion: 1,
      artifact: 'benchmark-report',
      evidenceKind: EVIDENCE_KINDS.has(runs?.evidenceKind) ? runs.evidenceKind : 'synthetic',
      ok: false,
      suiteId: manifest && manifest.suiteId || null,
      generatedAt: new Date().toISOString(),
      validation,
      runs: [],
      aggregate: null,
      gate: { ok: false, checks: [], failed: ['input-validation'] }
    };
  }
  const publicById = new Map(manifest.cases.map((entry) => [entry.id, entry]));
  const privateById = new Map(labels.cases.map((entry) => [entry.id, entry]));
  const matchThreshold = finiteNumber(manifest.matchThreshold, 0.7);
  const scoredRuns = runs.runs.map((run) => scoreRun({
    run,
    publicCase: publicById.get(run.caseId),
    privateCase: privateById.get(run.caseId),
    matchThreshold
  }));
  const aggregate = buildAggregate({ scoredRuns, privateCases: labels.cases });
  const gate = evaluateGate(aggregate, manifest.thresholds || {});
  return {
    schemaVersion: 1,
    artifact: 'benchmark-report',
    evidenceKind: runs.evidenceKind,
    provenance: runs.provenance || {},
    ok: gate.ok,
    suiteId: manifest.suiteId,
    generatedAt: new Date().toISOString(),
    manifestSha256: manifestPath ? sha256File(manifestPath) : null,
    validation,
    thresholds: manifest.thresholds || {},
    labelCatalog: labels.cases.flatMap((entry) => entry.findings.map((label) => ({
      labelId: label.labelId, caseId: entry.id, severity: label.severity
    }))),
    runs: scoredRuns,
    aggregate,
    gate
  };
}

function gateReport(report) {
  const validation = validateArtifactValue({ artifactName: 'benchmark-report', value: report });
  if (!validation.ok || report.validation?.ok !== true || !report.aggregate || report.runs.length === 0) {
    return { ok: false, checks: [], failed: ['input-validation'], errors: validation.errors };
  }
  const aggregate = buildAggregate({ scoredRuns: report.runs, privateCases: [] });
  return evaluateGate(aggregate, report.thresholds || {});
}

function requireArtifact(artifactName, value) {
  const result = validateArtifactValue({ artifactName, value });
  if (!result.ok) throw new Error(`${artifactName}: ${result.errors.join('; ')}`);
}

function recordRun({ runDir, caseId, profile = 'balanced', repeat = 1, telemetryPath,
  evidenceKind = 'replayed', manifestPath = path.join(BENCHMARK_ROOT, 'public-manifest.json'),
  labelsPath = path.join(BENCHMARK_ROOT, 'private-labels.json') }) {
  if (!EVIDENCE_KINDS.has(evidenceKind)) throw new Error('invalid evidenceKind');
  if (!Number.isSafeInteger(repeat) || repeat < 1) throw new Error('repeat must be a positive integer');
  if (!profile.trim()) throw new Error('profile is required');
  const manifest = readJson(manifestPath);
  const labels = readJson(labelsPath);
  const validation = validatePublicManifest(manifest, { manifestPath, labels });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  if (sha256File(manifestPath) !== labels.publicManifestSha256) throw new Error('private labels manifest digest mismatch');
  const publicCase = manifest.cases.find((entry) => entry.id === caseId);
  const privateCase = labels.cases.find((entry) => entry.id === caseId);
  if (!publicCase || !privateCase) throw new Error(`unknown case: ${caseId}`);
  const artifactDir = fs.existsSync(path.join(runDir, '.bug-hunter')) ? path.join(runDir, '.bug-hunter') : runDir;
  const findings = readJson(path.join(artifactDir, 'findings.json'));
  const referee = readJson(path.join(artifactDir, 'referee.json'));
  const scan = readJson(path.join(artifactDir, 'scan-report.json'));
  requireArtifact('findings', findings);
  requireArtifact('referee', referee);
  requireArtifact('scan-report', scan);
  const byId = new Map(findings.map((finding) => [finding.bugId, finding]));
  const verdicts = new Map(referee.map((verdict) => [verdict.bugId, verdict]));
  if (byId.size !== findings.length || verdicts.size !== referee.length) throw new Error('duplicate artifact bugId');
  const seen = new Set();
  for (const bucket of ['confirmed', 'dismissed', 'manualReview', 'unreviewed']) {
    if (scan.counts[bucket] !== scan[bucket].length) throw new Error(`scan-report ${bucket} count mismatch`);
    for (const row of scan[bucket]) {
      const finding = byId.get(row.id);
      const verdict = verdicts.get(row.id);
      if (!finding || seen.has(row.id) || !isDeepStrictEqual(row.finding, finding)) {
        throw new Error(`scan-report finding mismatch: ${row.id}`);
      }
      seen.add(row.id);
      const expectedVerdict = { confirmed: 'REAL_BUG', dismissed: 'NOT_A_BUG', manualReview: 'MANUAL_REVIEW' }[bucket];
      if (expectedVerdict && (!verdict || verdict.verdict !== expectedVerdict
        || !isDeepStrictEqual(row.verdict, verdict))) throw new Error(`scan-report verdict mismatch: ${row.id}`);
      if (!expectedVerdict && verdict) throw new Error(`reviewed finding in unreviewed bucket: ${row.id}`);
    }
  }
  if (seen.size !== findings.length || scan.counts.findings !== findings.length
    || referee.some((verdict) => !byId.has(verdict.bugId))) throw new Error('artifact finding coverage mismatch');
  const optionalTelemetry = telemetryPath || path.join(artifactDir, 'telemetry.json');
  const telemetry = (telemetryPath || fs.existsSync(optionalTelemetry)) ? readJson(optionalTelemetry) : {};
  if (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)) throw new Error('telemetry must be an object');
  const usage = telemetry.usage || telemetry;
  const telemetryValue = (value, field) => {
    if (value !== undefined && value !== null && !isMeasurement(value)) throw new Error(`invalid telemetry ${field}`);
    return measurement(value);
  };
  const input = telemetryValue(telemetry.inputTokens ?? usage.input_tokens, 'inputTokens');
  const output = telemetryValue(telemetry.outputTokens ?? usage.output_tokens, 'outputTokens');
  const extraInput = ['cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((sum, key) => {
    if (usage[key] === undefined) return sum;
    if (!isMeasurement(usage[key])) throw new Error(`invalid telemetry ${key}`);
    return sum + usage[key];
  }, 0);
  const run = {
    runId: `${caseId}:${profile}:${repeat}`,
    caseId, profile, repeat,
    inputTokens: input === null ? null : input + extraInput,
    outputTokens: output,
    durationMs: telemetryValue(telemetry.durationMs ?? telemetry.duration_ms, 'durationMs'),
    costUsd: telemetryValue(telemetry.costUsd ?? telemetry.total_cost_usd, 'costUsd'),
    coverage: { filesDone: scan.filesScanned, filesTotal: publicCase.sourceFiles.length },
    findings: scan.confirmed.map((row) => ({ ...row.finding,
      severity: row.verdict.trueSeverity, confidenceScore: row.verdict.confidenceScore })),
    artifactSha256: { ...Object.fromEntries(['findings.json', 'referee.json', 'scan-report.json'].map((name) => [
      name, sha256File(path.join(artifactDir, name))
    ])), ...(fs.existsSync(optionalTelemetry) ? { telemetry: sha256File(optionalTelemetry) } : {}) },
    provenance: { agent: telemetry.agent || null, model: telemetry.model || null, skillGitSha: telemetry.skillGitSha || null }
  };
  for (const finding of run.findings) {
    const errors = findingErrors(finding);
    if (errors.length > 0) throw new Error(errors.join('; '));
    if (!publicCase.sourceFiles.includes(normalizePath(finding.file))) throw new Error(`finding outside case: ${finding.file}`);
  }
  if (run.coverage.filesDone > run.coverage.filesTotal) throw new Error('filesScanned exceeds case source file count');
  return {
    schemaVersion: 1, suiteId: manifest.suiteId, evidenceKind,
    provenance: { agent: telemetry.agent || null, model: telemetry.model || null,
      skillGitSha: telemetry.skillGitSha || null, caseHashes: { [caseId]: publicCase.sha256 } },
    runs: [run],
    scores: [scoreRun({ run, publicCase, privateCase, matchThreshold: manifest.matchThreshold })]
  };
}

// Seeded, paired bootstrap over case clusters: repeats from one case stay together.
function bootstrapComparison(baseline, candidate, samples = 1000) {
  let seed = 0x6b756768;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const cases = [...new Set(baseline.runs.map((run) => run.caseId))].sort();
  const metric = (runs, name) => {
    const tp = runs.reduce((sum, run) => sum + run.truePositives, 0);
    const other = runs.reduce((sum, run) => sum + (name === 'precision' ? run.falsePositives : run.falseNegatives), 0);
    return ratio(tp, tp + other, 1);
  };
  const output = {};
  for (const name of ['precision', 'recall']) {
    const values = { baseline: [], candidate: [], delta: [] };
    for (let index = 0; index < samples; index += 1) {
      const selection = cases.map(() => cases[Math.floor(random() * cases.length)]);
      const left = metric(selection.flatMap((id) => baseline.runs.filter((run) => run.caseId === id)), name);
      const right = metric(selection.flatMap((id) => candidate.runs.filter((run) => run.caseId === id)), name);
      values.baseline.push(left);
      values.candidate.push(right);
      values.delta.push(right - left);
    }
    output[name] = Object.fromEntries(Object.entries(values).map(([key, entries]) => [key, {
      estimate: key === 'delta' ? metric(candidate.runs, name) - metric(baseline.runs, name)
        : metric(key === 'baseline' ? baseline.runs : candidate.runs, name),
      lower: percentile(entries, 0.025), upper: percentile(entries, 0.975)
    }]));
  }
  return { method: 'paired-case-bootstrap', confidenceLevel: 0.95, samples, caseCount: cases.length, ...output };
}

function compareReports(baseline, candidate, { qualityTolerance = 0.05, efficiencyTolerance = 0.2 } = {}) {
  for (const report of [baseline, candidate]) {
    requireArtifact('benchmark-report', report);
    if (!report.validation.ok || !report.aggregate || report.runs.length === 0) throw new Error('cannot compare invalid or empty reports');
  }
  if (baseline.suiteId !== candidate.suiteId || baseline.manifestSha256 !== candidate.manifestSha256) {
    throw new Error('comparison requires the same suite and corpus digest');
  }
  const runKey = (run) => `${run.caseId}|${run.profile}|${run.repeat}`;
  const baselineKeys = baseline.runs.map(runKey).sort();
  const candidateKeys = candidate.runs.map(runKey).sort();
  if (new Set(baselineKeys).size !== baselineKeys.length || JSON.stringify(baselineKeys) !== JSON.stringify(candidateKeys)) {
    throw new Error('comparison requires paired cases, profiles, and repeats');
  }
  if (JSON.stringify(baseline.labelCatalog) !== JSON.stringify(candidate.labelCatalog)) throw new Error('comparison requires the same label catalog');
  if (!Array.isArray(baseline.labelCatalog)) throw new Error('comparison requires labelCatalog; re-score older reports');
  const candidateByRun = new Map(candidate.runs.map((run) => [runKey(run), run]));
  const labels = baseline.labelCatalog.map((label) => {
    const left = baseline.runs.filter((run) => run.caseId === label.caseId);
    const right = candidate.runs.filter((run) => run.caseId === label.caseId);
    const baselineHits = left.filter((run) => run.matchedLabelIds.includes(label.labelId)).length;
    const candidateHits = right.filter((run) => run.matchedLabelIds.includes(label.labelId)).length;
    return { ...label, instances: left.length, baselineHits, candidateHits,
      baselineHitRate: ratio(baselineHits, left.length), candidateHitRate: ratio(candidateHits, right.length),
      newlyFound: left.filter((run) => !run.matchedLabelIds.includes(label.labelId)
        && candidateByRun.get(runKey(run)).matchedLabelIds.includes(label.labelId)).map(runKey),
      lost: left.filter((run) => run.matchedLabelIds.includes(label.labelId)
        && !candidateByRun.get(runKey(run)).matchedLabelIds.includes(label.labelId)).map(runKey) };
  });
  const fpDelta = (left, right) => left.runs.flatMap((run) => {
    const peer = right.runs.find((entry) => runKey(entry) === runKey(run));
    const remaining = [...peer.falsePositiveFingerprints];
    return run.falsePositiveFingerprints.filter((fingerprint) => {
      const index = remaining.indexOf(fingerprint);
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    }).map((fingerprint) => ({ run: runKey(run), fingerprint }));
  });
  const confidenceIntervals = bootstrapComparison(baseline, candidate);
  const failed = [];
  for (const label of labels) {
    if (SEVERITY_RANK[label.severity] >= SEVERITY_RANK.High
      && label.baselineHits === label.instances && label.candidateHits < label.instances) failed.push(`lost:${label.labelId}`);
  }
  for (const name of ['precision', 'recall']) {
    if (confidenceIntervals[name].delta.estimate < -qualityTolerance) failed.push(`regressed:${name}`);
  }
  const efficiency = {};
  for (const name of ['tokensPerTruePositive', 'p95DurationMs']) {
    const left = baseline.aggregate[name];
    const right = candidate.aggregate[name];
    efficiency[name] = { baseline: left, candidate: right,
      relativeChange: Number.isFinite(left) && Number.isFinite(right) && left > 0 ? (right - left) / left : null };
    if (!Number.isFinite(left) || !Number.isFinite(right)) failed.push(`unknown:${name}`);
    else if (right > left * (1 + efficiencyTolerance)) failed.push(`regressed:${name}`);
  }
  return { ok: failed.length === 0, suiteId: baseline.suiteId,
    evidenceKind: { baseline: baseline.evidenceKind, candidate: candidate.evidenceKind },
    qualityTolerance, efficiencyTolerance, labels,
    newlyFound: labels.filter((label) => label.newlyFound.length).map((label) => label.labelId),
    lost: labels.filter((label) => label.lost.length).map((label) => label.labelId),
    newFalsePositives: fpDelta(candidate, baseline), removedFalsePositives: fpDelta(baseline, candidate),
    confidenceIntervals, efficiency, failed };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === 'validate-public') {
    if (!options.manifest) throw new Error('--manifest is required');
    const manifest = readJson(path.resolve(options.manifest));
    const manifestPath = path.resolve(options.manifest);
    const labels = readJson(path.resolve(options.labels || path.join(path.dirname(manifestPath), 'private-labels.json')));
    const result = validatePublicManifest(manifest, { manifestPath, labels });
    if (labels.publicManifestSha256 !== sha256File(manifestPath)) result.errors.push('private labels manifest digest mismatch');
    result.ok = result.errors.length === 0;
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'gate') {
    if (!options.report) throw new Error('--report is required');
    const report = readJson(path.resolve(options.report));
    const gate = gateReport(report);
    console.log(JSON.stringify({ ok: gate.ok, gate }, null, 2));
    if (!gate.ok) process.exitCode = 1;
    return;
  }
  if (command === 'record') {
    if (!options['run-dir'] || !options.case || !options.output) throw new Error('--run-dir, --case, and --output are required');
    const recording = recordRun({ runDir: path.resolve(options['run-dir']), caseId: options.case,
      profile: options.profile || 'balanced', repeat: Number(options.repeat || 1),
      telemetryPath: options.telemetry && path.resolve(options.telemetry), evidenceKind: options['evidence-kind'] || 'replayed',
      manifestPath: options.manifest && path.resolve(options.manifest), labelsPath: options.labels && path.resolve(options.labels) });
    const outputPath = path.resolve(options.output);
    if (fs.existsSync(outputPath)) {
      const previous = readJson(outputPath);
      if (previous.suiteId !== recording.suiteId || previous.evidenceKind !== recording.evidenceKind) throw new Error('incompatible recording bundle');
      if (previous.runs.some((run) => run.runId === recording.runs[0].runId)) throw new Error('duplicate recorded run');
      recording.runs = [...previous.runs, ...recording.runs];
      recording.scores = [...previous.scores || [], ...recording.scores];
      recording.provenance.caseHashes = { ...previous.provenance?.caseHashes, ...recording.provenance.caseHashes };
    }
    writeJson(outputPath, recording);
    console.log(JSON.stringify({ output: outputPath, evidenceKind: recording.evidenceKind, runs: recording.runs.length }));
    return;
  }
  if (command === 'compare') {
    if (!options.baseline || !options.candidate) throw new Error('--baseline and --candidate are required');
    const result = compareReports(readJson(path.resolve(options.baseline)), readJson(path.resolve(options.candidate)));
    if (options.output) writeJson(path.resolve(options.output), result);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'score') {
    if (!options.manifest || !options.labels || !options.runs) {
      throw new Error('--manifest, --labels, and --runs are required');
    }
    const manifestPath = path.resolve(options.manifest);
    const report = scoreSuite({
      manifest: readJson(manifestPath),
      labels: readJson(path.resolve(options.labels)),
      runs: readJson(path.resolve(options.runs)),
      manifestPath
    });
    if (options.output) writeJson(path.resolve(options.output), report);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  usage();
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  buildAggregate,
  candidateScore,
  compareReports,
  evaluateGate,
  findingErrors,
  gateReport,
  matchFindings,
  recordRun,
  scoreRun,
  scoreSuite,
  validateInputs,
  validatePublicManifest
};
