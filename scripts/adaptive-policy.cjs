#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const PROFILE_DEFAULTS = Object.freeze({
  fast: Object.freeze({
    maxSourceTokens: 32000,
    maxFilesPerChunk: 20,
    confidenceThreshold: 82,
    deltaHops: 1,
    expansionCap: 16,
    skepticPasses: 1,
    refereeMode: 'critical-plus-disputed',
    stableRounds: 1,
    minCoverage: 1,
    verificationKinds: ['typecheck', 'test'],
    reasoningTier: 'economy'
  }),
  balanced: Object.freeze({
    maxSourceTokens: 48000,
    maxFilesPerChunk: 30,
    confidenceThreshold: 75,
    deltaHops: 2,
    expansionCap: 40,
    skepticPasses: 1,
    refereeMode: 'all-small-critical-plus-disputed-large',
    stableRounds: 2,
    minCoverage: 1,
    verificationKinds: ['typecheck', 'test', 'static'],
    reasoningTier: 'standard'
  }),
  assurance: Object.freeze({
    maxSourceTokens: 64000,
    maxFilesPerChunk: 24,
    confidenceThreshold: 70,
    deltaHops: 3,
    expansionCap: 80,
    skepticPasses: 2,
    refereeMode: 'all',
    stableRounds: 2,
    minCoverage: 1,
    verificationKinds: ['typecheck', 'test', 'static', 'fuzz'],
    reasoningTier: 'deep'
  })
});

