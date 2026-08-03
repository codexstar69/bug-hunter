---
title: Troubleshooting
description: >
  Diagnose installation, agent discovery, environment, scan, and publication
  failures without hiding unsupported states.
prompt: |
  can we do that so everything is end to end seamless and anyone and
  specially agents can understand easily how to use it all properly

  you removed a lot of content that helped rank it om google - bring it back

  Use @bin/bug-hunter, @README.md, @docs/agent-installation.md,
  @docs/getting-started.md, @SKILL.md, and @SECURITY.md as source material.
---

# Troubleshooting

## The agent cannot find Bug Hunter

Verify the same target used during installation:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

Then:

1. Confirm the target name matches the agent.
2. Restart the agent.
3. Open a new agent session in the repository.
4. Ask: `Use the bug-hunter skill to scan this repository. Do not edit files.`

If the agent uses a nonstandard skill directory, reinstall and verify with
`--path`.

## Doctor reports an old version

Run installation and verification with the same package source:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent codex
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

If a global `bug-hunter` command reports another version, check:

```bash
bug-hunter --version
npm list -g @codexstar/bug-hunter
```

Use either the `npx` path or the global path consistently.

## Doctor reports a manifest problem

Do not edit the manifest by hand. Reinstall the exact target. The installer
stages and validates a replacement before swapping it into place.

If the target contains user-owned files, keep a backup before manual removal.
Files outside the manifest are preserved by normal upgrades.

## Node.js is unsupported

Bug Hunter requires Node.js 22 or newer:

```bash
node --version
```

After upgrading Node.js, run doctor again.

## Git is missing

Git is required for the complete fix pipeline. A scan can still be requested,
but branch scope, worktree isolation, rollback, and commit checks need Git.

Install Git for the operating system, then run doctor again.

## Context Hub is missing

Context Hub is optional. Install it for curated documentation:

```bash
npm install -g @aisuite/chub
```

Without it, Bug Hunter uses the bundled Context7 path.

## The scan produced no report

Ask the agent to report:

- the selected Bug Hunter mode
- the resolved target path
- the preflight result
- failed phase names
- missing or invalid artifacts
- `.bug-hunter/` contents

An interrupted or invalid pipeline is not a clean result.

## Findings are missing review

Check `.bug-hunter/scan-report.json`. Nonzero `manualReview` or `unreviewed`
counts mean work remains.

Request:

```text
Use the bug-hunter skill to finish adversarial review for every unreviewed
finding. Do not edit files.
```

## Dependency scan says `scanner-unsupported`

The bundled dependency parser and reachability analysis currently support
JavaScript and TypeScript lockfiles. Use the ecosystem's native audit tool for
Python, Go, or Rust, then give its result to the agent as additional evidence.

Do not interpret `scanner-unsupported` as no vulnerabilities.

## A fix run stopped

Read:

- `.bug-hunter/fix-report.json`
- `.bug-hunter/fix-plan.json`
- `.bug-hunter/state.json`
- the agent's validation logs

Do not bypass a failed canary, scope violation, dirty-worktree guard, or
preservation failure. Recover the named worktree or file first.

## The npm version differs from GitHub

GitHub source and npm publication are separate release states. Check:

```bash
npm view @codexstar/bug-hunter version
```

Use the npm package for published releases. Use the source-install steps in
[agent installation](agent-installation.md) only when you intentionally want
an unreleased GitHub commit.

## Report a problem

Include:

- `bug-hunter --version`
- `node --version`
- the install target name
- the failing command
- the complete error text
- whether the source tree or Git state changed

Do not include secrets, tokens, private source code, or production data.

Open an issue at
[github.com/codexstar69/bug-hunter/issues](https://github.com/codexstar69/bug-hunter/issues).
