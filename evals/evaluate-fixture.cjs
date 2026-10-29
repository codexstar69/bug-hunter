#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function usage() {
  console.error('Usage: evaluate-fixture.cjs <findings-json> [--min-recall <0..1>] [--max-false-positives <count>]');
}

function parseOptions(argv) {
  return argv.reduce((state, token, index) => {
    if (!token.startsWith('--')) {
      return state;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${token} requires a value`);
    }
    return {
      ...state,
      [token.slice(2)]: value
    };
  }, {});
}

function parseRatio({ value, fallback, label }) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${label} must be a number from 0 to 1`);
  }
  return parsed;
}

function parseCount({ value, fallback, label }) {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return Number(value);
}

const { findingErrors, matchFindings } = require('../scripts/benchmark-suite.cjs');

function calibrationLabels(benchmark) {
  if (Array.isArray(benchmark.expected)) {
    return benchmark.expected.map((entry) => ({ ...entry,
      labelId: entry.labelId || entry.id, severity: entry.severity || entry.severities?.[0] }));
  }
  const labels = JSON.parse(fs.readFileSync(path.resolve(__dirname, benchmark.labelsFile), 'utf8'));
  const entry = labels.cases.find((item) => item.id === benchmark.caseId);
  if (!entry) throw new Error('fixture calibration case is missing');
  return entry.findings;
}

function findingMatchesExpectation({ finding, expectation }) {
  return matchFindings([finding], calibrationLabels({ expected: [expectation] })).matches.length === 1;
}

function evaluate({ findings, benchmark, minRecall = 1, maxFalsePositives = 0 }) {
  if (!Array.isArray(findings)) throw new Error('findings JSON must be an array');
  const errors = findings.flatMap(findingErrors);
  if (errors.length) throw new Error(errors.join('; '));
  const labels = calibrationLabels(benchmark);
  const matching = matchFindings(findings, labels);
  const byLabel = new Map(matching.matches.map((match) => [match.label.labelId, match.findingIndex]));
  const matched = matching.matches.length;
  const falsePositives = matching.unmatchedFindingIndexes.length;
  const recall = labels.length === 0 ? 1 : matched / labels.length;
  const matches = labels.map((label) => ({ expectationId: label.labelId,
    matched: byLabel.has(label.labelId), findingIndex: byLabel.get(label.labelId) ?? null }));
  return { ok: recall >= minRecall && falsePositives <= maxFalsePositives,
    benchmarkSchemaVersion: benchmark.schemaVersion, expected: labels.length, matched,
    missing: labels.filter((label) => !byLabel.has(label.labelId)).map((label) => label.labelId),
    falsePositives, recall, thresholds: { minRecall, maxFalsePositives }, matches };
}

function main() {
  const [findingsPathRaw, ...optionArgs] = process.argv.slice(2);
  if (!findingsPathRaw) {
    usage();
    process.exit(1);
  }
  const options = parseOptions(optionArgs);
  const minRecall = parseRatio({
    value: options['min-recall'],
    fallback: 1,
    label: '--min-recall'
  });
  const maxFalsePositives = parseCount({
    value: options['max-false-positives'],
    fallback: 0,
    label: '--max-false-positives'
  });
  const findingsPath = path.resolve(findingsPathRaw);
  const benchmarkPath = path.resolve(__dirname, 'expected-findings.json');
  const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  const benchmark = JSON.parse(fs.readFileSync(benchmarkPath, 'utf8'));
  const result = evaluate({
    findings,
    benchmark,
    minRecall,
    maxFalsePositives
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

module.exports = {
  evaluate,
  findingMatchesExpectation
};
