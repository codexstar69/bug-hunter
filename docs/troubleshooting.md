---
title: Troubleshooting
description: >
  Diagnose installation, agent discovery, source-integrity, scan, verification,
  and publication failures without hiding unsupported or unresolved states.
prompt: |
  Diagnose Bug Hunter failures from the current package/source identity and
  canonical artifacts. Never reinterpret missing review, failed coverage,
  unsupported scanners, or required-verification failure as a clean result.
---

# Troubleshooting

## The agent cannot find Bug Hunter

Verify the same package source and target used during installation.

Published package:

```bash
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter doctor --agent codex
```

Current GitHub source:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

Then:

1. confirm the target name matches the agent;
2. restart the agent;
3. open a new agent session in the repository;
4. ask: `Use the bug-hunter skill to scan this repository. Do not edit files.`

For a nonstandard skill directory, install and verify with the same `--path`.

## Doctor reports an old or mismatched version

Keep install and doctor on the same package source.

Published package refresh:

```bash
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter install --agent codex
npm exec --yes --package=@codexstar/bug-hunter@latest -- bug-hunter doctor --agent codex
```

Current-source refresh:

```bash
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz install --agent codex
npx --yes https://github.com/codexstar69/bug-hunter/archive/refs/heads/main.tar.gz doctor --agent codex
```

If a global CLI reports another version:

```bash
bug-hunter --version
npm list -g @codexstar/bug-hunter
npm view @codexstar/bug-hunter version
```

Do not use an old global CLI to validate a newer GitHub-source install.

## Doctor reports a manifest problem

Do not edit `.bug-hunter-install-manifest.json` by hand. Reinstall the exact
target from the intended package source. The installer stages and validates a
replacement before swapping it into place.

Normal upgrades preserve files outside the managed manifest. Back up user-owned
files before any manual removal.

## Node.js is unsupported

Bug Hunter requires Node.js 22 or newer:

```bash
node --version
```

Upgrade Node.js, then run doctor again.

## Git is missing

Git is required for branch/PR fallback scope and the complete guarded fix
pipeline. Basic path scanning may still be possible, but branch safety,
worktree isolation, rollback, and commit checks require Git.

## Context Hub is missing

Context Hub is optional:

```bash
npm install -g @aisuite/chub
```

Without it, Bug Hunter can use the bundled Context7 fallback. Missing
version-specific documentation lowers confidence; it does not authorize a
framework-behavior guess.

## The scan produced no final report

Ask the agent to report:

- resolved target and selected mode;
- preflight result;
- failed phase names;
- missing/invalid canonical artifacts;
- `.bug-hunter/` contents;
- coverage state;
- source-integrity failures;
- required hybrid-verification status.

An interrupted/invalid pipeline is not a clean result.

## Findings are missing adversarial review

Check `.bug-hunter/scan-report.json`. Nonzero `manualReview` or `unreviewed`
counts mean work remains.

Request:

```text
Use the bug-hunter skill to finish adversarial review for every unreviewed
finding. Do not edit files.
```

## Coverage is incomplete

The public default is single-pass. If the target requires complete queued
coverage, rerun with:

```text
/bug-hunter --loop
```

Do not mark a file covered merely because its parent chunk says done; current
coverage is per-file evidence driven.

## A source-integrity check failed

Mutation/deletion/unreadability/symlink escape during scanning intentionally
fails the affected chunk closed. Do not overwrite the baseline and continue.

Resolve the source/Git change, then start a run whose identity matches the
current intended source. Resume should not silently adopt drifted content.

## Required hybrid verification failed

Read `.bug-hunter/verification-report.json` and identify the required check that
failed, timed out, or was unavailable. Required verification failure blocks
Fixer authorization by design.

Do not downgrade a required check to optional merely to make the run green.
Correct the environment/check plan or keep the finding/remediation unresolved.

## Evidence cache did not reuse prior facts

Cache reuse is intentionally exact-match only. Changes to source hashes,
protocol identity, role, hypothesis, relevant options, age, or cache integrity
can invalidate a prior entry. A miss is safer than stale evidence reuse.

## Dependency scan says `scanner-unsupported`

Bundled dependency parsing/reachability currently supports JavaScript and
TypeScript lockfiles for npm, pnpm, Yarn, and Bun. Use the ecosystem's native
audit tool for an unsupported ecosystem and provide its result as additional
evidence if appropriate.

Never interpret `scanner-unsupported` as “no vulnerabilities.”

## A fix run stopped

Read:

- `.bug-hunter/fix-strategy.json`;
- `.bug-hunter/fix-plan.json`;
- `.bug-hunter/fixer-scope.json`;
- `.bug-hunter/fix-report.json`;
- `.bug-hunter/verification-report.json` when present;
- `.bug-hunter/state.json` and validation logs.

Do not bypass a failed canary, immutable-scope violation, required verification,
dirty-worktree guard, preservation failure, or circuit breaker. Recover the
named worktree/file/check first.

## Benchmark quality gate failed

Run:

```bash
pnpm benchmark:gate
```

Inspect `.bug-hunter/benchmark/report.json`. The bundled fixture validates the
measurement contract and should be deterministic. Do not relax thresholds just
to make an unexplained regression pass; identify whether precision, recall,
calibration, stability, cost, or latency changed.

## The npm version differs from GitHub

GitHub source and npm publication are separate release states:

```bash
npm view @codexstar/bug-hunter version
```

Use npm for the latest published release. Use the GitHub-source installation
only when you intentionally want the current `main` commit before/independent of
a package release.

## Report a problem

Include:

- `bug-hunter --version` or the exact package source;
- `node --version`;
- install target name;
- failing command;
- complete non-secret error text;
- relevant canonical artifact/status;
- whether source files, Git state, or commits changed.

Do not include secrets, tokens, private source, or production data.

Open a normal issue at
[github.com/codexstar69/bug-hunter/issues](https://github.com/codexstar69/bug-hunter/issues).
For vulnerabilities in Bug Hunter itself, follow [`SECURITY.md`](../SECURITY.md).
