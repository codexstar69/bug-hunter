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

The install/doctor behavior described here requires v3.2.0 or newer. As of
2026-10-29, npm `latest` is still v3.0.8; use the GitHub-source commands below
until v3.2.0 is published. Check the selected CLI with `bug-hunter --version`.

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
are preserved. New manifests record a SHA-256 digest for each managed file.
An unmanaged link that overlaps a runtime path blocks installation rather
than writing through it; review that link before reinstalling.

## Agent targets

| Agent | Target name | Default directory |
|---|---|---|
| Claude Code | `claude-code` | `~/.claude/skills/bug-hunter` |
| Codex | `codex` | `~/.agents/skills/bug-hunter` |
| Generic agent skills | `agents` | `~/.agents/skills/bug-hunter` |
| Cursor | `cursor` | `~/.cursor/skills/bug-hunter` |
| Kiro | `kiro` | `~/.kiro/skills/bug-hunter` |
| GitHub Copilot | `copilot` | `~/.copilot/skills/bug-hunter` |
| Windsurf | `windsurf` | `~/.codeium/windsurf/skills/bug-hunter` |
| OpenCode | `opencode` | `~/.config/opencode/skills/bug-hunter` |
| Factory Droid CLI | `droid` | `~/.factory/skills/bug-hunter` |

Install into several targets by running the command once for each target.
Explicit target selection is preferred over auto-detection when multiple agents
are installed.

OpenCode uses `$XDG_CONFIG_HOME/opencode/skills/bug-hunter` when
`XDG_CONFIG_HOME` is an absolute path; unset, empty, or relative values use
`~/.config`. Codex and `agents` now select the same shared directory. Doctor
reports copies at the former `~/.codex/skills/bug-hunter`,
`~/.opencode/skills/bug-hunter`, and `~/.windsurf/skills/bug-hunter` paths and
leaves them in place as non-fatal warnings. Install at the current target, then
review and remove each reported legacy path. A legacy link resolving to the
active install is skipped.

Official discovery references (checked 2026-10-29):
[Claude Code](https://code.claude.com/docs/en/skills),
[Codex/shared agents](https://developers.openai.com/codex/skills/),
[Cursor](https://cursor.com/docs/skills), [Kiro](https://kiro.dev/docs/skills/),
[Copilot](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills),
[Windsurf](https://docs.windsurf.com/windsurf/cascade/skills),
[OpenCode](https://opencode.ai/docs/skills/), and
[Droid](https://docs.factory.ai/cli/configuration/skills).

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
- `~/.agents/skills/bug-hunter` — shared compatibility location used by target
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
- a home-agent target resolves within the real home directory; custom `--path`
  targets may link outside HOME;
- the managed manifest, when present, is valid;
- installed package and manifest versions agree;
- the manifest matches the runtime inventory of the CLI performing the check;
- every runtime file exists as a regular file inside the resolved target;
- SHA-256 contents match both the CLI package and recorded digests.

Bare `doctor` checks each distinct resolved agent target once, including legacy copies,
and lists paths, resolved paths, versions, managed/unmanaged status, and link
destinations. Missing unused targets are informational. It exits non-zero if
no current valid install exists, or an active copy is stale, incomplete,
or corrupted. Legacy copies only warn; review and remove their reported paths. Explicit `--agent` and `--path` checks fail if that target is absent.

A complete manifest-less install is checked against the CLI package and gets
an **unmanaged** warning with its package version. Legacy manifests without
digests are also checked against the package; reinstall to record digests.
Missing or malformed v2 digests fail doctor; install can repair them using the
validated managed-file list. Source digests are computed once per doctor run.
For automation, append `--json` to any doctor command; its exit status retains
the same meaning.

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

## Release validation (maintainers)

Before tagging a candidate, run `pnpm quality:world-class` and the packed
consumer smoke test:

```bash
BUG_HUNTER_PACKED_SMOKE=1 node --test scripts/tests/opt-e-packed-smoke.test.cjs
```

The smoke test packs with pnpm, installs the tarball into a temporary prefix
and home, exercises installation and upgrade, and runs doctor and preflight
from the installed copy. CI runs it on Node 22 and 24.

The Publish workflow accepts a manual `workflow_dispatch` with `dry_run=true`
(the default). An untagged branch runs the generated checks, tests, benchmark
gate, preflight, package inventory, packed consumer smoke, and clean-tree
guard, then `npm publish --dry-run --access public --provenance`. The dry-run
guard does not require a tag or upstream binding. Dirty checkouts still block;
for an untracked local file such as `CLAUDE.md`, use a clean release checkout
or move the local file outside it.

A GitHub release, or a manual dispatch with `dry_run=false`, requires the
version tag to point to HEAD and `origin/main`. Real manual publication must
select that tag. Publication uses npm OIDC Trusted Publishing without an npm
token. Configure the package's Trusted Publisher on npmjs.com for owner
`codexstar69`, repository `bug-hunter`, workflow `publish.yml`, with no
environment. A dry run checks packaging and lifecycle gates; it does **not**
prove that npm will authorize an OIDC token exchange. See
[npm's Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/).

After publication, the workflow checks the exact version and
`npm view @codexstar/bug-hunter@<version> dist.attestations`, requiring a SLSA
provenance attestation after a bounded registry propagation wait. A failed
post-publish check fails the workflow even though publication has already
occurred; inspect the registry before attempting another release.
