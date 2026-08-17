---
title: Bug Hunter
description: >
  Install and use the measurable adversarial code-audit skill with scan-only
  defaults and explicit permission before source edits.
prompt: |
  Explain and use the current Bug Hunter protocol accurately. Keep scan-only
  and single-pass defaults unless the user explicitly requests loop coverage or
  mutation. Prefer canonical JSON artifacts, evidence-backed adversarial review,
  bounded adaptive/retrieval context, and fail-closed verification.
---

<p align="center">
  <img src="https://raw.githubusercontent.com/codexstar69/bug-hunter/183e0a957bd22ea5df83741cd31e396f68b14ae5/docs/images/hero.png" alt="Bug Hunter pipeline: triage, recon, Hunter, Skeptic, Referee, Fixer, and verification" width="720">
</p>

<h1 align="center">Bug Hunter</h1>
<p align="center"><strong>Adversarial code auditing for AI coding agents.</strong></p>
<p align="center">
  <a href="https://www.npmjs.com/package/@codexstar/bug-hunter"><img src="https://img.shields.io/npm/v/@codexstar/bug-hunter" alt="npm version"></a>
  <a href="https://github.com/codexstar69/bug-hunter/actions/workflows/ci.yml"><img src="https://github.com/codexstar69/bug-hunter/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/codexstar69/bug-hunter/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@codexstar/bug-hunter" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-blue" alt="Node.js 22 or newer">
</p>

Bug Hunter is an AI-agent skill for code review and security auditing. A Hunter finds possible bugs, a Skeptic challenges each claim, and a Referee decides what the evidence supports. The default run only scans and reports. It is single-pass unless `--loop` is explicitly requested. Editing, autonomous fixing, and commits each require explicit permission.

## v3.2.0 source — measurable, adaptive bug hunting

The current v3.2.0 source makes the precision-first pipeline measurable and adaptive while preserving the scan-only default and fail-closed safety boundaries. The latest published npm release may lag GitHub `main`; use the current-source command below when you need the exact implementation documented on this page.

- **Measurable benchmark quality gate** scores one-to-one finding matches, precision, recall, F1, severity-weighted recall, false positives per KLOC, calibration, repeat stability, token usage, latency, and cost data when supplied.
- **Adaptive execution profiles** select `fast`, `balanced`, or `assurance` behavior from triage risk, security scope, benchmark evidence, stability, calibration, and token efficiency.
- **Hybrid verification** safely runs argv-only tests, type checks, static checks, fuzz checks, and security-static checks, and fails closed when required verification fails or is unavailable.
- **Exact evidence caching** reuses evidence only when source content, protocol identity, role, and relevant configuration match exactly; changed source cannot inherit stale conclusions.
- **Hypothesis-driven retrieval** prioritizes direct files, symbols, dependencies, dependents, cross-references, and trust boundaries under hard context budgets.
- **Stronger source integrity** keeps scan scope, source hashes, resume identity, coverage state, and Fixer authorization explicit and rejects source drift.
- **Permanent CI quality gates** verify Node.js 22 and 24; the Node.js 24 lane also runs the benchmark quality gate and package inventory verification.
- **Bundled security workflows** cover PR-focused security review, full repository security review, STRIDE threat modeling, vulnerability validation, and supported dependency CVE scanning.

The bundled deterministic regression fixture currently records precision `1.00`, recall `1.00`, F1 `1.00`, repeat stability `1.00`, zero false positives, median `12,090` tokens per true positive, p95 duration `61.3s`, and expected calibration error about `0.048`. These figures validate the bundled harness and fixture; they are not an independent benchmark of every repository or model.

See [the measurable world-class protocol](docs/world-class-protocol.md) for the full architecture, artifact contracts, quality thresholds, and verification design.

## TL;DR

Install the exact current GitHub source documented here. Replace `codex` with a target from the table below.

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent codex
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

For the latest published npm release—which may lag current GitHub source—use:

```bash
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter install --agent codex
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter doctor --agent codex
```

Restart the agent if it was open during installation. Then send this prompt from the repository you want to audit:

```text
Use the bug-hunter skill to scan this repository. Do not edit files.
Return the final report and call out every item that needs manual review.
```

That is the recommended first run. It is scan-only and single-pass. Request `--loop` when complete queued coverage is required.

## Choose your agent

| Agent | Install target |
|---|---|
| Claude Code | `claude-code` |
| Codex | `codex` |
| Cursor | `cursor` |
| GitHub Copilot | `copilot` |
| Kiro | `kiro` |
| Windsurf | `windsurf` |
| OpenCode | `opencode` |
| Factory Droid CLI | `droid` |
| Other file-based agents | `agents` |

Always pass `--agent` when more than one coding agent is installed. Auto-detection is available, but an explicit target prevents installation into the wrong skill directory.

Factory Droid CLI (`droid`) installs into `~/.factory/skills/bug-hunter` and loads the skill for every repository. Use `--path "$PWD/.factory/skills/bug-hunter"` instead when the skill should be checked into a single repository. Droid also reads the legacy `~/.agents/skills` location, so an existing `--agent agents` install already works there.

