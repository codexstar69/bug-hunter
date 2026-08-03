---
title: Complete Bug Hunter Fix Plan
description: >
  Master execution plan for all 40 validated defects and the broader audit
  gaps, ordered by safety dependency and backed by explicit verification gates.
prompt: |
  can we build a complete fix plan for all bugs?

  Use @plans/audit-report.md, @plans/validation-report.md, and
  @plans/001-mutation-and-worktree-safety.md through
  @plans/006-runtime-packaging-quality-and-docs.md as source context.
---

# Complete Bug Hunter Fix Plan

This is the master plan for fixing every accepted defect in the Bug Hunter
audit. It coordinates the detailed plans in @plans/001-006. Those files remain
the implementation specifications for each wave; this file supplies the
complete dependency graph, bug traceability, shared decisions, rollout gates,
and final release proof.

## Executor instructions

- Execute the waves in order.
- Do not start a later wave until the previous wave's required gate passes.
- Treat this as the ordered waves below, including isolated 1b and extraction
  4b gates, not one large rewrite.
- Before editing a file, reread it and check `git status --short`.
- Preserve user-owned and unrelated changes. Never edit @CLAUDE.md.
- Do not create a commit, tag, publish, or deploy unless the user separately
  asks for that action.
- Use @plans/001-006 for step-level detail when this master plan points to a
  wave.
- Stop immediately on an unexpected test failure, unexpected Git change, lost
  artifact, or ambiguous destructive path.

## Status

- **Priority:** P0 program
- **Effort:** XL, executed as ordered safety, contract, reliability,
  correctness, extraction, and packaging gates
- **Risk:** High
- **Category:** safety, security, correctness, reliability, architecture,
  packaging, and documentation
- **Planned at commit:** `4564ffc`
- **Plan date:** 2026-08-03
- **Validated defect set:** BUG-1 through BUG-41, excluding rejected BUG-33
- **Broader audit set:** A01 through A35
- **Review gap set:** R01 through R08
- **Implementation:** Complete on 2026-08-03; all six gates and extraction
  gate 4b passed
- **Release preparation:** Version 3.1.0 prepared locally; no commit, tag,
  publish, or deploy performed

## Confirmed implementation decisions

The completed implementation uses these design choices.

1. Normal no-flag use becomes single-pass, scan-only, and non-mutating.
2. Fixing requires `--fix`; unattended fixing additionally requires
   `--autonomous`; committing requires explicit `--auto-commit`.
3. The package keeps zero runtime dependencies by compiling @schemas with Ajv
   during development, bundling standalone CommonJS validators, and committing
   the generated runtime module. CI regenerates it and fails on a diff. Strict
   schema compilation rejects unknown or ignored keywords.
4. Canonical machine artifacts use separate versioned files. Markdown is only
   a rendered view.
5. Old `.bug-hunter/findings.json` data gets a read-only migration diagnostic
   for one minor release. The program will not rewrite old artifacts.
6. Python, Go, or Rust dependency scanning is advertised only after that
   ecosystem has real parser and reachability fixtures. Until then, the result
   is `scanner-unsupported`, never clean.
7. Implementation remains CommonJS and uses the existing Node test runner.
8. Each wave remains independently reviewable. Release preparation updates the
   version and changelog, but publishing still requires separate user approval.

## Why the order is strict

```text
safe tests and mutations
        |
        v
trusted agent inputs and bounded Fixer scope
        |
        v
canonical artifacts and Referee-only fix authorization
        |
        v
run identity, atomic state, retries, locks, and process control
        |
        v
complete triage, dependency analysis, and code indexing
        |
        v
installed-package, CI, eval, documentation, and release proof
```

Wave 1 is the safety boundary for every later test. Wave 2 prevents repository
text and Fixer output from expanding authority. Wave 3 gives later state and
reporting code one stable artifact contract. Wave 4 can then refactor the
orchestrator without preserving broken contracts. Waves 5 and 6 depend on all
of those guarantees.

## Current baseline

- HEAD is `4564ffc`.
- The user-owned @CLAUDE.md file is untracked and must remain unchanged.
- The original full suite ran 113 tests: 112 passed and one unsafe experiment
  test failed.
- The safe subset ran 61 tests across 11 files, all passing.
- Do not run the current full `pnpm test` until Wave 1 isolates every Git
  command. The unsafe test has already staged and committed parent-repository
  files twice.
- Current preflight passes only with `local-sequential` in this environment.
- Package version is 3.0.10, while repository tags stop at v3.0.7.
- The package includes about 36 MB of documentation images.

