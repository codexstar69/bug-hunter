---
title: Bug Hunter
description: >
  Adversarial AI code review and security auditing with measurable quality gates,
  adaptive execution, hybrid verification, and explicit permission before edits.
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

Bug Hunter is an AI-agent skill for code review, security auditing, changed-code review, threat modeling, dependency analysis, and guarded remediation. A Hunter finds possible bugs, a Skeptic challenges every claim, and a Referee decides what the evidence supports. The default run scans and reports only. Editing, autonomous fixing, and commits each require explicit permission.

## v3.2.0 — measurable, adaptive bug hunting

This release turns the precision-first pipeline into a measurable execution protocol instead of relying only on qualitative agent behavior.

### What changed

- **Measurable benchmark quality gate** — deterministic hidden-label fixtures score precision, recall, F1, severity-weighted recall, false positives per KLOC, calibration, repeat stability, token cost, latency, and time-to-first-true-positive.
- **Adaptive execution profiles** — `fast`, `balanced`, and `assurance` plans are selected from triage risk, security scope, benchmark evidence, stability, calibration, and token efficiency.
- **Hybrid verification** — safe argv-only verification can run tests, type checks, static checks, fuzz checks, and security-static checks, with required checks failing closed.
- **Exact evidence caching** — reusable evidence is content-addressed and bound to exact source content, protocol identity, role, and relevant configuration. Changed source cannot inherit stale conclusions.
- **Hypothesis-driven retrieval** — indexed runs rank direct files, symbols, dependencies, dependents, cross-references, and trust boundaries under hard context budgets.
- **Stronger source integrity** — scan scope, source hashes, resume identity, per-file outcomes, and Fixer authorization remain explicit and fail closed on drift.
- **Permanent CI quality gate** — Node.js 22/24 CI runs the full regression suite; Node.js 24 also runs the benchmark quality gate and package inventory verification.
- **Expanded agent support** — Claude Code, Codex, Cursor, GitHub Copilot, Kiro, Windsurf, OpenCode, Factory Droid CLI, and generic file-based agents are documented install targets.
- **Bundled security workflows** — PR security review, full repository security review, STRIDE threat modeling, vulnerability validation, and supported dependency CVE scanning are part of the managed runtime.

The bundled deterministic benchmark fixture currently reports precision `1.00`, recall `1.00`, F1 `1.00`, repeat stability `1.00`, zero false positives, median `12,090` tokens per true positive, p95 duration `61.3s`, and expected calibration error about `0.048`. These numbers validate the regression harness and bundled fixture; they are not claimed as an independent benchmark of every repository or model.

See [Measurable world-class protocol](docs/world-class-protocol.md) for the full design and artifact contracts.

## Quick start

Install Bug Hunter for the coding agent you use. Replace `codex` with one of the supported targets below.

```bash
npx --yes @codexstar/bug-hunter@latest install --agent codex
npx --yes @codexstar/bug-hunter@latest doctor --agent codex
```

To install directly from the current GitHub source instead:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent codex
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

Restart the coding agent if it was open during installation. Then, from the repository you want to audit, ask the agent:

```text
Use the bug-hunter skill to scan this repository. Do not edit files.
Return the final report and call out every item that needs manual review.
```

That is the recommended first run. It is scan-only.

## Supported agent install targets

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

Always pass `--agent` when more than one coding agent is installed. Auto-detection exists, but explicit selection prevents installation into the wrong skills directory.

Factory Droid CLI installs globally into `~/.factory/skills/bug-hunter`. Use `--path "$PWD/.factory/skills/bug-hunter"` for a repository-local installation. Droid also reads the legacy `~/.agents/skills` location.

See [Agent installation](docs/agent-installation.md) for install paths, upgrades, custom targets, and removal.

## Use it with any agent

Natural language is the portable interface:

```text
Use the bug-hunter skill to scan src/auth. Do not edit files.
```

Agents that expose slash-style skill commands may also accept:

```text
/bug-hunter src/auth
```

For a plan without edits:

```text
/bug-hunter --plan
```

For a reviewed fix run:

