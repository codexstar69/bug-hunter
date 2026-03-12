#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php'
];

const JS_CALL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'new',
  'typeof',
  'await'
]);

function usage() {
  console.error('Usage:');
  console.error('  code-index.cjs build <indexPath> <filesJsonPath> [repoRoot]');
  console.error('  code-index.cjs status <indexPath>');
  console.error('  code-index.cjs deps <indexPath> <filePath>');
  console.error('  code-index.cjs reverse-deps <indexPath> <filePath>');
  console.error('  code-index.cjs query <indexPath> <seedFilesJsonPath> [hops]');
  console.error('  code-index.cjs query-bugs <indexPath> <bugsJsonPath> [hops]');
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function isSupportedSource(filePath) {
  return SOURCE_EXTENSIONS.includes(path.extname(filePath));
}

function isTestFile(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.includes('/__tests__/') ||
    normalized.includes('/tests/') ||
    normalized.endsWith('.test.ts') ||
    normalized.endsWith('.test.tsx') ||
    normalized.endsWith('.test.js') ||
    normalized.endsWith('.spec.ts') ||
    normalized.endsWith('.spec.tsx') ||
    normalized.endsWith('.spec.js')
  );
}

function inferRiskHint(relativePath) {
  const normalized = relativePath.toLowerCase();
  if (isTestFile(relativePath)) {
    return 'context-only';
  }
  if (/(auth|middleware|route|router|api|controller|handler|server|webhook|payment|billing)/.test(normalized)) {
    return 'critical';
  }
  if (/(service|state|store|db|repository|queue|worker|cron|job|model)/.test(normalized)) {
    return 'high';
  }
  return 'medium';
}

function inferTrustBoundaries(relativePath, content) {
  const boundaries = new Set();
  const normalizedPath = relativePath.toLowerCase();
  const normalizedContent = content.toLowerCase();

  if (/(route|router|api|controller|handler|webhook)/.test(normalizedPath)) {
    boundaries.add('external-input');
  }
  if (/(auth|middleware|session|token|jwt|permission|acl)/.test(normalizedPath + normalizedContent)) {
    boundaries.add('auth');
  }
  if (/(db|model|repository|query|prisma|sql|mongo|redis)/.test(normalizedPath + normalizedContent)) {
    boundaries.add('data-store');
  }
  if (/(queue|worker|cron|job|kafka|rabbitmq|sqs|pubsub)/.test(normalizedPath + normalizedContent)) {
    boundaries.add('async-boundary');
  }

  return [...boundaries].sort();
}

function extractImports(content, extension) {
  const imports = new Set();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const regexes = [
      /import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /require\(\s*['"]([^'"]+)['"]\s*\)/g,
      /export\s+[^'"]*?from\s+['"]([^'"]+)['"]/g
    ];
    for (const regex of regexes) {
      let match = regex.exec(content);
      while (match) {
        imports.add(match[1]);
        match = regex.exec(content);
      }
    }
  } else if (extension === '.py') {
    const importRegex = /^\s*import\s+([a-zA-Z0-9_\.]+)/gm;
    const fromRegex = /^\s*from\s+([a-zA-Z0-9_\.]+)\s+import\s+/gm;
    let match = importRegex.exec(content);
    while (match) {
      imports.add(match[1]);
      match = importRegex.exec(content);
    }
    match = fromRegex.exec(content);
    while (match) {
      imports.add(match[1]);
      match = fromRegex.exec(content);
    }
  }
  return [...imports];
}

