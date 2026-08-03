---
title: State, Process, and Schema Reliability
description: Make scans resumable, process-safe, schema-correct, and efficient.
prompt: |
  I want you to do a complete end to end Audit for the possible improvements
  of the entire bug-hunter plugin. First understand what it does, then
  understand the logic and see what if we can actually improve everything
  end-to-end. If there's any slightly chance of improvements in the system,
  build a complete end-to-end plan. But ensure do audit every perspective,
  every logic, and do in everything that you want to do.
---

# State, Process, and Schema Reliability

## Goal

A scan must have an immutable identity, resume only when explicitly requested,
recover interrupted work, preserve accurate per-file coverage, and terminate
failed workers without leaks. Runtime validation must enforce the schemas the
package publishes.

## Scope

Modify:

- @scripts/run-bug-hunter.cjs
- @scripts/bug-hunter-state.cjs
- @scripts/fix-lock.cjs
- @scripts/schema-runtime.cjs
- @scripts/experiment-loop.cjs
- @schemas/experiment.schema.json
- Focused tests under @scripts/tests

This plan may extract CommonJS modules from @scripts/run-bug-hunter.cjs after
characterization tests lock down behavior.

## State design

Each run stores:

- A random run ID.
- Canonical repository root and current base commit.
- Mode, backend, normalized options, and schema version.
- Hash of the ordered input scope.
- Per-file state: pending, scanned, missing, unreadable, skipped, failed.
- Per-chunk lease owner, attempt count, start time, and expiry.
- Atomic artifact references and journal sequence numbers.

Starting without `--resume` creates a new run directory. `--resume <run-id>`
requires every immutable fingerprint to match or fails with a diff.

## Implementation steps

1. Add characterization tests for state initialization, resume, retries,
   coverage, process timeout, and locking.

2. Move state operations into an importable module.
   - Keep the existing CLI as a thin adapter.
   - Load state once per chunk.
   - Index findings with a `Map` keyed by stable identity.
   - Persist one atomic update per transition.

3. Use atomic state writes.
   - Write a sibling temporary file.
   - Flush it, rename it, and flush the directory where supported.
   - Keep the last known good generation for recovery.
   - Treat malformed state as blocked, never empty.

4. Reconcile resume state.
   - Require explicit resume.
   - Requeue expired `in_progress` leases.
   - Allow capped retry of failed chunks.
   - Reopen changed files and add newly scoped files.
   - Mark removed and unreadable files accurately.
   - Never count a whole done chunk as proof that every file was scanned.

5. Replace the fix lock with an atomic lease.
   - Prefer an atomically created directory containing owner metadata.
   - Give each owner an unguessable token.
   - Renew only when the token still matches.
   - Bind stale takeover to the exact observed generation.
   - Fail closed on malformed locks.

6. Replace worker process supervision.
   - Add a child `error` handler and one-settlement guard.
   - Preserve null exit code and signal separately.
   - Stream bounded logs to the journal instead of unlimited memory buffers.
   - Spawn a process group on POSIX and terminate the full group.
   - Send TERM, wait for confirmed exit, then send KILL.
   - Add a platform adapter for Windows rather than assuming POSIX signals.

7. Make retry semantics explicit.
   - Accept zero retries.
   - Do not start a retry until the previous process tree is confirmed dead.
   - Give each attempt unique artifact paths, then promote only a validated
     successful attempt.

8. Make schema validation complete for the used schema vocabulary.
   - Support `allOf`, `if`, `then`, and schema-valued
     `additionalProperties`.
   - Add a test that inventories every keyword used under @schemas.
   - Either implement every used keyword or fail the build.
   - Remove duplicate handwritten experiment validation after parity.

9. Tighten experiment state.
   - Reject corrupt JSONL with line numbers.
   - Make `value` optional or numeric consistently in schema and runtime.
   - Bound child output before it is held in memory.

10. Extract the oversized orchestrator only after tests pass.
    - `process-runner.cjs`
    - `state-store.cjs`
    - `artifact-planner.cjs`
    - `chunk-scheduler.cjs`
    - Keep @scripts/run-bug-hunter.cjs as parsing and composition.

## Verification

```bash
node --test scripts/tests/bug-hunter-state.test.cjs
node --test scripts/tests/fix-lock.test.cjs
node --test scripts/tests/run-bug-hunter.test.cjs
node --test scripts/tests/payload-guard.test.cjs
node --test scripts/tests/experiment-loop.test.cjs
pnpm test
```

Add deterministic tests for:

- New run versus explicit resume.
- Scope, base-commit, mode, and option mismatch.
- Crash between temporary write and rename.
- Expired lease recovery and capped failed-chunk retry.
- Worker that ignores TERM and spawns a grandchild.
- Missing shell executable.
- More output than the configured cap.
- Two stale-lock contenders.
- Every schema keyword in use.

## Acceptance criteria

- A new run cannot reuse old completed state by accident.
- Interrupted and transiently failed chunks can resume safely.
- Coverage reports per-file outcomes and never inflates scanned counts.
- Timeout completion is bounded even when workers ignore TERM.
- Lock ownership is exclusive under concurrent stale takeover.
- Published schemas and runtime validators accept and reject the same fixtures.
- The refactor preserves CLI output and journal compatibility.

## References

- @scripts/run-bug-hunter.cjs
- @scripts/bug-hunter-state.cjs
- @scripts/fix-lock.cjs
- @scripts/schema-runtime.cjs
- https://nodejs.org/api/child_process.html
