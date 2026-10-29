#!/usr/bin/env node

/**
 * triage.cjs — Zero-token pre-Recon codebase triage
 *
 * Runs BEFORE any LLM agent is invoked. Uses pure filesystem operations
 * (no fd, rg, grep, or any optional CLI tool) to:
 *
 * 1. Count and classify all source files
 * 2. Decide the optimal execution strategy
 * 3. Build a risk-scored file list using path heuristics
 * 4. Compute FILE_BUDGET from actual file sizes
 * 5. Output a machine-readable plan the orchestrator can act on directly
 *
 * This replaces the expensive "Recon agent reads 2,000 files" step with
 * a deterministic script that uses no LLM tokens.
 *
 * Usage:
 *   triage.cjs scan <targetPath> [--output <path>] [--max-depth <n>]
 *   triage.cjs scan <targetPath> --format human
 *
 * Output: JSON plan to stdout (or --output file) with:
 *   - strategy: "single-file" | "small" | "parallel" | "extended" | "scaled" | "large-codebase"
 *   - totalFiles: supported source count (includes directory context-only files);
 *     excluded single-file targets report zero files and an empty scanOrder
 *   - scannableFiles: scanOrder.length, excluding tests/context-only files
 *   - fileBudget: computed from actual file sizes
 *   - domains: directory-level risk classification
 *   - riskMap: file-level classification (only for ≤200 files)
 *   - scanOrder: complete risk-ordered file manifest at every repository size
 *   - domainSummaries: separate human-readable domain descriptions
 *   - coverageLimitations: unreadable paths and max-depth truncation
 *   - modeFile and needsLoop: selected pipeline and looping recommendation
 */

const fs = require('fs');
const path = require('path');

const MAX_SCAN_DEPTH = 100;

// ─── Source extensions ───────────────────────────────────────────────
const {
  DEFAULT_SOURCE_TOKEN_BUDGET,
  MAX_FILES_PER_CHUNK,
  buildSourceChunks,
  isSupportedSourceFile,
  classifySourcePath,
  extractImports,
  inferSourceExtension,
  isTestSourcePath
} = require('./source-config.cjs');

// ─── Directories to always skip ─────────────────────────────────────
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', '.git', '__pycache__',
  '.next', 'coverage', '.cache', 'tmp', '.tmp', '.idea', '.vscode',
  '.svn', 'target', 'out', '.output', '.nuxt', '.turbo', '.parcel-cache',
  'bower_components', 'jspm_packages', '.yarn', '.pnp',
  'venv', '.venv', 'env', '.env', 'virtualenv',
  'Pods', '.gradle', '.mvn', 'obj',
  'artifacts', 'logs', '.terraform'
]);

// ─── Walk filesystem with explicit coverage limitations ─────────────
function walkDir(dirPath, maxDepth, currentDepth = 0, limitations = []) {
  const results = [];
  const stack = [{ directory: dirPath, depth: currentDepth }];
  while (stack.length > 0) {
    const { directory, depth } = stack.pop();
    if (depth > maxDepth) {
      limitations.push({ path: directory, reason: 'max-depth', maxDepth });
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      limitations.push({ path: directory, reason: 'directory-read-failed', code: error.code || 'UNKNOWN' });
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push({ directory: fullPath, depth: depth + 1 });
      } else if (entry.isFile()) {
        try {
          if (isSupportedSourceFile(fullPath)) results.push(fullPath);
        } catch (error) {
          limitations.push({ path: fullPath, reason: 'file-read-failed', code: error.code || 'UNKNOWN' });
        }
      }
    }
  }
  return results;
}

function classifyFile(filePath, repoRoot, classifications) {
  return classifications.get(filePath);
}