function usage() {
  console.error('Usage: adaptive-policy.cjs plan --triage <triage.json> [--benchmark <report.json>] [--profile <auto|fast|balanced|assurance>] [--security <true|false>] [--output <plan.json>]');
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
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

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function boolean(value, fallback = false) {
  if (value === undefined) return fallback;
  const normalized = String(value).toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Expected true or false, got ${value}`);
}

function summarizeTriage(triage) {
  if (!triage || typeof triage !== 'object' || Array.isArray(triage)) {
    throw new Error('triage must be a JSON object');
  }
  const totalFiles = Math.max(0, number(triage.scannableFiles, number(triage.totalFiles)));
  const riskMap = triage.riskMap && typeof triage.riskMap === 'object' ? triage.riskMap : {};
  const count = (key) => Array.isArray(riskMap[key]) ? riskMap[key].length : 0;
  const critical = count('critical');
  const high = count('high');
  const medium = count('medium');
  const low = count('low');
  const contextOnly = count('context-only');
  const known = critical + high + medium + low + contextOnly;
  const denominator = Math.max(1, known || totalFiles);
  const averageTokens = Math.max(0, number(triage.avgTokens));
  const domains = Array.isArray(triage.domains) ? triage.domains.length : 0;
  return {
    totalFiles,
    critical,
    high,
    medium,
    low,
    contextOnly,
    domains,
    averageTokens,
    criticalRatio: critical / denominator,
    elevatedRatio: (critical + high) / denominator
  };
}

function summarizeBenchmark(report) {
  const aggregate = report && report.aggregate && typeof report.aggregate === 'object'
    ? report.aggregate
    : {};
  return {
    available: Boolean(report && report.aggregate),
    precision: number(aggregate.precision, 1),
    recall: number(aggregate.recall, 1),
    f1: number(aggregate.f1, 1),
    severityWeightedRecall: number(aggregate.severityWeightedRecall, 1),
    medianTokensPerTruePositive: number(aggregate.medianTokensPerTruePositive, 0),
    repeatStability: number(aggregate.repeatStability && aggregate.repeatStability.meanJaccard, 1),
    calibrationError: number(aggregate.expectedCalibrationError, 0)
  };
}

function calculateRiskScore({ triage, benchmark, securityReview }) {
  let score = 0;
  score += Math.min(30, triage.critical * 6);
  score += Math.min(25, triage.high * 2.5);
  score += triage.elevatedRatio * 20;
  score += Math.min(10, triage.domains * 2);
  score += triage.totalFiles > 500 ? 10 : triage.totalFiles > 150 ? 6 : triage.totalFiles > 40 ? 3 : 0;
  score += securityReview ? 15 : 0;
  if (benchmark.available) {
    score += Math.max(0, 0.9 - benchmark.recall) * 35;
    score += Math.max(0, 0.9 - benchmark.severityWeightedRecall) * 30;
    score += Math.max(0, 0.85 - benchmark.repeatStability) * 20;
  }
  return clamp(score, 0, 100);
}

function chooseProfile({ requestedProfile, riskScore, benchmark, securityReview }) {
  if (requestedProfile && requestedProfile !== 'auto') {
    if (!PROFILE_DEFAULTS[requestedProfile]) throw new Error(`Unsupported profile: ${requestedProfile}`);
    return requestedProfile;
  }
  if (securityReview || riskScore >= 60 || (benchmark.available && benchmark.recall < 0.8)) return 'assurance';
  if (riskScore <= 20 && (!benchmark.available || benchmark.precision >= 0.93)) return 'fast';
  return 'balanced';
}

function buildAdaptivePolicy({ triage, benchmarkReport = null, requestedProfile = 'auto', securityReview = false }) {
  const triageSummary = summarizeTriage(triage);
  const benchmarkSummary = summarizeBenchmark(benchmarkReport);
  const riskScore = calculateRiskScore({ triage: triageSummary, benchmark: benchmarkSummary, securityReview });
  const profile = chooseProfile({ requestedProfile, riskScore, benchmark: benchmarkSummary, securityReview });
  const defaults = PROFILE_DEFAULTS[profile];

  let confidenceThreshold = defaults.confidenceThreshold;
  let skepticPasses = defaults.skepticPasses;
  let deltaHops = defaults.deltaHops;
  let expansionCap = defaults.expansionCap;
  let maxSourceTokens = defaults.maxSourceTokens;
  const reasons = [`selected ${profile} profile at risk score ${riskScore.toFixed(1)}`];

  if (benchmarkSummary.available && benchmarkSummary.precision < 0.9) {
    confidenceThreshold = Math.min(92, confidenceThreshold + 5);
    skepticPasses = Math.min(3, skepticPasses + 1);
    reasons.push('raised confirmation threshold and Skeptic depth because measured precision is below 0.90');
  }
  if (benchmarkSummary.available && benchmarkSummary.recall < 0.85) {
    confidenceThreshold = Math.max(65, confidenceThreshold - 3);
    deltaHops = Math.min(4, deltaHops + 1);
    expansionCap = Math.min(120, Math.ceil(expansionCap * 1.5));
    reasons.push('expanded dependency reach because measured recall is below 0.85');
  }
  if (benchmarkSummary.available && benchmarkSummary.medianTokensPerTruePositive > 50000) {
    maxSourceTokens = Math.max(24000, Math.floor(maxSourceTokens * 0.8));
    reasons.push('reduced per-chunk context because measured tokens per confirmed bug are high');
  }
  if (triageSummary.averageTokens > 12000) {
    maxSourceTokens = Math.max(24000, Math.min(maxSourceTokens, triageSummary.averageTokens * 2));
    reasons.push('bounded context for unusually large source files');
  }

  const criticalWork = triageSummary.critical > 0 || securityReview;
  const reviewerPolicy = {
    skepticPasses,
    refereeMode: criticalWork ? 'all-critical-and-disputed' : defaults.refereeMode,
    independentlyVerifyAllWhenFindingsAtMost: profile === 'fast' ? 10 : profile === 'balanced' ? 20 : 40,
    independentlyVerifyCritical: true,
    disputedFindingsAlwaysEscalate: true
  };

  const earlyStop = {
    enabled: true,
    stableRounds: defaults.stableRounds,
    minCoverage: defaults.minCoverage,
    minConfirmedPrecision: Math.max(0.85, benchmarkSummary.available ? benchmarkSummary.precision - 0.03 : 0.9),
    stopOnlyWhenNoOpenCriticalHypotheses: true,
    stopOnlyWhenNoUnreviewedFindings: true,
    maximumNoProgressRounds: profile === 'assurance' ? 3 : 2
  };

  const verificationKinds = [...new Set([
    ...defaults.verificationKinds,
    ...(criticalWork ? ['security-static'] : []),
    ...(triageSummary.totalFiles > 100 ? ['targeted-test'] : [])
  ])];

  return {
    schemaVersion: 1,
    artifact: 'adaptive-plan',
    generatedAt: new Date().toISOString(),
    profile,
    riskScore,
    inputs: {
      triage: triageSummary,
      benchmark: benchmarkSummary,
      securityReview
    },
    budgetPolicy: {
      maxSourceTokens,
      maxFilesPerChunk: defaults.maxFilesPerChunk,
      deltaHops,
      expansionCap,
      confidenceThreshold,
      tokenBudgetHardLimit: true,
      isolateOversizedFiles: true,
      preferSymbolSlices: true
    },
    reviewerPolicy,
    earlyStop,
    verificationPolicy: {
      kinds: verificationKinds,
      requiredKinds: criticalWork ? ['typecheck', 'test'] : ['test'],
      failClosedOnRequiredFailure: true,
      maximumTotalDurationMs: profile === 'assurance' ? 900000 : profile === 'balanced' ? 420000 : 180000
    },
    modelPolicy: {
      reasoningTier: defaults.reasoningTier,
      economyForReconAndSettledChallenges: true,
      deepReasoningForCriticalAndDisputed: true,
      avoidParallelDuplicateReads: true
    },
    cachePolicy: {
      contentAddressed: true,
      reuseOnlyOnExactContentAndProtocolVersion: true,
      maximumAgeDays: 30,
      maximumEntries: profile === 'assurance' ? 20000 : 10000
    },
    reasons
  };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'plan') {
    usage();
    process.exit(1);
  }
  const options = parseOptions(rest);
  if (!options.triage) throw new Error('--triage is required');
  const plan = buildAdaptivePolicy({
    triage: readJson(path.resolve(options.triage)),
    benchmarkReport: options.benchmark ? readJson(path.resolve(options.benchmark)) : null,
    requestedProfile: options.profile || 'auto',
    securityReview: boolean(options.security, false)
  });
  if (options.output) writeJson(path.resolve(options.output), plan);
  console.log(JSON.stringify(plan, null, 2));
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
  PROFILE_DEFAULTS,
  buildAdaptivePolicy,
  calculateRiskScore,
  chooseProfile,
  summarizeBenchmark,
  summarizeTriage
};
