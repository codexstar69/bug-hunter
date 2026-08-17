---
title: Agent installation
description: >
  Install, verify, update, and remove Bug Hunter for each supported coding
  agent using either the published package or current GitHub source.
prompt: |
  Install or update Bug Hunter for the requested coding agent, keep package
  source and doctor source consistent, preserve user-owned files, and explain
  when to use the published package versus current GitHub source.
---

# Agent installation

## Choose the package source

Use the **latest published npm package** for normal installations:

```bash
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter install --agent codex
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter doctor --agent codex
```

Use the **current GitHub `main` source** only when you intentionally want code
that may be newer than the latest published release:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent codex
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

Keep `install` and `doctor` on the same package source when diagnosing version
or manifest mismatches.

The installer copies the managed runtime and writes
`.bug-hunter-install-manifest.json`. Repeating the command performs an atomic
upgrade. Managed files are replaced; files not owned by the previous manifest
are preserved.

## Agent targets

| Agent | Target name | Default directory |
|---|---|---|
| Claude Code | `claude-code` | `~/.claude/skills/bug-hunter` |
| Codex | `codex` | `~/.codex/skills/bug-hunter` |
| Generic agent skills | `agents` | `~/.agents/skills/bug-hunter` |
| Cursor | `cursor` | `~/.cursor/skills/bug-hunter` |
| Kiro | `kiro` | `~/.kiro/skills/bug-hunter` |
| GitHub Copilot | `copilot` | `~/.copilot/skills/bug-hunter` |
| Windsurf | `windsurf` | `~/.windsurf/skills/bug-hunter` |
| OpenCode | `opencode` | `~/.opencode/skills/bug-hunter` |
| Factory Droid CLI | `droid` | `~/.factory/skills/bug-hunter` |

Install into several targets by running the command once for each target.
Explicit target selection is preferred over auto-detection when multiple agents
are installed.

## Factory Droid CLI

The `droid` target installs into the personal skill directory Droid reads for
every repository:

```bash
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter install --agent droid
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter doctor --agent droid
```

Droid can also load:

- `<repo>/.factory/skills/bug-hunter` — project-scoped; install with
  `--path "$PWD/.factory/skills/bug-hunter"`;
- `~/.agents/skills/bug-hunter` — legacy shared location used by target
  `agents`.

Project-scoped skills take precedence over personal ones. Avoid installing both
unless the repository intentionally pins its own copy. Restart Droid after an
install/update if it caches skill definitions.

## Verify a target

Published package:

```bash
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter doctor --agent codex
```

Current GitHub source:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

Target verification checks include:

- the install directory resolves to a real directory;
- the managed manifest is valid;
- installed package and manifest versions agree;
- the manifest matches the runtime inventory of the CLI performing the check;
- every managed runtime file exists as a regular file.

User-owned files outside the managed manifest are ignored by the integrity
comparison and preserved by normal upgrades.

## Custom directory

For an agent with a nonstandard skill path:

```bash
npm exec --yes --package=@codexstar/bug-hunter@latest -- \
  bug-hunter install --path "$HOME/my-agent/skills/bug-hunter"

npm exec --yes --package=@codexstar/bug-hunter@latest -- \
  bug-hunter doctor --path "$HOME/my-agent/skills/bug-hunter"
```

For current GitHub source, use the same `--path` with the GitHub archive command.
`--path` takes precedence when both `--path` and `--agent` are provided.

## Install from a cloned source checkout

Use a clone when developing or testing an unreleased commit:

```bash
git clone https://github.com/codexstar69/bug-hunter.git
cd bug-hunter
pnpm install --frozen-lockfile
pnpm quality:world-class
node bin/bug-hunter install --agent codex
node bin/bug-hunter doctor --agent codex
```

The doctor command treats the source checkout's package version/runtime
inventory as the expected installed state.

## Update

Published package update:

```bash
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter install --agent codex
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter doctor --agent codex
```

Current-source update:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent codex
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

Restart the coding agent after updating if it caches skill definitions.

## Optional global CLI

A global CLI is optional:

```bash
npm install -g @codexstar/bug-hunter@latest
bug-hunter install --agent codex
bug-hunter doctor --agent codex
```

Use `bug-hunter --version` to inspect the CLI version. A globally installed old
CLI should not be used to validate a newer current-source installation.

## Remove

The CLI does not provide an uninstall command. Before manually removing a
target:

1. read `.bug-hunter-install-manifest.json`;
2. identify files not listed in `managedFiles`;
3. preserve those user-owned files;
4. remove only the intended `bug-hunter` skill directory.

Do not recursively remove a broad parent skills directory.

## After installation

Restart the agent, open the repository to audit, and send:

```text
Use the bug-hunter skill to scan this repository. Do not edit files.
Return the final report and call out every manual-review or unreviewed item.
```

Continue with [getting started](getting-started.md).
