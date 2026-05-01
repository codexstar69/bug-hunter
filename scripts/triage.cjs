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
 * a deterministic script that costs 0 tokens and runs in <2 seconds.
 *
 * Usage:
 *   triage.cjs scan <targetPath> [--output <path>] [--max-depth <n>]
 *   triage.cjs scan <targetPath> --format human
 *
 * Output: JSON plan to stdout (or --output file) with:
 *   - strategy: "single-file" | "small" | "parallel" | "extended" | "scaled" | "large-codebase"
 *   - fileBudget: computed from actual file sizes
 *   - domains: directory-level risk classification
 *   - riskMap: file-level classification (only for ≤200 files)
 *   - plan: which mode file to read, whether --loop is needed
 */

const fs = require('fs');
const path = require('path');

// ─── Source extensions ───────────────────────────────────────────────
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php',
  '.cs', '.cpp', '.c', '.h', '.hpp', '.swift', '.scala',
  '.ex', '.exs', '.erl', '.hs', '.ml', '.clj', '.lua'
]);

// ─── Directories to always skip ─────────────────────────────────────
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', '.git', '__pycache__',
  '.next', 'coverage', '.cache', 'tmp', '.tmp', '.idea', '.vscode',
  '.svn', 'target', 'out', '.output', '.nuxt', '.turbo', '.parcel-cache',
  'bower_components', 'jspm_packages', '.yarn', '.pnp',
  'venv', '.venv', 'virtualenv',
  'Pods', '.gradle', '.mvn', 'bin', 'obj',
  'artifacts', 'logs', '.terraform'
]);

// ─── Non-source directories (low value for bug hunting) ─────────────
const LOW_VALUE_DIRS = new Set([
  'docs', 'doc', 'documentation', 'assets', 'public', 'static',
  'images', 'img', 'icons', 'fonts', 'styles', 'css', 'scss',
  'less', 'locales', 'i18n', 'l10n', 'translations',
  'migrations', 'seeds', 'fixtures', 'snapshots', '__snapshots__',
  'scripts', 'tools', 'devtools', 'examples', 'samples', 'demo',
  'storybook', '.storybook', 'stories'
]);

// ─── Risk classification by directory name ──────────────────────────
const CRITICAL_PATTERNS = /\b(auth|security|session|token|jwt|oauth|saml|permission|acl|rbac|crypto|secret|credential|password|login|signup|register|verify|middleware|gateway|proxy|payment|billing|checkout|charge|subscription|stripe|paypal|webhook|callback)\b/i;
const HIGH_PATTERNS = /\b(api|route|router|controller|handler|endpoint|resolver|service|model|schema|database|db|repository|store|state|queue|worker|job|cron|consumer|producer|cache|redis|mongo|prisma|sequelize|typeorm|knex|sql|graphql|trpc|grpc|socket|websocket|sse|stream|upload|download|file|storage|s3|email|notification|sms)\b/i;
const MEDIUM_PATTERNS = /\b(util|utils|helper|helpers|lib|common|shared|core|config|env|logger|error|exception|validator|sanitize|transform|format|parse|convert|serialize)\b/i;
const TEST_PATTERNS = /\b(test|tests|spec|specs|__tests__|__test__|testing|e2e|integration|unit|cypress|playwright|jest)\b/i;
const TEST_FILE_PATTERNS = /\.(test|spec|e2e)\.(ts|tsx|js|jsx|py|go|rs|java|rb)$|_test\.(go|py|rb)$|Test\.(java|kt)$/;

