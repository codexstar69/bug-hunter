const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  makeSandbox,
  resolveSkillScript,
  runJson,
  runRaw
} = require('./test-utils.cjs');

const SCRIPT = resolveSkillScript('worktree-harvest.cjs');

/** Create a bare git repo + a working clone with a fix branch. */
function makeGitFixture() {
  const sandbox = makeSandbox('wt-harvest-');

  // Bare origin
  const origin = path.join(sandbox, 'origin.git');
  fs.mkdirSync(origin, { recursive: true });
  execFileSync('git', ['init', '--bare'], { cwd: origin, stdio: 'ignore' });

  // Working clone
  const repo = path.join(sandbox, 'repo');
  execFileSync('git', ['clone', origin, repo], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'ignore' });

  // Initial commit on main
  fs.writeFileSync(path.join(repo, 'file.txt'), 'hello\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });

  // Create fix branch
  const fixBranch = 'bug-hunter-fix-test';
  execFileSync('git', ['checkout', '-b', fixBranch], { cwd: repo, stdio: 'ignore' });
  // Go back to main so fix branch isn't checked out
  execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' });

  return { sandbox, repo, fixBranch };
}

test('prepare creates worktree on fix branch', () => {
  const { repo, fixBranch } = makeGitFixture();
  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'batch-1');

  const result = runJson('node', [SCRIPT, 'prepare', fixBranch, wtDir], { cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(result.fixBranch, fixBranch);
  assert.ok(result.preHarvestHead);
  assert.ok(fs.existsSync(wtDir));

  // Verify worktree is on fix branch
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: wtDir, encoding: 'utf8'
  }).trim();
  assert.equal(branch, fixBranch);

  // Verify manifest
  const manifest = JSON.parse(fs.readFileSync(path.join(wtDir, '.worktree-manifest.json'), 'utf8'));
  assert.equal(manifest.fixBranch, fixBranch);
  assert.ok(manifest.preHarvestHead);
});

test('prepare detaches main tree when on fix branch', () => {
  const { repo, fixBranch } = makeGitFixture();
  // Check out fix branch on main tree
  execFileSync('git', ['checkout', fixBranch], { cwd: repo, stdio: 'ignore' });

  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'batch-1');
  const result = runJson('node', [SCRIPT, 'prepare', fixBranch, wtDir], { cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(result.detachedMainTree, true);

  // Main tree should be detached
  const mainBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repo, encoding: 'utf8'
  }).trim();
  assert.equal(mainBranch, 'HEAD'); // detached
});

test('prepare fails for non-existent branch', () => {
  const { repo } = makeGitFixture();
  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'batch-1');

  const result = runRaw('node', [SCRIPT, 'prepare', 'no-such-branch', wtDir], { cwd: repo });
  assert.notEqual(result.status, 0);
  const output = `${result.stdout || ''}`;
  assert.match(output, /fix-branch-not-found/);
});

test('prepare cleans up stale worktree', () => {
  const { repo, fixBranch } = makeGitFixture();
  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'batch-1');

  // Create first worktree
  runJson('node', [SCRIPT, 'prepare', fixBranch, wtDir], { cwd: repo });
  // Harvest + cleanup the first one so the branch is free
  runJson('node', [SCRIPT, 'harvest', wtDir], { cwd: repo });
  runJson('node', [SCRIPT, 'cleanup', wtDir], { cwd: repo });

  // Create second one on same path — should succeed
  const result = runJson('node', [SCRIPT, 'prepare', fixBranch, wtDir], { cwd: repo });
  assert.equal(result.ok, true);
});

