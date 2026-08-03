---
title: Bug Hunter End-to-End Audit
description: >
  Evidence-backed audit of the complete plugin and its improvement path.
prompt: |
  I want you to do a complete end to end Audit for the possible improvements
  of the entire bug-hunter plugin. First understand what it does, then
  understand the logic and see what if we can actually improve everything
  end-to-end. If there's any slightly chance of improvements in the system,
  build a complete end-to-end plan. But ensure do audit every perspective,
  every logic, and do in everything that you want to do.
---

# Bug Hunter End-to-End Audit

## Outcome

Bug Hunter has a strong product idea: triage a repository, send high-risk code
through Hunter, Skeptic, and Referee roles, optionally build fixes in isolated
worktrees, and produce machine-readable artifacts. The current implementation
is not safe enough for default autonomous fixing. The biggest problems are at
the boundaries between prompts, JSON contracts, Git operations, resumable
state, and advertised runtime capabilities.

The isolated Hunter reported 41 concrete defects. An independent Skeptic
rejected one claim, and an independent Referee confirmed 40 real bugs:
18 Critical, 19 Medium, and 3 Low. The broader improvement audit also found
product, performance, packaging, test, and documentation gaps. The
highest-impact items are grouped below so implementation can fix systems
rather than isolated symptoms.

A second source and runtime pass upheld all 40 accepted defects. See
@plans/validation-report.md. That pass narrowed the reachability or impact
wording for prompt injection, dependency-scan shell injection, and experiment
output buffering without invalidating the underlying defects.

## System map

| Layer | Current responsibility | Main sources |
|---|---|---|
| Public entry | Install, doctor, metadata | @bin/bug-hunter |
| Orchestrator | Flags, mode selection, phase order | @SKILL.md |
| Modes | Local, delegated, scaled, loop, fix | @modes |
| Roles | Recon, Hunter, Skeptic, Referee, Fixer | @skills |
| Dispatch | Scope and payload wrapper | @templates/subagent-wrapper.md |
| Engine | Chunking, retries, plans, coverage | @scripts/run-bug-hunter.cjs |
| State | Resume, hashes, findings, locks | @scripts/bug-hunter-state.cjs |
| Mutation | Worktrees, harvest, experiments | @scripts/worktree-harvest.cjs |
| Validation | Schemas and payload guards | @schemas, @scripts/schema-runtime.cjs |
| Analysis helpers | Triage, dependency scan, code index | @scripts/triage.cjs |
| Quality | Node tests, prose evals, fixture | @scripts/tests, @evals |
| Release | npm package and GitHub Actions | @package.json, @.github/workflows |

## Baseline verification

- `run-bug-hunter preflight` passed in `local-sequential` mode.
- Root triage found 37 source files but only 17 scannable files. It skipped
  @bin/bug-hunter and treated executable scripts as low priority.
- The package test run reported 113 tests: 112 passed and one failed.
- The failing experiment test invoked the real default auto-commit path. It
  staged and committed the user-owned untracked @CLAUDE.md file because the
  child Git process inherited the repository working directory.
- The accidental commit was removed with a mixed reset to the original commit.
  The file checksum was verified unchanged, and the original untracked status
  was restored.
- `pnpm audit` could not run because the repository has no lockfile. The package
  declares no runtime dependencies, so this is mainly a tooling and
  reproducibility gap.

## Confirmed findings