## Shared target architecture

### Capability boundary

Preflight builds one capability registry for dispatch backends, Git mutation,
dependency scanners, threat-model tools, and documentation lookup. A command
must fail before creating run state if a required capability is unavailable.
There is no no-op worker fallback.

### Trust boundary

Caller policy is trusted. Repository files, comments, docs, tool output,
findings, patches, external documentation, and package metadata are untrusted
data. They may be analyzed but cannot grant tools, change output paths, expand
file scope, expose secrets, or authorize mutation.

### Artifact graph

| Phase | Canonical artifact |
|---|---|
| Recon | `.bug-hunter/recon.json` |
| Hunter | `.bug-hunter/hunter-findings.json` |
| Skeptic | `.bug-hunter/skeptic.json` |
| Referee | `.bug-hunter/referee.json` |
| Final scan | `.bug-hunter/scan-report.json` |
| Strategy | `.bug-hunter/fix-strategy.json` |
| Fix plan | `.bug-hunter/fix-plan.json` |
| Fix result | `.bug-hunter/fix-report.json` |

Every artifact declares a schema version and run ID. A phase writes its own
artifact atomically and never overwrites an earlier phase with another shape.

### Authorization boundary

Only `REAL_BUG` Referee verdicts may enter a fix strategy. The orchestrator,
not the Fixer, creates an immutable scope manifest containing the run ID,
canonical repository root, base commit, approved bug IDs, and approved files.
Every returned diff is checked against it before any merge or cleanup.

### Run and mutation boundary

Every run gets a unique directory and immutable fingerprint. Resume is
explicit. State transitions and artifacts are atomic. Git and filesystem
mutation fail closed. A worktree can be removed only after current identity,
status, preservation, and removal checks all succeed in the same cleanup call.

## Complete defect traceability

The table maps all 40 accepted numbered bugs. BUG-33 is intentionally absent
because the independent review rejected it.