// ─── Discover domain boundaries ─────────────────────────────────────
function discoverDomains(files, repoRoot, classifications) {
  // Group files by their top-level meaningful directory
  const domainFiles = new Map();

  for (const filePath of files) {
    const relative = path.relative(repoRoot, filePath);
    const parts = relative.split(path.sep);

    // Find the domain root: first 1-2 meaningful directory levels
    let domainKey;
    if (parts.length <= 1) {
      domainKey = '.';
    } else if (['src', 'lib', 'app', 'packages', 'services', 'apps', 'modules'].includes(parts[0].toLowerCase())) {
      domainKey = parts.length >= 3 ? parts.slice(0, 2).join('/') : parts[0];
    } else {
      domainKey = parts[0];
    }

    if (!domainFiles.has(domainKey)) {
      domainFiles.set(domainKey, []);
    }
    domainFiles.get(domainKey).push(filePath);
  }

  // Classify each domain
  const domains = [];
  for (const [domainPath, domainFileList] of domainFiles.entries()) {
    const riskCounts = { critical: 0, high: 0, medium: 0, low: 0, 'context-only': 0 };
    for (const f of domainFileList) {
      const risk = classifyFile(f, repoRoot, classifications);
      riskCounts[risk] += 1;
    }

    // Domain tier = based on concentration of risk, not just presence
    let tier;
    const total = domainFileList.length;
    const criticalRatio = riskCounts.critical / total;
    const highRatio = riskCounts.high / total;

    if (riskCounts.critical >= 3 && criticalRatio >= 0.15) {
      // Genuinely critical: meaningful portion of files are critical
      tier = 'CRITICAL';
    } else if (riskCounts.critical >= 1 && criticalRatio >= 0.3) {
      // Small domain where most files are critical
      tier = 'CRITICAL';
    } else if (riskCounts.critical >= 1) {
      // Has some critical files but mostly other stuff — boost to HIGH
      tier = 'HIGH';
    } else if (riskCounts.high > 0) {
      tier = 'HIGH';
    } else if (riskCounts['context-only'] > total * 0.8) {
      tier = 'CONTEXT-ONLY';
    } else if (riskCounts.low > total * 0.5) {
      tier = 'LOW';
    } else {
      tier = 'MEDIUM';
    }

    domains.push({
      path: domainPath,
      tier,
      fileCount: domainFileList.length,
      riskBreakdown: riskCounts,
      files: domainFileList.map((f) => path.relative(repoRoot, f))
    });
  }

  // Sort: CRITICAL first, then HIGH, then MEDIUM, then rest
  const tierOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, 'CONTEXT-ONLY': 4 };
  domains.sort((a, b) => (tierOrder[a.tier] ?? 99) - (tierOrder[b.tier] ?? 99));

  return domains;
}

// ─── Compute FILE_BUDGET from actual file sizes ─────────────────────
function computeFileBudget(files, limitations = []) {
  const tokensByFile = new Map();
  let estimatedSourceTokens = 0;
  let totalLines = 0;
  let sampled = 0;
  const sampleStep = Math.max(1, Math.floor(files.length / 30));
  for (let i = 0; i < files.length; i += 1) {
    try {
      const stat = fs.statSync(files[i]);
      const tokens = Math.max(1, Math.ceil(stat.size / 4));
      tokensByFile.set(files[i], tokens);
      if (sampled < 30 && i % sampleStep === 0 && stat.size <= 5 * 1024 * 1024) {
        totalLines += fs.readFileSync(files[i], 'utf8').split('\n').length;
        sampled += 1;
      }
    } catch (error) {
      limitations.push({ path: files[i], reason: 'file-read-failed', code: error.code || 'UNKNOWN' });
      // Unknown sizes must not silently become one-token files.
      tokensByFile.set(files[i], DEFAULT_SOURCE_TOKEN_BUDGET + 1);
    }
    estimatedSourceTokens += tokensByFile.get(files[i]);
  }
  // Size every planned chunk once, using the final risk-ordered source manifest.
  const plannedChunks = buildSourceChunks(files, {
    maxFiles: MAX_FILES_PER_CHUNK,
    maxSourceTokens: DEFAULT_SOURCE_TOKEN_BUDGET,
    enforceTokenBudget: true,
    tokensByFile
  });
  const avgLines = sampled ? Math.round(totalLines / sampled) : 0;
  return {
    fileBudget: plannedChunks.length ? Math.max(1, plannedChunks[0].files.length) : MAX_FILES_PER_CHUNK,
    avgLines,
    totalLines: avgLines * files.length,
    avgTokens: files.length ? Math.ceil(estimatedSourceTokens / files.length) : 0,
    sampledFiles: sampled,
    plannedChunkCount: plannedChunks.length,
    estimatedSourceTokens,
    perHunterChunk: plannedChunks.reduce((max, chunk) => Math.max(max, chunk.estimatedSourceTokens), 0)
  };
}

function determineStrategy(fileCount, plannedChunkCount) {
  let strategy;
  if (fileCount <= 1) strategy = 'single-file';
  else if (fileCount > 200 || plannedChunkCount > 4) strategy = 'large-codebase';
  else if (fileCount <= 10 && plannedChunkCount <= 1) strategy = 'small';
  else if (plannedChunkCount <= 1) strategy = 'parallel';
  else if (plannedChunkCount === 2) strategy = 'extended';
  else strategy = 'scaled';
  return { strategy, modeFile: `modes/${strategy}.md`, needsLoop: strategy === 'large-codebase' };
}

