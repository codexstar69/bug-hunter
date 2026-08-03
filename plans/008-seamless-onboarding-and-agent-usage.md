---
title: Seamless onboarding and agent usage
description: >
  Give people and coding agents one accurate path from installation through
  verification, scanning, review, and approved fixing.
prompt: |
  can we do that so everything is end to end seamless and anyone and
  specially agents can understand easily how to use it all properly

  Use @README.md, @bin/bug-hunter, @package.json,
  @scripts/tests/documentation-contract.test.cjs,
  @scripts/tests/installer-atomic.test.cjs, @CHANGELOG.md, and
  https://docs.npmjs.com/trusted-publishers/ as source material.
---

# Seamless onboarding and agent usage

## Goal

A first-time user should be able to choose an agent, install Bug Hunter,
verify the exact installation, run a scan without edits, understand the
result, and opt into fixes without guessing.

The same path must work for agents that support slash commands and agents that
only understand natural-language skill requests.

## Current problems

- The README mixes installation, tutorials, concepts, reference material, and
  historical release notes in one long page.
- Auto-detection can select the wrong target when several agent directories
  exist.
- The installer prints a slash command as the only usage instruction.
- `doctor` checks the environment but not the installed skill.
- Some README capability claims do not match the current implementation.
- Some loop examples omit a required worker command or use invalid shell
  continuation syntax.
- Referee and Git/worktree safety failures can still leave fixing enabled in
  the written orchestration contract.
- The npm package is older than the GitHub source until npm publishing access
  is restored.

## Implementation

1. Make the README the short product and quick-start page.
2. Add focused guides for installation, agent usage, CLI reference,
   architecture, outputs, and troubleshooting.
3. Make explicit `--agent` selection the recommended installation path.
4. Add `doctor --agent` and `doctor --path` so users can verify the exact
   installed manifest, version, and required runtime files.
5. Print an agent-neutral prompt after installation, followed by the optional
   slash-command form.
6. Ship the focused guides in the npm package.
7. Add regression tests for links, capability claims, package inventory, and
   install verification.
8. Update LLM-facing summaries, version, and changelog.
9. Make Referee and mutation-safety failures disable fixing, and correct the
   internal loop examples.
10. Run focused tests, the full suite, package inventory, and a packed-install
   smoke test.
11. Publish only after GitHub source proof and npm authentication both pass.

## Verification

```bash
node --test scripts/tests/documentation-contract.test.cjs
node --test scripts/tests/installer-atomic.test.cjs
pnpm check:generated
pnpm test
pnpm verify:package
pnpm pack --dry-run
git status --short
```

The smoke test must install into a repository-local `tmp/` directory, verify
with `doctor --path`, upgrade the same target, and verify it again.

## Acceptance criteria

- The first screen gives one recommended install command and one safe scan
  prompt.
- Every supported agent has an exact install and verification command.
- Natural-language invocation is the default documented interface.
- Scan-only behavior is stated before any fixing examples.
- Fixing and committing require explicit user authorization.
- Unsupported dependency ecosystems are reported honestly.
- Every internal Markdown link resolves.
- All onboarding guides ship in the npm tarball.
- A clean install and an upgrade both pass targeted doctor checks.
- Publication status is reported separately for GitHub and npm.