// ─── Walk filesystem (no external tools needed) ─────────────────────
function walkDir(dirPath, maxDepth, currentDepth) {
  if (currentDepth > maxDepth) {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      results.push(...walkDir(fullPath, maxDepth, currentDepth + 1));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SOURCE_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

// ─── Classify a single file by its path ─────────────────────────────
function classifyFile(filePath, repoRoot) {
  const relative = path.relative(repoRoot, filePath);
  const parts = relative.split(path.sep);
  const dirPath = parts.slice(0, -1).join('/');
  const fileName = parts[parts.length - 1];

  // Test files
  if (TEST_FILE_PATTERNS.test(fileName) || parts.some((p) => TEST_PATTERNS.test(p))) {
    return 'context-only';
  }

  // Low-value directories
  if (parts.some((p) => LOW_VALUE_DIRS.has(p.toLowerCase()))) {
    return 'low';
  }

  // Check file path + name against risk patterns
  const fullPathStr = dirPath + '/' + fileName;
  if (CRITICAL_PATTERNS.test(fullPathStr)) {
    return 'critical';
  }
  if (HIGH_PATTERNS.test(fullPathStr)) {
    return 'high';
  }
  if (MEDIUM_PATTERNS.test(fullPathStr)) {
    return 'medium';
  }

  // Default: medium (unknown files are worth scanning)
  return 'medium';
}

// ─── Discover domain boundaries ─────────────────────────────────────
function discoverDomains(files, repoRoot) {
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
      const risk = classifyFile(f, repoRoot);
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
  domains.sort((a, b) => (tierOrder[a.tier] || 99) - (tierOrder[b.tier] || 99));

  return domains;
}

// ─── Compute FILE_BUDGET from actual file sizes ─────────────────────
function computeFileBudget(files) {
  if (files.length === 0) {
    return { fileBudget: 40, avgLines: 0, totalLines: 0, avgTokens: 0, sampledFiles: 0 };
  }

  // Sample up to 30 files to estimate average size (fast, even for huge repos)
  const sampleSize = Math.min(30, files.length);
  const step = Math.max(1, Math.floor(files.length / sampleSize));
  let totalLines = 0;
  let sampled = 0;

  for (let i = 0; i < files.length && sampled < sampleSize; i += step) {
    try {
      const content = fs.readFileSync(files[i], 'utf8');
      totalLines += content.split('\n').length;
      sampled += 1;
    } catch {
      // Skip unreadable files
    }
  }

  if (sampled === 0) {
    return { fileBudget: 40, avgLines: 0, totalLines: 0, avgTokens: 0, sampledFiles: 0 };
  }

  const avgLines = Math.round(totalLines / sampled);
  const avgTokens = avgLines * 4;
  const estimatedTotalLines = avgLines * files.length;

  // FILE_BUDGET = floor(150000 / avgTokens), capped at 60, floored at 10
  let fileBudget;
  if (avgTokens <= 0) {
    fileBudget = 60;
  } else {
    fileBudget = Math.floor(150000 / avgTokens);
  }
  fileBudget = Math.max(10, Math.min(60, fileBudget));

  return { fileBudget, avgLines, totalLines: estimatedTotalLines, avgTokens, sampledFiles: sampled };
}

// ─── Determine strategy ─────────────────────────────────────────────
function determineStrategy(fileCount, fileBudget) {
  if (fileCount <= 1) {
    return { strategy: 'single-file', modeFile: 'modes/single-file.md', needsLoop: false };
  }
  if (fileCount <= 10) {
    return { strategy: 'small', modeFile: 'modes/small.md', needsLoop: false };
  }
  if (fileCount <= fileBudget) {
    return { strategy: 'parallel', modeFile: 'modes/parallel.md', needsLoop: false };
  }
  if (fileCount <= fileBudget * 2) {
    return { strategy: 'extended', modeFile: 'modes/extended.md', needsLoop: false };
  }
  if (fileCount <= fileBudget * 3) {
    return { strategy: 'scaled', modeFile: 'modes/scaled.md', needsLoop: false };
  }
  return { strategy: 'large-codebase', modeFile: 'modes/large-codebase.md', needsLoop: true };
}

// ─── Build the risk map (file-level, only for small/medium codebases)
function buildRiskMap(files, repoRoot) {
  const riskMap = { critical: [], high: [], medium: [], low: [], 'context-only': [] };

  for (const filePath of files) {
    const risk = classifyFile(filePath, repoRoot);
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
function scan(targetPath, options) {
  const resolvedTarget = path.resolve(targetPath);
  const maxDepth = options.maxDepth || 20;

  if (!fs.existsSync(resolvedTarget)) {
    throw new Error(`Target not found: ${resolvedTarget}`);
  }

  // Single file?
  const stat = fs.statSync(resolvedTarget);
  if (stat.isFile()) {
    const relative = path.basename(resolvedTarget);
    return {
      generatedAt: new Date().toISOString(),
      target: resolvedTarget,
      totalFiles: 1,
      strategy: 'single-file',
      modeFile: 'modes/single-file.md',
      needsLoop: false,
      fileBudget: 40,
      avgLines: 0,
      riskMap: { critical: [relative], high: [], medium: [], low: [], 'context-only': [] },
      domains: [],
      scanOrder: [relative],
      tokenEstimate: { recon: 0, perHunterChunk: 0, total: 0 },
      recommendations: ['Single file — run full pipeline directly, skip Recon.']
    };
  }

  // Directory scan
  const allFiles = walkDir(resolvedTarget, maxDepth, 0);
  const totalFiles = allFiles.length;

  // Compute FILE_BUDGET
  const budget = computeFileBudget(allFiles);

  // Determine strategy
  const { strategy, modeFile, needsLoop } = determineStrategy(totalFiles, budget.fileBudget);

  // Discover domains
  const domains = discoverDomains(allFiles, resolvedTarget);

  // Build risk map only for ≤ 200 files (otherwise too expensive for the output)
  const includeFileRiskMap = totalFiles <= 200;
  const riskMap = includeFileRiskMap ? buildRiskMap(allFiles, resolvedTarget) : null;

  // Build scan order: CRITICAL → HIGH → MEDIUM (skip low + context-only)
  let scanOrder;
  if (riskMap) {
    scanOrder = [...riskMap.critical, ...riskMap.high, ...riskMap.medium];
    if (scanOrder.length === 0 && riskMap.low.length > 0) {
      scanOrder = [...riskMap.low];
    }
  } else {
    // For large codebases, just list domains in priority order
    scanOrder = domains
      .filter((d) => d.tier !== 'CONTEXT-ONLY' && d.tier !== 'LOW')
      .map((d) => `${d.path}/ (${d.fileCount} files, ${d.tier})`);
  }

  // Token estimates
  const scannable = riskMap
    ? scanOrder.length
    : domains.filter((d) => !['CONTEXT-ONLY', 'LOW'].includes(d.tier)).reduce((s, d) => s + d.fileCount, 0);
  const tokensPerFile = budget.avgTokens || 400;
  const reconTokens = includeFileRiskMap ? Math.min(totalFiles * 20, 5000) : Math.min(domains.length * 100, 3000);
  const perHunterChunk = Math.min(budget.fileBudget, scannable) * tokensPerFile;
  const totalTokenEstimate = reconTokens + (scannable * tokensPerFile) + (scannable * 200); // 200 tokens per finding estimate

  // Recommendations
  const recommendations = [];
  if (strategy === 'single-file' || strategy === 'small') {
    recommendations.push('Small codebase — Recon is optional, proceed directly to Hunter.');
  }
  if (strategy === 'large-codebase') {
    recommendations.push('Large codebase — use domain-scoped auditing. Process one domain at a time.');
    recommendations.push(`${domains.filter((d) => d.tier === 'CRITICAL').length} CRITICAL domains to audit first.`);
    if (!needsLoop) {
      recommendations.push('Consider --loop for full coverage.');
    }
  }
  if (budget.avgLines > 300) {
    recommendations.push(`Large files (avg ${budget.avgLines} lines) — FILE_BUDGET is low (${budget.fileBudget}). Chunking is important.`);
  }
  if (totalFiles > 500 && !includeFileRiskMap) {
    recommendations.push('File-level risk map omitted for performance. Recon should classify files within each domain.');
  }
  if (riskMap && riskMap.critical.length + riskMap.high.length + riskMap.medium.length === 0 && riskMap.low.length > 0) {
    recommendations.push('Only LOW-tier source files detected — promote them into scan order to avoid an empty audit.');
  }

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
    avgTokensPerFile: budget.avgTokens || 400,
    estimatedTotalLines: budget.totalLines,
    sampledFiles: budget.sampledFiles,
    domains: domains.map((d) => ({
      path: d.path,
      tier: d.tier,
      fileCount: d.fileCount,
      riskBreakdown: d.riskBreakdown
    })),
    scanOrder,
    tokenEstimate: {
      recon: reconTokens,
      perHunterChunk,
      totalPipeline: totalTokenEstimate
    },
    recommendations
  };

  // Include file-level risk map only for small-to-medium codebases
  if (riskMap) {
    result.riskMap = riskMap;
  }

  // Include domain file lists only for large-codebase strategy
  if (strategy === 'large-codebase') {
    result.domainFileLists = {};
    for (const domain of domains) {
      if (domain.tier !== 'CONTEXT-ONLY') {
        result.domainFileLists[domain.path] = domain.files;
      }
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
  lines.push('Domains:');
  // Sort by tier for display: CRITICAL → HIGH → MEDIUM → LOW → CONTEXT-ONLY
  const tierOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, 'CONTEXT-ONLY': 4 };
  const sorted = [...result.domains].sort((a, b) => (tierOrder[a.tier] || 99) - (tierOrder[b.tier] || 99));
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
      args.maxDepth = parseInt(argv[i + 1], 10) || 20;
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
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