| Bug | Wave | Fix | Primary files | Required regression proof |
|---|---:|---|---|---|
| BUG-1 | 4 | Enforce conditional schema branches including `if`, `then`, and `allOf` | @scripts/schema-runtime.cjs, @schemas/experiment.schema.json | Invalid conditional config fails with its JSON path |
| BUG-2 | 4 | Validate schema-valued `additionalProperties` recursively | @scripts/schema-runtime.cjs | Non-numeric secondary metric fails |
| BUG-3 | 3 | Make Fixer instructions emit the exact fix-report schema | @skills/fixer/SKILL.md, @schemas/fix-report.schema.json | Documented Fixer example validates |
| BUG-4 | 3 | Make Recon emit canonical JSON and render Markdown separately | @skills/recon/SKILL.md, @schemas/recon.schema.json | Recon contract fixture passes both outputs |
| BUG-5 | 3 | Split Hunter findings from final scan-report shape | @SKILL.md, @scripts/render-report.cjs, @schemas | Object/array mismatch fails loudly, never renders zero |
| BUG-6 | 3 | Require exactly one JSON artifact with no trailing prose | @skills/hunter/SKILL.md, @templates/subagent-wrapper.md | Conflicting instruction check finds no conflict |
| BUG-7 | 2 | Delimit all repository and external text as untrusted data | @templates/subagent-wrapper.md, @skills | Adversarial instruction text cannot change role or path |
| BUG-8 | 1b | Replace `bash -lc` interpolation with executable plus argument arrays for both paths and package-derived patterns | @scripts/dep-scan.cjs | Shell metacharacters in either input remain inert |
| BUG-9 | 5 | Parse each supported ecosystem or return unsupported | @scripts/dep-scan.cjs | Pip, Go, and Rust cannot return empty success without parser proof |
| BUG-10 | 5 | Use ecosystem-specific reachability analysis | @scripts/dep-scan.cjs | Mixed-language import fixture has correct status |
| BUG-11 | 5 | Separate zero matches, unsupported scanner, and command/search failure | @scripts/dep-scan.cjs | Failed `rg` returns unknown/failed, never not-reachable |
| BUG-12 | 4 | Replace stale lock delete/create with atomic token leases | @scripts/fix-lock.cjs | Exactly one stale-lock contender acquires |
| BUG-13 | 4 | Use atomic state writes and preserve malformed generations | @scripts/bug-hunter-state.cjs | Partial state blocks or recovers; it is never deleted as absent |
| BUG-14 | 1 | Verify managed worktree identity, token, root, and Git registration | @scripts/worktree-harvest.cjs | Forged manifest cannot authorize removal |
| BUG-15 | 1 | Freshly harvest and verify before `prepare` removes anything | @scripts/worktree-harvest.cjs | Dirty existing worktree is preserved |
| BUG-16 | 1 | Inspect and preserve dirty state even after branch change | @scripts/worktree-harvest.cjs | Branch-switched dirty files remain recoverable |
| BUG-17 | 1 | Never treat cached harvest data as cleanup authorization | @scripts/worktree-harvest.cjs | Edit after harvest blocks cleanup |
| BUG-18 | 1 | Make failed add, stash, lookup, or status block cleanup | @scripts/worktree-harvest.cjs | Every forced Git failure preserves the directory |
| BUG-19 | 4 | Supervise process groups and confirm descendant exit | @scripts/run-bug-hunter.cjs | TERM-ignoring worker and grandchild both stop |
| BUG-20 | 3 | Remove no-op worker default and require a capable backend | @scripts/run-bug-hunter.cjs, @modes | Missing worker fails preflight before state creation |
| BUG-21 | 4 | Bind state to run, scope, base commit, mode, options, and schema | @scripts/run-bug-hunter.cjs, @scripts/bug-hunter-state.cjs | Changed file scope refuses implicit reuse |
| BUG-22 | 4 | Keep failed chunks retryable and make run result truthful | @scripts/run-bug-hunter.cjs, @scripts/bug-hunter-state.cjs | Failed chunk cannot produce `ok: true`; resume can retry |
| BUG-23 | 3 | Derive execution stage after canary/rollout bucket assignment | @scripts/run-bug-hunter.cjs | Every item stage matches its containing bucket |
| BUG-24 | 1b | Parse retry count as a nonnegative integer, including zero | @scripts/run-bug-hunter.cjs | `--max-retries 0` makes one total attempt |
| BUG-25 | 1b | Use nullish rank fallback so CRITICAL rank zero survives | @scripts/triage.cjs | Domain order is CRITICAL, HIGH, MEDIUM, LOW |
| BUG-26 | 1b | Keep maintained scripts/tools in scan scope, with priority only affecting order | @scripts/triage.cjs | Maintained `scripts/tool.js` appears |
| BUG-27 | 1b | Remove blanket `bin` exclusion | @scripts/triage.cjs | @bin/bug-hunter appears in self-scan scope |
| BUG-28 | 1b | Validate depth as a bounded nonnegative integer | @scripts/triage.cjs | Negative, fractional, NaN, and oversized depth fail clearly |
| BUG-29 | 1 | Treat failed commit as failed experiment status | @scripts/experiment-loop.cjs | Forced commit failure cannot log `keep` |
| BUG-30 | 1 | Default auto-commit off; stage only approved paths in explicit repository `cwd` | @scripts/experiment-loop.cjs, tests | Parent index and unrelated files remain unchanged |
| BUG-31 | 4 | Reject corrupt JSONL with path and line number | @scripts/experiment-loop.cjs | Corrupt history stops reconstruction |
| BUG-32 | 4 | Align nullable/optional experiment value schema and runtime | @scripts/experiment-loop.cjs, @schemas/experiment.schema.json | All persisted results validate |
| BUG-34 | 4a | Stream and cap child output during capture; handle asynchronous spawn errors with one settlement | @scripts/experiment-loop.cjs, @scripts/run-bug-hunter.cjs | Output beyond cap terminates predictably and a missing executable returns a structured failure |
| BUG-35 | 3 | Preserve unmatched findings as `UNREVIEWED` | @scripts/render-report.cjs | Rendered groups and counts cover every finding ID |
| BUG-36 | 6 | Fail closed when upstream proof is unavailable; use actual upstream | @scripts/prepublish-guard.cjs | Missing `origin/main` cannot bypass release proof |
| BUG-37 | 6 | Stage, validate, atomically swap, and clean managed install files | @bin/bug-hunter | Second install removes obsolete managed file and keeps user file |
| BUG-38 | 1b | Guard null and primitives before property access | @scripts/payload-guard.cjs | Every JSON primitive returns structured errors, never crashes |
| BUG-39 | 1b | Index JavaScript side-effect imports | @scripts/code-index.cjs | `import "package"` creates dependency edge |
| BUG-40 | 1b | Resolve Python relative imports by package location and depth | @scripts/code-index.cjs | `.foo` and `..pkg` resolve or show explicit reason |
| BUG-41 | 3 | Add one tracked dispatch contract and verify all references | @modes/dispatch.md, @modes, @SKILL.md | Every internal Markdown reference resolves in packed package |

