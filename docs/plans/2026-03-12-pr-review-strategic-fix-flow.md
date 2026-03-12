# PR Review + Strategic Fix Flow

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must stay current as work lands.

## Purpose / Big Picture

Bug Hunter already has the ingredients for branch-diff review and safe fix execution, but two user-facing workflows are still underpowered:

1. **Review a recent PR directly** without requiring the user to manually map a PR to a branch/base diff.
2. **Plan fixes strategically before editing code** so the tool can distinguish safe autofixes from larger remediation work.

After this change, Bug Hunter should support a first-class PR review flow and a first-class fix-strategy flow. A user should be able to run a PR-focused review against the current, recent, or numbered PR, and the tool should produce PR-specific metadata plus a focused review artifact. When bugs are confirmed, the tool should create a machine-readable fix strategy before the fixer phase starts, making the plan visible and auditable.

## Progress

- [x] (2026-03-12 06:58Z) Audit the current codebase to confirm existing branch-diff support, fix-plan behavior, and the lack of first-class PR and strategy flows.
- [x] (2026-03-12 07:23Z) Add `scripts/pr-scope.cjs` plus tests covering `current`, `recent`, explicit numbered PR failure behavior, and git fallback for current-branch review.
- [x] (2026-03-12 07:24Z) Extend `README.md` and `SKILL.md` with first-class PR-review flags and `--plan-only` strategy-first usage.
- [x] (2026-03-12 07:26Z) Add canonical `fix-strategy` schema/runtime support plus Markdown rendering.
- [x] (2026-03-12 07:28Z) Generate `fix-strategy.json` and `fix-strategy.md` from `scripts/run-bug-hunter.cjs` before fix execution.
- [x] (2026-03-12 07:30Z) Update fix pipeline docs and fixer prompt language so strategy is explicit before patching.
- [x] (2026-03-12 07:33Z) Run `node --test scripts/tests/*.test.cjs` successfully (39/39 passing).

## Surprises & Discoveries

- Observation: branch-diff review is already documented and partially supported, but it is branch-centric rather than PR-centric.
  Evidence: `README.md` and `SKILL.md` support `-b <branch>` and `--staged`, but there is no `--pr` or `--review-pr` workflow.

- Observation: the documented fix pipeline is more strategic than the current code-level planner.
  Evidence: `modes/fix-pipeline.md` describes dependency ordering, canary rollout, and circuit breaking, while `scripts/run-bug-hunter.cjs` currently builds a fix plan mostly from confidence/severity sorting plus canary slicing.

- Observation: the packaged skill copy is not a git checkout.
  Evidence: `git status` fails in the working directory, so Ralph-loop safety assumptions about git history do not fully apply here.

## Decision Log

- Decision: implement PR review as a helper-script-driven scope resolver instead of encoding GitHub logic directly into `SKILL.md` prose.
  Rationale: the resolver is testable, reusable from docs/prompt flows, and lets the prompt stay focused on behavior rather than shell branching.
  Date/Author: 2026-03-12 / Codex

- Decision: represent strategy as a canonical JSON artifact (`fix-strategy.json`) alongside the existing fix plan.
  Rationale: strategy needs to be inspectable and machine-validated, not embedded as prose in reports.
  Date/Author: 2026-03-12 / Codex

- Decision: keep the existing fix plan artifact, but enrich the pipeline with a prior strategy artifact rather than replacing the whole fix planner.
  Rationale: this minimizes risk and preserves the existing verification/test harness.
  Date/Author: 2026-03-12 / Codex

## Outcomes & Retrospective

This implementation landed the intended end-to-end flow. Bug Hunter now has a reusable PR scope resolver (`scripts/pr-scope.cjs`) that turns `current`, `recent`, or explicit PR references into normalized file scope, with a safe git fallback for current-branch review when GitHub metadata is unavailable. The core orchestrator now emits `fix-strategy.json` and `fix-strategy.md` before fix execution, giving users a visible strategy layer ahead of the existing fix plan.

The work stayed low-risk because it extended existing artifacts rather than replacing them. `fix-plan.json` still drives rollout/canary handling, while `fix-strategy.json` adds the missing classification layer for safe autofix vs manual review vs larger remediation. The full automated test suite passed after the changes.

## Context and Orientation

Relevant files for this effort:
- `SKILL.md` — user-facing orchestration instructions and argument parsing behavior.
- `README.md` — public product surface and examples.
- `scripts/run-bug-hunter.cjs` — orchestrator and fix-plan generation.
- `scripts/render-report.cjs` — human-readable report rendering from canonical JSON.
- `scripts/payload-guard.cjs` and `scripts/schema-runtime.cjs` — schema/runtime plumbing.
- `modes/fix-pipeline.md` — documented fix flow.
- `scripts/tests/run-bug-hunter.test.cjs` — orchestration safety net.

## Plan of Work

### Milestone 1: PR review scope resolution
Create a helper script that resolves PR input into a normalized review scope. It should support `current`, `recent`, and numeric PR references. When GitHub CLI metadata is available, it should return PR number, title, head branch, base branch, and changed files. When GitHub CLI is unavailable but the request targets the current branch, it should fall back to git-based branch diff metadata where possible.

### Milestone 2: Strategy artifact generation
Add a canonical `fix-strategy` artifact that groups confirmed bugs into execution-oriented clusters and classifies them as safe autofix, manual review, larger refactor, or architectural remediation. Generate this artifact inside the orchestrator after findings have been normalized and before fix execution.

### Milestone 3: Prompt and documentation alignment
Update `SKILL.md`, `README.md`, and fix-pipeline docs so the new flows are explicit: PR review is first-class, and fix execution is preceded by an explicit strategy phase.

### Milestone 4: Validation
Add tests for PR scope resolution and orchestrator strategy generation. Run the existing test suite to guard against regressions.
