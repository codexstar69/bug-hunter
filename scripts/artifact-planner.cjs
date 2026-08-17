const fs = require('fs');
const path = require('path');

function nowIso() {
  return new Date().toISOString();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function severityRank(severity) {
  const normalized = String(severity || '').toLowerCase();
  if (normalized === 'critical') {
    return 3;
  }
  if (normalized === 'high') {
    return 2;
  }
  if (normalized === 'medium') {
    return 1;
  }
  if (normalized === 'low') {
    return 0;
  }
  return -1;
}

function buildConsistencyReport({ bugLedger, confidenceThreshold }) {
  const conflicts = [];
  const byBugId = new Map();
  const byLocation = new Map();

  for (const entry of bugLedger) {
    const bugId = String(entry.bugId || '').trim();
    const locationKey = `${entry.file || ''}|${entry.lines || ''}`;
    if (bugId) {
      if (!byBugId.has(bugId)) {
        byBugId.set(bugId, []);
      }
      byBugId.get(bugId).push(entry);
    }
    if (!byLocation.has(locationKey)) {
      byLocation.set(locationKey, []);
    }
    byLocation.get(locationKey).push(entry);
  }

  for (const [bugId, entries] of byBugId.entries()) {
    const uniqueKeys = new Set(entries.map((entry) => entry.key));
    if (uniqueKeys.size > 1) {
      conflicts.push({
        type: 'bug-id-reused',
        bugId,
        count: uniqueKeys.size,
        files: [...new Set(entries.map((entry) => entry.file))].sort()
      });
    }
  }

  for (const [location, entries] of byLocation.entries()) {
    const claims = [...new Set(entries.map((entry) => String(entry.claim || '').trim()).filter(Boolean))];
    if (claims.length > 1) {
      conflicts.push({
        type: 'location-claim-conflict',
        location,
        claims: claims.slice(0, 5)
      });
    }
  }

  const lowConfidence = bugLedger.filter((entry) => {
    const confidenceScore = entry.confidenceScore;
    return confidenceScore === null || confidenceScore === undefined || Number(confidenceScore) < confidenceThreshold;
  }).length;

  return {
    checkedAt: nowIso(),
    confidenceThreshold,
    totalFindings: bugLedger.length,
    lowConfidenceFindings: lowConfidence,
    conflicts
  };
}

function buildConflictSets(consistency) {
  const conflicts = toArray(consistency && consistency.conflicts);
  const bugIds = new Set();
  const locations = new Set();

  for (const conflict of conflicts) {
    if (conflict && conflict.type === 'bug-id-reused' && conflict.bugId) {
      bugIds.add(String(conflict.bugId));
    }
    if (conflict && conflict.type === 'location-claim-conflict' && conflict.location) {
      locations.add(String(conflict.location));
    }
  }

  return { bugIds, locations };
}

function classifyStrategy(entry, confidenceThreshold) {
  const confidenceScore = Number.isFinite(Number(entry.confidenceScore)) ? Number(entry.confidenceScore) : null;
  const claim = String(entry.claim || '').toLowerCase();
  const crossReferences = toArray(entry.crossReferences);
  const architecturalSignals = ['architecture', 'migration', 'schema', 'contract', 'signature', 'protocol'];
  const refactorSignals = ['refactor', 'transaction', 'concurrency', 'race', 'lock ordering'];

  if (confidenceScore === null || confidenceScore < confidenceThreshold) {
    return {
      strategy: 'manual-review',
      executionStage: 'manual-review',
      autofixEligible: false,
      reason: 'Confidence is below the autofix threshold.'
    };
  }

  if (architecturalSignals.some((signal) => claim.includes(signal)) || crossReferences.length >= 3) {
    return {
      strategy: 'architectural-remediation',
      executionStage: 'report-only',
      autofixEligible: false,
      reason: 'Claim spans broader contracts or architecture boundaries.'
    };
  }

  if (refactorSignals.some((signal) => claim.includes(signal)) || (severityRank(entry.severity) >= 2 && crossReferences.length >= 2)) {
    return {
      strategy: 'larger-refactor',
      executionStage: 'manual-review',
      autofixEligible: false,
      reason: 'Fix likely needs coordinated multi-file changes beyond a surgical patch.'
    };
  }

  return {
    strategy: 'safe-autofix',
    executionStage: severityRank(entry.severity) >= 2 ? 'canary' : 'rollout',
    autofixEligible: true,
    reason: 'Finding is localized enough for a guarded surgical fix.'
  };
}

function applyConflictClassification(entry, classification, conflictSets) {
  const bugId = String(entry.bugId || '').trim();
  const location = `${entry.file || ''}|${entry.lines || ''}`;
  const hasConflict = conflictSets.bugIds.has(bugId) || conflictSets.locations.has(location);
  if (!hasConflict) {
    return classification;
  }
  return {
    strategy: 'manual-review',
    executionStage: 'manual-review',
    autofixEligible: false,
    reason: 'Consistency conflict requires manual review before any fix is attempted.'
  };
}

function buildFixPlan({ bugLedger, confidenceThreshold, canarySize, consistency }) {
  const conflictSets = buildConflictSets(consistency);
  const classifiedEntries = bugLedger.map((entry) => {
    const confidenceRaw = entry.confidenceScore;
    const confidenceScore = Number.isFinite(Number(confidenceRaw)) ? Number(confidenceRaw) : null;
    const classification = applyConflictClassification(
      entry,
      classifyStrategy({ ...entry, confidenceScore }, confidenceThreshold),
      conflictSets
    );
    return {
      ...entry,
      confidenceScore,
      ...classification
    };
  });
  const eligible = classifiedEntries
    .filter((entry) => entry.autofixEligible === true)
    .sort((left, right) => {
      const severityDiff = severityRank(right.severity) - severityRank(left.severity);
      if (severityDiff !== 0) {
        return severityDiff;
      }
      const confidenceDiff = (right.confidenceScore || 0) - (left.confidenceScore || 0);
      if (confidenceDiff !== 0) {
        return confidenceDiff;
      }
      return String(left.key).localeCompare(String(right.key));
    });
  const manualReview = classifiedEntries
    .filter((entry) => entry.autofixEligible !== true)
    .map((entry) => {
      return {
        ...entry,
        executionStage: entry.strategy === 'architectural-remediation'
          ? 'report-only'
          : 'manual-review'
      };
    });
  const canary = eligible.slice(0, canarySize).map((entry) => {
    return {
      ...entry,
      executionStage: 'canary'
    };
  });
  const rollout = eligible.slice(canarySize).map((entry) => {
    return {
      ...entry,
      executionStage: 'rollout'
    };
  });

  return {
    generatedAt: nowIso(),
    confidenceThreshold,
    canarySize,
    totals: {
      findings: classifiedEntries.length,
      eligible: eligible.length,
      canary: canary.length,
      rollout: rollout.length,
      manualReview: manualReview.length
    },
    canary,
    rollout,
    manualReview
  };
}

function recommendedActionForStrategy(strategy) {
  if (strategy === 'architectural-remediation') {
    return 'Do not auto-edit. Capture a remediation design and schedule a broader change.';
  }
  if (strategy === 'larger-refactor') {
    return 'Pause before patching. Review interfaces, callers, and rollback scope with a human.';
  }
  if (strategy === 'manual-review') {
    return 'Keep this in the report and require human approval before any edits.';
  }
  return 'Proceed through the guarded fix pipeline with canary verification and rollback safety.';
}

function buildFixStrategy({ fixPlan, confidenceThreshold }) {
  const normalized = [
    ...toArray(fixPlan && fixPlan.canary),
    ...toArray(fixPlan && fixPlan.rollout),
    ...toArray(fixPlan && fixPlan.manualReview)
  ].map((entry) => {
    const filePath = String(entry.file || '').trim() || 'unknown-file';
    const clusterDir = path.dirname(filePath);
    const clusterSeed = `${entry.strategy}|${entry.executionStage}|${clusterDir}`;
    return {
      ...entry,
      file: filePath,
      clusterDir,
      clusterSeed
    };
  });

  const byCluster = new Map();
  for (const entry of normalized) {
    if (!byCluster.has(entry.clusterSeed)) {
      byCluster.set(entry.clusterSeed, []);
    }
    byCluster.get(entry.clusterSeed).push(entry);
  }

  const clusters = [...byCluster.entries()].map(([clusterSeed, entries], index) => {
    const strategy = entries[0].strategy;
    const executionStage = entries[0].executionStage;
    const files = [...new Set(entries.map((entry) => entry.file))].sort();
    const bugIds = [...new Set(entries.map((entry) => String(entry.bugId || entry.key || '').trim()).filter(Boolean))];
    const maxSeverity = entries
      .map((entry) => entry.severity)
      .sort((left, right) => severityRank(right) - severityRank(left))[0] || 'Low';
    const reasons = [...new Set(entries.map((entry) => entry.reason).filter(Boolean))];
    const firstDir = entries[0].clusterDir || path.dirname(files[0] || 'unknown-file');
    return {
      clusterId: `cluster-${index + 1}`,
      strategy,
      executionStage,
      autofixEligible: entries.every((entry) => entry.autofixEligible),
      bugIds,
      files,
      maxSeverity,
      summary: `${bugIds.length} bug(s) in ${firstDir || '.'} classified as ${strategy}.`,
      recommendedAction: recommendedActionForStrategy(strategy),
      reasons
    };
  }).sort((left, right) => {
    const stageRank = {
      canary: 0,
      rollout: 1,
      'manual-review': 2,
      'report-only': 3
    };
    const stageDiff = stageRank[left.executionStage] - stageRank[right.executionStage];
    if (stageDiff !== 0) {
      return stageDiff;
    }
    return severityRank(right.maxSeverity) - severityRank(left.maxSeverity);
  });

  const summary = {
    confirmed: normalized.length,
    safeAutofix: normalized.filter((entry) => entry.strategy === 'safe-autofix').length,
    manualReview: normalized.filter((entry) => entry.strategy === 'manual-review').length,
    largerRefactor: normalized.filter((entry) => entry.strategy === 'larger-refactor').length,
    architecturalRemediation: normalized.filter((entry) => entry.strategy === 'architectural-remediation').length,
    canaryCandidates: normalized.filter((entry) => entry.executionStage === 'canary').length,
    rolloutCandidates: normalized.filter((entry) => entry.executionStage === 'rollout').length
  };

  return {
    version: '3.1.0',
    generatedAt: nowIso(),
    confidenceThreshold,
    summary,
    clusters
  };
}

function selectRefereeAuthorizedFindings({ bugLedger, authorization }) {
  const findingsById = new Map();
  bugLedger.map((finding) => {
    const bugId = String(finding.bugId || '').trim();
    if (!bugId) {
      throw new Error('A Hunter finding is missing the stable bugId required for Referee authorization');
    }
    if (findingsById.has(bugId)) {
      throw new Error(`Duplicate Hunter finding ID cannot be authorized: ${bugId}`);
    }
    findingsById.set(bugId, finding);
    return finding;
  });

  authorization.verdicts.map((verdict) => {
    if (!findingsById.has(verdict.bugId)) {
      throw new Error(`Referee verdict references unknown finding ID: ${verdict.bugId}`);
    }
    return verdict;
  });

  return authorization.verdicts
    .filter((verdict) => verdict.verdict === 'REAL_BUG')
    .map((verdict) => {
      const finding = findingsById.get(verdict.bugId);
      return {
        ...finding,
        severity: verdict.trueSeverity,
        confidenceScore: verdict.confidenceScore,
        confidenceLabel: verdict.confidenceLabel
      };
    });
}

function buildFixerScope({ runIdentity, authorizedFindings, fixPlan }) {
  const repositoryRoot = fs.realpathSync(runIdentity.repositoryRoot);
  const findingsById = new Map();

  for (const finding of authorizedFindings) {
    const bugId = String(finding.bugId || '').trim();
    if (!bugId) {
      throw new Error('Referee-authorized finding is missing a bug ID');
    }
    if (findingsById.has(bugId)) {
      throw new Error(`Duplicate Referee-authorized bug ID: ${bugId}`);
    }
    const resolvedFile = path.resolve(String(finding.file));
    if (!fs.existsSync(resolvedFile)) {
      throw new Error(`Referee-authorized file does not exist: ${finding.file}`);
    }
    const realFile = fs.realpathSync(resolvedFile);
    const relative = path.relative(repositoryRoot, realFile);
    if (relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
      throw new Error(`Referee-authorized file is outside the repository root: ${finding.file}`);
    }
    findingsById.set(bugId, { finding, realFile });
  }

  const planEntries = [
    ...toArray(fixPlan && fixPlan.canary),
    ...toArray(fixPlan && fixPlan.rollout),
    ...toArray(fixPlan && fixPlan.manualReview)
  ];
  for (const entry of planEntries) {
    const bugId = String(entry.bugId || '').trim();
    const authorized = findingsById.get(bugId);
    if (!authorized) {
      throw new Error(`Fix plan expanded beyond Referee authorization: ${bugId} at ${entry.file}`);
    }
    const resolvedEntry = path.resolve(String(entry.file || ''));
    const realEntry = fs.existsSync(resolvedEntry)
      ? fs.realpathSync(resolvedEntry)
      : resolvedEntry;
    if (realEntry !== authorized.realFile) {
      throw new Error(`Fix plan expanded beyond Referee authorization: ${bugId} at ${entry.file}`);
    }
  }

  const executableEntries = [
    ...toArray(fixPlan && fixPlan.canary),
    ...toArray(fixPlan && fixPlan.rollout)
  ];
  const approvedBugIds = new Set();
  const approvedFiles = new Set();
  for (const entry of executableEntries) {
    const bugId = String(entry.bugId || '').trim();
    const authorized = findingsById.get(bugId);
    approvedBugIds.add(bugId);
    approvedFiles.add(authorized.realFile);
  }

  return {
    schemaVersion: 1,
    runId: runIdentity.runId,
    repositoryRoot,
    baseCommit: runIdentity.baseCommit,
    approvedBugIds: [...approvedBugIds].sort(),
    approvedFiles: [...approvedFiles].sort()
  };
}

module.exports = {
  buildConsistencyReport,
  buildFixPlan,
  buildFixStrategy,
  buildFixerScope,
  selectRefereeAuthorizedFindings
};
