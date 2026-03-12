#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function usage() {
  console.error('Usage:');
  console.error('  render-report.cjs report <findings-json> <referee-json>');
  console.error('  render-report.cjs coverage <coverage-json>');
  console.error('  render-report.cjs skeptic <skeptic-json>');
  console.error('  render-report.cjs referee <referee-json>');
  console.error('  render-report.cjs fix-report <fix-report-json>');
  console.error('  render-report.cjs fix-strategy <fix-strategy-json>');
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function renderReport({ findingsPath, refereePath }) {
  const findings = toArray(readJson(findingsPath));
  const verdicts = toArray(readJson(refereePath));
  const findingByBugId = new Map(findings.map((finding) => [finding.bugId, finding]));
  const confirmed = [];
  const dismissed = [];
  const manualReview = [];

  for (const verdict of verdicts) {
    const finding = findingByBugId.get(verdict.bugId) || null;
    const row = { verdict, finding };
    if (verdict.verdict === 'REAL_BUG') {
      confirmed.push(row);
      continue;
    }
    if (verdict.verdict === 'MANUAL_REVIEW') {
      manualReview.push(row);
      continue;
    }
    dismissed.push(row);
  }

  const lines = [
    '# Bug Hunter Report',
    '',
    `- Findings reviewed: ${findings.length}`,
    `- Confirmed: ${confirmed.length}`,
    `- Dismissed: ${dismissed.length}`,
    `- Manual review: ${manualReview.length}`,
    ''
  ];

  lines.push('## Confirmed Bugs');
  if (confirmed.length === 0) {
    lines.push('- None');
  } else {
    for (const { verdict, finding } of confirmed) {
      lines.push(`- ${verdict.bugId} | ${verdict.trueSeverity} | ${finding ? finding.file : 'unknown file'} | ${finding ? finding.claim : verdict.analysisSummary}`);
      lines.push(`  Confidence: ${verdict.confidenceScore} (${verdict.confidenceLabel}) | ${verdict.verificationMode}`);
      lines.push(`  Analysis: ${verdict.analysisSummary}`);
    }
  }

  lines.push('', '## Manual Review');
  if (manualReview.length === 0) {
    lines.push('- None');
  } else {
    for (const { verdict, finding } of manualReview) {
      lines.push(`- ${verdict.bugId} | ${finding ? finding.file : 'unknown file'} | ${finding ? finding.claim : verdict.analysisSummary}`);
      lines.push(`  Confidence: ${verdict.confidenceScore} (${verdict.confidenceLabel})`);
      lines.push(`  Analysis: ${verdict.analysisSummary}`);
    }
  }

  lines.push('', '## Dismissed Findings');
  if (dismissed.length === 0) {
    lines.push('- None');
  } else {
    for (const { verdict, finding } of dismissed) {
      lines.push(`- ${verdict.bugId} | ${finding ? finding.file : 'unknown file'} | ${finding ? finding.claim : 'No finding available'}`);
      lines.push(`  Analysis: ${verdict.analysisSummary}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderCoverage({ coveragePath }) {
  const coverage = readJson(coveragePath);
  const lines = [
    '# Bug Hunter Coverage',
    '',
    `- Status: ${coverage.status}`,
    `- Iteration: ${coverage.iteration}`,
    `- Files: ${toArray(coverage.files).length}`,
    `- Bugs: ${toArray(coverage.bugs).length}`,
    `- Fix entries: ${toArray(coverage.fixes).length}`,
    '',
    '## Files'
  ];

  const files = toArray(coverage.files);
  if (files.length === 0) {
    lines.push('- None');
  } else {
    for (const entry of files) {
      lines.push(`- ${entry.status} | ${entry.path}`);
    }
  }

  lines.push('', '## Bugs');
  const bugs = toArray(coverage.bugs);
  if (bugs.length === 0) {
    lines.push('- None');
  } else {
    for (const bug of bugs) {
      lines.push(`- ${bug.bugId} | ${bug.severity} | ${bug.file} | ${bug.claim}`);
    }
  }

  lines.push('', '## Fixes');
  const fixes = toArray(coverage.fixes);
  if (fixes.length === 0) {
    lines.push('- None');
  } else {
    for (const fix of fixes) {
      lines.push(`- ${fix.bugId} | ${fix.status}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderSkeptic({ skepticPath }) {
  const skeptic = toArray(readJson(skepticPath));
  const lines = ['# Skeptic Review', ''];
  if (skeptic.length === 0) {
    lines.push('- None');
    return `${lines.join('\n')}\n`;
  }
  for (const item of skeptic) {
    lines.push(`- ${item.bugId} | ${item.response}`);
    lines.push(`  ${item.analysisSummary}`);
    if (item.counterEvidence) {
      lines.push(`  Evidence: ${item.counterEvidence}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderReferee({ refereePath }) {
  const referee = toArray(readJson(refereePath));
  const lines = ['# Referee Verdicts', ''];
  if (referee.length === 0) {
    lines.push('- None');
    return `${lines.join('\n')}\n`;
  }
  for (const item of referee) {
    lines.push(`- ${item.bugId} | ${item.verdict} | ${item.trueSeverity}`);
    lines.push(`  Confidence: ${item.confidenceScore} (${item.confidenceLabel}) | ${item.verificationMode}`);
    lines.push(`  Analysis: ${item.analysisSummary}`);
    if (item.suggestedFix) {
      lines.push(`  Suggested fix: ${item.suggestedFix}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderFixReport({ fixReportPath }) {
  const report = readJson(fixReportPath);
  const fixes = toArray(report.fixes);
  const lines = [
    '# Fix Report',
    '',
    `- Branch: ${report.fix_branch}`,
    `- Base commit: ${report.base_commit}`,
    `- Dry run: ${report.dry_run ? 'yes' : 'no'}`,
    `- Circuit breaker: ${report.circuit_breaker_tripped ? 'tripped' : 'not tripped'}`,
    `- Phase 2 timeout: ${report.phase2_timeout_hit ? 'hit' : 'not hit'}`,
    '',
    '## Fixes'
  ];
  if (fixes.length === 0) {
    lines.push('- None');
  } else {
    for (const item of fixes) {
      lines.push(`- ${item.bugId} | ${item.status} | ${item.severity}`);
      lines.push(`  Files: ${toArray(item.files).join(', ')}`);
      lines.push(`  Lines: ${item.lines}`);
      if (item.description) {
        lines.push(`  Description: ${item.description}`);
      }
      if (item.reason) {
        lines.push(`  Reason: ${item.reason}`);
      }
      if (item.commit) {
        lines.push(`  Commit: ${item.commit}`);
      }
    }
  }

  lines.push('', '## Verification');
  lines.push(`- Baseline: ${report.verification.baseline_pass} pass / ${report.verification.baseline_fail} fail`);
  lines.push(`- Final: ${report.verification.final_pass} pass / ${report.verification.final_fail} fail`);
  lines.push(`- New failures: ${report.verification.new_failures}`);
  lines.push(`- Resolved failures: ${report.verification.resolved_failures}`);
  lines.push(`- Typecheck: ${report.verification.typecheck_pass ? 'pass' : 'fail'}`);
  lines.push(`- Build: ${report.verification.build_pass ? 'pass' : 'fail'}`);
  lines.push(`- Fixer bugs found: ${report.verification.fixer_bugs_found}`);

  lines.push('', '## Summary');
  for (const [key, value] of Object.entries(report.summary || {})) {
    lines.push(`- ${key}: ${value}`);
  }

  return `${lines.join('\n')}\n`;
}

function renderFixStrategy({ fixStrategyPath }) {
  const strategy = readJson(fixStrategyPath);
  const clusters = toArray(strategy.clusters);
  const lines = [
    '# Fix Strategy',
    '',
    `- Confidence threshold: ${strategy.confidenceThreshold}`,
    `- Confirmed findings: ${strategy.summary.confirmed}`,
    `- Safe autofix: ${strategy.summary.safeAutofix}`,
    `- Manual review: ${strategy.summary.manualReview}`,
    `- Larger refactor: ${strategy.summary.largerRefactor}`,
    `- Architectural remediation: ${strategy.summary.architecturalRemediation}`,
    `- Canary candidates: ${strategy.summary.canaryCandidates}`,
    `- Rollout candidates: ${strategy.summary.rolloutCandidates}`,
    '',
    '## Clusters'
  ];

  if (clusters.length === 0) {
    lines.push('- None');
  } else {
    for (const cluster of clusters) {
      lines.push(`- ${cluster.clusterId} | ${cluster.strategy} | ${cluster.executionStage} | max severity ${cluster.maxSeverity}`);
      lines.push(`  Bugs: ${toArray(cluster.bugIds).join(', ')}`);
      lines.push(`  Files: ${toArray(cluster.files).join(', ')}`);
      lines.push(`  Summary: ${cluster.summary}`);
      lines.push(`  Action: ${cluster.recommendedAction}`);
      lines.push(`  Reasons: ${toArray(cluster.reasons).join(' | ')}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    usage();
    process.exit(1);
  }

  if (command === 'report') {
    const [findingsPath, refereePath] = args;
    if (!findingsPath || !refereePath) {
      usage();
      process.exit(1);
    }
    process.stdout.write(renderReport({
      findingsPath: path.resolve(findingsPath),
      refereePath: path.resolve(refereePath)
    }));
    return;
  }

  if (command === 'coverage') {
    const [coveragePath] = args;
    if (!coveragePath) {
      usage();
      process.exit(1);
    }
    process.stdout.write(renderCoverage({
      coveragePath: path.resolve(coveragePath)
    }));
    return;
  }

  if (command === 'skeptic') {
    const [skepticPath] = args;
    if (!skepticPath) {
      usage();
      process.exit(1);
    }
    process.stdout.write(renderSkeptic({
      skepticPath: path.resolve(skepticPath)
    }));
    return;
  }

  if (command === 'referee') {
    const [refereePath] = args;
    if (!refereePath) {
      usage();
      process.exit(1);
    }
    process.stdout.write(renderReferee({
      refereePath: path.resolve(refereePath)
    }));
    return;
  }

  if (command === 'fix-report') {
    const [fixReportPath] = args;
    if (!fixReportPath) {
      usage();
      process.exit(1);
    }
    process.stdout.write(renderFixReport({
      fixReportPath: path.resolve(fixReportPath)
    }));
    return;
  }

  if (command === 'fix-strategy') {
    const [fixStrategyPath] = args;
    if (!fixStrategyPath) {
      usage();
      process.exit(1);
    }
    process.stdout.write(renderFixStrategy({
      fixStrategyPath: path.resolve(fixStrategyPath)
    }));
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
