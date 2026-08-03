---
title: Bug Hunter
description: >
  Install and use the adversarial code-audit skill with human approval before
  any source edit.
prompt: |
  can we do that so everything is end to end seamless and anyone and
  specially agents can understand easily how to use it all properly

  Use @SKILL.md, @bin/bug-hunter, @package.json, @docs/getting-started.md,
  @docs/agent-installation.md, @docs/usage-guide.md,
  @docs/cli-reference.md, @docs/how-it-works.md,
  @docs/troubleshooting.md, and @CHANGELOG.md as source material.
---

<p align="center">
  <img src="https://raw.githubusercontent.com/codexstar69/bug-hunter/main/docs/images/hero.png" alt="Bug Hunter pipeline: triage, recon, Hunter, Skeptic, Referee, Fixer, and verification" width="720">
</p>

<h1 align="center">Bug Hunter</h1>
<p align="center"><strong>Adversarial code auditing for AI coding agents.</strong></p>
<p align="center">
  <a href="https://www.npmjs.com/package/@codexstar/bug-hunter"><img src="https://img.shields.io/npm/v/@codexstar/bug-hunter" alt="npm version"></a>
  <a href="https://github.com/codexstar69/bug-hunter/actions/workflows/ci.yml"><img src="https://github.com/codexstar69/bug-hunter/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/codexstar69/bug-hunter/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@codexstar/bug-hunter" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-blue" alt="Node.js 22 or newer">
</p>

Bug Hunter is an AI-agent skill for code review and security auditing. A Hunter finds possible bugs, a Skeptic challenges each claim, and a Referee decides what the evidence supports. The default run only scans and reports. Editing, autonomous fixing, and commits each require explicit permission.

## TL;DR

Install for your agent. Replace `codex` with a target from the table below.

```bash
npx --yes @codexstar/bug-hunter install --agent codex
npx --yes @codexstar/bug-hunter doctor --agent codex
```

Restart the agent if it was open during installation. Then send this prompt from the repository you want to audit:

```text
Use the bug-hunter skill to scan this repository. Do not edit files.
Return the final report and call out every item that needs manual review.
```

That is the recommended first run. It is scan-only.

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
| Other file-based agents | `agents` |

Always pass `--agent` when more than one coding agent is installed. Auto-detection is available, but an explicit target prevents installation into the wrong skill directory.

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

Equivalent skill arguments:

```text
/bug-hunter --fix --approve
```

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
  -> architecture recon
  -> Hunter findings
  -> documentation checks
  -> Skeptic challenges
  -> Referee verdicts
  -> report
  -> optional approved fix plan
  -> optional approved fixes and verification
```

The pipeline:

- prioritizes high-risk files before lower-risk files
- records claims with file evidence and runtime triggers
- checks version-sensitive behavior against available documentation
- challenges findings before reporting them as confirmed
- separates confirmed, dismissed, unreviewed, and manual-review results
- validates canonical JSON artifacts between phases
- keeps source edits disabled unless fixing is requested

Read [how it works](docs/how-it-works.md) for the full model and safety boundaries.

## Common workflows

| Goal | Skill request |
|---|---|
| Scan the whole repository | `/bug-hunter` |
| Scan one path | `/bug-hunter src/auth` |
| Review staged changes | `/bug-hunter --staged` |
| Review the current pull request | `/bug-hunter --pr` |
| Run a pull-request security review | `/bug-hunter --pr-security` |
| Add Node.js dependency scanning | `/bug-hunter --deps` |
| Generate a STRIDE threat model | `/bug-hunter --threat-model` |
| Create a fix plan without edits | `/bug-hunter --plan` |
| Ask before every fix | `/bug-hunter --fix --approve` |
| Preview proposed patches | `/bug-hunter --preview` |
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

## Outputs

Runs write artifacts under `.bug-hunter/`. Add that directory to the audited repository's `.gitignore`.

The main files are:

| File | Purpose |
|---|---|
| `report.md` | Human-readable final report |
| `scan-report.json` | Joined machine-readable result |
| `hunter-findings.json` | Hunter claims before adversarial review |
| `skeptic.json` | Challenges and counter-evidence |
| `referee.json` | Final verdicts |
| `triage.json` | File risk classification |
| `recon.json` | Stack and attack-surface map |
| `fix-strategy.json` | Remediation class for each confirmed bug |
| `fix-plan.json` | Authorized canary and rollout plan |
| `fix-report.json` | Fix and verification results |

See [outputs](docs/how-it-works.md#output-contract) for the complete artifact contract.

## Supported analysis

Source analysis supports JavaScript, TypeScript, Python, Go, Rust, Java, Kotlin, Ruby, PHP, C#, Swift, C, and C++ through agent reasoning and repository evidence.

Dependency audit parsing and reachability currently support JavaScript and TypeScript projects using npm, pnpm, Yarn, or Bun lockfiles. Other ecosystems return `scanner-unsupported`; Bug Hunter does not report them as clean.

Documentation verification uses Context Hub when installed and falls back to the bundled Context7 path:

```bash
npm install -g @aisuite/chub
```

Context Hub is optional. Node.js 22 or newer and Git are required for the complete workflow.

## Safety model

- No flags means scan-only.
- `--fix` permits reviewed edits.
- `--approve` requires approval for each fix.
- `--plan` stops before edits.
- `--preview` renders proposed changes without applying them.
- `--autonomous` permits unattended edits.
- `--auto-commit` separately permits scoped commits.
- Fix plans bind approved bug IDs, files, and line ranges.
- Worktree cleanup fails closed when preservation cannot be proven.
- User-owned files are preserved during managed skill upgrades.

Review [SECURITY.md](SECURITY.md) before using autonomous fixing in a sensitive repository.

## Documentation

- [Getting started](docs/getting-started.md)
- [Agent installation](docs/agent-installation.md)
- [Usage guide](docs/usage-guide.md)
- [CLI reference](docs/cli-reference.md)
- [How it works](docs/how-it-works.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Agent orchestration contract](SKILL.md)

## Development

From a source checkout:

```bash
pnpm install --frozen-lockfile
pnpm check:generated
pnpm test
node scripts/run-bug-hunter.cjs preflight --skill-dir .
pnpm verify:package
```

The planted-bug fixture exists only in the source repository:

```text
Use the bug-hunter skill to scan test-fixture/. Do not edit files.
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before changing runtime contracts.

## License

[MIT](LICENSE)
