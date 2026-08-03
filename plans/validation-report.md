---
title: Bug Hunter Finding Validation
description: >
  Second-pass source and runtime validation of the 40 accepted audit defects.
prompt: |
  cross check and validate these bugs
---

# Bug Hunter Finding Validation

## Verdict

All 40 findings accepted by the earlier Referee remain valid.

- 21 findings were reproduced with safe local runtime or contract checks.
- 19 findings were confirmed from direct control flow, incompatible contracts,
  or current authoritative runtime documentation.
- The one previously rejected claim, BUG-33, remains rejected.
- No accepted finding was invalidated.

Three descriptions were narrowed:

- BUG-8 is a real command-injection sink, but practical reachability requires
  control over the local scan path or invocation. Treat it as Medium severity.
- BUG-7 confirms a missing trust boundary. Successful prompt injection still
  depends on the host model, its tools, and caller permissions.
- BUG-34 applies the plugin's 50 KB truncation only after capture. Node normally
  caps synchronous child output at 1 MiB, so the impact is early termination or
  excess buffering relative to the intended cap, not unlimited memory growth.

## Safe test baseline

The full test suite was not rerun because
@scripts/tests/experiment-loop.test.cjs invokes Git without setting `cwd`.
The other 11 test files ran successfully:

```text
tests: 61
passed: 61
failed: 0
```

The excluded experiment file contains the remaining 52 tests. Its auto-commit
case is unsafe in the current repository layout.

## Finding-by-finding validation

| Finding | Result | Validation method |
|---|---|---|
| BUG-1 | Valid | Runtime: invalid `config` missing conditional fields passed schema validation |
| BUG-2 | Valid | Runtime: string `secondaryMetrics` value passed schema validation |
| BUG-3 | Valid | Runtime: the exact Fixer example failed `fix-report` validation |
| BUG-4 | Valid | Contract: Recon requires Markdown while delegated payload requires JSON |
| BUG-5 | Valid | Runtime: final object shape rendered as zero findings |
| BUG-6 | Valid | Contract: Hunter both forbids and requires prose after JSON |
| BUG-7 | Valid control gap | Source: no inert-data boundary before repository content |
| BUG-8 | Valid, Medium | Source: resolved target path is interpolated into `bash -lc` |
| BUG-9 | Valid | Source: pip, Go, and Rust parser branch returns an empty success |
| BUG-10 | Valid | Source: one narrow JavaScript regex is used across ecosystems |
| BUG-11 | Valid | Source: search failure and zero matches return the same status |
| BUG-12 | Valid race | Source interleaving: stale delete and create are separate operations |
| BUG-13 | Valid race | Source interleaving: partial JSON is treated as absent and deleted |
| BUG-14 | Valid destructive path | Source: parseable manifest alone marks a directory managed |
| BUG-15 | Valid destructive path | Source: `prepare` force-removes without a fresh harvest |
| BUG-16 | Valid destructive path | Source: branch mismatch returns before dirty-state preservation |
| BUG-17 | Valid destructive path | Source: cached harvest bypasses a fresh cleanup check |
| BUG-18 | Valid destructive path | Source: failed add or stash does not block cleanup |
| BUG-19 | Valid | Source plus Node docs: killing a shell does not kill descendants |
| BUG-20 | Valid | Runtime: omitted worker produced failed chunks instead of findings |
| BUG-21 | Valid | Runtime: changed file list reused state containing only the old file |
| BUG-22 | Valid | Runtime: failed chunk returned `ok: true` and could not retry |
| BUG-23 | Valid | Runtime: canary entry contained `executionStage: "rollout"` |
| BUG-24 | Valid | Runtime: `--max-retries 0` still produced two attempts |
| BUG-25 | Valid | Runtime: domain order was MEDIUM, LOW, CRITICAL |
| BUG-26 | Valid | Runtime: maintained `scripts/tool.js` was omitted from scan order |
| BUG-27 | Valid | Runtime: `bin/cli.js` was omitted from discovered source |
| BUG-28 | Valid | Runtime: negative depth silently produced a zero-file scan |
| BUG-29 | Valid | Runtime with forced Git failure still recorded status `keep` |
| BUG-30 | Valid and observed | Runtime: auto-commit twice staged unrelated parent-repository files |
| BUG-31 | Valid | Runtime: corrupt JSONL line was silently ignored |
| BUG-32 | Valid | Runtime: result persisted `value: null` against numeric schema |
| BUG-34 | Valid, narrowed impact | Source/docs: 50 KB truncation runs after buffered capture |
| BUG-35 | Valid | Runtime: unmatched finding counted reviewed but disappeared |
| BUG-36 | Valid | Source: missing `origin/main` disables push-state proof |
| BUG-37 | Valid | Runtime: obsolete installed file survived a second installation |
| BUG-38 | Valid | Runtime: JSON `null` crashed the payload guard |
| BUG-39 | Valid | Runtime: side-effect JavaScript import produced no dependency |
| BUG-40 | Valid | Runtime: Python `.foo` remained unresolved |
| BUG-41 | Valid | Filesystem: six current sources reference absent `_dispatch.md` |

## Additional audit facts rechecked

- @SKILL.md still defaults both `LOOP_MODE` and `FIX_MODE` to true.
- @.github/workflows/ci.yml still tests only Node 18 and Node 20.
- Node 18 and Node 20 are currently listed as end-of-life.
- @package.json still publishes @docs, and @docs/images is about 36 MB while
  @scripts is about 424 KB.
- Package version is 3.0.10 while repository tags stop at v3.0.7.
- The public installer still recursively overlays its destination.
- The package still has no runtime dependencies and no pnpm lockfile.
- The safe preflight still selects only `local-sequential` in this environment.

## Safety note

The second-pass auto-commit validation initially used a sandbox under @tmp.
Git walked up to the parent repository and created an experiment commit
containing the audit plans and the user-owned @CLAUDE.md file. This independently
reproduced BUG-30.

The accidental commit was removed with a mixed reset to `4564ffc`. Checksums
for every affected working-tree file were verified unchanged. A later Git
failure test used an invalid explicit `GIT_DIR`, and HEAD remained unchanged.

## Claims not dynamically triggered

The worktree deletion, lock-race, process-tree, and command-injection triggers
were not executed. Running them would create destructive or exploit-like
conditions. Their validation is based on complete reachable control flow,
existing isolated tests around adjacent behavior, and authoritative platform
semantics.

## Sources

- @plans/audit-report.md
- @scripts/run-bug-hunter.cjs
- @scripts/bug-hunter-state.cjs
- @scripts/worktree-harvest.cjs
- @scripts/experiment-loop.cjs
- @scripts/fix-lock.cjs
- @scripts/dep-scan.cjs
- @scripts/schema-runtime.cjs
- @scripts/triage.cjs
- @scripts/code-index.cjs
- @scripts/render-report.cjs
- @scripts/payload-guard.cjs
- @schemas
- https://nodejs.org/api/child_process.html
- https://nodejs.org/en/about/eol
