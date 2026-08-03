---
title: How Bug Hunter works
description: >
  Explain the adversarial pipeline, trust boundaries, execution modes, safety
  gates, and output contract.
prompt: |
  can we do that so everything is end to end seamless and anyone and
  specially agents can understand easily how to use it all properly

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

Each phase exchanges schema-validated JSON. A malformed phase result is a
failure, not a successful clean scan.

## Roles

| Role | Responsibility | Cannot authorize |
|---|---|---|
| Recon | Map the repository and scan order | Findings or fixes |
| Hunter | Make bug claims with evidence | Final verdicts or edits |
| Skeptic | Challenge Hunter claims | Final verdicts or edits |
| Referee | Decide findings from evidence | Files outside the reviewed scope |
| Fix planner | Classify and order remediation | Unapproved bug IDs |
| Fixer | Apply the approved plan | New findings, wider files, or wider ranges |

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

All delegated modes use the same dispatch contract. State includes the run ID,
target fingerprint, queue, attempts, and artifact paths so an interrupted run
does not silently resume against a different target.

## Mutation boundaries

Scan-only is the default.

Fixing requires an explicit fixing mode. The plan binds:

- approved bug IDs
- allowed files
- allowed line ranges
- remediation class
- canary and rollout stages
- required checks

The Fixer must reject work outside that scope. `--auto-commit` is a separate
permission and only permits approved paths.

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
| `recon.json` | every scan | Stack and attack-surface map |
| `hunter-findings.json` | every scan | Canonical Hunter claims |
| `skeptic.json` | findings exist | Challenges and counter-evidence |
| `referee.json` | findings exist | Final verdicts |
| `scan-report.json` | completed scan | Joined counts and verdicts |
| `report.md` | completed scan | Human-readable report |
| `coverage.json` | coverage loop | Recorded file outcomes |
| `fix-strategy.json` | planning or fixing | Remediation classes |
| `fix-plan.json` | planning or fixing | Authorized execution plan |
| `fix-report.json` | fix run | Patch and verification results |
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
