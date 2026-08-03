---
title: Mutation and Worktree Safety
description: >
  Make every Git and filesystem mutation explicit, scoped, recoverable, and
  fail-closed.
prompt: |
  I want you to do a complete end to end Audit for the possible improvements
  of the entire bug-hunter plugin. First understand what it does, then
  understand the logic and see what if we can actually improve everything
  end-to-end. If there's any slightly chance of improvements in the system,
  build a complete end-to-end plan. But ensure do audit every perspective,
  every logic, and do in everything that you want to do.
---

# Mutation and Worktree Safety

## Goal

An ordinary scan or test must never edit, stage, commit, stash, switch, or
delete user work. Every mutation must require an explicit flag and a verified
scope. Cleanup must stop whenever preservation cannot be proven.

## Scope

Modify:

- @SKILL.md
- @README.md
- @modes/loop.md
- @modes/fix-loop.md
- @modes/fix-pipeline.md
- @scripts/experiment-loop.cjs
- @scripts/worktree-harvest.cjs
- @scripts/tests/experiment-loop.test.cjs
- @scripts/tests/worktree-harvest.test.cjs

Do not redesign artifact schemas or state orchestration in this plan.

## Current failure

`experiment-loop log` defaults `--auto-commit` to true and executes
`git add -A`. Its test invokes that command without setting a child working
directory. The audit reproduced an actual commit of an unrelated untracked
file in the parent repository.

Worktree cleanup has several independent loss paths:

- A parseable manifest is enough to mark any directory as managed.
- `prepare` force-removes an existing worktree without a fresh harvest.
- A branch switch returns `ok: true` before dirty-state inspection.
- A cached harvest suppresses a new status check.
- Failed `git add` or `git stash` does not block forced deletion.
- Failed `git worktree remove` falls back to recursive filesystem deletion.

## Design

Use one explicit mutation policy:

- Default `LOOP_MODE=false`.
- Default `FIX_MODE=false`.
- Default `APPROVE_MODE=true` whenever fixing is requested.
- `--fix` enables editing but not commits.
- `--autonomous` enables unattended edits only after all P0 gates pass.
- `--auto-commit` is explicit, never default.
- Auto-commit receives an approved path list and never uses `git add -A`.
- Refuse auto-commit on a dirty baseline outside those approved paths.

Use a fail-closed worktree state machine:

`unknown -> verified-managed -> freshly-inspected -> preserved -> removable`

A directory is removable only when all checks succeed in the current cleanup
call. A previous harvest file is evidence, not authorization.

## Implementation steps

1. Add regression tests before changing production behavior.
   - Create an isolated Git repository inside the test sandbox.
   - Pass `cwd` to every child command.
   - Put unrelated tracked, staged, untracked, and ignored files in the sandbox.
   - Assert default `log keep` creates no commit and changes no index entries.
   - Assert explicit auto-commit stages only the approved experiment paths.

2. Change experiment mutation defaults.
   - Parse `--auto-commit` as false unless explicitly true.
   - Make `gitAutoCommit` accept `{ description, cwd, allowedPaths }`.
   - Validate all paths are repository-relative and cannot escape by symlink.
   - Check `git add` status before attempting a commit.
   - Record commit failure as `checks_failed`, never `keep`.
   - Include `commitOk` and failure context in the JSONL result.
   - Reject corrupt JSONL instead of silently filtering it.

3. Change top-level product defaults.
   - Make no-flag usage scan-only and single-pass.
   - Require `--fix` for edits and `--autonomous` for unattended edits.
   - Keep `--safe` as the approval-required shortcut.
   - Update every usage example and flag table in the same change.

4. Strengthen worktree identity.
   - Extend the manifest with repository realpath, worktree realpath, base
     commit, branch, and a random creation token.
   - Verify that identity against `git worktree list --porcelain`.
   - Verify the target is below the configured worktree parent.
   - Treat malformed, missing, mismatched, or stale identity as not managed.

5. Make harvest conclusive.
   - Fail when branch lookup, status, add, stash, stash lookup, or head lookup
     fails.
   - Inspect dirty state even when the branch changed.
   - Include untracked files in preservation.
   - Write harvest results atomically.
   - Include the inspected head and status fingerprint in the result.

6. Make cleanup fresh and fail-closed.
   - Always rerun harvest immediately before removal.
   - Require `ok: true`, `safeToRemove: true`, and a matching current
     fingerprint.
   - Never recursively remove a directory after a failed Git worktree removal.
   - Return a nonzero exit and recovery instructions when cleanup is unsafe.
   - Make `cleanup-all` call the same single-worktree guard.

7. Make `prepare` preserve existing work.
   - If the path exists, run the same verified harvest and removal procedure.
   - Stop if the worktree is dirty, switched, unknown, or cannot be removed.
   - Never detach the user's main tree until the destination is proven safe.

## Verification

Run from the package root:

```bash
node --test scripts/tests/experiment-loop.test.cjs
node --test scripts/tests/worktree-harvest.test.cjs
pnpm test
git status --short
```

Add explicit tests for:

- Parent repository remains byte-for-byte unchanged.
- Dirty branch-switched worktree.
- Edits made after a cached harvest.
- Failed status, add, stash, stash lookup, and worktree removal.
- Forged manifest in an ordinary directory.
- Symlink escape from the worktree parent.
- Concurrent `cleanup-all` calls.

## Acceptance criteria

- No default command creates a Git commit or edits source.
- No test can run Git in the parent repository.
- No cleanup path uses recursive deletion as a fallback.
- Every user edit is either still in place or has a verified recovery ref.
- Failure output identifies the preserved path and exact recovery action.
- `pnpm test` passes without changing `git status`.

## Rollback

Revert only this plan's implementation changes. Do not remove worktrees during
rollback. Leave any preserved worktree and stash in place and report its path.