function extractSymbols(content, extension) {
  const symbols = new Set();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const patterns = [
      /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
      /(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\s*/g,
      /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(/g,
      /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g
    ];
    for (const pattern of patterns) {
      let match = pattern.exec(content);
      while (match) {
        symbols.add(match[1]);
        match = pattern.exec(content);
      }
    }
  } else if (extension === '.py') {
    const patterns = [
      /^\s*def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm,
      /^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[:\(]/gm
    ];
    for (const pattern of patterns) {
      let match = pattern.exec(content);
      while (match) {
        symbols.add(match[1]);
        match = pattern.exec(content);
      }
    }
  }
  return [...symbols].sort();
}

function extractCalls(content, extension) {
  const calls = new Set();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const callPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let match = callPattern.exec(content);
    while (match) {
      const name = match[1];
      if (!JS_CALL_KEYWORDS.has(name)) {
        calls.add(name);
      }
      match = callPattern.exec(content);
    }
  } else if (extension === '.py') {
    const callPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
    let match = callPattern.exec(content);
    while (match) {
      calls.add(match[1]);
      match = callPattern.exec(content);
    }
  }
  return [...calls].sort();
}

function resolveRelativeImport(specifier, fromFilePath, fileSet) {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const fromDir = path.dirname(fromFilePath);
  const base = path.resolve(fromDir, specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`))
  ];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function normalizeFilePath(filePath) {
  return path.resolve(filePath);
}

function buildCallGraph(filesIndex, symbolDefinitions) {
  const graph = {};
  for (const [filePath, entry] of Object.entries(filesIndex)) {
    const callees = new Set();
    const unresolved = new Set();
    for (const callName of entry.calls) {
      const targets = symbolDefinitions[callName] || [];
      if (targets.length === 1) {
        callees.add(targets[0]);
        continue;
      }
      if (targets.length > 1) {
        const externalTargets = targets.filter((targetFile) => targetFile !== filePath);
        for (const target of externalTargets) {
          callees.add(target);
        }
        continue;
      }
      unresolved.add(callName);
    }
    graph[filePath] = {
      callees: [...callees].sort(),
      unresolvedCalls: [...unresolved].sort()
    };
  }
  return graph;
}

function expandByHops({ seeds, index, hops }) {
  const selected = new Set(seeds);
  let frontier = new Set(seeds);
  for (let hop = 0; hop < hops; hop += 1) {
    const next = new Set();
    for (const filePath of frontier) {
      const deps = (index.files[filePath] && index.files[filePath].dependencies) || [];
      const reverse = index.reverseDependencies[filePath] || [];
      for (const neighbor of [...deps, ...reverse]) {
        if (selected.has(neighbor)) {
          continue;
        }
        selected.add(neighbor);
        next.add(neighbor);
      }
    }
    if (next.size === 0) {
      break;
    }
    frontier = next;
  }
  return [...selected].sort();
}

function buildIndex(indexPath, filesJsonPath, repoRootInput) {
  const filesRaw = readJson(filesJsonPath);
  if (!Array.isArray(filesRaw)) {
    throw new Error('filesJsonPath must contain an array');
  }
  const repoRoot = path.resolve(repoRootInput || process.cwd());
  const files = [...new Set(filesRaw.map((filePath) => normalizeFilePath(filePath)))]
    .filter((filePath) => fs.existsSync(filePath))
    .filter((filePath) => isSupportedSource(filePath))
    .sort();
  const fileSet = new Set(files);
  const filesIndex = {};
  const reverseDepsMap = new Map();
  const symbolDefinitions = {};

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const extension = path.extname(filePath);
    const importsRaw = extractImports(content, extension);
    const symbols = extractSymbols(content, extension);
    const calls = extractCalls(content, extension);
    const resolvedDeps = [];
    const unresolvedDeps = [];

    for (const importSpecifier of importsRaw) {
      const resolved = resolveRelativeImport(importSpecifier, filePath, fileSet);
      if (resolved) {
        resolvedDeps.push(resolved);
        if (!reverseDepsMap.has(resolved)) {
          reverseDepsMap.set(resolved, new Set());
        }
        reverseDepsMap.get(resolved).add(filePath);
      } else {
        unresolvedDeps.push(importSpecifier);
      }
    }

    const relativePath = path.relative(repoRoot, filePath) || path.basename(filePath);
    const trustBoundaries = inferTrustBoundaries(relativePath, content);
    filesIndex[filePath] = {
      relativePath,
      extension,
      hash: sha256(content),
      lineCount: content.split('\n').length,
      importsRaw,
      symbols,
      calls,
      dependencies: [...new Set(resolvedDeps)].sort(),
      unresolvedDependencies: [...new Set(unresolvedDeps)].sort(),
      riskHint: inferRiskHint(relativePath),
      trustBoundaries,
      isTest: isTestFile(relativePath)
    };

    for (const symbol of symbols) {
      if (!symbolDefinitions[symbol]) {
        symbolDefinitions[symbol] = [];
      }
      symbolDefinitions[symbol].push(filePath);
    }
  }

  const reverseDependencies = {};
  for (const [dependencyPath, dependents] of reverseDepsMap.entries()) {
    reverseDependencies[dependencyPath] = [...dependents].sort();
  }

  const callGraph = buildCallGraph(filesIndex, symbolDefinitions);
  const symbolCount = Object.values(filesIndex).reduce((sum, entry) => {
    return sum + entry.symbols.length;
  }, 0);
  const callEdges = Object.values(callGraph).reduce((sum, entry) => {
    return sum + entry.callees.length;
  }, 0);
  const trustBoundaryFiles = Object.values(filesIndex).filter((entry) => {
    return Array.isArray(entry.trustBoundaries) && entry.trustBoundaries.length > 0;
  }).length;

  const index = {
    schemaVersion: 2,
    builtAt: nowIso(),
    repoRoot,
    metrics: {
      filesIndexed: Object.keys(filesIndex).length,
      dependencyEdges: Object.values(filesIndex).reduce((sum, entry) => {
        return sum + entry.dependencies.length;
      }, 0),
      symbolsIndexed: symbolCount,
      callEdges,
      trustBoundaryFiles
    },
    files: filesIndex,
    symbolDefinitions,
    reverseDependencies,
    callGraph
  };

  writeJson(indexPath, index);
  return {
    ok: true,
    indexPath,
    metrics: index.metrics
  };
}

function status(indexPath) {
  const index = readJson(indexPath);
  return {
    ok: true,
    indexPath,
    schemaVersion: index.schemaVersion,
    builtAt: index.builtAt,
    repoRoot: index.repoRoot,
    metrics: index.metrics
  };
}

function getDeps(indexPath, filePath, reverse) {
  const index = readJson(indexPath);
  const normalizedTarget = path.resolve(filePath);
  if (reverse) {
    return {
      ok: true,
      file: normalizedTarget,
      reverseDependencies: index.reverseDependencies[normalizedTarget] || []
    };
  }
  return {
    ok: true,
    file: normalizedTarget,
    dependencies: (index.files[normalizedTarget] && index.files[normalizedTarget].dependencies) || []
  };
}

function query(indexPath, seedFilesJsonPath, hopsRaw) {
  const index = readJson(indexPath);
  const seedFilesRaw = readJson(seedFilesJsonPath);
  if (!Array.isArray(seedFilesRaw)) {
    throw new Error('seedFilesJson must contain an array');
  }
  const hops = Number.isInteger(Number.parseInt(String(hopsRaw || ''), 10))
    ? Number.parseInt(String(hopsRaw || ''), 10)
    : 1;
  const filesInIndex = new Set(Object.keys(index.files || {}));
  const seeds = [...new Set(seedFilesRaw.map((filePath) => path.resolve(String(filePath))))]
    .filter((filePath) => filesInIndex.has(filePath));
  const selected = expandByHops({ seeds, index, hops: hops > 0 ? hops : 1 });
  const trustBoundaryFiles = selected.filter((filePath) => {
    const fileMeta = index.files[filePath];
    return fileMeta && Array.isArray(fileMeta.trustBoundaries) && fileMeta.trustBoundaries.length > 0;
  });
  return {
    ok: true,
    hops: hops > 0 ? hops : 1,
    seeds,
    selected,
    trustBoundaryFiles,
    metrics: {
      seedCount: seeds.length,
      selectedCount: selected.length,
      trustBoundaryCount: trustBoundaryFiles.length
    }
  };
}

function queryBugs(indexPath, bugsJsonPath, hopsRaw) {
  const bugs = readJson(bugsJsonPath);
  if (!Array.isArray(bugs)) {
    throw new Error('bugsJsonPath must contain an array');
  }
  const seedFiles = bugs
    .map((bug) => String((bug && bug.file) || '').trim())
    .filter(Boolean)
    .map((filePath) => path.resolve(filePath));
  const tempSeedPath = path.join(
    path.dirname(path.resolve(bugsJsonPath)),
    `.seed-files.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp.json`
  );
  writeJson(tempSeedPath, seedFiles);
  try {
    return query(indexPath, tempSeedPath, hopsRaw);
  } finally {
    if (fs.existsSync(tempSeedPath)) {
      fs.unlinkSync(tempSeedPath);
    }
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    usage();
    process.exit(1);
  }

  if (command === 'build') {
    const [indexPath, filesJsonPath, repoRoot] = args;
    if (!indexPath || !filesJsonPath) {
      usage();
      process.exit(1);
    }
    const result = buildIndex(path.resolve(indexPath), path.resolve(filesJsonPath), repoRoot);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'status') {
    const [indexPath] = args;
    if (!indexPath) {
      usage();
      process.exit(1);
    }
    console.log(JSON.stringify(status(path.resolve(indexPath)), null, 2));
    return;
  }

  if (command === 'deps') {
    const [indexPath, filePath] = args;
    if (!indexPath || !filePath) {
      usage();
      process.exit(1);
    }
    console.log(JSON.stringify(getDeps(path.resolve(indexPath), filePath, false), null, 2));
    return;
  }

  if (command === 'reverse-deps') {
    const [indexPath, filePath] = args;
    if (!indexPath || !filePath) {
      usage();
      process.exit(1);
    }
    console.log(JSON.stringify(getDeps(path.resolve(indexPath), filePath, true), null, 2));
    return;
  }

  if (command === 'query') {
    const [indexPath, seedFilesJsonPath, hopsRaw] = args;
    if (!indexPath || !seedFilesJsonPath) {
      usage();
      process.exit(1);
    }
    console.log(JSON.stringify(query(path.resolve(indexPath), path.resolve(seedFilesJsonPath), hopsRaw), null, 2));
    return;
  }

  if (command === 'query-bugs') {
    const [indexPath, bugsJsonPath, hopsRaw] = args;
    if (!indexPath || !bugsJsonPath) {
      usage();
      process.exit(1);
    }
    console.log(JSON.stringify(queryBugs(path.resolve(indexPath), path.resolve(bugsJsonPath), hopsRaw), null, 2));
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
