#!/usr/bin/env node

/**
 * worktree-harvest.cjs — Worktree lifecycle manager for bug-hunter fix pipeline.
 *
 * Manages isolated git worktrees for Fixer subagents:
 *   prepare       → create worktree on the fix branch
 *   harvest       → validate Fixer commits, detect uncommitted work
 *   checkout-fix  → return main working tree to the fix branch
 *   cleanup       → remove a single worktree
 *   cleanup-all   → remove all worktrees under a directory
 *   status        → report worktree health
 *
 * Design (inspired by Droid Mission Control):
 *   Workers are process-isolated but commit to the SAME branch.
 *   The worktree checks out the fix branch directly — no cherry-picking.
 *   The orchestrator manages the lifecycle: prepare → dispatch → harvest → cleanup.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage() {
  console.error('Usage:');
  console.error('  worktree-harvest.cjs prepare     <fixBranch> <worktreeDir>');
  console.error('  worktree-harvest.cjs harvest      <worktreeDir>');
  console.error('  worktree-harvest.cjs checkout-fix  <fixBranch>');
  console.error('  worktree-harvest.cjs cleanup      <worktreeDir>');
  console.error('  worktree-harvest.cjs cleanup-all   <parentDir>');
  console.error('  worktree-harvest.cjs status       <worktreeDir>');
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

/** Run git with execFileSync — no shell, no injection risk. */
function git(args, cwd) {
  const opts = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
  if (cwd) opts.cwd = cwd;
  return execFileSync('git', args, opts).trim();
}

