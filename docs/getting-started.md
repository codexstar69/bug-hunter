---
title: Getting started
description: >
  Install Bug Hunter, verify the target, run a scan-only audit, and interpret
  the current precision-first result.
prompt: |
  Guide a user through installing and verifying Bug Hunter, running a safe
  scan-only audit, understanding unresolved results, and choosing loop or plan
  modes without granting unintended mutation authority.
---

# Getting started

## Before you begin

You need:

- Node.js 22 or newer;
- Git for branch/PR scope and the complete fix pipeline;
- a coding agent that can read skill files and run normal repository checks;
- a repository to audit.

The default workflow is **scan-only and single-pass**. It does not edit source
files. Use `--loop` when you explicitly want the queued scope worked until
coverage completes.

## 1. Install for one agent

For the latest published package, install Bug Hunter for Codex with:

```bash
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter install --agent codex
```

Use another target when needed, for example:

```bash
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter install --agent claude-code
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter install --agent cursor
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter install --agent copilot
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter install --agent droid
```

If you intentionally want the current GitHub `main` source instead of the
latest published package:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent codex
```

See [agent installation](agent-installation.md) for every supported target,
source installs, custom paths, and updates.

## 2. Verify the installed copy

Use the same package source and target you installed.

Published package:

```bash
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter doctor --agent codex
```

Current GitHub source:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

A complete target check reports that the managed runtime and install manifest
are current for the CLI package performing the check. Do not mix an old global
CLI with a newer source install when diagnosing version mismatches.

Restart the coding agent if it was open during installation.

## 3. Open the repository

Start your coding agent in the repository root. The agent should have permission
to read source and run the project's normal validation commands.

## 4. Request the safe first scan

Send this portable natural-language prompt:

```text
Use the bug-hunter skill to scan this repository. Do not edit files.
Return the final report and call out every manual-review or unreviewed item.
```

If the agent exposes slash skill commands, the short form is:

```text
/bug-hunter
```

Natural language is preferred in shared instructions because it works across
agent interfaces.

## 5. Understand what the scan is doing

The current pipeline is precision-first:

```text
triage -> optional adaptive plan -> Recon -> retrieval -> Hunter
       -> Skeptic -> Referee -> optional hybrid verification -> report
```

Important guarantees include risk-ordered scope, token-bounded chunks,
source-hash integrity, assigned-file enforcement, truthful per-file coverage,
and fail-closed required verification.

The public skill defaults to one pass. For large targets where you require the
entire queued scope to reach a terminal coverage state, request:

```text
/bug-hunter --loop
```

## 6. Review the result

Start with:

- `.bug-hunter/report.md` — human-readable report;
- `.bug-hunter/scan-report.json` — joined machine-readable result;
- `.bug-hunter/referee.json` — final verdict evidence;
- `.bug-hunter/coverage.json` — per-file coverage when persisted/loop work is
  used;
- `.bug-hunter/verification-report.json` — hybrid verification evidence when
  requested;
- `.bug-hunter/adaptive-plan.json` and `.bug-hunter/retrieval-plan.json` —
  bounded execution/retrieval policy when those layers are active.

Treat `manual-review`, `unreviewed`, failed coverage, and required-verification
failure as unresolved. They are not clean results.

## 7. Plan fixes without editing

After reviewing the report:

```text
Use the existing Bug Hunter findings to build a fix plan. Do not edit files.
```

Slash form:

```text
/bug-hunter --plan
```

Review `.bug-hunter/fix-strategy.json`, `.bug-hunter/fix-plan.json`, and the
resulting immutable scope before any mutation run.

## 8. Apply reviewed fixes

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
prompt behavior depends on the coding agent. `--auto-commit` is separate and
must not be assumed from edit permission.

Do not grant autonomous fixing or commit permission unless that behavior is
intended.

## Quality note

The bundled benchmark and `pnpm quality:world-class` validate Bug Hunter's
measurement and regression contracts. They do not prove universal superiority
across every repository or model. See [world-class protocol](world-class-protocol.md).

## Next steps

- [Usage guide](usage-guide.md) for PRs, security reviews, loop scans, and paths;
- [How it works](how-it-works.md) for trust boundaries and canonical artifacts;
- [Precision protocol](precision-protocol.md) for fail-closed evidence rules;
- [World-class protocol](world-class-protocol.md) for adaptive/benchmark design;
- [Troubleshooting](troubleshooting.md) when installation or discovery fails.