// ─── Build the risk map (file-level, only for small/medium codebases)
function buildRiskMap(files, repoRoot, classifications) {
  const riskMap = { critical: [], high: [], medium: [], low: [], 'context-only': [] };

  for (const filePath of files) {
    const risk = classifyFile(filePath, repoRoot, classifications);
    const relative = path.relative(repoRoot, filePath);
    riskMap[risk].push(relative);
  }

  // Sort each tier alphabetically
  for (const tier of Object.keys(riskMap)) {
    riskMap[tier].sort();
  }

  return riskMap;
}

// ─── Main: triage scan ──────────────────────────────────────────────
function scan(targetPath, options = {}) {
  const resolvedTarget = path.resolve(targetPath);
  const maxDepth = options.maxDepth ?? 20;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_SCAN_DEPTH) {
    throw new Error(`max depth must be an integer between 0 and ${MAX_SCAN_DEPTH}`);
  }
  const stat = fs.statSync(resolvedTarget);
  const repoRoot = stat.isFile() ? path.dirname(resolvedTarget) : resolvedTarget;
  const coverageLimitations = [];
  let candidates;
  if (stat.isFile()) {
    try { candidates = isSupportedSourceFile(resolvedTarget) ? [resolvedTarget] : []; }
    catch (error) {
      coverageLimitations.push({ path: resolvedTarget, reason: 'file-read-failed', code: error.code || 'UNKNOWN' });
      candidates = [];
    }
  } else {
    candidates = walkDir(resolvedTarget, maxDepth, 0, coverageLimitations);
  }
  const classifications = new Map();
  const allFiles = candidates.filter((filePath) => {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const imports = extractImports(content, inferSourceExtension(filePath, content));
      const risk = classifySourcePath(path.relative(repoRoot, filePath), imports).riskHint;
      // A single excluded target has zero source/scannable files. Directory scans
      // retain context-only files in totalFiles and riskMap for Recon context.
      if (stat.isFile() && (risk === 'context-only' || isTestSourcePath(resolvedTarget))) return false;
      classifications.set(filePath, risk);
      return true;
    } catch (error) {
      coverageLimitations.push({ path: filePath, reason: 'file-read-failed', code: error.code || 'UNKNOWN' });
      return false;
    }
  });
  const totalFiles = allFiles.length;
  const fullRiskMap = buildRiskMap(allFiles, repoRoot, classifications);
  const scanOrder = [...fullRiskMap.critical, ...fullRiskMap.high, ...fullRiskMap.medium, ...fullRiskMap.low];
  const scannable = scanOrder.length;
  const budget = computeFileBudget(scanOrder.map((file) => path.join(repoRoot, file)), coverageLimitations);
  const { strategy, modeFile, needsLoop } = determineStrategy(scannable, budget.plannedChunkCount);
  const domains = discoverDomains(allFiles, repoRoot, classifications);
  const includeFileRiskMap = totalFiles <= 200;
  const reconTokens = includeFileRiskMap ? Math.min(totalFiles * 20, 5000) : Math.min(domains.length * 100, 3000);
  const recommendations = [];
  if (strategy === 'single-file' || strategy === 'small') recommendations.push('Small codebase — Recon is optional, proceed directly to Hunter.');
  if (strategy === 'large-codebase') {
    recommendations.push('Large codebase — use domain-scoped auditing. Process one domain at a time.');
    recommendations.push(`${domains.filter((domain) => domain.tier === 'CRITICAL').length} CRITICAL domains to audit first.`);
  }
  if (budget.avgLines > 300) recommendations.push(`Large files (avg ${budget.avgLines} lines) — FILE_BUDGET is ${budget.fileBudget}. Chunking is important.`);
  if (!includeFileRiskMap) recommendations.push('File-level risk map omitted; scanOrder retains the complete ordered source manifest.');
  if (coverageLimitations.length) recommendations.push('Coverage is incomplete; inspect coverageLimitations before claiming a complete audit.');
  const result = {
    generatedAt: new Date().toISOString(),
    target: resolvedTarget,
    totalFiles,
    scannableFiles: scannable,
    strategy,
    modeFile,
    needsLoop,
    fileBudget: budget.fileBudget,
    avgLines: budget.avgLines,
    avgTokensPerFile: budget.avgTokens,
    estimatedTotalLines: budget.totalLines,
    estimatedSourceTokens: budget.estimatedSourceTokens,
    sampledFiles: budget.sampledFiles,
    plannedChunkCount: budget.plannedChunkCount,
    domains: domains.map(({ path: domainPath, tier, fileCount, riskBreakdown }) => ({ path: domainPath, tier, fileCount, riskBreakdown })),
    domainSummaries: domains.filter((domain) => domain.tier !== 'CONTEXT-ONLY').map((domain) => `${domain.path}/ (${domain.fileCount} files, ${domain.tier})`),
    scanOrder,
    coverageComplete: coverageLimitations.length === 0,
    coverageLimitations,
    tokenEstimate: {
      recon: reconTokens,
      perHunterChunk: budget.perHunterChunk,
      totalPipeline: reconTokens + budget.estimatedSourceTokens + scannable * 200
    },
    recommendations
  };
  if (includeFileRiskMap) result.riskMap = fullRiskMap;
  if (strategy === 'large-codebase') {
    result.domainFileLists = Object.create(null);
    const scannablePaths = new Set(scanOrder);
    for (const domain of domains) {
      const files = domain.files.filter((file) => scannablePaths.has(file));
      if (files.length) result.domainFileLists[domain.path] = files;
    }
  }
  return result;
}