## Broader audit gap traceability

The numbered defects do not cover every system-level gap. These audit items
must also close before the plan is complete.

| Audit item | Wave | Closure |
|---|---:|---|
| A01 | 1 | Auto-commit becomes explicit and stages approved paths only |
| A02 | 1 | Every worktree removal requires a fresh successful harvest |
| A03 | 1 | Manifest, Git registration, repository root, and token prove ownership |
| A04 | 1 | Default invocation becomes single-pass and scan-only |
| A05 | 2 | Every repository and external block is labeled untrusted data |
| A06 | 2 | Skeptic judges prompt injection by evidence instead of exclusion |
| A07 | 3 | Only joined `REAL_BUG` Referee verdicts enter fix planning |
| A08 | 3 | Hunter findings and final scan report use different paths and schemas |
| A09 | 3 | Fixer instructions and fix-report schema use the same shape |
| A10 | 3 | Recon JSON is canonical and Markdown is rendered separately |
| A11 | 3 | One tracked dispatch contract serves all delegated modes |
| A12 | 3 | Missing worker capability fails preflight instead of doing no work |
| A13 | 2 | Immutable scope manifest and post-fix diff checks bound Fixer changes |
| A14 | 4 | Run fingerprint blocks stale state reuse after scope changes |
| A15 | 4 | Chunk leases and capped retries recover interrupted and failed work |
| A16 | 4 | Run-scoped atomic state generations prevent shared partial writes |
| A17 | 4 | Process-group supervision stops workers and descendants |
| A18 | 4 | Spawn errors settle once and output is capped while streaming |
| A19 | 4 | Atomic owner-token leases replace stale fix-lock takeover |
| A20 | 4 | Runtime schema support matches every keyword used by published schemas |
| A21 | 5 | Dependency tools use executable and argument arrays without a shell |
| A22 | 5 | Unsupported ecosystem parsing returns `scanner-unsupported` |
| A23 | 5 | Search failure returns unknown or failed, never not-reachable |
| A24 | 5 | Triage orders every tier and retains maintained bin/script/low code |
| A25 | 5 | Code index covers side-effect JavaScript and Python relative imports |
| A26 | 1 | Commit failure changes experiment status to failed |
| A27 | 3 | Reports include unmatched findings as `UNREVIEWED` |
| A28 | 6 | Atomic managed installation removes stale files and large non-runtime assets |
| A29 | 6 | Engine, doctor, and CI use supported Node releases |
| A30 | 6 | Exact tag, HEAD, and upstream proof gate every publication path |
| A31 | 6 | Hidden expected answers and executable scoring replace prose-only evals |
| A32 | 6 | Skills become canonical; prompt compatibility content is generated |
| A33 | 6 | Test counts, capabilities, and package inventory are generated |
| A34 | 4b | In-process indexed state removes per-chunk subprocess and linear lookup costs |
| A35 | 4b | Tested modules split process, state, planning, and scheduling concerns |

## Review-validated gap traceability

@plans/007-review-notes.md and the follow-up source review found these gaps
after the original 40-bug ledger was frozen.

| Gap | Wave | Closure |
|---|---:|---|
| R01 | 4a | Count and render actual per-file scanned, skipped, missing, unreadable, and failed outcomes |
| R02 | 4a | Treat a lock without a valid owner token as malformed and never renewable or releasable |
| R03 | 1 | Store harvest and recovery records outside the worktree removal target |
| R04 | 1 | Keep sandboxes under local @tmp while proving every Git fixture has an isolated top-level repository |
| R05 | 1 | Clean each test sandbox and prove a focused or full suite leaves the prior sandbox count unchanged |
| R06 | 1b | Validate delta hops strictly and never silently omit a changed file absent from the index |
| R07 | 1b | Bound GitHub CLI and Git execution time in PR scope resolution |
| R08 | 6 | Bound documentation response size, return failure status on total lookup failure, and add deterministic helper tests |

## Wave 0: Freeze the evidence and protect the repository

This is a setup gate, not a source-change wave.

1. Record:

   ```bash
   git rev-parse HEAD
   git status --short
   git diff --stat
   ```