test('harvest finds new commits', () => {
  const { repo, fixBranch } = makeGitFixture();
  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'batch-1');

  runJson('node', [SCRIPT, 'prepare', fixBranch, wtDir], { cwd: repo });

  // Simulate fixer: edit and commit inside worktree
  fs.writeFileSync(path.join(wtDir, 'fix.txt'), 'patched\n');
  execFileSync('git', ['add', 'fix.txt'], { cwd: wtDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fix(bug-hunter): BUG-3 — add input validation'], {
    cwd: wtDir, stdio: 'ignore'
  });

  const result = runJson('node', [SCRIPT, 'harvest', wtDir], { cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(result.harvestedCount, 1);
  assert.equal(result.commits[0].bugId, 'BUG-3');
  assert.equal(result.noChanges, false);
  assert.equal(result.uncommittedStashed, false);
});

test('harvest handles dirty state — stashes uncommitted work', () => {
  const { repo, fixBranch } = makeGitFixture();
  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'batch-1');

  runJson('node', [SCRIPT, 'prepare', fixBranch, wtDir], { cwd: repo });

  // Simulate fixer that edits but doesn't commit
  fs.writeFileSync(path.join(wtDir, 'dirty.txt'), 'uncommitted\n');

  const result = runJson('node', [SCRIPT, 'harvest', wtDir], { cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(result.harvestedCount, 0);
  assert.equal(result.uncommittedStashed, true);
  assert.ok(result.stashRef);
});

test('harvest handles no-op — clean worktree with no changes', () => {
  const { repo, fixBranch } = makeGitFixture();
  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'batch-1');

  runJson('node', [SCRIPT, 'prepare', fixBranch, wtDir], { cwd: repo });

  // No changes at all
  const result = runJson('node', [SCRIPT, 'harvest', wtDir], { cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(result.harvestedCount, 0);
  assert.equal(result.noChanges, true);
  assert.equal(result.uncommittedStashed, false);
});

test('cleanup removes worktree', () => {
  const { repo, fixBranch } = makeGitFixture();
  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'batch-1');

  runJson('node', [SCRIPT, 'prepare', fixBranch, wtDir], { cwd: repo });
  runJson('node', [SCRIPT, 'harvest', wtDir], { cwd: repo });

  const result = runJson('node', [SCRIPT, 'cleanup', wtDir], { cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.ok(!fs.existsSync(wtDir));
});

test('cleanup handles missing worktree gracefully', () => {
  const { repo } = makeGitFixture();
  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'nonexistent');

  const result = runJson('node', [SCRIPT, 'cleanup', wtDir], { cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'not-found');
});

test('cleanup-all removes multiple worktrees', () => {
  const { repo, fixBranch } = makeGitFixture();
  const parentDir = path.join(repo, '.bug-hunter', 'worktrees');
  const wt1 = path.join(parentDir, 'batch-1');
  const wt2 = path.join(parentDir, 'batch-2');

  // Create two worktrees sequentially (one at a time on the fix branch)
  runJson('node', [SCRIPT, 'prepare', fixBranch, wt1], { cwd: repo });
  runJson('node', [SCRIPT, 'harvest', wt1], { cwd: repo });
  runJson('node', [SCRIPT, 'cleanup', wt1], { cwd: repo });

  runJson('node', [SCRIPT, 'prepare', fixBranch, wt2], { cwd: repo });

  // Now simulate crash — wt2 still exists. Cleanup-all should handle it.
  // First recreate wt1 dir as if it's stale leftover
  fs.mkdirSync(wt1, { recursive: true });

  const result = runJson('node', [SCRIPT, 'cleanup-all', parentDir], { cwd: repo });
  assert.equal(result.ok, true);
  assert.ok(result.cleaned >= 1);
});

test('checkout-fix returns main tree to fix branch', () => {
  const { repo, fixBranch } = makeGitFixture();
  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'batch-1');

  // Prepare (may detach main tree)
  runJson('node', [SCRIPT, 'prepare', fixBranch, wtDir], { cwd: repo });
  runJson('node', [SCRIPT, 'harvest', wtDir], { cwd: repo });
  runJson('node', [SCRIPT, 'cleanup', wtDir], { cwd: repo });

  // Now checkout fix branch on main tree
  const result = runJson('node', [SCRIPT, 'checkout-fix', fixBranch], { cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(result.branch, fixBranch);
  assert.ok(result.head);

  // Verify
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repo, encoding: 'utf8'
  }).trim();
  assert.equal(branch, fixBranch);
});

test('full lifecycle: prepare → commit → harvest → cleanup → checkout-fix', () => {
  const { repo, fixBranch } = makeGitFixture();
  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'batch-1');

  // 1. Prepare
  const prep = runJson('node', [SCRIPT, 'prepare', fixBranch, wtDir], { cwd: repo });
  assert.equal(prep.ok, true);

  // 2. Fixer commits two bugs
  fs.writeFileSync(path.join(wtDir, 'auth.ts'), 'fixed auth\n');
  execFileSync('git', ['add', 'auth.ts'], { cwd: wtDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fix(bug-hunter): BUG-1 — SQL injection fix'], {
    cwd: wtDir, stdio: 'ignore'
  });

  fs.writeFileSync(path.join(wtDir, 'api.ts'), 'fixed api\n');
  execFileSync('git', ['add', 'api.ts'], { cwd: wtDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fix(bug-hunter): BUG-2 — XSS prevention'], {
    cwd: wtDir, stdio: 'ignore'
  });

  // 3. Harvest
  const harv = runJson('node', [SCRIPT, 'harvest', wtDir], { cwd: repo });
  assert.equal(harv.ok, true);
  assert.equal(harv.harvestedCount, 2);
  assert.equal(harv.commits[0].bugId, 'BUG-1');
  assert.equal(harv.commits[1].bugId, 'BUG-2');

  // 4. Cleanup
  const clean = runJson('node', [SCRIPT, 'cleanup', wtDir], { cwd: repo });
  assert.equal(clean.ok, true);
  assert.equal(clean.removed, true);

  // 5. Checkout fix branch on main tree
  const co = runJson('node', [SCRIPT, 'checkout-fix', fixBranch], { cwd: repo });
  assert.equal(co.ok, true);

  // 6. Verify commits are on the fix branch in main tree
  const log = execFileSync('git', ['log', '--oneline', 'main..HEAD'], {
    cwd: repo, encoding: 'utf8'
  }).trim();
  assert.match(log, /BUG-1/);
  assert.match(log, /BUG-2/);

  // 7. Verify files exist in main tree
  assert.ok(fs.existsSync(path.join(repo, 'auth.ts')));
  assert.ok(fs.existsSync(path.join(repo, 'api.ts')));
});

test('status reports worktree health', () => {
  const { repo, fixBranch } = makeGitFixture();
  const wtDir = path.join(repo, '.bug-hunter', 'worktrees', 'batch-1');

  // Non-existent
  const s1 = runJson('node', [SCRIPT, 'status', wtDir], { cwd: repo });
  assert.equal(s1.exists, false);

  // Create worktree
  runJson('node', [SCRIPT, 'prepare', fixBranch, wtDir], { cwd: repo });

  const s2 = runJson('node', [SCRIPT, 'status', wtDir], { cwd: repo });
  assert.equal(s2.exists, true);
  assert.equal(s2.branch, fixBranch);
  assert.equal(s2.isStale, false);
  assert.equal(s2.commitCount, 0);
  assert.equal(s2.harvested, false);

  // Clean up
  runJson('node', [SCRIPT, 'harvest', wtDir], { cwd: repo });
  runJson('node', [SCRIPT, 'cleanup', wtDir], { cwd: repo });
});