// ─── Human-readable output ──────────────────────────────────────────
function formatHuman(result) {
  const lines = [];
  lines.push(`Bug Hunter Triage — ${result.target}`);
  lines.push('═'.repeat(60));
  lines.push('');
  lines.push(`Total source files:    ${result.totalFiles}`);
  lines.push(`Scannable files:       ${result.scannableFiles}`);
  lines.push(`Average lines/file:    ${result.avgLines}`);
  lines.push(`FILE_BUDGET:           ${result.fileBudget}`);
  lines.push(`Strategy:              ${result.strategy}`);
  lines.push(`Mode file:             ${result.modeFile}`);
  lines.push(`Needs --loop:          ${result.needsLoop ? 'YES' : 'no'}`);
  lines.push('');
  for (const limit of result.coverageLimitations) lines.push(`Coverage limitation: ${limit.reason}: ${limit.path}`);
  lines.push('Domains:');
  // Sort by tier for display: CRITICAL → HIGH → MEDIUM → LOW → CONTEXT-ONLY
  const tierOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, 'CONTEXT-ONLY': 4 };
  const sorted = [...result.domains].sort((a, b) => (tierOrder[a.tier] ?? 99) - (tierOrder[b.tier] ?? 99));
  for (const d of sorted) {
    lines.push(`  ${d.tier.padEnd(12)} ${d.path} (${d.fileCount} files)`);
  }
  lines.push('');
  lines.push('Token estimates:');
  lines.push(`  Recon:           ~${result.tokenEstimate.recon.toLocaleString()} tokens`);
  lines.push(`  Per Hunter chunk: ~${result.tokenEstimate.perHunterChunk.toLocaleString()} tokens`);
  lines.push(`  Full pipeline:   ~${result.tokenEstimate.totalPipeline.toLocaleString()} tokens`);
  lines.push('');
  if (result.recommendations.length > 0) {
    lines.push('Recommendations:');
    for (const r of result.recommendations) {
      lines.push(`  • ${r}`);
    }
  }
  return lines.join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { command: null, target: null, output: null, maxDepth: 20, format: 'json' };
  let i = 0;
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    args.command = argv[0];
    i = 1;
  }
  if (i < argv.length && !argv[i].startsWith('-')) {
    args.target = argv[i];
    i += 1;
  }
  while (i < argv.length) {
    const flag = argv[i];
    if (flag === '--output' && i + 1 < argv.length) {
      args.output = argv[i + 1];
      i += 2;
    } else if (flag === '--max-depth' && i + 1 < argv.length) {
      const maxDepth = Number(argv[i + 1]);
      if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_SCAN_DEPTH) {
        throw new Error(`--max-depth must be an integer between 0 and ${MAX_SCAN_DEPTH}`);
      }
      args.maxDepth = maxDepth;
      i += 2;
    } else if (flag === '--format' && i + 1 < argv.length) {
      args.format = argv[i + 1];
      i += 2;
    } else {
      i += 1;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command !== 'scan' || !args.target) {
    console.error('Usage:');
    console.error('  triage.cjs scan <targetPath> [--output <path>] [--max-depth <n>] [--format json|human]');
    process.exit(1);
  }

  const result = scan(args.target, { maxDepth: args.maxDepth });

  if (args.format === 'human') {
    console.log(formatHuman(result));
  } else {
    const json = JSON.stringify(result, null, 2);
    if (args.output) {
      const dir = path.dirname(args.output);
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(args.output, json + '\n', 'utf8');
      console.log(JSON.stringify({ ok: true, outputPath: args.output, totalFiles: result.totalFiles, strategy: result.strategy }));
    } else {
      console.log(json);
    }
  }
}

try {
  if (require.main === module) main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

module.exports = { computeFileBudget, determineStrategy, scan, walkDir };
