#!/usr/bin/env node

/**
 * worktree-harvest.cjs — Fail-closed worktree lifecycle manager.
 *
 * A worktree may be removed only after its repository identity is verified,
 * its current state is freshly inspected, and every user change has a recovery
 * reference recorded outside the removal target.
 */

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_NAME = '.worktree-manifest.json';
const HARVEST_NAME = '.harvest-result.json';
const MANIFEST_VERSION = 2;
const STALE_AGE_MS = 60 * 60 * 1000;
const META_FILES = [MANIFEST_NAME, HARVEST_NAME];

function usage() {
  console.error('Usage:');
  console.error('  worktree-harvest.cjs prepare      <fixBranch> <worktreeDir>');
  console.error('  worktree-harvest.cjs harvest      <worktreeDir>');
  console.error('  worktree-harvest.cjs checkout-fix <fixBranch>');
  console.error('  worktree-harvest.cjs cleanup      <worktreeDir>');
  console.error('  worktree-harvest.cjs cleanup-all  <parentDir>');
  console.error('  worktree-harvest.cjs status       <worktreeDir>');
}

function out(value) {
  console.log(JSON.stringify(value, null, 2));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function git(args, cwd) {
  if (!cwd) {
    throw new Error('Every Git command requires an explicit cwd');
  }
  return childProcess.execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
}

function gitSafe(args, cwd) {
  try {
    return { ok: true, output: git(args, cwd) };
  } catch (error) {
    const stderr = error && error.stderr ? error.stderr.toString().trim() : '';
    return { ok: false, output: stderr || errorMessage(error) };
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function manifestPath(worktreeDir) {
  return path.join(worktreeDir, MANIFEST_NAME);
}

function harvestPath(worktreeDir) {
  return path.join(worktreeDir, HARVEST_NAME);
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${errorMessage(error)}`);
  }
}

function writeJsonFileAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      const cleanupMessage = errorMessage(cleanupError);
      throw new Error(
        `Failed to write ${filePath}: ${errorMessage(error)}; temporary cleanup failed: ${cleanupMessage}`
      );
    }
    throw new Error(`Failed to write ${filePath}: ${errorMessage(error)}`);
  }
}

function realpath(filePath) {
  return fs.realpathSync(filePath);
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative !== ''
    && !relative.startsWith('..')
    && !path.isAbsolute(relative);
}

function repositoryIdentity(cwd) {
  const topLevel = git(['rev-parse', '--show-toplevel'], cwd);
  const commonDirOutput = git(['rev-parse', '--git-common-dir'], cwd);
  const commonDir = path.isAbsolute(commonDirOutput)
    ? commonDirOutput
    : path.resolve(cwd, commonDirOutput);
  return {
    topLevelRealpath: realpath(topLevel),
    gitCommonDirRealpath: realpath(commonDir)
  };
}

function parseWorktreeList(output) {
  return output
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const worktreeLine = lines.find((line) => line.startsWith('worktree '));
      const headLine = lines.find((line) => line.startsWith('HEAD '));
      const branchLine = lines.find((line) => line.startsWith('branch '));
      return {
        worktreePath: worktreeLine ? worktreeLine.slice('worktree '.length) : '',
        head: headLine ? headLine.slice('HEAD '.length) : '',
        branch: branchLine ? branchLine.replace('branch refs/heads/', '') : null
      };
    });
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return 'manifest is missing';
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    return `unsupported manifest version: ${manifest.manifestVersion}`;
  }
  const requiredStrings = [
    'fixBranch',
    'preHarvestHead',
    'baseCommit',
    'repositoryRealpath',
    'gitCommonDirRealpath',
    'worktreeRealpath',
    'worktreeParentRealpath',
    'creationToken',
    'recoveryRecordPath'
  ];
  const missing = requiredStrings.filter((key) => {
    return typeof manifest[key] !== 'string' || manifest[key].length === 0;
  });
  if (missing.length > 0) {
    return `manifest is missing fields: ${missing.join(', ')}`;
  }
  if (!/^[a-f0-9]{48}$/.test(manifest.creationToken)) {
    return 'manifest creation token is malformed';
  }
  return '';
}

function verifyManagedWorktree({ repositoryCwd, worktreeDir }) {
  const absDir = path.resolve(worktreeDir);
  const manifest = readJsonFile(manifestPath(absDir));
  const manifestError = validateManifest(manifest);
  if (manifestError) {
    return { ok: false, error: 'invalid-manifest', detail: manifestError };
  }
  if (!fs.existsSync(absDir)) {
    return { ok: false, error: 'worktree-not-found', detail: absDir };
  }

  let callerIdentity;
  let currentWorktreeRealpath;
  let parentRealpath;
  let targetCommonDir;
  try {
    callerIdentity = repositoryIdentity(repositoryCwd);
    currentWorktreeRealpath = realpath(absDir);
    parentRealpath = realpath(path.dirname(absDir));
    targetCommonDir = repositoryIdentity(absDir).gitCommonDirRealpath;
  } catch (error) {
    return { ok: false, error: 'identity-lookup-failed', detail: errorMessage(error) };
  }

  if (callerIdentity.topLevelRealpath !== manifest.repositoryRealpath
    || callerIdentity.gitCommonDirRealpath !== manifest.gitCommonDirRealpath
    || targetCommonDir !== manifest.gitCommonDirRealpath) {
    return {
      ok: false,
      error: 'repository-identity-mismatch',
      detail: 'The manifest does not belong to the current repository'
    };
  }
  if (currentWorktreeRealpath !== manifest.worktreeRealpath
    || parentRealpath !== manifest.worktreeParentRealpath
    || !isPathInside(manifest.worktreeParentRealpath, currentWorktreeRealpath)) {
    return {
      ok: false,
      error: 'worktree-path-mismatch',
      detail: 'The worktree path escaped or no longer matches its configured parent'
    };
  }
  if (path.resolve(manifest.recoveryRecordPath).startsWith(`${currentWorktreeRealpath}${path.sep}`)) {
    return {
      ok: false,
      error: 'recovery-record-inside-worktree',
      detail: manifest.recoveryRecordPath
    };
  }
  const expectedRecoveryPath = recoveryRecordPath({
    repositoryRealpath: manifest.repositoryRealpath,
    creationToken: manifest.creationToken
  });
  if (path.resolve(manifest.recoveryRecordPath) !== path.resolve(expectedRecoveryPath)) {
    return {
      ok: false,
      error: 'recovery-record-path-mismatch',
      detail: manifest.recoveryRecordPath
    };
  }

  const listResult = gitSafe(
    ['worktree', 'list', '--porcelain'],
    manifest.repositoryRealpath
  );
  if (!listResult.ok) {
    return { ok: false, error: 'worktree-list-failed', detail: listResult.output };
  }
  const entries = parseWorktreeList(listResult.output);
  const mainEntry = entries[0];
  const matchingEntry = entries.find((entry) => {
    if (!entry.worktreePath || !fs.existsSync(entry.worktreePath)) {
      return false;
    }
    return realpath(entry.worktreePath) === currentWorktreeRealpath;
  });
  if (!mainEntry || !mainEntry.worktreePath
    || realpath(mainEntry.worktreePath) !== manifest.repositoryRealpath
    || !matchingEntry) {
    return {
      ok: false,
      error: 'worktree-registration-mismatch',
      detail: 'Git does not register this path as the manifested worktree'
    };
  }

  const branchResult = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], absDir);
  const headResult = gitSafe(['rev-parse', 'HEAD'], absDir);
  if (!branchResult.ok || !headResult.ok) {
    return {
      ok: false,
      error: 'worktree-state-lookup-failed',
      detail: branchResult.ok ? headResult.output : branchResult.output
    };
  }
  if (matchingEntry.head !== headResult.output
    || matchingEntry.branch !== (branchResult.output === 'HEAD' ? null : branchResult.output)) {
    return {
      ok: false,
      error: 'worktree-list-state-mismatch',
      detail: 'Git worktree registration does not match the current HEAD and branch'
    };
  }

  return {
    ok: true,
    absDir,
    manifest,
    currentBranch: branchResult.output,
    currentHead: headResult.output,
    listedHead: matchingEntry.head,
    listedBranch: matchingEntry.branch
  };
}

function relevantStatusLines(statusOutput) {
  return statusOutput
    .split('\0')
    .filter(Boolean)
    .filter((line) => {
      const fileName = line.slice(3);
      return !META_FILES.some((metaFile) => {
        return fileName === metaFile || fileName.endsWith(`/${metaFile}`);
      });
    });
}

function statusSnapshot(worktreeDir) {
  const statusResult = gitSafe(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    worktreeDir
  );
  if (!statusResult.ok) {
    throw new Error(`git status failed: ${statusResult.output}`);
  }
  const lines = relevantStatusLines(statusResult.output);
  return {
    lines,
    fingerprint: crypto.createHash('sha256').update(lines.join('\0')).digest('hex')
  };
}

function recoveryRecordPath({ repositoryRealpath, creationToken }) {
  return path.join(
    repositoryRealpath,
    '.bug-hunter',
    'worktree-recovery',
    `${creationToken}.json`
  );
}

function persistHarvest({ absDir, manifest, result }) {
  const recoveryRecord = {
    ...result,
    worktreeRealpath: manifest.worktreeRealpath,
    repositoryRealpath: manifest.repositoryRealpath,
    fixBranch: manifest.fixBranch,
    creationToken: manifest.creationToken,
    recoveryAction: result.stashRefs && result.stashRefs.length > 0
      ? result.stashRefs.map((stashRef) => {
        return `Run git -C ${JSON.stringify(manifest.repositoryRealpath)} stash apply ${stashRef}`;
      })
      : `Inspect branch ${manifest.fixBranch} at ${result.inspectedHead || manifest.preHarvestHead}`
  };
  writeJsonFileAtomic(manifest.recoveryRecordPath, recoveryRecord);
  writeJsonFileAtomic(harvestPath(absDir), result);
}

function harvestFailure({ verified, error, detail, extra = {} }) {
  const previousRecovery = readJsonFile(verified.manifest.recoveryRecordPath);
  const previousStashRefs = previousRecovery
    && previousRecovery.creationToken === verified.manifest.creationToken
    && Array.isArray(previousRecovery.stashRefs)
    ? previousRecovery.stashRefs
    : [];
  const result = {
    ok: false,
    safeToRemove: false,
    error,
    detail,
    inspectedAtMs: Date.now(),
    ...extra,
    stashRefs: [
      ...new Set([
        ...previousStashRefs,
        ...(extra.stashRef ? [extra.stashRef] : [])
      ])
    ]
  };
  persistHarvest({
    absDir: verified.absDir,
    manifest: verified.manifest,
    result
  });
  return result;
}

function harvestCore({ repositoryCwd, worktreeDir }) {
  const verified = verifyManagedWorktree({ repositoryCwd, worktreeDir });
  if (!verified.ok) {
    return { ...verified, safeToRemove: false };
  }

  const { absDir, manifest } = verified;
  const previousRecovery = readJsonFile(manifest.recoveryRecordPath);
  const previousStashRefs = previousRecovery
    && previousRecovery.creationToken === manifest.creationToken
    && Array.isArray(previousRecovery.stashRefs)
    ? previousRecovery.stashRefs
    : [];
  const branchSwitched = verified.currentBranch !== manifest.fixBranch;
  const logResult = gitSafe(
    ['log', '--oneline', '--reverse', `${manifest.preHarvestHead}..HEAD`],
    absDir
  );
  if (!logResult.ok) {
    return harvestFailure({
      verified,
      error: 'commit-log-failed',
      detail: logResult.output
    });
  }

  const commitLines = logResult.output
    ? logResult.output.split('\n').filter(Boolean)
    : [];
  const commits = commitLines.map((line) => {
    const spaceIndex = line.indexOf(' ');
    const hash = spaceIndex >= 0 ? line.slice(0, spaceIndex) : line;
    const message = spaceIndex >= 0 ? line.slice(spaceIndex + 1) : '';
    const bugMatch = message.match(/BUG-(\d+)/);
    return {
      hash,
      message,
      bugId: bugMatch ? `BUG-${bugMatch[1]}` : null
    };
  });

  let initialStatus;
  try {
    initialStatus = statusSnapshot(absDir);
  } catch (error) {
    return harvestFailure({
      verified,
      error: 'status-failed',
      detail: errorMessage(error),
      extra: { commits }
    });
  }

  let stashRef = null;
  let stashOid = null;
  if (initialStatus.lines.length > 0) {
    const addResult = gitSafe([
      'add',
      '-A',
      '--',
      '.',
      `:(exclude)${MANIFEST_NAME}`,
      `:(exclude)${HARVEST_NAME}`
    ], absDir);
    if (!addResult.ok) {
      return harvestFailure({
        verified,
        error: 'preservation-add-failed',
        detail: addResult.output,
        extra: { commits, statusFingerprint: initialStatus.fingerprint }
      });
    }

    const stashMessage = `bug-hunter-fixer-uncommitted-${manifest.creationToken}`;
    const stashResult = gitSafe([
      'stash',
      'push',
      '--include-untracked',
      '-m',
      stashMessage,
      '--',
      '.',
      `:(exclude)${MANIFEST_NAME}`,
      `:(exclude)${HARVEST_NAME}`
    ], absDir);
    if (!stashResult.ok) {
      return harvestFailure({
        verified,
        error: 'preservation-stash-failed',
        detail: stashResult.output,
        extra: { commits, statusFingerprint: initialStatus.fingerprint }
      });
    }

    const stashListResult = gitSafe(
      ['stash', 'list', '--max-count=1', '--format=%gd%x00%H%x00%gs'],
      absDir
    );
    if (!stashListResult.ok) {
      return harvestFailure({
        verified,
        error: 'stash-lookup-failed',
        detail: stashListResult.output,
        extra: { commits, statusFingerprint: initialStatus.fingerprint }
      });
    }
    const [latestRef, latestOid, latestSubject] = stashListResult.output.split('\0');
    if (!latestRef || !latestOid || !latestSubject.endsWith(stashMessage)) {
      return harvestFailure({
        verified,
        error: 'stash-verification-failed',
        detail: 'The preservation stash could not be identified',
        extra: { commits, statusFingerprint: initialStatus.fingerprint }
      });
    }
    stashRef = latestRef;
    stashOid = latestOid;
  }

  const headResult = gitSafe(['rev-parse', 'HEAD'], absDir);
  if (!headResult.ok) {
    return harvestFailure({
      verified,
      error: 'head-lookup-failed',
      detail: headResult.output,
      extra: { commits, stashRef, stashOid }
    });
  }

  let finalStatus;
  try {
    finalStatus = statusSnapshot(absDir);
  } catch (error) {
    return harvestFailure({
      verified,
      error: 'post-preservation-status-failed',
      detail: errorMessage(error),
      extra: { commits, stashRef, stashOid, inspectedHead: headResult.output }
    });
  }
  if (finalStatus.lines.length > 0) {
    return harvestFailure({
      verified,
      error: 'preservation-incomplete',
      detail: `Worktree remains dirty: ${finalStatus.lines.join(', ')}`,
      extra: {
        commits,
        stashRef,
        stashOid,
        inspectedHead: headResult.output,
        statusFingerprint: finalStatus.fingerprint
      }
    });
  }

  const result = {
    ok: !branchSwitched,
    safeToRemove: !branchSwitched,
    error: branchSwitched ? 'branch-switched' : null,
    detail: branchSwitched
      ? `Fixer switched from ${manifest.fixBranch} to ${verified.currentBranch}`
      : '',
    branchSwitched,
    commits,
    harvestedCount: commits.length,
    noChanges: commits.length === 0 && initialStatus.lines.length === 0,
    uncommittedStashed: stashRef !== null,
    stashRef,
    stashOid,
    stashRefs: [
      ...new Set([
        ...previousStashRefs,
        ...(stashRef ? [stashRef] : [])
      ])
    ],
    preHarvestHead: manifest.preHarvestHead,
    inspectedHead: headResult.output,
    statusFingerprint: finalStatus.fingerprint,
    inspectedAtMs: Date.now(),
    recoveryRecordPath: manifest.recoveryRecordPath
  };
  persistHarvest({ absDir, manifest, result });
  return result;
}

function verifyFreshHarvest({ repositoryCwd, worktreeDir, harvestResult }) {
  if (!harvestResult.ok || !harvestResult.safeToRemove) {
    return {
      ok: false,
      error: harvestResult.error || 'harvest-not-safe',
      detail: harvestResult.detail || 'Fresh harvest did not authorize removal'
    };
  }
  const verified = verifyManagedWorktree({ repositoryCwd, worktreeDir });
  if (!verified.ok) {
    return verified;
  }
  let currentStatus;
  try {
    currentStatus = statusSnapshot(verified.absDir);
  } catch (error) {
    return { ok: false, error: 'fresh-status-failed', detail: errorMessage(error) };
  }
  if (verified.currentHead !== harvestResult.inspectedHead
    || currentStatus.fingerprint !== harvestResult.statusFingerprint
    || currentStatus.lines.length > 0) {
    return {
      ok: false,
      error: 'worktree-changed-after-harvest',
      detail: 'HEAD or status changed after the fresh preservation check'
    };
  }
  if (!fs.existsSync(verified.manifest.recoveryRecordPath)) {
    return {
      ok: false,
      error: 'recovery-record-missing',
      detail: verified.manifest.recoveryRecordPath
    };
  }
  return { ok: true, verified };
}

function cleanupCore({ repositoryCwd, worktreeDir }) {
  const absDir = path.resolve(worktreeDir);
  if (!fs.existsSync(absDir)) {
    return { ok: true, removed: false, reason: 'not-found' };
  }

  const verified = verifyManagedWorktree({ repositoryCwd, worktreeDir: absDir });
  if (!verified.ok) {
    return { ...verified, removed: false };
  }

  const freshHarvest = harvestCore({ repositoryCwd, worktreeDir: absDir });
  const freshCheck = verifyFreshHarvest({
    repositoryCwd,
    worktreeDir: absDir,
    harvestResult: freshHarvest
  });
  if (!freshCheck.ok) {
    return {
      ...freshCheck,
      removed: false,
      stashRef: freshHarvest.stashRef || null,
      recoveryRecordPath: verified.manifest.recoveryRecordPath
    };
  }

  const removeResult = gitSafe(
    ['worktree', 'remove', '--force', '--', absDir],
    verified.manifest.repositoryRealpath
  );
  if (!removeResult.ok) {
    return {
      ok: false,
      removed: false,
      error: 'worktree-remove-failed',
      detail: removeResult.output,
      preservedPath: absDir,
      stashRef: freshHarvest.stashRef,
      recoveryRecordPath: verified.manifest.recoveryRecordPath
    };
  }
  if (fs.existsSync(absDir)) {
    return {
      ok: false,
      removed: false,
      error: 'worktree-remove-incomplete',
      detail: `${absDir} still exists; recursive deletion was not attempted`,
      preservedPath: absDir,
      stashRef: freshHarvest.stashRef,
      recoveryRecordPath: verified.manifest.recoveryRecordPath
    };
  }

  const pruneResult = gitSafe(['worktree', 'prune'], verified.manifest.repositoryRealpath);
  if (!pruneResult.ok) {
    return {
      ok: false,
      removed: true,
      error: 'worktree-prune-failed',
      detail: pruneResult.output,
      stashRef: freshHarvest.stashRef,
      recoveryRecordPath: verified.manifest.recoveryRecordPath
    };
  }
  return {
    ok: true,
    removed: true,
    detachedMainTree: verified.manifest.detachedMainTree,
    stashRef: freshHarvest.stashRef,
    recoveryRecordPath: verified.manifest.recoveryRecordPath
  };
}

function prepare({ fixBranch, worktreeDir, repositoryCwd }) {
  const absDir = path.resolve(repositoryCwd, worktreeDir);
  const repoIdentity = repositoryIdentity(repositoryCwd);
  const branchCheck = gitSafe(
    ['rev-parse', '--verify', `refs/heads/${fixBranch}`],
    repoIdentity.topLevelRealpath
  );
  if (!branchCheck.ok) {
    return { ok: false, error: 'fix-branch-not-found', detail: branchCheck.output };
  }

  if (fs.existsSync(absDir)) {
    const existingVerification = verifyManagedWorktree({
      repositoryCwd,
      worktreeDir: absDir
    });
    if (!existingVerification.ok) {
      return {
        ok: false,
        error: 'existing-worktree-not-safe',
        detail: existingVerification,
        preservedPath: absDir
      };
    }
    let existingStatus;
    try {
      existingStatus = statusSnapshot(absDir);
    } catch (error) {
      return {
        ok: false,
        error: 'existing-worktree-status-failed',
        detail: errorMessage(error),
        preservedPath: absDir
      };
    }
    if (existingStatus.lines.length > 0) {
      return {
        ok: false,
        error: 'existing-worktree-dirty',
        detail: existingStatus.lines,
        preservedPath: absDir
      };
    }
    const cleanupResult = cleanupCore({ repositoryCwd, worktreeDir: absDir });
    if (!cleanupResult.ok || fs.existsSync(absDir)) {
      return {
        ok: false,
        error: 'existing-worktree-not-safe',
        detail: cleanupResult,
        preservedPath: absDir
      };
    }
  }

  const currentBranch = gitSafe(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    repoIdentity.topLevelRealpath
  );
  if (!currentBranch.ok) {
    return { ok: false, error: 'current-branch-lookup-failed', detail: currentBranch.output };
  }

  let detachedMainTree = false;
  if (currentBranch.output === fixBranch) {
    const detachResult = gitSafe(['checkout', '--detach'], repoIdentity.topLevelRealpath);
    if (!detachResult.ok) {
      return { ok: false, error: 'main-tree-detach-failed', detail: detachResult.output };
    }
    detachedMainTree = true;
  }

  ensureDir(path.dirname(absDir));
  const addResult = gitSafe(
    ['worktree', 'add', '--', absDir, fixBranch],
    repoIdentity.topLevelRealpath
  );
  if (!addResult.ok) {
    const restoreResult = detachedMainTree
      ? gitSafe(['checkout', fixBranch], repoIdentity.topLevelRealpath)
      : { ok: true, output: '' };
    return {
      ok: false,
      error: 'worktree-add-failed',
      detail: addResult.output,
      restoreError: restoreResult.ok ? '' : restoreResult.output
    };
  }

  let targetIdentity;
  try {
    targetIdentity = repositoryIdentity(absDir);
  } catch (error) {
    return {
      ok: false,
      error: 'new-worktree-identity-failed',
      detail: errorMessage(error),
      preservedPath: absDir
    };
  }
  if (targetIdentity.gitCommonDirRealpath !== repoIdentity.gitCommonDirRealpath) {
    return {
      ok: false,
      error: 'new-worktree-repository-mismatch',
      preservedPath: absDir
    };
  }

  const creationToken = crypto.randomBytes(24).toString('hex');
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    fixBranch,
    preHarvestHead: branchCheck.output,
    baseCommit: branchCheck.output,
    repositoryRealpath: repoIdentity.topLevelRealpath,
    gitCommonDirRealpath: repoIdentity.gitCommonDirRealpath,
    worktreeRealpath: realpath(absDir),
    worktreeParentRealpath: realpath(path.dirname(absDir)),
    creationToken,
    recoveryRecordPath: recoveryRecordPath({
      repositoryRealpath: repoIdentity.topLevelRealpath,
      creationToken
    }),
    detachedMainTree,
    createdAtMs: Date.now(),
    createdAt: new Date().toISOString()
  };
  if (!isPathInside(manifest.worktreeParentRealpath, manifest.worktreeRealpath)) {
    return {
      ok: false,
      error: 'new-worktree-parent-mismatch',
      preservedPath: absDir
    };
  }

  try {
    writeJsonFileAtomic(manifestPath(absDir), manifest);
  } catch (error) {
    return {
      ok: false,
      error: 'manifest-write-failed',
      detail: errorMessage(error),
      preservedPath: absDir
    };
  }
  const verification = verifyManagedWorktree({ repositoryCwd, worktreeDir: absDir });
  if (!verification.ok) {
    return {
      ...verification,
      preservedPath: absDir
    };
  }

  return {
    ok: true,
    worktreeDir: absDir,
    fixBranch,
    preHarvestHead: branchCheck.output,
    detachedMainTree,
    creationToken,
    recoveryRecordPath: manifest.recoveryRecordPath,
    createdAt: manifest.createdAt
  };
}

function harvest({ repositoryCwd, worktreeDir }) {
  const result = harvestCore({ repositoryCwd, worktreeDir });
  out(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function checkoutFix({ fixBranch, repositoryCwd }) {
  const repoIdentity = repositoryIdentity(repositoryCwd);
  const worktreeList = git(
    ['worktree', 'list', '--porcelain'],
    repoIdentity.topLevelRealpath
  );
  const entries = parseWorktreeList(worktreeList);
  const activeEntry = entries.find((entry) => {
    return entry.branch === fixBranch
      && entry.worktreePath
      && realpath(entry.worktreePath) !== repoIdentity.topLevelRealpath;
  });
  if (activeEntry) {
    return {
      ok: false,
      error: 'worktree-still-active',
      detail: `Branch ${fixBranch} is checked out in worktree: ${activeEntry.worktreePath}`
    };
  }
  const result = gitSafe(['checkout', fixBranch], repoIdentity.topLevelRealpath);
  if (!result.ok) {
    return { ok: false, error: 'checkout-failed', detail: result.output };
  }
  return {
    ok: true,
    branch: fixBranch,
    head: git(['rev-parse', 'HEAD'], repoIdentity.topLevelRealpath)
  };
}

function cleanup({ repositoryCwd, worktreeDir }) {
  const result = cleanupCore({ repositoryCwd, worktreeDir });
  out(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function cleanupAll({ parentDir, repositoryCwd }) {
  const absParent = path.resolve(repositoryCwd, parentDir);
  if (!fs.existsSync(absParent)) {
    out({ ok: true, cleaned: 0, entries: [] });
    return;
  }

  let entries;
  try {
    entries = fs.readdirSync(absParent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    out({ ok: false, cleaned: 0, entries: [], error: errorMessage(error) });
    process.exitCode = 1;
    return;
  }

  const results = entries.map((name) => {
    const result = cleanupCore({
      repositoryCwd,
      worktreeDir: path.join(absParent, name)
    });
    return { name, ...result };
  });
  const ok = results.every((result) => {
    return result.ok || result.reason === 'not-found';
  });
  out({
    ok,
    cleaned: results.filter((result) => result.removed).length,
    entries: results
  });
  if (!ok) {
    process.exitCode = 1;
  }
}

function statusCmd({ repositoryCwd, worktreeDir }) {
  const absDir = path.resolve(repositoryCwd, worktreeDir);
  if (!fs.existsSync(absDir)) {
    out({ ok: true, exists: false });
    return;
  }

  const verification = verifyManagedWorktree({ repositoryCwd, worktreeDir: absDir });
  if (!verification.ok) {
    out({ ...verification, exists: true });
    process.exitCode = 1;
    return;
  }
  const manifest = verification.manifest;
  const harvestResult = readJsonFile(harvestPath(absDir));
  let snapshot;
  try {
    snapshot = statusSnapshot(absDir);
  } catch (error) {
    out({
      ok: false,
      exists: true,
      error: 'status-failed',
      detail: errorMessage(error)
    });
    process.exitCode = 1;
    return;
  }
  const logResult = gitSafe(
    ['log', '--oneline', `${manifest.preHarvestHead}..HEAD`],
    absDir
  );
  if (!logResult.ok) {
    out({ ok: false, exists: true, error: 'commit-log-failed', detail: logResult.output });
    process.exitCode = 1;
    return;
  }
  const commitCount = logResult.output
    ? logResult.output.split('\n').filter(Boolean).length
    : 0;

  out({
    ok: true,
    exists: true,
    branch: verification.currentBranch,
    fixBranch: manifest.fixBranch,
    ageMs: Date.now() - manifest.createdAtMs,
    isStale: Date.now() - manifest.createdAtMs > STALE_AGE_MS,
    hasUncommitted: snapshot.lines.length > 0,
    commitCount,
    harvested: harvestResult !== null,
    safeToRemove: harvestResult ? harvestResult.safeToRemove === true : false,
    recoveryRecordPath: manifest.recoveryRecordPath,
    createdAt: manifest.createdAt
  });
}

function requireArgs(args, count, message) {
  if (args.length < count) {
    console.error(message);
    process.exit(1);
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const repositoryCwd = path.resolve(process.cwd());
  if (!command) {
    usage();
    process.exit(1);
  }

  if (command === 'prepare') {
    requireArgs(args, 2, 'prepare requires <fixBranch> <worktreeDir>');
    const result = prepare({ fixBranch: args[0], worktreeDir: args[1], repositoryCwd });
    out(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'harvest') {
    requireArgs(args, 1, 'harvest requires <worktreeDir>');
    harvest({ repositoryCwd, worktreeDir: args[0] });
    return;
  }
  if (command === 'checkout-fix') {
    requireArgs(args, 1, 'checkout-fix requires <fixBranch>');
    const result = checkoutFix({ fixBranch: args[0], repositoryCwd });
    out(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'cleanup') {
    requireArgs(args, 1, 'cleanup requires <worktreeDir>');
    cleanup({ repositoryCwd, worktreeDir: args[0] });
    return;
  }
  if (command === 'cleanup-all') {
    requireArgs(args, 1, 'cleanup-all requires <parentDir>');
    cleanupAll({ parentDir: args[0], repositoryCwd });
    return;
  }
  if (command === 'status') {
    requireArgs(args, 1, 'status requires <worktreeDir>');
    statusCmd({ repositoryCwd, worktreeDir: args[0] });
    return;
  }

  usage();
  process.exit(1);
}

try {
  main();
} catch (error) {
  out({ ok: false, error: 'unexpected-failure', detail: errorMessage(error) });
  process.exit(1);
}