```text
Use the bug-hunter skill to scan this repository. Build a fix plan.
Ask for approval before every edit. Do not commit.
```

The closest flag-based request is:

```text
/bug-hunter --fix --approve
```

Do not use `--autonomous` or `--auto-commit` unless you intend to grant those permissions.

See [Usage guide](docs/usage-guide.md) for common human and agent prompts.

## How Bug Hunter works

```text
your code
  -> deterministic risk triage
  -> architecture recon
  -> adaptive execution plan
  -> hypothesis-driven retrieval
  -> Hunter findings
  -> documentation verification
  -> Skeptic challenges
  -> Referee verdicts
  -> hybrid verification
  -> report
  -> optional approved fix strategy
  -> optional approved fixes + verification
```

The pipeline is designed to reduce false-positive overload without hiding uncertainty:

1. **Risk triage** inventories source and prioritizes higher-risk files before lower-risk context.
2. **Recon** builds architecture, stack, trust-boundary, and cross-file context.
3. **Adaptive policy** selects a bounded execution profile based on risk and measured evidence.
4. **Retrieval planning** keeps named hypotheses and mandatory evidence in scope while budgeting optional context.
5. **Hunter** reports only concrete behavioral, runtime, security, concurrency, data, and error-path claims with source evidence and a trigger.
6. **Documentation lookup** verifies version-sensitive framework or library assumptions when available.
7. **Skeptic** tries to disprove every finding using code and counter-evidence.
8. **Referee** owns the final `REAL_BUG`, `NOT_A_BUG`, or `MANUAL_REVIEW` verdict.
9. **Hybrid verification** can attach compiler, test, static-analysis, fuzz, or security-static evidence to findings.
10. **Report join** keeps confirmed, dismissed, manual-review, and unreviewed work separate.
11. **Fix planning and execution** happen only when explicit mutation authority is granted.

A malformed or missing required canonical artifact is a failed phase, not proof of a clean repository.

## Measurable quality and cost

Bug Hunter ships a deterministic benchmark harness that supports separate public manifests, private labels, and recorded runs. The scorer reports:

- one-to-one true-positive matching
- precision, recall, and F1
- severity-weighted recall and severity accuracy
- false positives per KLOC
- confidence calibration and Brier score
- repeat stability across repeated runs
- total input/output tokens and tokens per true positive
- runtime duration and p95 latency
- time to first true positive
- cost and cost per true positive when supplied

Run the bundled regression benchmark from a source checkout:

```bash
pnpm benchmark:gate
```

The normal quality command is:

```bash
pnpm quality:world-class
```

That verifies generated runtime assets, runs the complete regression suite, enforces the benchmark gate, runs Bug Hunter preflight, and verifies the npm package inventory.

For real product evaluation, use privately held historical bugs plus clean repositories rather than relying only on the bundled deterministic fixture.

## Adaptive execution profiles

The adaptive policy can select three execution profiles:

| Profile | Intended use | Typical behavior |
|---|---|---|
| `fast` | Small, low-risk, high-confidence scope | tighter token/file budgets, fewer review passes |
| `balanced` | General repository and PR review | moderate context, review, and verification |
| `assurance` | Security-heavy, high-risk, disputed, or low-confidence scope | deeper reasoning, wider retrieval, stronger independent verification |

Profile decisions can tune source-token limits, file caps, delta hops, expansion caps, reviewer passes, Referee escalation, verification requirements, confidence thresholds, and early-stop rules. Explicit user limits remain authoritative.

## Hybrid verification

Verification plans are data, not shell scripts. Commands are executed as argv arrays inside the repository boundary.

The verifier can represent:

- `test`
- `typecheck`
- `static`
- `fuzz`
- `security-static`

Required checks fail closed when they fail, time out, or are unavailable. Ambient secrets are stripped, sensitive environment injection is rejected, repository escapes are rejected, and captured output is bounded and redacted.

Verification evidence can change finding confidence, but it does not let the Fixer invent new scope.

## Exact evidence reuse

The evidence cache is content-addressed. Reuse requires an exact match of relevant identity, including source content and protocol context. It is not an approximate semantic cache.