2. Record the checksum of every pre-existing untracked file without staging it.
3. Build the safe test list and prove that it excludes exactly the intended
   file before executing anything:

   ```bash
   BUG_HUNTER_ALL_TESTS=$(git ls-files 'scripts/tests/*.test.cjs')
   BUG_HUNTER_UNSAFE_TESTS=$(printf '%s\n' "$BUG_HUNTER_ALL_TESTS" \
     | rg '(^|/)experiment-loop\.test\.cjs$')
   BUG_HUNTER_UNSAFE_COUNT=$(printf '%s\n' "$BUG_HUNTER_UNSAFE_TESTS" \
     | awk 'NF { count += 1 } END { print count + 0 }')
   test "$BUG_HUNTER_UNSAFE_COUNT" -eq 1

   BUG_HUNTER_SAFE_TESTS=$(printf '%s\n' "$BUG_HUNTER_ALL_TESTS" \
     | rg -v '(^|/)experiment-loop\.test\.cjs$')
   if printf '%s\n' "$BUG_HUNTER_SAFE_TESTS" \
     | rg -q '(^|/)experiment-loop\.test\.cjs$'; then
     echo 'unsafe experiment test remains selected'
     exit 1
   fi
   printf '%s\n' "$BUG_HUNTER_SAFE_TESTS" | xargs node --test
   ```

4. Never trust a negative safety filter without asserting the excluded target.
5. Do not run `pnpm test`, `pnpm pack`, or prepublish hooks yet because the
   current experiment test can execute parent-repository Git operations.
6. If HEAD, the index, or a user-owned file changes during a test, stop. Do not
   try to repair the tree with checkout or reset. Report the exact change.

**Gate 0:** safe subset passes and the before/after Git status is identical.

## Wave 1: Mutation and worktree safety

Detailed specification: @plans/001-mutation-and-worktree-safety.md.

### Implementation order

1. Refactor the experiment test helper so every Git fixture:
   - stays under local @tmp and creates its own repository below the sandbox;
   - passes explicit `cwd` to every child;
   - asserts the resolved Git top-level is exactly the nested test repository;
   - rejects paths outside that repository;
   - checks parent HEAD and index before and after each test.
   - removes its own sandbox after the test.
2. Add failing cases for BUG-29 and BUG-30 before production changes.
3. Change experiment auto-commit to explicit opt-in and approved-path staging.
4. Add worktree identity and preservation regressions for BUG-14 through
   BUG-18.
5. Implement the verified worktree state machine.
6. Change @SKILL.md and mode defaults to scan-only, single-pass operation.
7. Update user-facing flag descriptions in the same change.
8. Prove the @package.json `prepack` lifecycle is safe after the test-helper
   change. Until then, do not run any pack command.

### Required checks

```bash
node --test scripts/tests/experiment-loop.test.cjs
node --test scripts/tests/worktree-harvest.test.cjs
pnpm test
git status --short
```

**Gate 1:** all tests pass, `pnpm test` makes no Git or source change, default
use cannot edit or commit, and every unsafe cleanup case preserves a recovery
path.

## Wave 1b: Isolated correctness and boundary corrections

This wave runs immediately after Gate 1. It fixes small independent defects
before the larger trust, artifact, and state work. A change that expands beyond
its listed production file returns to its original owning wave.

1. Remove the dependency scanner shell boundary for target and package inputs.
2. Accept zero retries as one total attempt.
3. Correct CRITICAL ordering and include maintained bin, script, and low-tier
   source after higher-priority files.
4. Reject invalid triage depth values.
5. Guard primitive payloads before object operations.
6. Index JavaScript side-effect imports and Python relative imports.
7. Validate delta hops and surface changed files missing from the index.
8. Add timeouts to PR scope child commands.

### Required checks

```bash
node --test scripts/tests/triage.test.cjs
node --test scripts/tests/dep-scan.test.cjs
node --test scripts/tests/code-index.test.cjs
node --test scripts/tests/payload-guard.test.cjs
node --test scripts/tests/delta-mode.test.cjs
node --test scripts/tests/pr-scope.test.cjs
node --test scripts/tests/run-bug-hunter.test.cjs
pnpm test
```

**Gate 1b:** the self-scan orders CRITICAL first, includes maintained
@bin/bug-hunter and @scripts files, treats shell characters as inert, accepts
zero retries, and reports every omitted delta file explicitly.

## Wave 2: Agent trust and Fixer scope

Detailed specification: @plans/002-agent-trust-and-scope.md.

### Implementation order

1. Add a short authoritative trust policy to the wrapper and every directly
   runnable role.
