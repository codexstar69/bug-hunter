const SCHEMA_FILES = Object.freeze({
  recon: 'recon.schema.json',
  findings: 'findings.schema.json',
  skeptic: 'skeptic.schema.json',
  referee: 'referee.schema.json',
  coverage: 'coverage.schema.json',
  experiment: 'experiment.schema.json',
  'fix-report': 'fix-report.schema.json',
  'fix-plan': 'fix-plan.schema.json',
  'fix-strategy': 'fix-strategy.schema.json',
  'fixer-scope': 'fixer-scope.schema.json',
  'scan-report': 'scan-report.schema.json',
  shared: 'shared.schema.json'
});

const VALIDATOR_EXPORTS = Object.freeze({
  recon: 'recon',
  findings: 'findings',
  skeptic: 'skeptic',
  referee: 'referee',
  coverage: 'coverage',
  experiment: 'experiment',
  'fix-report': 'fixReport',
  'fix-plan': 'fixPlan',
  'fix-strategy': 'fixStrategy',
  'fixer-scope': 'fixerScope',
  'scan-report': 'scanReport'
});

module.exports = {
  SCHEMA_FILES,
  VALIDATOR_EXPORTS
};