See [agent installation](docs/agent-installation.md) for paths, source installs, updates, removal, and custom targets.

## Use it with any agent

Natural language is the portable interface:

```text
Use the bug-hunter skill to scan src/auth. Do not edit files.
```

Agents that expose skill commands may also accept:

```text
/bug-hunter src/auth
```

For a reviewed fix run:

```text
Use the bug-hunter skill to scan this repository. Build a fix plan.
Ask for approval before every edit. Do not commit.
```

The closest flag-based mode is:

```text
/bug-hunter --fix --approve
```

`--approve` requests the host agent's reviewed/default permission mode. The
host decides when approval prompts appear. Use `--plan` or `--preview` when
source edits must be impossible.

For a plan without edits:

```text
/bug-hunter --plan
```

Do not use `--autonomous` or `--auto-commit` unless you intend to grant those permissions.

See [usage guide](docs/usage-guide.md) for common human and agent prompts.

## What happens during a scan

```text
your code
  -> risk triage
  -> optional adaptive plan
  -> architecture recon
  -> hypothesis-driven retrieval
  -> Hunter findings
  -> documentation checks
  -> Skeptic challenges
  -> Referee verdicts
  -> optional hybrid verification
  -> report
  -> optional approved fix plan
  -> optional approved fixes and verification
```

The pipeline:

- prioritizes high-risk files before lower-risk files
- keeps adaptive/retrieval context within explicit file and token budgets
- records claims with file evidence and runtime triggers
- checks version-sensitive behavior against available documentation
- challenges findings before reporting them as confirmed
- separates confirmed, dismissed, unreviewed, and manual-review results
- validates canonical JSON artifacts between phases
- fails closed on assigned-source drift and required verification failure
- keeps source edits disabled unless fixing is requested

Read [how it works](docs/how-it-works.md) for the full model and safety boundaries.

## Common workflows

| Goal | Skill request |
|---|---|
| Scan the whole repository once | `/bug-hunter` |
| Complete queued coverage | `/bug-hunter --loop` |
| Scan one path | `/bug-hunter src/auth` |
| Review staged changes | `/bug-hunter --staged` |
| Review the current pull request | `/bug-hunter --pr` |
| Run a pull-request security review | `/bug-hunter --pr-security` |
| Add Node.js dependency scanning | `/bug-hunter --deps` |
| Generate a STRIDE threat model | `/bug-hunter --threat-model` |
| Create a fix plan without edits | `/bug-hunter --plan` |
| Request host-interactive fixing | `/bug-hunter --fix --approve` |
| Build a no-edit remediation preview | `/bug-hunter --preview` |
| Allow unattended fixing | `/bug-hunter --autonomous` |

The executable `bug-hunter` command installs and verifies the skill. Scans are started through your coding agent, not by running `bug-hunter scan` in a shell.

See [CLI reference](docs/cli-reference.md) for installer commands and skill arguments.

## Security skill routing

The security flags use bundled local skills:

- PR-focused security review routes into `commit-security-scan` through
  `--pr-security`.
- `--threat-model` routes into `threat-model-generation`.
- enterprise/full security review routes into `security-review` through
  `--security-review`.
- `--validate-security` routes into `vulnerability-validation`.

These skills are part of the managed runtime. They do not require separate
installation.

<p align="center">
  <img src="https://raw.githubusercontent.com/codexstar69/bug-hunter/183e0a957bd22ea5df83741cd31e396f68b14ae5/docs/images/2026-03-12-security-pack.png" alt="Bundled Bug Hunter security skills for pull-request scanning, repository security review, STRIDE threat modeling, and vulnerability validation" width="100%">
</p>

## Complete product guide

