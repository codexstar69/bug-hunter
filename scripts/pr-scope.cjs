#!/usr/bin/env node

const childProcess = require('child_process');
const path = require('path');

function usage() {
  console.error('Usage:');
  console.error('  pr-scope.cjs resolve <current|recent|pr-number> [--repo-root <path>] [--base <branch>] [--gh-bin <path>] [--git-bin <path>] [--timeout-ms <milliseconds>]');
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

function runCommand({ bin, args, cwd, timeoutMs }) {
  const result = childProcess.spawnSync(bin, args, {
    encoding: 'utf8',
    cwd,
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(`${bin} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`${bin} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(stderr || stdout || `${bin} ${args.join(' ')} failed`);
  }
  return result.stdout || '';
}

function runJson({ bin, args, cwd, timeoutMs }) {
  const stdout = runCommand({ bin, args, cwd, timeoutMs });
  const output = stdout.trim();
  return output ? JSON.parse(output) : null;
}

function runLines({ bin, args, cwd, timeoutMs }) {
  return runCommand({ bin, args, cwd, timeoutMs })
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

function resolveWithGh({ selector, ghBin, cwd, timeoutMs }) {
  if (selector === 'recent') {
    const list = runJson({
      bin: ghBin,
      args: [
        'pr',
        'list',
        '--limit',
        '1',
        '--state',
        'open',
        '--json',
        'number,title,headRefName,baseRefName,url'
      ],
      cwd,
      timeoutMs
    });
    const pr = Array.isArray(list) ? list[0] : null;
    if (!pr) {
      throw new Error('No recent pull requests found');
    }
    const changedFiles = runLines({
      bin: ghBin,
      args: ['pr', 'diff', String(pr.number), '--name-only'],
      cwd,
      timeoutMs
    });
    return {
      ok: true,
      source: 'gh',
      selector,
      pr,
      changedFiles
    };
  }

  const pr = runJson({
    bin: ghBin,
    args: [
      'pr',
      'view',
      ...ghMetadataSelector(selector),
      '--json',
      'number,title,headRefName,baseRefName,url'
    ],
    cwd,
    timeoutMs
  });
  const changedFiles = runLines({
    bin: ghBin,
    args: ['pr', 'diff', ...ghMetadataSelector(selector), '--name-only'],
    cwd,
    timeoutMs
  });
  return {
    ok: true,
    source: 'gh',
    selector,
    pr,
    changedFiles
  };
}

function resolveDefaultBaseBranch({ gitBin, cwd, explicitBase, timeoutMs }) {
  if (explicitBase) {
    return { baseRefName: explicitBase, diffBaseRef: explicitBase };
  }

  const symbolicRef = runLines({
    bin: gitBin,
    args: ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    cwd,
    timeoutMs
  })[0];
  const match = symbolicRef && symbolicRef.match(/^refs\/remotes\/origin\/(.+)$/);
  if (match && match[1]) {
    return { baseRefName: match[1], diffBaseRef: `origin/${match[1]}` };
  }

  throw new Error('Unable to determine default base branch for git fallback');
}

function resolveWithGitFallback({ gitBin, cwd, base, timeoutMs }) {
  const headRefName = runLines({
    bin: gitBin,
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    cwd,
    timeoutMs
  })[0];
  const { baseRefName, diffBaseRef } = resolveDefaultBaseBranch({
    gitBin,
    cwd,
    explicitBase: base,
    timeoutMs
  });
  const changedFiles = runLines({
    bin: gitBin,
    args: ['diff', '--name-only', `${diffBaseRef}...${headRefName}`],
    cwd,
    timeoutMs
  });
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
  const timeoutRaw = options['timeout-ms'];
  const timeoutMs = (() => {
    if (timeoutRaw === undefined) {
      return 15000;
    }
    if (!/^\d+$/.test(timeoutRaw)) {
      throw new Error('--timeout-ms must be an integer from 1 to 60000');
    }
    const parsed = Number(timeoutRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 60000) {
      throw new Error('--timeout-ms must be an integer from 1 to 60000');
    }
    return parsed;
  })();

  try {
    return resolveWithGh({ selector, ghBin, cwd, timeoutMs });
  } catch (error) {
    if (selector !== 'current') {
      throw error;
    }
    const fallback = resolveWithGitFallback({ gitBin, cwd, base, timeoutMs });
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