2. Mark every injected repository/tool/document block with unique inert-data
   boundaries.
3. Remove Skeptic's automatic prompt-injection dismissal.
4. Validate payload shape before reading fields; reject null and primitives.
5. Canonicalize all repository, artifact, and allowed-file paths.
6. Generate the Fixer scope manifest only after Referee selection.
7. Verify harvested diffs against base commit, bug IDs, allowed files,
   symlinks, submodules, secrets, and Git metadata.

### Required checks

```bash
node --test scripts/tests/payload-guard.test.cjs
node --test scripts/tests/worktree-harvest.test.cjs
node --test scripts/tests/security-skills-integration.test.cjs
pnpm test
```

**Gate 2:** instruction-like repository text cannot expand authority, and one
extra changed file causes the Fixer result to be rejected and preserved.

## Wave 3: Artifact contracts, Referee gate, and dispatch

Detailed specification: @plans/003-artifact-and-verdict-contracts.md.

### Implementation order

1. Add valid and invalid fixtures for every current artifact.
2. Add new schemas for scan report and Fixer scope.
3. Align role instructions with exactly one output schema each.
4. Split Hunter findings from the final scan report.
5. Add the tracked @modes/dispatch.md contract and a reference checker.
6. Add a backend capability registry and remove the empty worker default.
7. Enforce `recon -> hunter -> skeptic -> referee -> scan-report`.
8. Construct fix strategy and plan only from joined `REAL_BUG` verdicts.
9. Render confirmed, dismissed, manual-review, and unreviewed groups.
10. Add a read-only diagnostic for old findings files.

### Required checks

```bash
node --test scripts/tests/payload-guard.test.cjs
node --test scripts/tests/render-report.test.cjs
node --test scripts/tests/run-bug-hunter.test.cjs
node --test scripts/tests/skills-packaging.test.cjs
pnpm test
```

**Gate 3:** every documented phase produces a validated artifact, every
internal reference resolves, and no non-Referee-confirmed item can enter a
Fixer assignment.

## Wave 4a: Run state, processes, locks, and schemas

Detailed specification:
@plans/004-state-process-and-schema-reliability.md.

### Implementation order

1. Add characterization tests around current CLI output and journal events.
2. Add explicit run IDs, immutable fingerprints, and `--resume <run-id>`.
3. Move state reads/writes into a run-scoped atomic store.
4. Add chunk leases and truthful pending/in-progress/failed/retryable states.
5. Replace fix locking with an atomic owner-token lease.
6. Extract a bounded, one-settlement process runner.
7. Make retry zero valid and wait for full process-tree exit before retry.
8. Add schema-keyword inventory and complete support for every used keyword.
9. Make JSONL corruption and experiment result shape fail clearly.
### Required checks

```bash
node --test scripts/tests/bug-hunter-state.test.cjs
node --test scripts/tests/fix-lock.test.cjs
node --test scripts/tests/run-bug-hunter.test.cjs
node --test scripts/tests/payload-guard.test.cjs
node --test scripts/tests/experiment-loop.test.cjs
pnpm test
```

**Gate 4a:** resume requires a matching run fingerprint, interrupted work is
recoverable, process trees stop within a bounded interval, locks have one
owner, and schema runtime behavior matches every published fixture.

## Wave 4b: Orchestrator extraction

This architecture wave is required for full audit closure but does not block a
safe release after Gate 4a.

Extract:

- @scripts/process-runner.cjs
- @scripts/state-store.cjs
- @scripts/artifact-planner.cjs
- @scripts/chunk-scheduler.cjs

Keep @scripts/run-bug-hunter.cjs as the CLI parser and composition root. Entry
requires the Wave 4a characterization suite to pass. Exit requires CLI output
and journal fixtures to remain byte-identical.

**Gate 4b:** the full suite passes and extraction-only comparison fixtures show
no contract change.

## Wave 5: Triage, dependency, and code-index correctness

Detailed specification:
@plans/005-coverage-dependency-and-index-correctness.md.

### Implementation order

1. Define priority as order, never silent exclusion of maintained source.
2. Fix tier sorting, low-tier inclusion, `bin` handling, and depth validation.
3. Replace every dependency command string with executable and argument arrays.
4. Return explicit scanner and reachability statuses.
5. Add versioned local output fixtures for each supported package manager.
6. Implement ecosystem-specific reachability one ecosystem at a time.
7. Add JavaScript side-effect and Python relative-import index support.
8. Update capability claims immediately when support changes.

