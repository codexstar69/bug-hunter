#!/usr/bin/env node
'use strict';

/**
 * prepublish-guard.cjs
 *
 * Blocks `npm publish` unless:
 *   1. Git working tree is clean (no uncommitted changes)
 *   2. Current HEAD is pushed to origin (no unpushed commits)
 *   3. package.json version matches the git tag (if tag exists)
 *
 * This prevents the "published to npm but forgot to commit/push" problem.
 * Bypass with: SKIP_PREPUBLISH_GUARD=1 npm publish
 */

const { execSync } = require('child_process');

if (process.env.SKIP_PREPUBLISH_GUARD === '1') {
  console.log('⚠️  prepublish-guard: SKIPPED (SKIP_PREPUBLISH_GUARD=1)');
  process.exit(0);
}

const run = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const errors = [];

// 1. Check for uncommitted changes
try {
  const status = run('git status --porcelain');
  if (status) {
    errors.push(
      '❌ Uncommitted changes detected. Commit or stash before publishing.\n' +
      status.split('\n').map(l => `   ${l}`).join('\n')
    );
  }
} catch {
  errors.push('❌ Not a git repository or git not available.');
}

// 2. Check for unpushed commits
try {
  const unpushed = run('git log --oneline origin/main..HEAD 2>/dev/null');
  if (unpushed) {
    errors.push(
      '❌ Unpushed commits. Run `git push` before publishing.\n' +
      unpushed.split('\n').map(l => `   ${l}`).join('\n')
    );
  }
} catch {
  // If origin/main doesn't exist, skip this check
}

// 3. Version/tag consistency check
try {
  const version = require('../package.json').version;
  const tagExists = (() => {
    try { run(`git rev-parse v${version} 2>/dev/null`); return true; } catch { return false; }
  })();
  if (tagExists) {
    const tagCommit = run(`git rev-parse v${version}`);
    const headCommit = run('git rev-parse HEAD');
    if (tagCommit !== headCommit) {
      errors.push(
        `❌ Tag v${version} exists but points to a different commit.\n` +
        `   Tag:  ${tagCommit.slice(0, 8)}\n` +
        `   HEAD: ${headCommit.slice(0, 8)}\n` +
        `   Bump the version or move the tag.`
      );
    }
  }
} catch {
  // Non-fatal
}

if (errors.length > 0) {
  console.error('\n🛑 prepublish-guard: publish blocked\n');
  errors.forEach(e => console.error(e + '\n'));
  console.error('Bypass with: SKIP_PREPUBLISH_GUARD=1 npm publish\n');
  process.exit(1);
}

console.log('✅ prepublish-guard: clean tree, all pushed — safe to publish');