- [Why adversarial AI code review](#why-adversarial-ai-code-review)
- [How the code-audit pipeline works](#how-the-code-audit-pipeline-works)
- [Hunter, Skeptic, and Referee](#hunter-skeptic-and-referee)
- [Core code-analysis capabilities](#core-code-analysis-capabilities)
- [Security vulnerability classification](#security-vulnerability-classification)
- [STRIDE threat modeling](#stride-threat-modeling)
- [Dependency CVE scanning](#dependency-cve-scanning)
- [Pull-request and changed-code review](#pull-request-and-changed-code-review)
- [Strategic fix planning and safe remediation](#strategic-fix-planning-and-safe-remediation)
- [Structured JSON for CI/CD](#structured-json-for-cicd)
- [Output files](#output-files)
- [Supported languages and frameworks](#supported-languages-and-frameworks)
- [Skill argument reference](#skill-argument-reference)
- [Project architecture](#project-architecture)

## Why adversarial AI code review

Many AI code-review tools produce a long list of possible issues but leave the
developer to discover which claims are real. A plausible explanation is not
proof that a runtime bug is reachable. Framework behavior, middleware,
validation in another file, and language guarantees can turn an alarming
finding into a false positive.

Bug Hunter treats a finding as a claim that must survive opposition:

1. The Hunter explains the exact runtime failure, source evidence, trigger,
   severity, and cross-file dependencies.
2. The Skeptic tries to disprove the claim by tracing the same code and checking
   protections the Hunter may have missed.
3. The Referee compares both sides, independently checks the strongest or most
   serious claims, and issues the final verdict.

For teams comparing an AI code-review tool, security code scanner,
vulnerability scanner, or static-analysis assistant, this separation matters:
automated code review stays useful only when the evidence and uncertainty are
visible.

This adversarial code review is designed to reduce false-positive overload
without hiding uncertainty. Results that cannot be settled become
`MANUAL_REVIEW` or `unreviewed`; they are not silently presented as clean.

The system focuses on behavioral correctness and security. It is not a style
linter. Naming preferences, formatting, unused code, missing comments, and
general refactoring suggestions are outside the Hunter's reporting scope unless
they create a reachable runtime problem.

## How the code-audit pipeline works

<p align="center">
  <img src="https://raw.githubusercontent.com/codexstar69/bug-hunter/183e0a957bd22ea5df83741cd31e396f68b14ae5/docs/images/pipeline-overview.png" alt="Bug Hunter adversarial code-audit pipeline from deterministic triage through Hunter, Skeptic, Referee, reporting, optional fix planning, and verification" width="100%">
</p>

Every phase has a separate job. Role, report, coverage, fix, adaptive, retrieval, verification, and benchmark artifacts use schema-validated JSON; triage JSON is deterministic pipeline input.

| Stage | What it does | Main evidence |
|---|---|---|
| Risk triage | Classifies source files and selects risk-ordered scan scope without an AI model | `triage.json` |
| Adaptive policy | Chooses bounded `fast`, `balanced`, or `assurance` context/review/verification policy when requested or supplied | `adaptive-plan.json` |
| Recon | Adds stack, architecture, and trust-boundary context for multi-file scans | `recon.json` |
| Retrieval planning | Selects hypothesis-relevant mandatory and optional evidence under hard budgets | `retrieval-plan.json` |
| Hunter | Finds reachable logic, security, concurrency, data, and error-path bugs | `hunter-findings.json` |
| Documentation lookup | Checks version-sensitive library or framework assumptions | Evidence added to the finding or challenge |
| Skeptic | Tries to disprove every Hunter claim with code and counter-evidence | `skeptic.json` |
| Referee | Delivers `REAL_BUG`, `NOT_A_BUG`, or `MANUAL_REVIEW` verdicts | `referee.json` |
| Hybrid verification | Runs bounded tests, type/static/build/reproduction/fuzz/security-static checks when configured | `verification-report.json` |
| Report join | Separates confirmed, dismissed, manual-review, and unreviewed results | `scan-report.json` and `report.md` |
| Fix strategy | Classifies confirmed bugs by remediation risk | `fix-strategy.json` |
| Fix plan | Records bug details, files, claimed ranges, remediation class, and rollout order | `fix-plan.json` |
| Fix and verify | Applies only authorized work and records checks or rollback results | `fix-report.json` |

A malformed or missing required canonical artifact is a failed phase, not
evidence of a clean scan. For schema-backed phases, JSON is the source of truth;
Markdown reports are readable views of those contracts.

Bug Hunter adjusts execution to the repository and the agent runtime. A
single-file scan stays small. Larger scans may use bounded parallel,
chunked, persisted-state, domain-scoped, or local-sequential modes. Most
delegated modes use the canonical role artifacts. Large-codebase mode currently
uses per-domain variants before its final merge.

## Hunter, Skeptic, and Referee

<p align="center">
  <img src="https://raw.githubusercontent.com/codexstar69/bug-hunter/183e0a957bd22ea5df83741cd31e396f68b14ae5/docs/images/adversarial-debate.png" alt="Hunter reports evidence-backed bugs, Skeptic challenges them, and Referee decides the final code-review verdict" width="100%">
</p>

The roles are deliberately separated:

| Role | Responsibility | What it cannot decide |
|---|---|---|
| Recon | Understand architecture and prioritize risk | Whether a bug is confirmed |
| Hunter | Make a concrete bug claim | Its own final verdict |
| Skeptic | Challenge the claim and expose missing context | The final verdict |
| Referee | Judge the claim from evidence | Permission to edit unrelated code |
| Fix planner | Turn confirmed verdicts into bounded remediation work | Permission outside approved bug IDs |
| Fixer | Apply an approved plan | New scope, new findings, or commit permission |

The incentive model favors evidence over volume:

| Agent | Positive signal | Cost of a weak decision |
|---|---|---|
| Hunter | Real findings earn severity-weighted value | Every false positive loses points |
| Skeptic | Correctly disproving noise earns the finding's value | Wrongly dismissing a real bug costs twice its value |
| Referee | Independent, evidence-backed verdicts | Unsupported trust in either side fails review |

The Skeptic also has 14 hard exclusions for recurring non-bugs such as findings
only in tests, documentation-only findings, missing audit logging, log
injection, rate-limiting suggestions, unsupported memory-safety claims in
memory-safe languages, or ReDoS without a demonstrated slow payload. Other
claims require code tracing, caller and callee review, runtime-trigger
reconstruction, and documentation verification when framework behavior matters.

The Referee independently re-reads every finding when there are 20 or fewer.
For larger sets it independently verifies all Critical findings and the top 15,
then evaluates the remaining evidence with promotion rules for disputed or
weakly supported decisions.

## Core code-analysis capabilities

### Deterministic risk triage

Before the model reads source, `scripts/triage.cjs` inventories the target,
filters non-source content, scores file risk, estimates scan size, and selects
an execution strategy. This deterministic pre-pass spends no model tokens and
keeps high-risk files ahead of lower-risk context.

Risk signals are path and filename heuristics for authentication, security,
API, data, service, utility, test, and low-value locations. Triage does not
parse source behavior or claim to find bugs; it creates a review order and an
explicit coverage budget.

### Runtime behavioral bug detection

The Hunter reads production code for failures that can change real behavior:

- wrong conditions, off-by-one errors, unreachable branches, and state errors
- injection, authorization bypass, path traversal, SSRF, XSS, and unsafe input
  flow
- race conditions, time-of-check/time-of-use bugs, and shared-state conflicts
- swallowed exceptions, unhandled rejections, and partial-failure corruption
- encoding, truncation, numeric, timezone, and serialization mistakes
- mismatched API contracts between callers and callees
- resource leaks involving files, sockets, connections, listeners, or workers
- missing validation at external, service, persistence, and trust boundaries

Each finding must identify a source location, concrete claim, evidence, runtime
trigger, cross-references, confidence, and security classification when
applicable. A theory without a reachable trigger should not become a finding.

### Cross-file and boundary analysis

Many production bugs do not exist in one function. Bug Hunter checks where
assumptions change:

- a caller assumes a callee validated input, but neither did
- a lower layer throws, an intermediate layer swallows the error, and an upper
  layer records success
- one route enforces authorization while another route reaches the same service
  without it
- a multi-step write leaves partial state when a later operation fails
- two modules read and update shared state without coordination
- string, number, boolean, date, or null semantics change across an API boundary

Recon supplies the map, Hunter makes the claim, Skeptic follows the defensive
path, and Referee decides what the full evidence supports.

### Documentation-verified framework analysis

<p align="center">
  <img src="https://raw.githubusercontent.com/codexstar69/bug-hunter/183e0a957bd22ea5df83741cd31e396f68b14ae5/docs/images/doc-verify-fix-plan.png" alt="Bug Hunter checks version-sensitive framework behavior against documentation before confirming findings, dismissals, or fixes" width="100%">
</p>

AI review often fails when it guesses what a library does. Bug Hunter can query
Context Hub and use the bundled Context7 path as a fallback for a specific
version-sensitive claim.

Documentation checks are used at decision points:

| Role | Example reason to check documentation |
|---|---|
| Hunter | Verify whether a framework actually escapes, validates, or parameterizes a value |
| Skeptic | Confirm that middleware or a library guarantee really blocks the reported trigger |
| Fixer | Verify the supported API and safe usage pattern before proposing a patch |

Lookups are claim-driven rather than a broad search over every import. If no
useful documentation is available, the agent must say that the claim could not
be verified and continue from repository evidence without inventing a guarantee.

Context Hub is optional:

```bash
npm install -g @aisuite/chub
```

### False-positive reduction

Bug Hunter reduces noise through several independent checks:

1. Scope rules exclude style and non-behavioral suggestions.
2. Hunter findings require code evidence and a runtime trigger.
3. Framework-dependent claims can be checked against documentation.
4. Skeptic re-reads code and tries to find defensive context.
5. Referee owns the only verdict that can authorize a confirmed result.
6. Missing review results remain visible as manual or unreviewed work.
7. A report join checks that the artifact counts and bug IDs agree.

No review process can promise zero false positives or zero missed bugs. The
goal is an auditable argument with enough evidence for a developer to review.

### Large-codebase coverage and resume

For larger repositories, Bug Hunter can divide work by bounded file chunks or
architectural domains while preserving a canonical queue. State records chunk
attempts, file outcomes, findings, and the fix-plan reference. A sibling
identity file stores the run ID, repository and base commit, scope hash, and
options hash so resume can reject a different target.

Coverage records `pending`, `in_progress`, `done`, or `failed` from per-file evidence. A parent chunk marked done cannot manufacture completion for a file whose evidence remains pending. Failed or incomplete coverage does not become a clean result. Cross-partition references can be sent through a reconciliation pass before the final join.

## Security vulnerability classification

<p align="center">
  <img src="https://raw.githubusercontent.com/codexstar69/bug-hunter/183e0a957bd22ea5df83741cd31e396f68b14ae5/docs/images/security-finding-card.png" alt="Security finding card with runtime evidence, STRIDE category, CWE identifier, CVSS 3.1 score, reachability, exploitability, and proof of concept" width="100%">
</p>

Security findings combine code-review evidence with common security taxonomies:

- **STRIDE** describes the threat class and affected trust boundary.
- **CWE** identifies the weakness family, such as CWE-89 for SQL injection or
  CWE-862 for missing authorization.
- **CVSS 3.1** records a base vector and score for confirmed Critical or High
  security bugs.
- **Reachability** distinguishes external, authenticated, internal, and
  unreachable paths.
- **Exploitability** records whether the trigger is easy, conditional, or hard.
- **Proof of concept** gives a minimal, benign way to understand the behavior.

STRIDE and CWE are typed finding fields. Reachability, exploitability, CVSS,
and proof-of-concept details are currently carried in the Referee's narrative
fields.

The six STRIDE categories are:

| Category | Security question |
|---|---|
| Spoofing | Can an attacker pretend to be another user, service, or identity? |
| Tampering | Can untrusted input change code, commands, queries, files, or records? |
| Repudiation | Can an important action happen without reliable attribution? |
| Information disclosure | Can protected data cross into an unauthorized response, log, or tenant? |
| Denial of service | Can a demonstrated external path exhaust a bounded resource or stop service? |
| Elevation of privilege | Can a user cross an authorization boundary or gain a stronger role? |

Common mappings include SQL injection (`CWE-89`, Tampering), command injection
(`CWE-78`, Tampering), XSS (`CWE-79`, Tampering), path traversal (`CWE-22`,
Tampering), IDOR (`CWE-639`, Information disclosure), missing authentication
(`CWE-306`, Spoofing), missing authorization (`CWE-862`, Elevation of
privilege), SSRF (`CWE-918`, Tampering), CSRF (`CWE-352`, Tampering), and
insecure deserialization (`CWE-502`, Tampering).

Classification adds context; it does not replace proof. A severe label without
a reachable trigger should not survive adversarial review.

## STRIDE threat modeling

Run `/bug-hunter --threat-model` to generate or reuse
`.bug-hunter/threat-model.md`. The threat-model workflow maps:

- public, authenticated, internal, and administrative entry points
- trust boundaries between clients, services, queues, storage, and third parties
- sensitive data flows from input through processing, persistence, and output
- important assets, attacker goals, and boundary-specific STRIDE threats
- framework- and stack-specific vulnerable and defensive patterns

Recon and Hunter use the threat model as scan context. An existing threat model
modified within the last 90 days can be reused; an older one is regenerated
with a warning. The bundled `threat-model-generation` skill owns the artifact,
and `security-review` can request it when a full security review needs one.

This is repository-level threat modeling, not a substitute for infrastructure,
cloud-policy, runtime configuration, or penetration testing outside the checked
source.

## Dependency CVE scanning

Run `/bug-hunter --deps` to add lockfile-aware dependency vulnerability
scanning for JavaScript and TypeScript projects.

The implemented parser supports:

| Lockfile | Package manager | Audit command |
|---|---|---|
| `package-lock.json` | npm | `npm audit --json` |
| `pnpm-lock.yaml` | pnpm | `pnpm audit --json` |
| `yarn.lock` | Yarn | `yarn npm audit --json` |
| `bun.lock` or `bun.lockb` | Bun | `bun audit --json` |

The scanner keeps High and Critical advisories and searches source for package
imports. Imports in paths containing `.test.`, `.spec.`, or `__tests__` are
treated as potentially reachable; other test naming patterns may still count as
reachable. The result is `REACHABLE`, `POTENTIALLY_REACHABLE`,
`NOT_REACHABLE`, or `UNKNOWN`. It is supporting evidence, not a complete
call-graph proof.

Python, Go, and Rust manifests may be detected, but their audit-output parsers
and reachability fixtures are not implemented. They return
`scanner-unsupported` and are never reported as clean by guesswork.

Dependency results are written to `.bug-hunter/dep-findings.json` and can feed
the Hunter when a vulnerable dependency appears reachable from application
code.

## Pull-request and changed-code review

<p align="center">
  <img src="https://raw.githubusercontent.com/codexstar69/bug-hunter/183e0a957bd22ea5df83741cd31e396f68b14ae5/docs/images/2026-03-12-pr-review-flow.png" alt="Pull-request review flow for current PRs, recent PRs, staged changes, branch diffs, security context, and final reporting" width="100%">
</p>

Bug Hunter can narrow the audit to the code that is about to merge:

```text
/bug-hunter --staged
/bug-hunter --pr
/bug-hunter --pr 123
/bug-hunter --pr recent
/bug-hunter -b feature/auth-refresh --base main
/bug-hunter --pr-security
```

PR security review routes through the bundled `commit-security-scan` skill and
can combine changed-code scope with STRIDE context, dependency evidence, and
vulnerability validation. GitHub metadata is used when available, with
repository-local Git scope as the fallback.

Changed-code review still follows the same Hunter, Skeptic, and Referee
contract. A smaller diff changes scope; it does not weaken the evidence rules.

## Strategic fix planning and safe remediation

<p align="center">
  <img src="https://raw.githubusercontent.com/codexstar69/bug-hunter/183e0a957bd22ea5df83741cd31e396f68b14ae5/docs/images/2026-03-12-fix-plan-rollout.png" alt="Strategic bug-fix plan with confidence gating, canary rollout, scoped editing, verification, circuit breakers, and rollback reporting" width="100%">
</p>

Finding a bug and changing code are separate permissions. The default run
stops after the report. `/bug-hunter --plan` writes a strategy and fix plan but
does not edit source. `/bug-hunter --fix --approve` permits reviewed edits and
requests the host agent's default permission mode; prompt behavior depends on
that host.

The remediation flow has these gates:

### Git and single-writer safety

Fixing requires a Git repository. The current contract records the original
branch and base commit, inspects dirty state, attempts to preserve tracked and
indexed changes in a named stash, and creates a dedicated fix branch. Untracked
files and pre-existing stashes need manual attention; automatic restoration is
not guaranteed.

A cooperative owner-token lock serializes compliant Bug Hunter Fixers after
Git setup. It does not block a user or another tool from changing the
repository. If status inspection, preservation, branch creation, or lock
acquisition fails, fixing stops.

Worktree isolation is used for supported subagent backends only when
`--auto-commit` was also authorized. Worktree identity, harvest freshness, and
cleanup are checked. If safe preservation or cleanup cannot be proven, the
worktree is left in place for recovery rather than deleted.

### Baseline and flaky-test detection

When a test command is available, the fix pipeline records two baseline runs.
Failures seen in both are tracked as existing failures; failures seen in only
one are tracked as flaky. New failures after a patch are evaluated against both
sets. Missing verification commands are reported instead of treated as passes.

### Remediation classification

Every confirmed finding is classified before patching:

| Class | Meaning |
|---|---|
| `safe-autofix` | Localized enough for the guarded Fixer workflow |
| `manual-review` | Evidence or patch confidence is too low |
| `larger-refactor` | Needs coordinated changes beyond a small patch |
| `architectural-remediation` | Requires a wider design or contract change |

The Fixer queue comes only from Referee `REAL_BUG` verdicts. The planner marks
low-confidence, conflicting, and non-autofix work as `manual-review`; the
orchestrator is required to exclude those entries from Fixer batches.

### Canary-first rollout

The agent-driven fix workflow can apply dependency ordering when an index is
available, then severity ordering. The deterministic composition runner orders
by severity, confidence, and stable key.

The guided workflow describes a highest-risk 20 percent canary bounded to one
through three findings:

```text
1–5 eligible bugs   -> 1 canary
6–10 eligible bugs  -> 2 canaries
11+ eligible bugs   -> 3 canaries
```

The deterministic composition runner instead uses its supplied
`--canary-size`, with a default of three. The generated `fix-plan.json` is the
authoritative canary set for a specific run.

Canary changes run before the remaining rollout. Fixer batches are bounded,
verification happens between batches, and a failure-rate circuit breaker stops
the run when more than half of at least three attempted fixes fail. The overall
fix phase also has a deadline.

### Scoped patches, verification, and rollback

The validated Fixer scope binds the repository root, base commit, approved bug
IDs, and approved file paths before dispatch. Claimed line ranges stay in the
fix plan as review context. Current validation does not independently prove
line-range, symlink, submodule, or Git-metadata compliance after a patch, so
review the final diff before merging.

Impacted checks run after checkpoints, followed by the available full tests,
typecheck, and build. A targeted post-fix Hunter pass examines only changed
hunks for newly introduced Medium-or-higher bugs.

Final statuses explain the result:

| Status | Meaning |
|---|---|
| `FIXED` | Patch landed and verification found no new failure |
| `FIX_REVERTED` | Patch introduced a failure and its checkpoint was reverted |
| `FIX_FAILED` | The patch or its rollback could not be verified safely |
| `PARTIAL` | A bounded patch landed but wider work remains |
| `SKIPPED` | The fix was not attempted or the guarded run stopped |
| `FIXER_BUG` | Post-fix review found a new Medium-or-higher bug |
| `MANUAL_REVIEW` | The finding was not authorized for automatic remediation |

Automatic per-bug rollback requires commit-backed checkpoints. A run without
commit permission records uncommitted changes and may need manual restoration.
Rollback is a guarded operation, not a promise that every repository state can
always be restored automatically. Failures remain visible in `fix-report.json`.

## Structured JSON for CI/CD

<p align="center">
  <img src="https://raw.githubusercontent.com/codexstar69/bug-hunter/183e0a957bd22ea5df83741cd31e396f68b14ae5/docs/images/2026-03-12-machine-readable-artifacts.png" alt="Machine-readable Bug Hunter artifacts for findings, challenges, verdicts, coverage, fix planning, reports, and CI/CD integration" width="100%">
</p>

`.bug-hunter/scan-report.json` is the joined machine-readable result for CI/CD,
security dashboards, pull-request gates, or ticket automation. It records run
identity, target, execution mode, scanned-file count, dependency status, counts,
and the confirmed, dismissed, manual-review, and unreviewed sets.

A shortened example:

```json
{
  "schemaVersion": 1,
  "runId": "scan-2026-08-04-083000",
  "generatedAt": "2026-08-04T08:30:00.000Z",
  "mode": "local-sequential",
  "target": "src/",
  "filesScanned": 47,
  "threatModelLoaded": false,
  "dependencies": {
    "status": "not-applicable"
  },
  "counts": {
    "findings": 2,
    "confirmed": 1,
    "dismissed": 1,
    "manualReview": 0,
    "unreviewed": 0
  },
  "confirmed": [
    {
      "id": "BUG-1",
      "finding": {
        "bugId": "BUG-1",
        "severity": "Critical",
        "file": "src/api/users.ts",
        "claim": "User input reaches a SQL query"
      },
      "verdict": {
        "bugId": "BUG-1",
        "verdict": "REAL_BUG",
        "trueSeverity": "Critical",
        "confidenceScore": 96
      }
    }
  ],
  "dismissed": [
    {
      "id": "BUG-2",
      "finding": {
        "bugId": "BUG-2",
        "severity": "Medium",
        "file": "src/api/profile.ts",
        "claim": "The response may expose a protected field"
      },
      "verdict": {
        "bugId": "BUG-2",
        "verdict": "NOT_A_BUG",
        "trueSeverity": "Low",
        "confidenceScore": 91
      }
    }
  ],
  "manualReview": [],
  "unreviewed": []
}
```

Consumers should distinguish result meanings:

- `confirmed` means the Referee accepted the finding.
- `dismissed` means the available evidence disproved it.
- `manualReview` means a human decision is still needed.
- `unreviewed` means adversarial review did not finish.
- `scanner-unsupported` means the requested dependency parser is unavailable.

Only a completed report with no confirmed, manual-review, unreviewed, failed-coverage, or required-verification items can support a clean result for the scanned scope.

## Output files

Runs write artifacts under `.bug-hunter/`. Add that directory to the audited repository's `.gitignore`.

The main files are:

| File | Generated when | Purpose |
|---|---|---|
| `triage.json` | Every scan | File classification, risk map, scan order, and budget |
| `recon.json` | Multi-file scan | Prioritized risk tiers and Recon notes |
| `hunter-findings.json` | Every scan | Canonical Hunter claims before adversarial review |
| `skeptic.json` | Findings exist | Challenges, decisions, and counter-evidence |
| `referee.json` | Findings exist | Canonical final verdicts |
| `scan-report.json` | Completed scan | Joined run metadata, counts, and verdicts |
| `report.md` | Completed scan | Human-readable final report |
| `coverage.json` | Coverage loop | Per-file evidence states; parent chunk status alone cannot mark a file done |
| `fix-strategy.json` | Plan or fix run | Remediation class for confirmed bugs |
| `fix-plan.json` | Plan or fix run | Authorized canary and rollout plan |
| `fixer-scope.json` | Plan or fix run | Repository, base commit, bug ID, and file boundary |
| `fix-report.json` | Fix run | Verification, rollback, and final-status results |
| `threat-model.md` | Threat-model run | STRIDE boundaries, assets, flows, and threats |
| `dep-findings.json` | Dependency run | Audit results, scanner status, and reachability |
| `state.json` | Persisted scan | Queue, attempts, file outcomes, findings, and plan reference |
| `adaptive-plan.json` | Adaptive run | Risk- and benchmark-derived context, review, verification, and early-stop policy |
| `retrieval-plan.json` | Indexed/retrieval run | Hypothesis-ranked files and symbol slices under a hard context budget |
| `verification-report.json` | Hybrid verification requested | Compiler, test, build, static, reproduction, or fuzz results tied to findings |
| `benchmark-report.json` | Benchmark gate | Precision, recall, calibration, stability, cost, latency, and Pareto metrics |

See [outputs](docs/how-it-works.md#output-contract) for the complete artifact contract.

## Supported languages and frameworks

Source analysis supports JavaScript, TypeScript, Python, Go, Rust, Java,
Kotlin, Ruby, PHP, C#, Swift, Scala, C, and C++ through agent reasoning and
repository evidence.

Dependency audit parsing and reachability currently support JavaScript and TypeScript projects using npm, pnpm, Yarn, or Bun lockfiles. Other ecosystems return `scanner-unsupported`; Bug Hunter does not report them as clean.

Commonly recognized server and web stacks include Express, Fastify, Next.js,
Django, Flask, FastAPI, Gin, Echo, Actix, Spring Boot, Rails, and Laravel.
Framework support is not a separate parser allowlist: Recon identifies the
repository stack, the agents reason from the checked source, and documentation
lookup supplies library context when available.

Language support means the agent can audit source behavior. It does not mean
that every language has a dependency-audit parser, compiler integration,
runtime sandbox, or framework-specific benchmark.

## Skill argument reference

These are arguments sent to the installed skill through your coding agent:

| Argument | Behavior |
|---|---|
| No arguments | Scan the current repository once without editing |
| `src/` or `file.ts` | Scan a specific path |
| `-b branch-name` | Scan a branch diff against the default base |
| `-b branch --base dev` | Scan a branch diff against a chosen base |
| `--staged` | Scan Git-staged changes |
| `--pr` or `--pr current` | Review the current pull request |
| `--pr recent` or `--last-pr` | Review the most recently updated open pull request |
| `--pr 123` | Review a specific pull-request number |
| `--review-pr` | Alias for `--pr current` |
| `--pr-security` | Changed-code security review with threat and dependency context |
| `--scan-only` or `--review` | Request report-only mode |
| `--plan-only` or `--plan` | Write strategy and plan artifacts, then stop |
| `--fix` | Permit reviewed fixes after confirmed verdicts |
| `--approve` | Request the host agent's reviewed/default permission mode |
| `--safe` | Alias for `--fix --approve` |
| `--dry-run` or `--preview` | Build strategy and fix-plan output without editing files |
| `--autonomous` | Permit unattended fixing |
| `--auto-commit` | Grant commit permission for an authorized fix plan |
| `--loop` | Continue until every queued file has a terminal recorded outcome |
| `--no-loop` | Explicitly keep the default single-pass behavior |
| `--deps` | Add supported dependency CVE scanning and reachability |
| `--threat-model` | Generate or reuse a STRIDE threat model |
| `--security-review` | Run the bundled repository security-review workflow |
| `--validate-security` | Add focused exploitability validation |

Arguments compose:

```text
/bug-hunter --deps --threat-model src/
/bug-hunter --pr-security --plan
/bug-hunter --fix --approve src/auth
```

Do not combine `--scan-only` or `--review` with `--fix`, `--approve`, `--safe`,
or `--autonomous`. The current control plane treats contradictory read-only and mutation intent as invalid/safety-sensitive rather than silently broadening authority.

The terminal `bug-hunter` CLI has a different job: install or upgrade, inspect
metadata, and verify the skill. Removal is manual; see
[agent installation](docs/agent-installation.md#remove).

## Safety model

- No flags means scan-only and single-pass.
- `--loop` changes coverage completion behavior; it does not grant edit authority.
- Do not combine report-only and mutation intent; use one explicit authority model.
- `--fix` permits reviewed edits after Referee/remediation gating.
- `--approve` requests reviewed/default host permissions; prompt behavior is
  host-dependent.
- `--plan` stops before edits.
- `--preview` builds remediation strategy and plan output without source edits.
- `--autonomous` permits unattended eligible edits.
- `--auto-commit` separately grants commit permission for the approved plan;
  inspect harvested commit paths before merging.
- Fix plans record bug IDs, files, and claimed line ranges. The validated
  scope independently enforces bug IDs and file paths before dispatch.
- Required hybrid-verification failure blocks Fixer authorization.
- Source mutation, deletion, unreadability, or repository escape fails the affected scan scope closed.
- Worktree cleanup fails closed when preservation cannot be proven.
- User-owned files are preserved during managed skill upgrades.

Review [SECURITY.md](SECURITY.md) before using autonomous fixing in a sensitive repository.

## Project architecture

```text
bug-hunter/
├── SKILL.md                    # Compact orchestration and permission control plane
├── bin/bug-hunter              # Installer, updater, info, and doctor CLI
├── docs/                       # Precision, measurable-protocol, installation, and usage guides
├── modes/                      # Scan, scale, loop, dispatch, and fix workflows
├── skills/
│   ├── recon/                  # Architecture and attack-surface mapping
│   ├── hunter/                 # Behavioral code and security analysis
│   ├── skeptic/                # Adversarial false-positive challenge
│   ├── referee/                # Independent verdict and security enrichment
│   ├── fixer/                  # Authorized patch execution
│   ├── doc-lookup/             # Context Hub and Context7 verification
│   ├── commit-security-scan/   # Pull-request and changed-code security review
│   ├── security-review/        # Full repository security workflow
│   ├── threat-model-generation/
│   └── vulnerability-validation/
├── schemas/                    # Canonical JSON artifact contracts
├── scripts/                    # Triage, state, benchmark, adaptive, retrieval, verification, cache, and safety tools
├── templates/                  # Payload and report templates
└── test-fixture/               # Source-only benchmark with planted bugs
```

The role skills are canonical. Compatibility prompts are generated from them,
and CI checks that generated files stay in sync.

## Documentation

- [Getting started](docs/getting-started.md)
- [Agent installation](docs/agent-installation.md)
- [Usage guide](docs/usage-guide.md)
- [CLI reference](docs/cli-reference.md)
- [How it works](docs/how-it-works.md)
- [Precision protocol](docs/precision-protocol.md)
- [Measurable world-class protocol](docs/world-class-protocol.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Agent orchestration contract](SKILL.md)

## Development

From a source checkout:

```bash
pnpm install --frozen-lockfile
pnpm quality:world-class
```

`quality:world-class` checks generated runtime assets, the complete regression suite, the benchmark gate, runtime preflight, and package inventory. Use `pnpm test` for the current test count instead of relying on a copied number in documentation.

The source repository also contains a deterministic hidden-label benchmark harness. Its bundled labels are a calibration fixture, not proof of universal superiority; production claims should use privately held historical bugs and clean repositories. See [the measurable protocol](docs/world-class-protocol.md).

The planted-bug fixture exists only in the source repository and is useful for
behavioral calibration:

```text
Use the bug-hunter skill to scan test-fixture/. Do not edit files.
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before changing runtime contracts.

## License

[MIT](LICENSE)