Use deterministic fixture executables and fixture output. Do not require
network access, mutate a package manager cache, or run a real audit against an
untrusted manifest in the deterministic suite.

If @scripts/tests/triage.test.cjs or @scripts/tests/dep-scan.test.cjs does not
exist yet, add it before running this wave's checks.

### Required checks

```bash
node --test scripts/tests/triage.test.cjs
node --test scripts/tests/dep-scan.test.cjs
node --test scripts/tests/code-index.test.cjs
pnpm test
```

**Gate 5:** this repository's maintained executable sources all appear in
scope, paths remain inert, and no unsupported or failed analysis is called
clean.

## Wave 6: Installed product, CI, evals, docs, and release

Detailed specification:
@plans/006-runtime-packaging-quality-and-docs.md.

### Implementation order

1. Raise the engine floor to a currently supported Node LTS and align doctor.
2. Test the supported LTS matrix in CI.
3. Define one runtime-file allowlist for npm packing and skill installation.
4. Make installation staged, validated, atomic, stale-file-cleaning, and
   recoverable.
5. Exclude screenshots, historical plans, eval answers, and fixtures from the
   runtime package.
6. Add package inventory and size gates. Initial acceptance target:
   - packed tarball no larger than 2 MB;
   - unpacked runtime installation no larger than 5 MB.
   If a required runtime asset makes either limit impossible, stop and present
   measured inventory before changing the limit.
7. Pack and install twice into a local sandbox, including a removed managed
   file and a preserved user-owned file.
8. Move planted eval answers outside the scanned fixture and implement
   deterministic scoring.
9. Establish @skills as the canonical role source and remove runtime drift from
   @prompts through generated compatibility assets or examples.
10. Bind publication to an exact `v${package.version}` tag at HEAD and a proven
    upstream state.
11. Generate volatile documentation facts from executable sources.
12. Prepare the version and @CHANGELOG.md only after the user approves release
    preparation. Do not publish.

### Required checks

```bash
pnpm test
pnpm pack --dry-run
node bin/bug-hunter doctor
node scripts/run-bug-hunter.cjs preflight --skill-dir .
git status --short
```

CI also proves:

- supported Node versions;
- unit and integration suite;
- package inventory and size limits;
- isolated install and upgrade;
- all internal references;
- capability registry consistency;
- deterministic evaluation contracts;
- tag, HEAD, and upstream release provenance.

**Gate 6:** the installed package behaves like the repository, contains only
runtime assets, removes stale managed files safely, measures quality with
hidden answers, and cannot publish from an untagged or unproven source.

## Test design rules

1. Add regression proof before changing destructive or stateful behavior.
2. Keep tests deterministic and local. Do not use network services.
3. Use real temporary repositories and local fixture executables, not process
   state from the parent checkout.
4. Every child process receives explicit `cwd`, bounded output, and a timeout.
5. No assertion timeout exceeds five seconds. A whole test file may have a
   longer runner timeout only when process cleanup requires it.
6. Assert both result values and side effects:
   - HEAD;
   - index;
   - tracked/untracked files;
   - worktree path;
   - process descendants;
   - run state;
   - canonical artifacts.
7. After any snapshot update, read the generated snapshot back before accepting
   it.
8. The full test command must leave `git status --short` identical.

## Rollout and review strategy

Each wave gets its own review checkpoint.

| Gate | User-visible result | Safe rollback |
|---|---|---|
| 1 | Default scan cannot mutate; worktree cleanup preserves edits | Leave preserved worktrees and recovery refs in place |
| 2 | Repository text is data; Fixer cannot exceed scope | Disable fixing and keep scan-only operation |
| 3 | Stable artifacts and Referee-only fixes | Keep old artifact reader diagnostic; do not rewrite data |
| 4 | Explicit resume and reliable worker/lock behavior | Stop new runs; preserve last good run generation |
| 5 | Complete and truthful code/dependency coverage | Report unsupported instead of falling back to clean |
| 6 | Small, reproducible, source-bound package | Restore prior managed install from staging backup |

Do not combine rollback with worktree deletion, state deletion, or Git reset.
Rollback means reverting only the implementation diff the user has reviewed,
while leaving user data and recovery material intact.

## Stop conditions

Stop the current wave and report evidence if any of these happens:

- A test changes parent HEAD, the parent index, or an unrelated file.
- A cleanup or installer path cannot prove ownership of its target.
- Git preservation fails or does not return a verified recovery reference.
- Two processes both believe they own the same lock or chunk lease.
- A worker descendant survives the bounded shutdown test.
- A canonical artifact cannot be validated without guessing its shape.
- A finding is missing a stable ID needed for Referee joining.
- A Fixer diff touches an unapproved path.
- A schema keyword exists that runtime validation does not support.
- An analysis tool failure would have to be represented as clean.
- A package inventory exceeds its limit for an unexplained reason.
- A pre-existing test fails outside the current wave.

## Final end-to-end proof

After all six gates pass, perform one local release-candidate validation without
publishing:

1. Start from a recorded clean review state plus any known user-owned files.
2. Run `pnpm test`.
3. Run preflight for every advertised local capability.
4. Run a safe scan-only fixture through:
   `Recon -> Hunter -> Skeptic -> Referee -> scan report`.
5. Validate every canonical artifact with the runtime validator.
6. Prove dismissed and unreviewed findings cannot enter a fix plan.
7. Run an explicit dry-run Fixer flow and verify its immutable scope.
8. Run a real local Fixer fixture only inside a disposable nested repository,
   then prove out-of-scope edits are rejected and preserved.
9. Exercise timeout, retry-zero, resume mismatch, corrupt state, stale lock,
   missing file, and missing backend cases.
10. Run mixed-language triage, dependency, and code-index fixtures.
11. Pack the tarball, inspect every entry, and check size limits.
12. Install twice into a local sandbox and verify stale managed-file removal,
    user-file preservation, doctor, info, and preflight.
13. Run deterministic eval scoring with hidden expected answers.
14. Confirm release guard rejects missing tag, wrong tag, detached/unproven
    upstream, and dirty source.
15. Compare `git status --short` with the recorded starting state.

## Completion evidence

Completed locally on 2026-08-03 without committing or publishing:

- The full source suite passes: 167 tests, 0 failures.
- The test run preserves HEAD, the index, and the complete working-tree status.
- Generated schema validators and compatibility prompts are current.
- Doctor and local-sequential preflight pass.
- The final rebased package inventory contains 79 runtime files, is 191,501
  bytes packed and 828,706 bytes unpacked, and contains no forbidden paths.
- `pnpm pack --dry-run` passes its generated-file checks and full prepack suite.
- Atomic install, second-install upgrade, stale managed-file cleanup,
  user-file preservation, failed-install rollback, and installed-copy
  validation pass in local sandboxes.
- Deterministic eval, release-guard rejection cases, timeout, retry-zero,
  resume mismatch, corrupt state, stale lock, unsupported scanner, and
  worktree preservation cases pass.
- Baseline HEAD remains `4564ffc`; user-owned @CLAUDE.md remains untouched.

## Definition of done

The program is complete only when:

- Every row in the 40-bug table has a passing regression.
- A01-A35 are each closed by their owning wave.
- R01-R08 are each closed by their owning wave.
- BUG-33 remains documented as rejected and is not accidentally changed.
- Default use is scan-only and non-mutating.
- Only Referee-confirmed bugs can reach scoped Fixer work.
- No worktree, installer, test, or release path can delete or stage an
  unverified target.
- State, locks, artifacts, and resume identities are atomic and explicit.
- Failed or unsupported analysis is never presented as clean.
- Every advertised backend and ecosystem has executable capability proof.
- Full tests, pack checks, installed-copy checks, evals, and release guards
  pass without changing unrelated working-tree state.
- Documentation and package contents are generated from the same capability
  and inventory sources.

## Plan sources

- @plans/audit-report.md
- @plans/validation-report.md
- @plans/001-mutation-and-worktree-safety.md
- @plans/002-agent-trust-and-scope.md
- @plans/003-artifact-and-verdict-contracts.md
- @plans/004-state-process-and-schema-reliability.md
- @plans/005-coverage-dependency-and-index-correctness.md
- @plans/006-runtime-packaging-quality-and-docs.md
- @SKILL.md
- @templates/subagent-wrapper.md
- @skills
- @modes
- @schemas
- @scripts/run-bug-hunter.cjs
- @scripts/bug-hunter-state.cjs
- @scripts/worktree-harvest.cjs
- @scripts/experiment-loop.cjs
- @scripts/fix-lock.cjs
- @scripts/dep-scan.cjs
- @scripts/triage.cjs
- @scripts/code-index.cjs
- @scripts/render-report.cjs
- @scripts/payload-guard.cjs
- @bin/bug-hunter
- @package.json
- @.github/workflows/ci.yml
- @.github/workflows/publish.yml