The cache:

- rejects symlink shards that escape its root
- uses exact-match lookup only
- can enforce age and entry-count limits
- refuses to carry conclusions across changed source or protocol identity

This reduces repeated model work without trading away source-integrity guarantees.

## Focused retrieval under hard budgets

The retrieval planner starts from named hypotheses and can score:

- direct hypothesis files
- symbols related to the hypothesis
- cross-referenced files
- dependencies and dependents
- trust-boundary files
- graph-neighbor context

Mandatory evidence remains in scope even when it exceeds an optional context budget. Optional files are ranked and omitted when the hard budget is reached. The planner records what was selected, what was omitted, and why.

## Common workflows

| Goal | Skill request |
|---|---|
| Scan the whole repository | `/bug-hunter` |
| Scan one path | `/bug-hunter src/auth` |
| Review staged changes | `/bug-hunter --staged` |
| Review the current pull request | `/bug-hunter --pr` |
| Review a specific PR | `/bug-hunter --pr 123` |
| Run PR security review | `/bug-hunter --pr-security` |
| Add supported dependency CVE scanning | `/bug-hunter --deps` |
| Generate a STRIDE threat model | `/bug-hunter --threat-model` |
| Run full bundled security review | `/bug-hunter --security-review` |
| Add exploitability validation | `/bug-hunter --validate-security` |
| Create a fix plan without edits | `/bug-hunter --plan` |
| Build a no-edit remediation preview | `/bug-hunter --preview` |
| Request reviewed fixing | `/bug-hunter --fix --approve` |
| Permit unattended fixing | `/bug-hunter --autonomous` |
| Separately grant commit permission | `/bug-hunter --auto-commit` |

The terminal `bug-hunter` executable installs and verifies the skill. Scans are started through the coding agent, not through a `bug-hunter scan` shell subcommand.

See [CLI reference](docs/cli-reference.md) for installer commands and skill arguments.

## Security review capabilities

Bug Hunter focuses on reachable behavior rather than style findings. Security findings can carry STRIDE, CWE, CVSS context, reachability, exploitability, and a benign proof-of-concept narrative when appropriate.

Typical bug classes include:

- authentication and authorization bypass
- SQL, command, template, and path injection
- SSRF and unsafe outbound requests
- XSS and unsafe rendering flows
- IDOR and cross-tenant data exposure
- CSRF and trust-boundary mistakes
- insecure deserialization
- race conditions and TOCTOU bugs
- swallowed errors and partial-failure corruption
- API contract mismatches
- unsafe validation assumptions
- resource leaks and unbounded work

Security flags route into bundled local skills:

- `--pr-security` -> `commit-security-scan`
- `--security-review` -> `security-review`
- `--threat-model` -> `threat-model-generation`
- `--validate-security` -> `vulnerability-validation`

These security skills ship with the managed runtime and do not need separate installation.

## Dependency vulnerability scanning

`--deps` adds lockfile-aware dependency vulnerability scanning for JavaScript and TypeScript projects.

| Lockfile | Package manager |
|---|---|
| `package-lock.json` | npm |
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | Yarn |
| `bun.lock` / `bun.lockb` | Bun |

High and Critical advisories can be correlated with source imports and labeled `REACHABLE`, `POTENTIALLY_REACHABLE`, `NOT_REACHABLE`, or `UNKNOWN`. This is supporting evidence, not a complete call-graph proof.

Unsupported dependency ecosystems return `scanner-unsupported`; they are never silently reported as clean.

## Safe remediation

Finding a bug and changing code are separate permissions.

- No mutation flags means scan-only.
- `--plan` and `--preview` stop before source edits.
- `--fix` permits reviewed fixes for Referee-confirmed bugs.
- `--approve` requests the host agent's reviewed/default permission mode.
- `--autonomous` permits unattended source edits.
- `--auto-commit` separately grants commit permission for the approved plan.

Fix authorization is bound to validated bug IDs and approved files. Worktree, lock, source-drift, state, and cleanup failures stop or degrade safely rather than silently broadening authority.

