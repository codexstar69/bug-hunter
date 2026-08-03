---
title: CLI reference
description: >
  Reference for the Bug Hunter installer commands and agent skill arguments.
prompt: |
  can we do that so everything is end to end seamless and anyone and
  specially agents can understand easily how to use it all properly

  you removed a lot of content that helped rank it om google - bring it back

  Use @bin/bug-hunter, @SKILL.md, @README.md, and
  @docs/agent-installation.md as source material.
---

# CLI reference

Bug Hunter has two interfaces:

- `bug-hunter` installs and verifies the skill.
- `/bug-hunter` represents arguments passed to the skill inside a coding
  agent.

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

Copies the managed runtime into an agent skill directory. The swap is atomic.
An upgrade preserves files that are not owned by the previous manifest.

| Option | Meaning |
|---|---|
| `--agent <name>` | Use a known agent target |
| `--path <dir>` | Use an exact custom target and override `--agent` |
| `--skip-doctor` | Skip the post-install environment and target check |

Without `--agent` or `--path`, the CLI searches known agent directories and
falls back to `~/.agents/skills/bug-hunter`. Explicit selection is preferred.

### `doctor`

Without options, checks Node.js, Git, Context Hub, and the bundled Context7
fallback.

With `--agent` or `--path`, it also verifies the exact installed runtime
against the current CLI package.

### `info`

Prints skill metadata and installation links.

## Skill arguments

These arguments are interpreted by the installed skill:

| Argument | Behavior |
|---|---|
| no arguments | Scan the current repository without edits |
| `<path>` | Scan one file or directory |
| `-b <branch>` | Scan a branch diff |
| `--base <branch>` | Select the branch-diff base |
| `--staged` | Scan staged files |
| `--pr [current\|recent\|N]` | Review a pull request |
| `--pr-security` | Review pull-request security context |
| `--scan-only` | Request report-only behavior |
| `--review` | Alias for `--scan-only` |
| `--plan-only` | Build strategy and plan, then stop |
| `--plan` | Alias for `--plan-only` |
| `--fix` | Permit the reviewed fix phase |
| `--approve` | Request the host's reviewed/default permission mode |
| `--safe` | Alias for `--fix --approve` |
| `--dry-run` | Build strategy and fix-plan output without source edits |
| `--preview` | Alias for `--fix --dry-run` |
| `--autonomous` | Permit unattended fixing |
| `--auto-commit` | Grant commit permission for an authorized fix plan |
| `--loop` | Continue until queued coverage is complete |
| `--no-loop` | Keep the default single pass |
| `--deps` | Add supported Node.js dependency auditing |
| `--threat-model` | Generate or load a STRIDE threat model |
| `--security-review` | Run the bundled security workflow |
| `--validate-security` | Force security-finding validation |

Flags compose:

```text
/bug-hunter --pr-security
/bug-hunter --deps --threat-model src/
/bug-hunter --fix --approve src/auth
/bug-hunter --autonomous --auto-commit src/
```

Do not combine `--scan-only` or `--review` with `--fix`, `--approve`, `--safe`,
or `--autonomous`. Conflicting read-only and mutation flags are not currently
rejected.

The skill's canonical argument parser and behavior contract live in
[`SKILL.md`](../SKILL.md).