/** Same as git() but returns { ok, output } instead of throwing. */
function gitSafe(args, cwd) {
  try {
    return { ok: true, output: git(args, cwd) };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    return { ok: false, output: stderr || (err.message || '').trim() };
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

const MANIFEST_NAME = '.worktree-manifest.json';
const HARVEST_NAME = '.harvest-result.json';
const STALE_AGE_MS = 60 * 60 * 1000; // 1 hour

function manifestPath(worktreeDir) {
  return path.join(worktreeDir, MANIFEST_NAME);
}

function harvestPath(worktreeDir) {
  return path.join(worktreeDir, HARVEST_NAME);
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function isManagedWorktreeDir(worktreeDir) {
  const absDir = path.resolve(worktreeDir);
  if (readJsonFile(manifestPath(absDir))) {
    return true;
  }
  const listed = gitSafe(['worktree', 'list', '--porcelain']);
  if (!listed.ok || !listed.output) {
    return false;
  }
  return listed.output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => path.resolve(line.slice('worktree '.length).trim()) === absDir);
}

// ---------------------------------------------------------------------------
// prepare — create worktree on the fix branch
// ---------------------------------------------------------------------------

function prepare(fixBranch, worktreeDir) {
  const absDir = path.resolve(worktreeDir);

  // 1. Verify fix branch exists
  const branchCheck = gitSafe(['rev-parse', '--verify', fixBranch]);
  if (!branchCheck.ok) {
    out({ ok: false, error: 'fix-branch-not-found', detail: branchCheck.output });
    process.exit(1);
  }

  // 2. If worktreeDir already exists, clean up stale managed worktree only
  if (fs.existsSync(absDir)) {
    const managed = isManagedWorktreeDir(absDir);
    if (!managed) {
      out({ ok: false, error: 'path-not-managed-worktree', detail: `${absDir} already exists and is not a managed worktree` });
      process.exit(1);
    }
    gitSafe(['worktree', 'remove', absDir, '--force']);
    if (fs.existsSync(absDir)) {
      fs.rmSync(absDir, { recursive: true, force: true });
    }
    gitSafe(['worktree', 'prune']);
  }

  // 3. Detach main working tree if it's on the fix branch
  //    (git won't allow two worktrees on the same branch)
  const currentBranch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD']);
  let detached = false;
  if (currentBranch.ok && currentBranch.output === fixBranch) {
    git(['checkout', '--detach']);
    detached = true;
  }

  // 4. Create worktree on the fix branch
  ensureDir(path.dirname(absDir));
  const addResult = gitSafe(['worktree', 'add', absDir, fixBranch]);
  if (!addResult.ok) {
    // Restore branch if we detached
    if (detached) gitSafe(['checkout', fixBranch]);
    out({ ok: false, error: 'worktree-add-failed', detail: addResult.output });
    process.exit(1);
  }

  // 5. Record pre-harvest HEAD
  const preHarvestHead = git(['rev-parse', 'HEAD'], absDir);

  // 6. Write manifest
  const manifest = {
    fixBranch,
    preHarvestHead,
    worktreeDir: absDir,
    detachedMainTree: detached,
    createdAtMs: Date.now(),
    createdAt: new Date().toISOString()
  };
  writeJsonFile(manifestPath(absDir), manifest);

  out({
    ok: true,
    worktreeDir: absDir,
    fixBranch,
    preHarvestHead,
    detachedMainTree: detached,
    createdAt: manifest.createdAt
  });
}

// ---------------------------------------------------------------------------
// harvest — validate Fixer commits and detect uncommitted work
// ---------------------------------------------------------------------------

/** Meta files written into the worktree — excluded from dirty detection. */
const META_FILES = [MANIFEST_NAME, HARVEST_NAME];

/**
 * Core harvest logic. Returns the result object or throws on error.
 * Does NOT call process.exit — safe for internal callers like cleanup-all.
 */
function harvestCore(worktreeDir) {
  const absDir = path.resolve(worktreeDir);

  // 1. Read manifest
  const manifest = readJsonFile(manifestPath(absDir));
  if (!manifest) {
    throw new Error(JSON.stringify({
      ok: false, error: 'no-manifest', detail: `${manifestPath(absDir)} not found`
    }));
  }

  const { preHarvestHead, fixBranch } = manifest;

  // 2. Verify worktree is still on the fix branch
  const wtBranch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], absDir);
  if (wtBranch.ok && wtBranch.output !== fixBranch) {
    const result = {
      ok: true,
      error: 'branch-switched',
      detail: `Fixer switched from ${fixBranch} to ${wtBranch.output}`,
      commits: [],
      branchSwitched: true
    };
    writeJsonFile(harvestPath(absDir), result);
    return result;
  }

  // 3. Find new commits since preHarvestHead
  const logResult = gitSafe(
    ['log', '--oneline', '--reverse', `${preHarvestHead}..HEAD`],
    absDir
  );
  const logOutput = logResult.ok ? logResult.output : '';
  const commitLines = logOutput ? logOutput.split('\n').filter(Boolean) : [];

  // 4. Parse commits
  const commits = commitLines.map(line => {
    const spaceIdx = line.indexOf(' ');
    const hash = line.slice(0, spaceIdx);
    const message = line.slice(spaceIdx + 1);
    const bugMatch = message.match(/BUG-(\d+)/);
    return {
      hash,
      message,
      bugId: bugMatch ? `BUG-${bugMatch[1]}` : null
    };
  });

  // 5. Check for uncommitted changes (exclude our own meta files)
  const statusOutput = gitSafe(['status', '--porcelain'], absDir);
  const statusLines = statusOutput.ok
    ? statusOutput.output.split('\n').filter(Boolean)
    : [];
  const relevantLines = statusLines.filter(line => {
    const fileName = line.slice(3); // strip status prefix (e.g. "?? ")
    return !META_FILES.some(mf => fileName === mf || fileName.endsWith(`/${mf}`));
  });
  const dirty = relevantLines.length > 0;

  let uncommittedStashed = false;
  let stashRef = null;

  if (dirty) {
    // Stash uncommitted work so it's not lost
    const stashMsg = `bug-hunter-fixer-uncommitted-${Date.now()}`;
    gitSafe(['add', '-A'], absDir);
    const stashResult = gitSafe(['stash', 'push', '-m', stashMsg], absDir);
    if (stashResult.ok) {
      uncommittedStashed = true;
      const stashList = gitSafe(['stash', 'list', '--max-count=1'], absDir);
      stashRef = stashList.ok ? stashList.output.split(':')[0] : null;
    }
  }

  const postHarvestHead = gitSafe(['rev-parse', 'HEAD'], absDir);

  const result = {
    ok: true,
    commits,
    harvestedCount: commits.length,
    noChanges: commits.length === 0 && !dirty,
    uncommittedStashed,
    stashRef,
    preHarvestHead,
    postHarvestHead: postHarvestHead.ok ? postHarvestHead.output : null
  };

  writeJsonFile(harvestPath(absDir), result);
  return result;
}

