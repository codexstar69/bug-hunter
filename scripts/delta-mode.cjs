#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function usage() {
  console.error('Usage:');
  console.error('  delta-mode.cjs select <indexPath> <changedFilesJsonPath> [hops]');
  console.error('  delta-mode.cjs expand <indexPath> <seedFilesJsonPath> <alreadySelectedFilesJsonPath> [hops]');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

function parseHops({ value, fallback }) {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(String(value))) {
    throw new Error('hops must be an integer from 0 to 100');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('hops must be an integer from 0 to 100');
  }
  return parsed;
}

function normalizeFile(filePath) {
  return path.resolve(String(filePath));
}

function buildGraph(index) {
  const graph = {};
  const reverse = {};
  const files = Object.keys(index.files || {});

  for (const filePath of files) {
    const deps = (index.files[filePath] && index.files[filePath].dependencies) || [];
    graph[filePath] = [...new Set(deps.map((item) => normalizeFile(item)))];
  }

  for (const filePath of files) {
    reverse[filePath] = [];
  }
  const reverseFromIndex = index.reverseDependencies || {};
  for (const [filePathRaw, dependentsRaw] of Object.entries(reverseFromIndex)) {
    const filePath = normalizeFile(filePathRaw);
    const dependents = Array.isArray(dependentsRaw)
      ? dependentsRaw.map((item) => normalizeFile(item))
      : [];
    reverse[filePath] = [...new Set(dependents)];
  }

  return { graph, reverse };
}

function expandByHops({ seeds, graph, reverse, hops }) {
  const selected = new Set(seeds);
  let frontier = new Set(seeds);

  for (let hop = 0; hop < hops; hop += 1) {
    const next = new Set();
    for (const filePath of frontier) {
      const neighbors = [...(graph[filePath] || []), ...(reverse[filePath] || [])];
      for (const neighbor of neighbors) {
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

  return selected;
}

function criticalOverlay(index, selected) {
  const entries = Object.entries(index.files || {});
  return entries
    .filter(([filePath, meta]) => {
      if (selected.has(filePath)) {
        return false;
      }
      const risk = String((meta && meta.riskHint) || '').toLowerCase();
      const boundaries = (meta && Array.isArray(meta.trustBoundaries)) ? meta.trustBoundaries : [];
      return risk === 'critical' || boundaries.length > 0;
    })
    .map(([filePath]) => filePath);
}

function select(indexPath, changedFilesJsonPath, hopsRaw) {
  const hops = parseHops({ value: hopsRaw, fallback: 2 });
  const index = readJson(indexPath);
  const changed = readJson(changedFilesJsonPath);
  assertArray(changed, 'changedFilesJson');

  const filesInIndex = new Set(Object.keys(index.files || {}));
  const normalizedChanged = [...new Set(changed.map((item) => normalizeFile(item)))];
  const seedsInIndex = normalizedChanged.filter((filePath) => {
    return filesInIndex.has(filePath);
  });
  const unindexedChanged = normalizedChanged.filter((filePath) => {
    return !filesInIndex.has(filePath);
  });

  const { graph, reverse } = buildGraph(index);
  const selectedSet = expandByHops({
    seeds: normalizedChanged,
    graph,
    reverse,
    hops
  });
  const selected = [...selectedSet];
  const overlays = criticalOverlay(index, selectedSet);

  return {
    ok: true,
    hops,
    changedTotal: normalizedChanged.length,
    changedInIndex: seedsInIndex.length,
    unindexedChanged,
    selected,
    expansionCandidates: overlays,
    metrics: {
      selectedCount: selected.length,
      expansionCandidatesCount: overlays.length
    }
  };
}

function expand(indexPath, seedFilesJsonPath, alreadySelectedFilesJsonPath, hopsRaw) {
  const hops = parseHops({ value: hopsRaw, fallback: 1 });
  const index = readJson(indexPath);
  const seedFiles = readJson(seedFilesJsonPath);
  const alreadySelectedFiles = readJson(alreadySelectedFilesJsonPath);
  assertArray(seedFiles, 'seedFilesJson');
  assertArray(alreadySelectedFiles, 'alreadySelectedFilesJson');

  const seeds = [...new Set(seedFiles.map((item) => normalizeFile(item)))];
  const alreadySelected = new Set(alreadySelectedFiles.map((item) => normalizeFile(item)));
  const { graph, reverse } = buildGraph(index);
  const expandedSet = expandByHops({
    seeds,
    graph,
    reverse,
    hops
  });
  const overlays = criticalOverlay(index, alreadySelected);
  const expanded = [...expandedSet]
    .filter((filePath) => !alreadySelected.has(filePath));
  const overlayOnly = overlays.filter((filePath) => !expandedSet.has(filePath));
  const prioritized = [...overlayOnly, ...expanded];

  return {
    ok: true,
    hops,
    seedCount: seeds.length,
    expanded,
    overlayOnly,
    prioritized,
    metrics: {
      expandedCount: expanded.length,
      overlayOnlyCount: overlayOnly.length,
      prioritizedCount: prioritized.length
    }
  };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    usage();
    process.exit(1);
  }

  if (command === 'select') {
    const [indexPath, changedFilesJsonPath, hopsRaw] = args;
    if (!indexPath || !changedFilesJsonPath) {
      usage();
      process.exit(1);
    }
    const result = select(
      path.resolve(indexPath),
      path.resolve(changedFilesJsonPath),
      hopsRaw
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'expand') {
    const [indexPath, seedFilesJsonPath, alreadySelectedFilesJsonPath, hopsRaw] = args;
    if (!indexPath || !seedFilesJsonPath || !alreadySelectedFilesJsonPath) {
      usage();
      process.exit(1);
    }
    const result = expand(
      path.resolve(indexPath),
      path.resolve(seedFilesJsonPath),
      path.resolve(alreadySelectedFilesJsonPath),
      hopsRaw
    );
    console.log(JSON.stringify(result, null, 2));
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
