---
title: Getting started
description: >
  Install Bug Hunter, verify the target, run a scan-only audit, and read the
  result.
prompt: |
  can we do that so everything is end to end seamless and anyone and
  specially agents can understand easily how to use it all properly

  you removed a lot of content that helped rank it om google - bring it back

  Use @README.md, @bin/bug-hunter, @SKILL.md,
  @docs/agent-installation.md, @docs/usage-guide.md,
  @docs/how-it-works.md, and @docs/troubleshooting.md as source material.
---

# Getting started

## Before you begin

You need:

- Node.js 22 or newer
- Git
- a coding agent that can read skill files and run shell commands
- a repository to audit

The default workflow does not edit source files.

## 1. Install for one agent

This example installs Bug Hunter for Codex:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent codex
```

Use another target when needed:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent claude-code
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent cursor
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent copilot
```

See [agent installation](agent-installation.md) for every supported target.

## 2. Verify the installed copy

Use the same target you installed:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

A complete check includes:

```text
[ok] Bug Hunter runtime v<current-version> is current and complete
Ready to hunt bugs.
```

The reported version follows the package running the command. If it differs
from the example, use the reported version.

Restart the coding agent if it was open during installation.

## 3. Open the repository

Start your coding agent in the root of the repository you want to audit. The
agent should have permission to read the repository and run its normal
validation commands.

## 4. Request a scan

Send this natural-language prompt:

```text
Use the bug-hunter skill to scan this repository. Do not edit files.
Return the final report and call out every item that needs manual review.
```

If your agent supports slash skill commands, this is the shorter equivalent:

```text
/bug-hunter
```

Natural language is preferred in shared instructions because it works across
different agent interfaces.

## 5. Review the result

Start with:

- `.bug-hunter/report.md` for the human-readable report
- `.bug-hunter/scan-report.json` for automation
- `.bug-hunter/referee.json` for final verdict evidence
- `.bug-hunter/coverage.json` when a coverage loop was requested

Treat `manual-review` and `unreviewed` items as unresolved. They are not clean
results.

## 6. Plan fixes without editing

After reading the report, request a plan:

```text
Use the existing Bug Hunter findings to build a fix plan. Do not edit files.
```

Slash form:

```text
/bug-hunter --plan
```

Review `.bug-hunter/fix-strategy.json` and `.bug-hunter/fix-plan.json`.

## 7. Apply reviewed fixes

When the plan is acceptable:

```text
Use the bug-hunter skill to apply the approved fix plan.
Ask before every edit. Do not commit.
```

Slash form:

```text
/bug-hunter --fix --approve
```

`--approve` requests the host's reviewed/default permission mode. Approval
prompts depend on the coding agent. Use `--plan` or `--preview` when source
edits must be impossible.

Do not grant autonomous fixing or commit permission unless that behavior is
intended.

## Next steps

- [Usage guide](usage-guide.md) for pull requests, security reviews, and paths
- [How it works](how-it-works.md) for trust boundaries and artifacts
- [Troubleshooting](troubleshooting.md) when installation or discovery fails