Confirmed findings are classified as `safe-autofix`, `manual-review`, `larger-refactor`, or `architectural-remediation`. Only authorized executable plan entries may reach the Fixer.

Canary-first execution, bounded batches, verification checkpoints, circuit breakers, and rollback reporting keep automated remediation constrained. Review the final diff before merging.

See [Security policy](SECURITY.md) before using autonomous fixing in a sensitive repository.

## Canonical output artifacts

Runs write machine-readable artifacts under `.bug-hunter/`.

| Artifact | Purpose |
|---|---|
| `triage.json` | deterministic file classification, risk map, ordering, and budget |
| `recon.json` | architecture and risk context |
| `adaptive-plan.json` | selected execution, review, verification, cache, and early-stop policy |
| `retrieval-plan.json` | hypothesis-ranked files and symbol slices under context budgets |
| `hunter-findings.json` | canonical Hunter claims |
| `skeptic.json` | adversarial challenges and counter-evidence |
| `referee.json` | final verdicts |
| `verification-report.json` | compiler, test, static, fuzz, or security-static evidence |
| `scan-report.json` | joined machine-readable scan result |
| `report.md` | human-readable report |
| `coverage.json` | per-file coverage state |
| `fix-strategy.json` | remediation class for confirmed bugs |
| `fix-plan.json` | authorized canary and rollout plan |
| `fixer-scope.json` | repository, base commit, bug ID, and file boundary |
| `fix-report.json` | verification, rollback, and final fix status |
| `threat-model.md` | STRIDE assets, flows, boundaries, and threats |
| `dep-findings.json` | dependency audit and reachability evidence |
| `benchmark-report.json` | quality, calibration, stability, token, latency, and cost metrics |
| `state.json` | persisted queue, attempts, file outcomes, and findings |

Canonical JSON is the source of truth for schema-backed phases; Markdown is a readable view.

## Supported source languages and stacks

Bug Hunter can reason over JavaScript, TypeScript, Python, Go, Rust, Java, Kotlin, Ruby, PHP, C#, Swift, Scala, C, and C++ using repository evidence and the host coding agent.

Common server and web stacks include Express, Fastify, Next.js, Django, Flask, FastAPI, Gin, Echo, Actix, Spring Boot, Rails, and Laravel.

Language support means the agent can audit source behavior. It does not mean every language has a dependency-audit parser, compiler integration, runtime sandbox, or dedicated benchmark.

## Project architecture

```text
bug-hunter/
├── SKILL.md                    # top-level orchestration and permission contract
├── bin/bug-hunter              # installer, updater, info, and doctor CLI
├── docs/                       # installation, usage, protocol, and troubleshooting guides
├── modes/                      # scan, scale, loop, dispatch, and fix workflows
├── skills/
│   ├── recon/
│   ├── hunter/
│   ├── skeptic/
│   ├── referee/
│   ├── fixer/
│   ├── doc-lookup/
│   ├── commit-security-scan/
│   ├── security-review/
│   ├── threat-model-generation/
│   └── vulnerability-validation/
├── schemas/                    # canonical artifact contracts
├── scripts/                    # triage, state, benchmark, retrieval, verifier, cache, and safety tools
├── evals/benchmark/            # deterministic benchmark fixtures
├── prompts/                    # generated compatibility prompts
└── templates/                  # payload and report templates
```

The role skills are canonical. Compatibility prompts are generated from them, and CI checks that generated files remain synchronized.

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

## Development and verification

From a source checkout:

```bash
pnpm install --frozen-lockfile
pnpm check:generated
pnpm test
pnpm benchmark:gate
node scripts/run-bug-hunter.cjs preflight --skill-dir .
pnpm verify:package
```

Or run the complete quality gate:

```bash
pnpm quality:world-class
```

The regression suite covers orchestration, schemas, source identity, resume behavior, state, PR scope, dependency parsing, retrieval planning, hybrid verification, evidence caching, fix authorization, locks, worktrees, installation, packaging, bundled security routing, benchmark scoring, and adaptive policy behavior.

## License

[MIT](LICENSE)