/** CLI-facing harvest — prints result and exits on error. */
function harvest(worktreeDir) {
  try {
    const result = harvestCore(worktreeDir);
    out(result);
  } catch (err) {
    // Error from harvestCore is a JSON string
    try {
      const parsed = JSON.parse(err.message);
      out(parsed);
    } catch (_) {
      out({ ok: false, error: 'harvest-failed', detail: err.message });
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// checkout-fix — return main working tree to the fix branch
// ---------------------------------------------------------------------------

function checkoutFix(fixBranch) {
  // Verify no non-main worktrees have this branch checked out
  const worktreeList = git(['worktree', 'list', '--porcelain']);
  const entries = worktreeList.split('\n\n').filter(Boolean);
  const mainWorktree = git(['rev-parse', '--show-toplevel']);

  for (const entry of entries) {
    const lines = entry.split('\n');
    const worktreeLine = lines.find(l => l.startsWith('worktree '));
    const branchLine = lines.find(l => l.startsWith('branch '));
    if (!branchLine || !worktreeLine) continue;

    const branch = branchLine.replace('branch refs/heads/', '');
    const wtPath = worktreeLine.replace('worktree ', '');

    if (branch === fixBranch && wtPath !== mainWorktree) {
      out({
        ok: false,
        error: 'worktree-still-active',
        detail: `Branch ${fixBranch} is checked out in worktree: ${wtPath}`
      });
      process.exit(1);
    }
  }

  const result = gitSafe(['checkout', fixBranch]);
  if (!result.ok) {
    out({ ok: false, error: 'checkout-failed', detail: result.output });
    process.exit(1);
  }

  const head = git(['rev-parse', 'HEAD']);
  out({ ok: true, branch: fixBranch, head });
}

// ---------------------------------------------------------------------------
// cleanup — remove a single worktree
// ---------------------------------------------------------------------------

function cleanup(worktreeDir) {
  const absDir = path.resolve(worktreeDir);

  if (!fs.existsSync(absDir)) {
    gitSafe(['worktree', 'prune']);
    out({ ok: true, removed: false, reason: 'not-found' });
    return;
  }

  const managed = isManagedWorktreeDir(absDir);
  if (!managed) {
    out({ ok: true, removed: false, reason: 'not-managed-worktree' });
    return;
  }

  let defensiveHarvest = readJsonFile(harvestPath(absDir));
  // If harvest hasn't run yet, run it defensively
  if (!defensiveHarvest) {
    try {
      defensiveHarvest = harvestCore(absDir);
    } catch (_) {
      out({ ok: true, removed: false, reason: 'harvest-failed' });
      return;
    }
  }

  const manifest = readJsonFile(manifestPath(absDir));

  // Remove worktree
  const removeResult = gitSafe(['worktree', 'remove', absDir, '--force']);
  if (!removeResult.ok && fs.existsSync(absDir)) {
    fs.rmSync(absDir, { recursive: true, force: true });
  }

  gitSafe(['worktree', 'prune']);
  const removed = !fs.existsSync(absDir);

  out({
    ok: true,
    removed,
    detachedMainTree: manifest ? manifest.detachedMainTree : false,
    reason: removed ? undefined : 'remove-failed',
    stashRef: defensiveHarvest && defensiveHarvest.stashRef ? defensiveHarvest.stashRef : null
  });
}

// ---------------------------------------------------------------------------
// cleanup-all — remove all worktrees under a parent directory
// ---------------------------------------------------------------------------

function cleanupAll(parentDir) {
  const absParent = path.resolve(parentDir);

  if (!fs.existsSync(absParent)) {
    out({ ok: true, cleaned: 0, entries: [] });
    return;
  }

  let entries;
  try {
    entries = fs.readdirSync(absParent, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (_) {
    out({ ok: true, cleaned: 0, entries: [] });
    return;
  }

  const results = [];
  for (const name of entries) {
    const wtDir = path.join(absParent, name);
    try {
      const managed = isManagedWorktreeDir(wtDir);
      if (!managed) {
        results.push({ name, removed: false, reason: 'not-managed-worktree' });
        continue;
      }
      let defensiveHarvest = readJsonFile(harvestPath(wtDir));
      // Defensive harvest before cleanup
      if (!defensiveHarvest) {
        try {
          defensiveHarvest = harvestCore(wtDir);
        } catch (_) {
          results.push({ name, removed: false, reason: 'harvest-failed' });
          continue;
        }
      }
      gitSafe(['worktree', 'remove', wtDir, '--force']);
      if (fs.existsSync(wtDir)) {
        fs.rmSync(wtDir, { recursive: true, force: true });
      }
      results.push({ name, removed: true, stashRef: defensiveHarvest && defensiveHarvest.stashRef ? defensiveHarvest.stashRef : null });
    } catch (err) {
      results.push({ name, removed: false, error: err.message });
    }
  }

  gitSafe(['worktree', 'prune']);

  // Remove parent if empty
  try {
    const remaining = fs.readdirSync(absParent);
    if (remaining.length === 0) fs.rmdirSync(absParent);
  } catch (_) { /* ignore */ }

  out({ ok: true, cleaned: results.filter(r => r.removed).length, entries: results });
}

// ---------------------------------------------------------------------------
// status — report worktree health
// ---------------------------------------------------------------------------

function statusCmd(worktreeDir) {
  const absDir = path.resolve(worktreeDir);

  if (!fs.existsSync(absDir)) {
    out({ ok: true, exists: false });
    return;
  }

  const manifest = readJsonFile(manifestPath(absDir));
  const harvestResult = readJsonFile(harvestPath(absDir));
  const age = manifest ? Date.now() - manifest.createdAtMs : null;
  const isStale = age !== null && age > STALE_AGE_MS;

  const statusOutput = gitSafe(['status', '--porcelain'], absDir);
  const statusLines = statusOutput.ok
    ? statusOutput.output.split('\n').filter(Boolean)
    : [];
  const relevantLines = statusLines.filter(line => {
    const fileName = line.slice(3);
    return !META_FILES.some(mf => fileName === mf || fileName.endsWith(`/${mf}`));
  });
  const hasUncommitted = relevantLines.length > 0;

  let commitCount = 0;
  if (manifest) {
    const logResult = gitSafe(
      ['log', '--oneline', `${manifest.preHarvestHead}..HEAD`],
      absDir
    );
    if (logResult.ok && logResult.output) {
      commitCount = logResult.output.split('\n').filter(Boolean).length;
    }
  }

  const branch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], absDir);

  out({
    ok: true,
    exists: true,
    branch: branch.ok ? branch.output : null,
    fixBranch: manifest ? manifest.fixBranch : null,
    ageMs: age,
    isStale,
    hasUncommitted,
    commitCount,
    harvested: harvestResult !== null,
    createdAt: manifest ? manifest.createdAt : null
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    usage();
    process.exit(1);
  }

  switch (command) {
    case 'prepare':
      if (!args[1] || !args[2]) {
        console.error('prepare requires <fixBranch> <worktreeDir>');
        process.exit(1);
      }
      prepare(args[1], args[2]);
      break;

    case 'harvest':
      if (!args[1]) {
        console.error('harvest requires <worktreeDir>');
        process.exit(1);
      }
      harvest(args[1]);
      break;

    case 'checkout-fix':
      if (!args[1]) {
        console.error('checkout-fix requires <fixBranch>');
        process.exit(1);
      }
      checkoutFix(args[1]);
      break;

    case 'cleanup':
      if (!args[1]) {
        console.error('cleanup requires <worktreeDir>');
        process.exit(1);
      }
      cleanup(args[1]);
      break;

    case 'cleanup-all':
      if (!args[1]) {
        console.error('cleanup-all requires <parentDir>');
        process.exit(1);
      }
      cleanupAll(args[1]);
      break;

    case 'status':
      if (!args[1]) {
        console.error('status requires <worktreeDir>');
        process.exit(1);
      }
      statusCmd(args[1]);
      break;

    default:
      usage();
      process.exit(1);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
