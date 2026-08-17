---
title: CLI reference
description: >
  Reference for the Bug Hunter installer CLI, public skill arguments, and the
  internal measurable runner controls used by integrations.
prompt: |
  Explain the difference between terminal installation commands, public
  in-agent Bug Hunter arguments, and internal runner options without implying
  permissions or commands that the requested interface does not provide.
---

# CLI reference

Bug Hunter has separate interfaces:

- `bug-hunter` in a terminal installs/verifies the skill;
- `/bug-hunter ...` represents public arguments interpreted by the installed
  skill inside a coding agent;
- `scripts/run-bug-hunter.cjs` is an internal/integration runner with additional
  measurable-protocol controls.

There is no `bug-hunter scan` shell command.

## Installer commands

```text
bug-hunter install [--agent <name>] [--path <dir>] [--skip-doctor]
bug-hunter doctor [--agent <name>] [--path <dir>]
bug-hunter info
bug-hunter --version
bug-hunter --help
```

### `install`

Copies the managed runtime into an agent skill directory using an atomic staged
swap. Normal upgrades preserve files not owned by the previous manifest.

| Option | Meaning |
|---|---|
| `--agent <name>` | Use a known agent target |
| `--path <dir>` | Use an exact custom target and override `--agent` |
| `--skip-doctor` | Skip the post-install environment/target check |

Without `--agent` or `--path`, the CLI searches known agent directories and
falls back to `~/.agents/skills/bug-hunter`. Explicit selection is preferred.

### `doctor`

Without a target, checks core environment dependencies such as Node.js, Git,
Context Hub, and the bundled Context7 fallback. With `--agent` or `--path`, it
also validates the installed managed runtime against the CLI package performing
the check.

### `info`

Prints skill metadata and installation guidance.

## Public skill arguments

These are interpreted by the installed `SKILL.md`:

| Argument | Behavior |
|---|---|
| no arguments | Single-pass scan of the current repository without edits |
| `<path>` | Scan one file or directory |
| `-b <branch>` | Scan a branch diff |
| `--base <branch>` | Select the branch-diff base |
| `--staged` | Scan staged source files |
| `--pr [current\|recent\|N]` | Review a pull request |
| `--pr-security` | Review pull-request security context |
| `--scan-only` | Request report-only behavior |
| `--review` | Alias for `--scan-only` |
| `--loop` | Continue until queued coverage is complete |
| `--no-loop` | Explicitly keep single-pass behavior |
| `--plan-only` | Build strategy/plan, then stop |
| `--plan` | Alias for `--plan-only` |
| `--fix` | Permit the reviewed fix phase |
| `--approve` | Request the host's reviewed/default permission mode |
| `--safe` | Alias for `--fix --approve` |
| `--dry-run` | Build remediation output without source edits |
| `--preview` | Alias for `--fix --dry-run` |
| `--autonomous` | Permit unattended fixing |
| `--auto-commit` | Separately grant commit permission for authorized fixes |
| `--deps` | Add supported Node.js dependency auditing |
| `--threat-model` | Generate or load a STRIDE threat model |
| `--security-review` | Run the bundled repository security workflow |
| `--validate-security` | Add focused security-finding validation |

Examples:

```text
/bug-hunter
/bug-hunter --loop src/
/bug-hunter --pr-security
/bug-hunter --deps --threat-model src/
/bug-hunter --plan src/
/bug-hunter --fix --approve src/auth
/bug-hunter --autonomous --auto-commit src/
```

Do not combine report-only intent with mutation intent. The skill should keep
read-only and mutation authority explicit rather than resolving contradictory
requests silently.

## Internal measurable runner controls

Integrations that invoke `scripts/run-bug-hunter.cjs` directly can provide
additional controls such as:

```text
--max-source-tokens <n>
--confidence-threshold <n>
--triage-path <triage.json>
--benchmark-report <benchmark-report.json>
--adaptive-profile <auto|fast|balanced|assurance>
--adaptive-plan-path <adaptive-plan.json>
--verification-plan <verification-plan.json>
--verification-report <verification-report.json>
--verification-required <true|false>
--verification-total-budget-ms <milliseconds>
--evidence-cache <directory>
```

These are **not automatically public `/bug-hunter` flags**. They belong to the
runner/integration surface and are persisted in run identity where relevant.
Explicit limits override adaptive defaults.

## Canonical runner outputs

The measurable layers introduce these schema-backed artifacts in addition to
the role/report/fix contracts:

- `adaptive-plan.json`;
- `retrieval-plan.json`;
- `verification-report.json`;
- `benchmark-report.json`.

See [how it works](how-it-works.md) and
[world-class protocol](world-class-protocol.md) for semantics.

The canonical public argument parser and permission contract live in
[`SKILL.md`](../SKILL.md).
