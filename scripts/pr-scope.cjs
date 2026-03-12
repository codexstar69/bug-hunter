#!/usr/bin/env node

const childProcess = require('child_process');
const path = require('path');

function usage() {
  console.error('Usage:');
  console.error('  pr-scope.cjs resolve <current|recent|pr-number> [--repo-root <path>] [--base <branch>] [--gh-bin <path>] [--git-bin <path>]');
}

function parseOptions(argv) {
  const options = {};
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      index += 1;
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      options[key] = 'true';
      index += 1;
      continue;
    }
    options[key] = value;
    index += 2;
  }
  return options;
}

function runJson(bin, args, cwd) {
  const result = childProcess.spawnSync(bin, args, {
    encoding: 'utf8',
    cwd
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(stderr || stdout || `${bin} ${args.join(' ')} failed`);
  }
  const output = (result.stdout || '').trim();
  return output ? JSON.parse(output) : null;
}

function runLines(bin, args, cwd) {
  const result = childProcess.spawnSync(bin, args, {
    encoding: 'utf8',
    cwd
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(stderr || stdout || `${bin} ${args.join(' ')} failed`);
  }
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function ghMetadataSelector(selector) {
  if (selector === 'current') {
    return [];
  }
  return [String(selector)];
}

function resolveWithGh({ selector, ghBin, cwd }) {
  if (selector === 'recent') {
    const list = runJson(ghBin, [
      'pr',
      'list',
      '--limit',
      '1',
      '--state',
      'open',
      '--json',
      'number,title,headRefName,baseRefName,url'
    ], cwd);
    const pr = Array.isArray(list) ? list[0] : null;
    if (!pr) {
      throw new Error('No recent pull requests found');
    }
    const changedFiles = runLines(ghBin, ['pr', 'diff', String(pr.number), '--name-only'], cwd);
    return {
      ok: true,
      source: 'gh',
      selector,
      pr,
      changedFiles
    };
  }

  const pr = runJson(ghBin, [
    'pr',
    'view',
    ...ghMetadataSelector(selector),
    '--json',
    'number,title,headRefName,baseRefName,url'
  ], cwd);
  const changedFiles = runLines(ghBin, ['pr', 'diff', ...ghMetadataSelector(selector), '--name-only'], cwd);
  return {
    ok: true,
    source: 'gh',
    selector,
    pr,
    changedFiles
  };
}

function resolveDefaultBaseBranch({ gitBin, cwd, explicitBase }) {
  if (explicitBase) {
    return { baseRefName: explicitBase, diffBaseRef: explicitBase };
  }

  const symbolicRef = runLines(gitBin, ['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd)[0];
  const match = symbolicRef && symbolicRef.match(/^refs\/remotes\/origin\/(.+)$/);
  if (match && match[1]) {
    return { baseRefName: match[1], diffBaseRef: `origin/${match[1]}` };
  }

  throw new Error('Unable to determine default base branch for git fallback');
}

function resolveWithGitFallback({ gitBin, cwd, base }) {
  const headRefName = runLines(gitBin, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)[0];
  const { baseRefName, diffBaseRef } = resolveDefaultBaseBranch({ gitBin, cwd, explicitBase: base });
  const changedFiles = runLines(gitBin, ['diff', '--name-only', `${diffBaseRef}...${headRefName}`], cwd);
  return {
    ok: true,
    source: 'git',
    selector: 'current',
    pr: {
      number: null,
      title: `Current branch diff (${headRefName} vs ${baseRefName})`,
      headRefName,
      baseRefName,
      url: null
    },
    changedFiles
  };
}

function resolveScope({ selector, options }) {
  const cwd = path.resolve(options['repo-root'] || process.cwd());
  const ghBin = options['gh-bin'] || process.env.BUG_HUNTER_GH_BIN || 'gh';
  const gitBin = options['git-bin'] || process.env.BUG_HUNTER_GIT_BIN || 'git';
  const base = options.base || null;

  try {
    return resolveWithGh({ selector, ghBin, cwd });
  } catch (error) {
    if (selector !== 'current') {
      throw error;
    }
    const fallback = resolveWithGitFallback({ gitBin, cwd, base });
    fallback.fallbackReason = error instanceof Error ? error.message : String(error);
    return fallback;
  }
}

function main() {
  const [command, selector, ...rest] = process.argv.slice(2);
  if (command !== 'resolve' || !selector) {
    usage();
    process.exit(1);
  }
  const options = parseOptions(rest);
  const result = resolveScope({ selector, options });
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
