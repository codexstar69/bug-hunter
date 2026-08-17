#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const RISK_WEIGHT = Object.freeze({ critical: 30, high: 20, medium: 10, low: 2 });

function usage() {
  console.error('Usage: retrieval-planner.cjs plan --index <index.json> --hypotheses <hypotheses.json> [--max-tokens <n>] [--max-files <n>] [--output <plan.json>]');
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

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function normalizePath(value, baseRoot = process.cwd()) {
  const text = String(value || '');
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(baseRoot, text);
}

function estimateTokens(filePath, meta) {
  const candidates = [meta && meta.estimatedTokens, meta && meta.tokens];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed);
  }
  const bytes = Number(meta && (meta.bytes || meta.size));
  if (Number.isFinite(bytes) && bytes >= 0) return Math.max(1, Math.ceil(bytes / 4));
  try {
    return Math.max(1, Math.ceil(fs.statSync(filePath).size / 4));
  } catch {
    return 1;
  }
}

function parseCrossReference(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = /^(.*?)(?::\d+(?:-\d+)?)?$/.exec(text);
  return match && match[1] ? match[1] : text;
}

function hypothesisText(hypothesis) {
  return [
    hypothesis.claim,
    hypothesis.evidence,
    hypothesis.runtimeTrigger,
    ...(Array.isArray(hypothesis.symbols) ? hypothesis.symbols : []),
    ...(Array.isArray(hypothesis.keywords) ? hypothesis.keywords : [])
  ].filter(Boolean).join(' ').toLowerCase();
}

function addCandidate(candidates, filePath, score, reason, mandatory = false, baseRoot = process.cwd()) {
  const normalized = normalizePath(filePath, baseRoot);
  const entry = candidates.get(normalized) || {
    file: normalized,
    score: 0,
    mandatory: false,
    reasons: new Set()
  };
  entry.score = Math.max(entry.score, score);
  entry.mandatory = entry.mandatory || mandatory;
  entry.reasons.add(reason);
  candidates.set(normalized, entry);
}

function buildReverseDependencies(files, baseRoot) {
  const reverse = new Map();
  for (const [filePath, meta] of Object.entries(files)) {
    for (const dependency of Array.isArray(meta.dependencies) ? meta.dependencies : []) {
      const normalized = normalizePath(dependency, baseRoot);
      const dependents = reverse.get(normalized) || [];
      dependents.push(normalizePath(filePath));
      reverse.set(normalized, dependents);
    }
  }
  return reverse;
}

function selectSymbols(meta, texts) {
  const symbols = Array.isArray(meta && meta.symbols) ? meta.symbols : [];
  if (symbols.length === 0) return [];
  const combined = texts.join(' ');
  const ranked = symbols.map((symbol) => {
    const normalizedSymbol = typeof symbol === 'string' ? { name: symbol } : symbol;
    const name = String(normalizedSymbol.name || normalizedSymbol.symbol || '').toLowerCase();
    const match = name && combined.includes(name) ? 20 : 0;
    const exported = normalizedSymbol.exported === true ? 5 : 0;
    const kind = ['function', 'method', 'class'].includes(String(normalizedSymbol.kind || '').toLowerCase()) ? 3 : 0;
    return { symbol: normalizedSymbol, score: match + exported + kind };
  }).sort((a, b) => b.score - a.score);
  const positive = ranked.filter((entry) => entry.score > 0);
  return (positive.length > 0 ? positive : ranked).slice(0, 8).map((entry) => ({
    name: entry.symbol.name || entry.symbol.symbol || null,
    kind: entry.symbol.kind || null,
    lineStart: entry.symbol.lineStart || entry.symbol.startLine || null,
    lineEnd: entry.symbol.lineEnd || entry.symbol.endLine || null,
    score: entry.score
  }));
}

