#!/usr/bin/env node
'use strict';

/**
 * Publication is allowed only when the working tree is clean, HEAD exactly
 * matches both its configured upstream and the package version tag. Dry runs
 * still require a clean checkout, but can validate an untagged candidate.
 */

const childProcess = require('node:child_process');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');

function runGit(args) {
  return childProcess.execFileSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000
  }).trim();
}

function readGitProof({ label, args, errors }) {
  try {
    const value = runGit(args);
    if (!value) {
      errors.push(`Cannot prove ${label}: Git returned an empty value.`);
      return null;
    }
    return value;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    errors.push(`Cannot prove ${label}: ${details}`);
    return null;
  }
}

function main() {
  const errors = [];
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run')) {
    throw new Error('Usage: prepublish-guard.cjs [--dry-run]');
  }
  // npm sets this for the prepublishOnly lifecycle of `npm publish --dry-run`.
  const dryRun = args.includes('--dry-run') || (
    process.env.npm_lifecycle_event === 'prepublishOnly' &&
    process.env.npm_config_dry_run === 'true'
  );
  let untrackedOnly = false;
  const packageJson = require(path.join(REPOSITORY_ROOT, 'package.json'));
  const expectedTag = `v${packageJson.version}`;

  try {
    const status = runGit(['status', '--porcelain']);
    if (status) {
      untrackedOnly = status.split('\n').every((line) => line.startsWith('?? '));
      errors.push(
        `Uncommitted changes detected:\n${status.split('\n').map((line) => {
          return `   ${line}`;
        }).join('\n')}`
      );
    }
  } catch (error) {
    errors.push(
      `Cannot prove a clean working tree: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const headCommit = readGitProof({
    label: 'HEAD identity',
    args: ['rev-parse', '--verify', 'HEAD^{commit}'],
    errors
  });
  const upstreamName = dryRun ? null : readGitProof({
    label: 'the current branch upstream',
    args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    errors
  });
  const upstreamCommit = upstreamName ? readGitProof({
    label: `upstream ${upstreamName}`,
    args: ['rev-parse', '--verify', '@{upstream}^{commit}'],
    errors
  }) : null;
  const tagCommit = dryRun ? null : readGitProof({
    label: `exact tag ${expectedTag}`,
    args: ['rev-parse', '--verify', `refs/tags/${expectedTag}^{commit}`],
    errors
  });

  if (headCommit && upstreamCommit && headCommit !== upstreamCommit) {
    errors.push(
      `HEAD is not exactly pushed to ${upstreamName}.\n` +
      `   HEAD:     ${headCommit}\n` +
      `   Upstream: ${upstreamCommit}`
    );
  }
  if (headCommit && tagCommit && headCommit !== tagCommit) {
    errors.push(
      `Tag ${expectedTag} does not point to HEAD.\n` +
      `   HEAD: ${headCommit}\n` +
      `   Tag:  ${tagCommit}`
    );
  }

  if (errors.length > 0) {
    console.error('\nprepublish-guard: publish blocked\n');
    errors.map((error) => {
      console.error(`- ${error}\n`);
      return error;
    });
    if (untrackedOnly && errors.length === 1) {
      console.error(
        'Only untracked local files block this checkout. The files listed above (for example, ' +
        'CLAUDE.md) are outside Git history, so this is not a reproducible release checkout, ' +
        'even if npm would exclude them from the tarball. Use a clean release checkout or ' +
        'move local-only files outside this checkout, then rerun prepublish-guard.\n'
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    dryRun ? 'prepublish-guard: clean tree and HEAD verified for dry-run; tag/upstream binding skipped' :
      `prepublish-guard: clean tree, HEAD matches ${upstreamName} and ${expectedTag}`
  );
}

main();
