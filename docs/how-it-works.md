---
title: How Bug Hunter works
description: >
  Explain the adversarial pipeline, adaptive execution, trust boundaries,
  safety gates, verification, and canonical output contracts.
prompt: |
  Explain Bug Hunter's current precision-first architecture from deterministic
  scope through adversarial verdicts, optional verification, and explicitly
  authorized remediation. Distinguish canonical JSON from rendered views.
---

# How Bug Hunter works

Bug Hunter separates **scope**, **evidence**, **verdicts**, and **mutation
authority**. The design goal is verified bug yield under explicit token, time,
and safety budgets—not the largest possible list of suspicious code.

## Pipeline

1. **Triage** classifies source files by risk without using an AI model and
   preserves risk order.
2. **Adaptive planning** can choose `fast`, `balanced`, or `assurance` behavior
   from deterministic risk and available benchmark evidence. Explicit caller
   limits always win.
3. **Recon** maps stack, entry points, trust boundaries, and high-risk paths.
4. **Retrieval planning** ranks direct evidence, symbols, cross-references,
   dependencies, dependents, and trust-boundary context under hard budgets.
5. **Hunter** reads assigned source and records evidence-backed findings.
6. **Documentation lookup** checks version-sensitive framework/library claims.
7. **Skeptic** attempts to disprove every finding.
8. **Referee** re-reads the evidence and owns the final verdict.
9. **Hybrid verification** optionally runs bounded tests, type checks, static
   checks, builds, reproductions, fuzzing, or security-static checks. Required
   verification fails closed before Fixer authorization.
10. **Report join** separates confirmed, dismissed, manual-review, and
    unreviewed results.
11. **Fix strategy and plan** classify confirmed findings and create an
    executable queue only for eligible remediation.
12. **Fixer** runs only with explicit mutation authority and immutable scope,
    followed by verification and rollback reporting.

A malformed or missing required canonical artifact is a failed phase, not a
successful clean scan.

## Roles and authority

| Role | Responsibility | Cannot authorize |
|---|---|---|
| Recon | Map architecture and trust boundaries | Findings or fixes |
| Hunter | Make concrete bug claims with evidence | Its own final verdict or edits |
| Skeptic | Challenge Hunter claims | Final verdicts or edits |
| Referee | Decide findings from evidence | Mutation outside validated remediation scope |
| Fix planner | Classify and order confirmed remediation | Non-confirmed or non-executable findings |
| Fixer | Apply an approved immutable plan | New findings, new files, or commit permission |

The Referee-only verdict boundary prevents the agent that discovered a bug from
declaring its own claim confirmed.

## Execution profiles and modes

### Adaptive profiles

When adaptive planning is used, `.bug-hunter/adaptive-plan.json` records the
bounded policy:

- **fast** — narrow retrieval and low-latency review for small/low-risk work;
- **balanced** — general-purpose Pareto point;
- **assurance** — deeper retrieval, review, and verification for release,
  security, or high-risk audits;
- **auto** — choose among those profiles from risk density, repository size,
  security intent, precision/recall, calibration, stability, and token
  efficiency.

Adaptive values are defaults, not permissions. They cannot expand caller scope,
override explicit token/chunk settings, or grant mutation authority.

### Repository execution modes

Bug Hunter also selects an orchestration mode from repository size, available
agent features, and requested scope:

- single-file for one file;
- small for a small source set;
- parallel or extended for bounded multi-agent/chunked work;
- scaled for persisted chunk state and resume;
- large-codebase for domain-scoped execution;
- local-sequential when delegation backends are unavailable.

Delegated modes use [`modes/dispatch.md`](../modes/dispatch.md). State records
queue/chunk progress and run identity so resume cannot silently attach to a
different target or changed baseline.

## Token-bounded context

Bug Hunter treats context as an evidence budget. Adaptive chunks are built from
the combined estimated tokens of the actual assigned files, preserving risk
order. Mixed chunks should stay within the configured source-token budget; a
single oversized file is isolated and explicitly marked.

Retrieval then admits optional graph/symbol context only while its own hard file
and token limits remain. Direct evidence and unresolved high-impact hypotheses
come first.

See [precision protocol](precision-protocol.md) for the fail-closed evidence
rules and [world-class protocol](world-class-protocol.md) for the measurable
adaptive design.

## Source and evidence integrity

Assigned source is canonicalized through real paths and must remain inside the
repository. The runner records source hashes before dispatch and rechecks them
before accepting findings/completion state.

The following fail the affected chunk closed:

- an assigned file disappears;
- source content changes during worker execution;
- source becomes unreadable;
- a symlink resolves outside the repository;
- a worker reports a finding for an unassigned file;
- required artifact validation fails.

Resume keeps the original source baseline. Changed content cannot silently
become the new evidence identity for an interrupted run.

