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

function findingText(finding) {
  return [
    finding.claim,
    finding.evidence,
    finding.runtimeTrigger,
    finding.category
  ].filter((value) => {
    return typeof value === 'string';
  }).join(' ').toLowerCase();
}

function findingMatchesExpectation({ finding, expectation }) {
  const normalizedFile = String(finding.file || '').replaceAll('\\', '/');
  if (!normalizedFile.endsWith(`/${expectation.file}`) && normalizedFile !== expectation.file) {
    return false;
  }
  if (!expectation.severities.includes(finding.severity)) {
    return false;
  }
  const text = findingText(finding);
  return expectation.keywordGroups.every((keywords) => {
    return keywords.some((keyword) => {
      return text.includes(keyword);
    });
  });
}

function evaluate({ findings, benchmark, minRecall, maxFalsePositives }) {
  if (!Array.isArray(findings)) {
    throw new Error('findings JSON must be an array');
  }
  if (!benchmark || !Array.isArray(benchmark.expected)) {
    throw new Error('benchmark expected findings must be an array');
  }

  const matches = benchmark.expected.map((expectation) => {
    const findingIndex = findings.findIndex((finding) => {
      return findingMatchesExpectation({ finding, expectation });
    });
    return {
      expectationId: expectation.id,
      matched: findingIndex >= 0,
      findingIndex: findingIndex >= 0 ? findingIndex : null
    };
  });
  const matchedFindingIndexes = new Set(matches.filter((match) => {
    return match.matched;
  }).map((match) => {
    return match.findingIndex;
  }));
  const matched = matches.filter((match) => {
    return match.matched;
  }).length;
  const falsePositives = findings.filter((finding, index) => {
    return !matchedFindingIndexes.has(index);
  }).length;
  const recall = benchmark.expected.length === 0 ? 1 : matched / benchmark.expected.length;
  const ok = recall >= minRecall && falsePositives <= maxFalsePositives;

  return {
    ok,
    benchmarkSchemaVersion: benchmark.schemaVersion,
    expected: benchmark.expected.length,
    matched,
    missing: matches.filter((match) => {
      return !match.matched;
    }).map((match) => {
      return match.expectationId;
    }),
    falsePositives,
    recall,
    thresholds: {
      minRecall,
      maxFalsePositives
    },
    matches
  };
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
