---
title: Agent installation
description: >
  Install, verify, update, and remove Bug Hunter for each supported coding
  agent.
prompt: |
  can we do that so everything is end to end seamless and anyone and
  specially agents can understand easily how to use it all properly

  you removed a lot of content that helped rank it om google - bring it back

  Use @README.md, @bin/bug-hunter, @package.json,
  @docs/getting-started.md, and @docs/troubleshooting.md as source material.
---

# Agent installation

## Install the current GitHub source

Pass the target explicitly:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent codex
```

The npm `latest` tag still points to an older release while `3.1.1` publishing
is pending. After npm catches up, `@codexstar/bug-hunter` can replace the
GitHub package specifier.

The installer copies the complete managed runtime and writes
`.bug-hunter-install-manifest.json`. Repeating the command performs an atomic
upgrade. Managed files are replaced, while files not listed in the previous
manifest are preserved.

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

Install into several targets by running the command once for each target.

## Verify a target

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

Target verification checks:

- the install directory is a real directory
- the managed manifest is valid
- the installed package and manifest versions match
- the manifest matches the current runtime inventory
- every managed runtime file is present and is a regular file

The check ignores user-owned files that are outside the managed manifest.

## Custom directory

Use `--path` when an agent reads skills from another directory:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install \
  --path "$HOME/my-agent/skills/bug-hunter"

npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor \
  --path "$HOME/my-agent/skills/bug-hunter"
```

`--path` takes precedence if both `--path` and `--agent` are present.

## Install from a cloned source checkout

Use this path when testing an unreleased commit:

```bash
git clone https://github.com/codexstar69/bug-hunter.git
cd bug-hunter
pnpm install --frozen-lockfile
node bin/bug-hunter install --agent codex
node bin/bug-hunter doctor --agent codex
```

The doctor command considers the source checkout's package version current.

## Update

Run the same GitHub-source command again:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent codex
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

Restart the coding agent after the update if it caches skill definitions.

## Install globally

A global CLI is optional:

```bash
npm install -g https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz
bug-hunter install --agent codex
bug-hunter doctor --agent codex
```

Use `bug-hunter --version` to see the global CLI version.

## Remove

The CLI does not provide an uninstall command. Before removing a target:

1. Read `.bug-hunter-install-manifest.json`.
2. Check for files that are not listed in `managedFiles`.
3. Preserve those user-owned files.
4. Remove only the intended `bug-hunter` skill directory.

Do not recursively remove a broad skills directory.

## After installation

Restart the coding agent, open the repository to audit, and send:

```text
Use the bug-hunter skill to scan this repository. Do not edit files.
```

Continue with [getting started](getting-started.md).