Coverage is derived from per-file evidence rather than trusting only a parent
chunk status.

## Exact evidence reuse

The content-addressed evidence cache keys reusable fact context to protocol
identity, role, relevant options, hypothesis identity, and exact source hashes.
A cache hit is a hint, never a verdict. Current source integrity is still
verified before any result is committed.

## Hybrid verification

`hybrid-verifier.cjs` executes verification commands as inert argv arrays with
`shell: false`, repository containment, ambient-secret stripping, sensitive-env
rejection, output redaction, per-command timeouts, and a total time budget.

A verification plan can include tests, type checks, static analysis, builds,
reproduction commands, fuzzing, or security-static checks. Required check
failure or unavailability prevents Fixer authorization. A passing check is
supporting evidence; it does not prove the absence of unrelated bugs.

## Mutation boundaries

Scan-only and single-pass are the defaults. `--loop` requests complete queued
coverage; it does not grant edit permission.

Fixing requires an explicit mutation mode. The plan records:

- approved bug IDs;
- allowed files;
- claimed line ranges for review context;
- remediation class;
- canary and rollout stages.

Only executable plan entries become `.bug-hunter/fixer-scope.json`. Findings
classified `manual-review`, `larger-refactor`, `architectural-remediation`, or
report-only never become writable Fixer authorization.

The validated Fixer scope binds repository root, base commit, bug IDs, and file
paths before dispatch. `--auto-commit` remains a separate permission.

Worktree-based fixing uses verified worktree identity and fresh preservation
checks. If safe cleanup cannot be proven, the worktree is left intact for
recovery.

## Dependency scanning

`--deps` detects npm, pnpm, Yarn, and Bun lockfiles for JavaScript and
TypeScript projects and records audit/reachability evidence.

Other ecosystems may be detected but are reported `scanner-unsupported` when a
parser/reachability implementation is unavailable. Unsupported does not mean
clean.

## Output contract

Artifacts live in `.bug-hunter/`.

| File | Generated when | Meaning |
|---|---|---|
| `triage.json` | scan setup | Deterministic risk map, scan order, budget inputs |
| `adaptive-plan.json` | adaptive planning | Context/reviewer/verification/early-stop policy |
| `recon.json` | multi-file scan | Stack, attack surface, trust-boundary context |
| `retrieval-plan.json` | indexed/retrieval run | Hypothesis-ranked evidence under hard budgets |
| `hunter-findings.json` | scan | Canonical Hunter claims |
| `skeptic.json` | findings exist | Challenges and counter-evidence |
| `referee.json` | findings exist | Final verdicts |
| `verification-report.json` | hybrid verification | Check results and required-check state |
| `scan-report.json` | completed scan | Joined counts and verdicts |
| `report.md` | completed scan | Human-readable final report |
| `coverage.json` | loop/persisted scan | Per-file coverage state |
| `fix-strategy.json` | planning/fixing | Remediation classifications |
| `fix-plan.json` | planning/fixing | Canary and rollout plan |
| `fixer-scope.json` | fixing | Immutable mutation boundary |
| `fix-report.json` | fix run | Patch, verification, rollback, final statuses |
| `threat-model.md` | threat-model run | STRIDE boundaries, assets, and flows |
| `dep-findings.json` | dependency run | Supported audit/reachability evidence |
| `benchmark-report.json` | benchmark gate | Precision/recall/calibration/stability/cost/latency metrics |

JSON files are canonical automation contracts. Markdown files are rendered or
explanatory views.

## Result meanings

- `confirmed` — Referee accepted the finding;
- `dismissed` — available evidence disproved the finding;
- `manual-review` — human decision or wider remediation remains;
- `unreviewed` — adversarial review did not complete;
- `scanner-unsupported` — the requested dependency scanner is unavailable for
  that ecosystem.

Do not claim a clean requested scope while confirmed bugs, unresolved review,
failed coverage, or required-verification failure remains.

## Documentation verification

Context Hub is the primary optional documentation source. The bundled Context7
path is the fallback. Missing docs lower the strength of version-sensitive
claims; they do not authorize guessing.

## Security classification

Security findings can carry STRIDE category and CWE directly, with Referee
narrative/evidence for reachability, exploitability, CVSS 3.1, and benign proof
of concept when applicable. Classification adds context; it does not replace
runtime evidence or the Referee verdict.

## Measuring quality

`pnpm quality:world-class` validates generated assets, the Node test suite, the
benchmark quality gate, preflight, and package inventory.

The bundled benchmark fixture proves the measurement machinery and regression
contract. It is not independent evidence that Bug Hunter is universally best.
External comparisons should use unseen repositories, blinded labels, repeated
runs, disclosed model/runtime versions, and comparable baselines.
