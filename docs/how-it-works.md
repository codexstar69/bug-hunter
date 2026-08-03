---
title: How Bug Hunter works
description: >
  Explain the adversarial pipeline, trust boundaries, execution modes, safety
  gates, and output contract.
prompt: |
  can we do that so everything is end to end seamless and anyone and
  specially agents can understand easily how to use it all properly

  you removed a lot of content that helped rank it om google - bring it back

  Use @SKILL.md, @modes/dispatch.md, @modes/fix-pipeline.md,
  @schemas/scan-report.schema.json, @schemas/fix-plan.schema.json,
  @schemas/fixer-scope.schema.json, @scripts/dep-scan.cjs, and
  @scripts/worktree-harvest.cjs as source material.
---

# How Bug Hunter works

## Pipeline

1. Triage classifies files by risk without using an AI model.
2. Recon maps the stack, boundaries, entry points, and high-risk paths.
3. Hunter reads code and records evidence-backed findings.
4. Documentation lookup checks version-sensitive library claims when
   documentation is available.
5. Skeptic attempts to disprove every finding.
6. Referee re-reads the evidence and issues the final verdict.
7. The report separates confirmed, dismissed, manual-review, and unreviewed
   results.
8. An optional strategy and fix plan classify safe and unsafe remediation.
9. An optional Fixer applies only authorized changes and runs verification.

Role, report, coverage, and fix phases exchange schema-validated JSON. Triage
JSON is deterministic pipeline input. A malformed required canonical artifact
is a failure, not a successful clean scan.

## Roles

| Role | Responsibility | Cannot authorize |
|---|---|---|
| Recon | Map the repository and scan order | Findings or fixes |
| Hunter | Make bug claims with evidence | Final verdicts or edits |
| Skeptic | Challenge Hunter claims | Final verdicts or edits |
| Referee | Decide findings from evidence | Files outside the reviewed scope |
| Fix planner | Classify and order remediation | Unapproved bug IDs |
| Fixer | Apply the approved plan | New findings or wider files |

The Referee-only verdict boundary prevents the agent that found a bug from
declaring its own claim confirmed.

## Execution modes

Bug Hunter selects an execution mode from repository size, available agent
features, and requested scope:

- single-file for one file
- small for a small file set
- parallel or extended for bounded multi-agent work
- scaled for chunked work with persisted state
- large-codebase for domain-scoped execution
- local-sequential when subagents are unavailable

Most delegated modes use the canonical dispatch contract. Large-codebase mode
currently uses per-domain variants before its final merge. State records queue
and chunk progress; a sibling identity file stores run and target identity so
an interrupted run does not silently resume against a different target.

## Mutation boundaries

Scan-only is the default.

Fixing requires an explicit fixing mode. The plan records:

- approved bug IDs
- allowed files
- claimed line ranges for review context
- remediation class
- canary and rollout stages
The validated Fixer scope binds repository root, base commit, bug IDs, and file
paths before dispatch. It does not independently prove line-range or committed
path compliance after a patch. `--auto-commit` is a separate permission.

Worktree-based fixing uses verified worktree identity and a fresh preservation
check before cleanup. If safe removal cannot be proven, cleanup stops and
leaves the worktree for recovery.

## Dependency scanning

`--deps` detects npm, pnpm, Yarn, and Bun lockfiles for JavaScript and
TypeScript projects. It records audit status and reachability evidence.

Python, Go, and Rust manifests may be detected, but their parsers and
reachability fixtures are not implemented. Those ecosystems return
`scanner-unsupported`. They are not reported as clean.

## Output contract

Artifacts live in `.bug-hunter/`.

| File | Generated when | Meaning |
|---|---|---|
| `triage.json` | every scan | Risk map and selected strategy |
| `recon.json` | multi-file scan | Prioritized risk tiers and Recon notes |
| `hunter-findings.json` | every scan | Canonical Hunter claims |
| `skeptic.json` | findings exist | Challenges and counter-evidence |
| `referee.json` | findings exist | Final verdicts |
| `scan-report.json` | completed scan | Joined counts and verdicts |
| `report.md` | completed scan | Human-readable report |
| `coverage.json` | coverage loop | Per-file entries derived from chunk progress |
| `fix-strategy.json` | planning or fixing | Remediation classes |
| `fix-plan.json` | planning or fixing | Authorized execution plan |
| `fix-report.json` | fix run | Verification and final-status results |
| `threat-model.md` | threat-model run | STRIDE boundaries and flows |
| `dep-findings.json` | dependency run | Supported audit results |

Rendered Markdown files are views. JSON files are the canonical automation
contracts.

## Result meanings

- `confirmed` means the Referee accepted the finding.
- `dismissed` means the evidence disproved the finding.
- `manual-review` means the system did not authorize automatic remediation.
- `unreviewed` means adversarial review did not complete.
- `scanner-unsupported` means the requested scanner does not support that
  ecosystem.

Only a completed report with no confirmed, manual-review, or unreviewed items
can support a clean result for the scanned scope.

## Documentation verification

Context Hub is the primary optional documentation source. The bundled
Context7 path is the fallback. Missing documentation lowers the strength of a
version-sensitive claim; it does not authorize guessing.

## Security classification

Security findings can include:

- STRIDE category
- CWE identifier
- CVSS 3.1 vector and score
- reachability evidence
- runtime trigger
- proof-of-concept description

These fields add context. They do not replace the Referee verdict.
