#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
  return Boolean(left && right && (left === right || left.endsWith(`/${right}`)));
}

function parseLineRange(value) {
  const numbers = String(value || '').match(/\d+/g);
  if (!numbers || numbers.length === 0) return null;
  const start = Number(numbers[0]);
  const end = numbers.length > 1 ? Number(numbers[1]) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
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
    finding.runtimeTrigger,
    finding.category,
    ...(Array.isArray(finding.crossReferences) ? finding.crossReferences : [])
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
  if (!fileMatches(finding.file, label.file)) return 0;
  const category = !label.category || finding.category === label.category ? 1 : 0;
  const keywords = keywordScore(finding, label);
  const groups = Array.isArray(label.keywordGroups) ? label.keywordGroups : [];
  const minimumKeywordRatio = Number.isFinite(Number(label.minimumKeywordGroupRatio))
    ? clamp(Number(label.minimumKeywordGroupRatio), 0, 1)
    : 0.5;
  if (groups.length > 0 && keywords < minimumKeywordRatio) return 0;
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
    String(finding.category || '').toLowerCase(),
    String(finding.claim || '').toLowerCase().replace(/\s+/g, ' ').trim()
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

function validatePublicManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['public manifest must be a JSON object'] };
  }
  if (manifest.schemaVersion !== 1) errors.push('public manifest schemaVersion must equal 1');
  if (!String(manifest.suiteId || '').trim()) errors.push('public manifest suiteId is required');
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    errors.push('public manifest cases must be a non-empty array');
  }
  const ids = new Set();
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
    const id = String(entry.id || '').trim();
    if (!id) errors.push('every public case requires an id');
    if (ids.has(id)) errors.push(`duplicate public case id: ${id}`);
    ids.add(id);
    const kloc = finiteNumber(entry.kloc, -1);
    if (kloc < 0) errors.push(`case ${id || '<unknown>'} requires nonnegative kloc`);
    if (!Array.isArray(entry.sourceFiles) || entry.sourceFiles.length === 0) {
      errors.push(`case ${id || '<unknown>'} requires a non-empty sourceFiles array`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateInputs({ manifest, labels, runs, manifestPath }) {
  const publicValidation = validatePublicManifest(manifest);
  const errors = [...publicValidation.errors];
  if (!labels || labels.schemaVersion !== 1 || !Array.isArray(labels.cases)) {
    errors.push('private labels must use schemaVersion 1 and contain a cases array');
  }
  if (!runs || runs.schemaVersion !== 1 || !Array.isArray(runs.runs)) {
    errors.push('runs must use schemaVersion 1 and contain a runs array');
  }
  if (labels && labels.suiteId !== manifest.suiteId) errors.push('private labels suiteId does not match public manifest');
  if (runs && runs.suiteId !== manifest.suiteId) errors.push('runs suiteId does not match public manifest');
  if (manifestPath && labels) {
    const actual = sha256File(manifestPath);
    if (!/^[a-f0-9]{64}$/.test(String(labels.publicManifestSha256 || ''))) {
      errors.push('private labels must contain publicManifestSha256');
    } else if (actual !== labels.publicManifestSha256) {
      errors.push(`private labels are bound to public manifest ${labels.publicManifestSha256}, got ${actual}`);
    }
  }
  const publicIds = new Set((manifest.cases || []).map((entry) => entry.id));
  const labelIds = new Set((labels && labels.cases || []).map((entry) => entry.id));
  const seenPrivateLabelIds = new Set();
  for (const privateCase of labels && labels.cases || []) {
    if (!Array.isArray(privateCase.findings)) {
      errors.push(`private case ${privateCase.id || '<unknown>'} findings must be an array`);
      continue;
    }
    for (const label of privateCase.findings) {
      const labelId = String(label.labelId || '').trim();
      if (!labelId) errors.push(`private case ${privateCase.id || '<unknown>'} has a finding without labelId`);
      if (seenPrivateLabelIds.has(labelId)) errors.push(`duplicate private labelId: ${labelId}`);
      seenPrivateLabelIds.add(labelId);
      if (!String(label.file || '').trim()) errors.push(`private label ${labelId || '<unknown>'} requires file`);
      if (!String(label.category || '').trim()) errors.push(`private label ${labelId || '<unknown>'} requires category`);
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
    const runId = String(run.runId || '').trim();
    if (!runId) errors.push('every run requires runId');
    if (seenRunIds.has(runId)) errors.push(`duplicate runId: ${runId}`);
    seenRunIds.add(runId);
    if (!publicIds.has(run.caseId)) errors.push(`run ${runId || '<unknown>'} references unknown case ${run.caseId}`);
    if (!Array.isArray(run.findings)) {
      errors.push(`run ${runId || '<unknown>'} findings must be an array`);
    } else {
      for (const finding of run.findings) {
        const confidence = Number(finding.confidenceScore);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
          errors.push(`run ${runId || '<unknown>'} has a finding with invalid confidenceScore`);
        }
      }
    }
    const repeat = Number(run.repeat);
    if (!Number.isSafeInteger(repeat) || repeat < 1) errors.push(`run ${runId || '<unknown>'} repeat must be a positive integer`);
    for (const field of ['inputTokens', 'outputTokens', 'durationMs', 'costUsd']) {
      const value = Number(run[field] ?? 0);
      if (!Number.isFinite(value) || value < 0) errors.push(`run ${runId || '<unknown>'} ${field} must be nonnegative`);
    }
    const coverage = run.coverage || {};
    const filesDone = Number(coverage.filesDone);
    const filesTotal = Number(coverage.filesTotal);
    if (!Number.isFinite(filesDone) || !Number.isFinite(filesTotal)
      || filesDone < 0 || filesTotal < 0 || filesDone > filesTotal) {
      errors.push(`run ${runId || '<unknown>'} has invalid coverage counts`);
    }
    const profile = String(run.profile || 'default');
    const key = `${run.caseId}|${profile}`;
    const repeats = repeatCoverage.get(key) || new Set();
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
  const tokens = finiteNumber(run.inputTokens) + finiteNumber(run.outputTokens);
  const durationMs = Math.max(0, finiteNumber(run.durationMs));
  const costUsd = Math.max(0, finiteNumber(run.costUsd));
  const completedFiles = Math.max(0, finiteNumber(run.coverage && run.coverage.filesDone));
  const totalFiles = Math.max(0, finiteNumber(run.coverage && run.coverage.filesTotal));
  const coverage = ratio(completedFiles, totalFiles, totalFiles === 0 ? 1 : 0);
  const matchedEmissionTimes = matching.matches
    .map((match) => finiteNumber(match.finding.emittedAtMs, NaN))
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
    severityExactAccuracy: ratio(severityErrors.filter((error) => error === 0).length, severityErrors.length, 1),
    meanSeverityRankError: severityErrors.length === 0
      ? 0
      : severityErrors.reduce((sum, value) => sum + value, 0) / severityErrors.length,
    calibration,
    calibrationSamples,
    coverage,
    inputTokens: finiteNumber(run.inputTokens),
    outputTokens: finiteNumber(run.outputTokens),
    totalTokens: tokens,
    durationMs,
    costUsd,
    tokensPerTruePositive: truePositives > 0 ? tokens / truePositives : null,
    costPerTruePositiveUsd: truePositives > 0 ? costUsd / truePositives : null,
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
    for (const label of privateCase.findings || []) {
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

function buildAggregate({ scoredRuns, privateCases }) {
  const totals = scoredRuns.reduce((state, run) => {
    state.truePositives += run.truePositives;
    state.falsePositives += run.falsePositives;
    state.falseNegatives += run.falseNegatives;
    state.kloc += run.kloc;
    state.tokens += run.totalTokens;
    state.durationMs += run.durationMs;
    state.costUsd += run.costUsd;
    return state;
  }, {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    kloc: 0,
    tokens: 0,
    durationMs: 0,
    costUsd: 0
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
    severityWeightedRecall: scoredRuns.length === 0
      ? 1
      : scoredRuns.reduce((sum, run) => sum + run.severityWeightedRecall, 0) / scoredRuns.length,
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
    medianTokensPerTruePositive: percentile(tokenPerTpValues, 0.5),
    p95TokensPerTruePositive: percentile(tokenPerTpValues, 0.95),
    medianCostPerTruePositiveUsd: percentile(costPerTpValues, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    expectedCalibrationError: calibration.expectedCalibrationError,
    brierScore: calibration.brierScore,
    pooledCalibration: calibration,
    repeatStability: stability,
    byCategory: aggregateClassMetrics(scoredRuns, privateCases)
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
    ['maxMedianTokensPerTruePositive', aggregate.medianTokensPerTruePositive ?? Infinity, finiteNumber(thresholds.maxMedianTokensPerTruePositive, 50000), 'max'],
    ['maxP95DurationMs', aggregate.p95DurationMs ?? Infinity, finiteNumber(thresholds.maxP95DurationMs, 300000), 'max'],
    ['maxExpectedCalibrationError', aggregate.expectedCalibrationError, finiteNumber(thresholds.maxExpectedCalibrationError, 0.2), 'max'],
    ['maxMeanSeverityRankError', aggregate.meanSeverityRankError, finiteNumber(thresholds.maxMeanSeverityRankError, 0.5), 'max']
  ].map(([name, actual, threshold, direction]) => {
    const passed = direction === 'min' ? actual >= threshold : actual <= threshold;
    return { name, direction, actual, threshold, passed };
  });
  if (thresholds.maxMedianCostPerTruePositiveUsd !== undefined) {
    checks.push({
      name: 'maxMedianCostPerTruePositiveUsd',
      direction: 'max',
      actual: aggregate.medianCostPerTruePositiveUsd ?? Infinity,
      threshold: finiteNumber(thresholds.maxMedianCostPerTruePositiveUsd),
      passed: (aggregate.medianCostPerTruePositiveUsd ?? Infinity) <= finiteNumber(thresholds.maxMedianCostPerTruePositiveUsd)
    });
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
    ok: gate.ok,
    suiteId: manifest.suiteId,
    generatedAt: new Date().toISOString(),
    manifestSha256: manifestPath ? sha256File(manifestPath) : null,
    validation,
    thresholds: manifest.thresholds || {},
    runs: scoredRuns,
    aggregate,
    gate
  };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === 'validate-public') {
    if (!options.manifest) throw new Error('--manifest is required');
    const manifest = readJson(path.resolve(options.manifest));
    const result = validatePublicManifest(manifest);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'gate') {
    if (!options.report) throw new Error('--report is required');
    const report = readJson(path.resolve(options.report));
    console.log(JSON.stringify({ ok: report.ok === true, gate: report.gate || null }, null, 2));
    if (report.ok !== true) process.exitCode = 1;
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
  evaluateGate,
  matchFindings,
  scoreRun,
  scoreSuite,
  validateInputs,
  validatePublicManifest
};