function buildRetrievalPlan({ index, hypotheses, maxTokens = 48000, maxFiles = 30, dependencyHops = 1 }) {
  if (!index || typeof index !== 'object' || !index.files || typeof index.files !== 'object') {
    throw new Error('index must contain a files object');
  }
  if (!Array.isArray(hypotheses)) throw new Error('hypotheses must be an array');
  const baseRoot = path.resolve(index.root || process.cwd());
  const files = Object.fromEntries(Object.entries(index.files).map(([filePath, meta]) => [normalizePath(filePath, baseRoot), meta]));
  const reverse = buildReverseDependencies(files, baseRoot);
  const candidates = new Map();
  const hypothesisTextsByFile = new Map();

  for (const hypothesis of hypotheses) {
    const directFiles = [
      ...(hypothesis.file ? [hypothesis.file] : []),
      ...(Array.isArray(hypothesis.files) ? hypothesis.files : [])
    ];
    for (const directFile of directFiles) {
      const file = normalizePath(directFile, baseRoot);
      addCandidate(candidates, file, 100, `direct hypothesis ${hypothesis.bugId || hypothesis.id || ''}`.trim(), true, baseRoot);
      const texts = hypothesisTextsByFile.get(file) || [];
      texts.push(hypothesisText(hypothesis));
      hypothesisTextsByFile.set(file, texts);
    }
    for (const reference of Array.isArray(hypothesis.crossReferences) ? hypothesis.crossReferences : []) {
      const referenced = parseCrossReference(reference);
      if (referenced) addCandidate(candidates, referenced, 85, `cross-reference from ${hypothesis.bugId || hypothesis.id || 'hypothesis'}`, false, baseRoot);
    }
    for (const related of Array.isArray(hypothesis.relatedFiles) ? hypothesis.relatedFiles : []) {
      addCandidate(candidates, related, 80, `explicit related file from ${hypothesis.bugId || hypothesis.id || 'hypothesis'}`, false, baseRoot);
    }
  }

  let frontier = [...candidates.values()].map((entry) => entry.file);
  const visited = new Set(frontier);
  for (let hop = 1; hop <= dependencyHops; hop += 1) {
    const next = [];
    for (const filePath of frontier) {
      const meta = files[filePath];
      for (const dependency of Array.isArray(meta && meta.dependencies) ? meta.dependencies : []) {
        const normalized = normalizePath(dependency, baseRoot);
        addCandidate(candidates, normalized, 60 - (hop * 8), `dependency hop ${hop} from ${filePath}`, false, baseRoot);
        if (!visited.has(normalized)) {
          visited.add(normalized);
          next.push(normalized);
        }
      }
      for (const dependent of reverse.get(filePath) || []) {
        addCandidate(candidates, dependent, 55 - (hop * 8), `dependent hop ${hop} from ${filePath}`, false, baseRoot);
        if (!visited.has(dependent)) {
          visited.add(dependent);
          next.push(dependent);
        }
      }
    }
    frontier = next;
  }

  for (const entry of candidates.values()) {
    const meta = files[entry.file];
    if (!meta) continue;
    entry.score += RISK_WEIGHT[String(meta.riskHint || '').toLowerCase()] || 0;
    if (Array.isArray(meta.trustBoundaries) && meta.trustBoundaries.length > 0) {
      entry.score += 8;
      entry.reasons.add(`trust boundaries: ${meta.trustBoundaries.join(', ')}`);
    }
  }

  const ranked = [...candidates.values()].sort((a, b) => {
    if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.file.localeCompare(b.file);
  });
  const selected = [];
  const omitted = [];
  let usedTokens = 0;
  for (const entry of ranked) {
    const meta = files[entry.file] || null;
    const tokens = estimateTokens(entry.file, meta);
    const fitsFiles = selected.length < maxFiles;
    const fitsTokens = usedTokens + tokens <= maxTokens;
    if ((fitsFiles && fitsTokens) || entry.mandatory) {
      selected.push({
        file: entry.file,
        relativePath: meta && meta.relativePath || entry.file,
        score: entry.score,
        mandatory: entry.mandatory,
        estimatedTokens: tokens,
        oversized: tokens > maxTokens,
        reasons: [...entry.reasons],
        symbols: selectSymbols(meta, hypothesisTextsByFile.get(entry.file) || [])
      });
      usedTokens += tokens;
    } else {
      omitted.push({
        file: entry.file,
        score: entry.score,
        estimatedTokens: tokens,
        reason: !fitsFiles ? 'file-limit' : 'token-budget'
      });
    }
  }

  return {
    schemaVersion: 1,
    artifact: 'retrieval-plan',
    generatedAt: new Date().toISOString(),
    budgets: { maxTokens, maxFiles, dependencyHops },
    estimatedTokens: usedTokens,
    selectedFileCount: selected.length,
    omittedFileCount: omitted.length,
    selected,
    omitted,
    budgetExceededByMandatoryFiles: usedTokens > maxTokens,
    instructions: [
      'Read selected symbol slices before expanding to whole files.',
      'Mandatory hypothesis files remain in scope even when individually oversized.',
      'Expand omitted files only when current evidence leaves a named hypothesis unresolved.'
    ]
  };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'plan') {
    usage();
    process.exit(1);
  }
  const options = parseOptions(rest);
  if (!options.index || !options.hypotheses) throw new Error('--index and --hypotheses are required');
  const plan = buildRetrievalPlan({
    index: readJson(path.resolve(options.index)),
    hypotheses: readJson(path.resolve(options.hypotheses)),
    maxTokens: positiveInteger(options['max-tokens'], 48000, '--max-tokens'),
    maxFiles: positiveInteger(options['max-files'], 30, '--max-files'),
    dependencyHops: positiveInteger(options['dependency-hops'], 1, '--dependency-hops')
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
  buildRetrievalPlan,
  estimateTokens,
  parseCrossReference,
  selectSymbols
};