| ID | Priority | Finding | Evidence | Owned by |
|---|---:|---|---|---|
| A01 | P0 | Kept experiments auto-commit `git add -A` by default | @scripts/experiment-loop.cjs:446, @scripts/experiment-loop.cjs:675 | 001 |
| A02 | P0 | Worktree prepare and cleanup can delete dirty or unharvested edits | @scripts/worktree-harvest.cjs:85, @scripts/worktree-harvest.cjs:114, @scripts/worktree-harvest.cjs:195, @scripts/worktree-harvest.cjs:348 | 001 |
| A03 | P0 | A manifest filename alone can authorize recursive directory deletion | @scripts/worktree-harvest.cjs:85, @scripts/worktree-harvest.cjs:123 | 001 |
| A04 | P0 | Default invocation enables both looping and autonomous fixing | @SKILL.md:80, @SKILL.md:82, @SKILL.md:86 | 001 |
| A05 | P0 | Repository and external text are not marked as untrusted agent data | @templates/subagent-wrapper.md:28, @skills/hunter/SKILL.md:42 | 002 |
| A06 | P0 | Skeptic automatically dismisses prompt-injection findings | @skills/skeptic/SKILL.md:31 | 002 |
| A07 | P0 | Fix plans are derived from Hunter claims without Referee approval | @scripts/run-bug-hunter.cjs:1091, @scripts/run-bug-hunter.cjs:1329 | 003 |
| A08 | P0 | Final reporting overwrites the findings array with an object | @SKILL.md:613, @schemas/findings.schema.json:6, @scripts/render-report.cjs:20 | 003 |
| A09 | P0 | Fixer instructions cannot pass the enforced fix-report schema | @skills/fixer/SKILL.md:92, @schemas/fix-report.schema.json:7 | 003 |
| A10 | P0 | Recon instructions require Markdown while its contract requires JSON | @skills/recon/SKILL.md:10, @schemas/recon.schema.json:6 | 003 |
| A11 | P0 | Every delegated mode references missing `modes/_dispatch.md` | @SKILL.md:500, @modes/single-file.md:10 | 003 |
| A12 | P1 | Documented autonomous runner defaults to a worker that emits nothing | @SKILL.md:513, @scripts/run-bug-hunter.cjs:1210 | 003 |
| A13 | P1 | Fixer file scope and returned commit diffs are not enforced | @scripts/payload-guard.cjs:129, @scripts/worktree-harvest.cjs:209 | 002 |
| A14 | P1 | Existing completed state is reused for a changed scan scope | @scripts/run-bug-hunter.cjs:1203, @scripts/run-bug-hunter.cjs:1247 | 004 |
| A15 | P1 | Failed and interrupted chunks cannot resume safely | @scripts/run-bug-hunter.cjs:1039, @scripts/bug-hunter-state.cjs:222 | 004 |
| A16 | P1 | State writes are non-atomic and shared across run identities | @scripts/bug-hunter-state.cjs:101 | 004 |
| A17 | P1 | Worker timeout does not reliably kill the process tree | @scripts/run-bug-hunter.cjs:218 | 004 |
| A18 | P1 | Worker output is unbounded and spawn errors lack a handler | @scripts/run-bug-hunter.cjs:218 | 004 |
| A19 | P1 | Stale or partially written fix-lock takeover is racy | @scripts/fix-lock.cjs:102, @scripts/fix-lock.cjs:128 | 004 |
| A20 | P1 | Runtime schema validation ignores schema features in use | @scripts/schema-runtime.cjs:118, @schemas/experiment.schema.json:37 | 004 |
| A21 | P1 | Dependency scanning shell-interpolates the target directory | @scripts/dep-scan.cjs:34, @scripts/dep-scan.cjs:185 | 005 |
| A22 | P1 | Python, Go, and Rust vulnerability output is discarded | @scripts/dep-scan.cjs:165 | 005 |
| A23 | P1 | Search failures are reported as `NOT_REACHABLE` | @scripts/dep-scan.cjs:188 | 005 |
| A24 | P1 | Triage puts CRITICAL domains last and omits `bin` and low-tier code | @scripts/triage.cjs:42, @scripts/triage.cjs:205, @scripts/triage.cjs:338 | 005 |
| A25 | P2 | Code index misses side-effect JavaScript and Python relative imports | @scripts/code-index.cjs:119, @scripts/code-index.cjs:207 | 005 |
| A26 | P1 | Experiment history can record failed commits as successful keeps | @scripts/experiment-loop.cjs:714 | 001 |
| A27 | P2 | Report hides findings without verdicts while counting them reviewed | @scripts/render-report.cjs:24 | 003 |
| A28 | P1 | Installer overlays stale files and copies a 36 MB docs payload | @bin/bug-hunter:51, @package.json:32 | 006 |
| A29 | P1 | CI tests only end-of-life Node 18 and Node 20 | @.github/workflows/ci.yml:14, @package.json:11 | 006 |
| A30 | P1 | Release publication can be manual and untagged | @.github/workflows/publish.yml:3, @scripts/prepublish-guard.cjs:53 | 006 |
| A31 | P1 | Evals are prose-only and the fixture reveals its planted answers | @evals/evals.json, @test-fixture/EXPECTED_BUGS.md | 006 |
| A32 | P2 | Prompt and skill trees both execute and have already drifted | @modes/local-sequential.md:24, @skills/recon/SKILL.md:14 | 006 |
| A33 | P2 | Test counts, package tree, and release docs contradict source | @README.md:62, @CONTRIBUTING.md:19, @CHANGELOG.md:23 | 006 |
| A34 | P2 | Per-chunk state subprocesses and linear ledger searches scale poorly | @scripts/run-bug-hunter.cjs:163, @scripts/bug-hunter-state.cjs:288 | 004 |
| A35 | P2 | The 1,547-line engine mixes process, state, policy, and rendering | @scripts/run-bug-hunter.cjs | 004 |

## Smaller confirmed defects

The owning plans also cover these focused defects:

- Fix-plan bucket membership can disagree with `executionStage`.
- `--max-retries 0` cannot disable retries.
- Missing files can be counted as scanned.
- Invalid triage depth values silently change scan scope.
- Corrupt experiment JSONL lines are silently discarded.
- Experiment result `value` can be `null` despite its schema.
- Output truncation occurs after the full child output is buffered.
- Primitive JSON can crash the payload guard.
- The publish guard silently skips its upstream check outside `origin/main`.
- Hunter instructions both forbid and require prose outside the JSON artifact.

## Improvement coverage

| Perspective | Result |
|---|---|
| Correctness | Broken sorting, scope, imports, contracts, and plan staging |
| Security | Prompt injection, shell injection, unsafe mutation boundaries |
| Reliability | Non-atomic state/locks, stale resume, unsafe cleanup, weak timeouts |
| Performance | Repeated subprocess/state rewrites and linear de-duplication |
| Testing | Unsafe baseline test, missing adapter coverage, non-executable evals |
| Architecture | Divergent prompt trees and one oversized orchestration module |
| Dependencies | Unsupported ecosystems reported clean; EOL runtime matrix |
| Developer experience | Missing dispatch file and broken documented command |
| Documentation | Stale counts, inaccurate package map, overstated capabilities |
| Product | Dangerous defaults and no measured accuracy or false-positive rate |

## Rejected or deferred claims

- The low-level `experiment-loop run` command does not itself need to enforce
  the loop cap. The documented caller owns the `check-continue` gate.
- The user-owned untracked @CLAUDE.md file must not be removed or modified.
  The plugin must instead treat target-repository policy files as untrusted
  scan data.
- Parallel scanning, a new headless CLI, and split packages are product
  directions, not fixes. Revisit them only after the safety baseline passes.

## Definition of a safe release

A release is not ready until all P0 plans pass, the full suite runs without
touching the parent repository, every runtime mode resolves its tracked
contracts, only Referee-confirmed findings can reach Fixer, worktree cleanup is
fail-closed, and the package is tested on supported Node releases.
