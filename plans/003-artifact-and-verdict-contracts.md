---
title: Artifact and Verdict Contracts
description: >
  Establish one versioned artifact graph from Recon through Referee and Fixer.
prompt: |
  I want you to do a complete end to end Audit for the possible improvements
  of the entire bug-hunter plugin. First understand what it does, then
  understand the logic and see what if we can actually improve everything
  end-to-end. If there's any slightly chance of improvements in the system,
  build a complete end-to-end plan. But ensure do audit every perspective,
  every logic, and do in everything that you want to do.
---

# Artifact and Verdict Contracts

## Goal

Every phase must emit exactly one validated canonical artifact. No phase may
overwrite an earlier artifact with a different shape. Only Referee-confirmed
bugs may enter a fix strategy or Fixer assignment.

## Scope

Modify:

- @schemas
- @scripts/payload-guard.cjs
- @scripts/schema-runtime.cjs
- @scripts/render-report.cjs
- @scripts/run-bug-hunter.cjs
- @skills/recon/SKILL.md
- @skills/hunter/SKILL.md
- @skills/skeptic/SKILL.md
- @skills/referee/SKILL.md
- @skills/fixer/SKILL.md
- @modes
- @templates/subagent-wrapper.md
- Contract tests under @scripts/tests

## Canonical artifact graph

Use distinct paths and distinct schemas:

| Phase | Canonical path | Shape |
|---|---|---|
| Recon | `.bug-hunter/recon.json` | risk-map object |
| Hunter | `.bug-hunter/hunter-findings.json` | finding array |
| Skeptic | `.bug-hunter/skeptic.json` | challenge array |
| Referee | `.bug-hunter/referee.json` | verdict array |
| Final scan | `.bug-hunter/scan-report.json` | metadata plus confirmed/dismissed |
| Strategy | `.bug-hunter/fix-strategy.json` | approved strategy |
| Plan | `.bug-hunter/fix-plan.json` | canary and rollout |
| Fixer | `.bug-hunter/fix-report.json` | fix and verification results |

Markdown files are rendered views, never source-of-truth artifacts.

## Implementation steps

1. Freeze and test the current intended schemas with valid and invalid
   fixtures. Decide one field naming convention and one severity enum.

2. Fix role instructions.
   - Recon writes JSON; render a Markdown companion separately.
   - Hunter writes only the array. Coverage moves to a separate coverage
     artifact or wrapper metadata.
   - Fixer writes the exact `fix-report` schema.
   - Remove every instruction that requires prose after canonical JSON.

3. Split Hunter findings from the final scan report.
   - Never write the summary object to the Hunter path.
   - Add a dedicated `scan-report` schema and renderer.
   - Support reading the old path only through an explicit migration adapter.
   - Never guess object shape by converting non-arrays to `[]`.

4. Restore the missing dispatch contract.
   - Prefer one canonical tracked dispatch module used by every mode.
   - Define backend capability checks, wrapper construction, output
     validation, fallback behavior, and worktree lifecycle.
   - Add every required file to preflight and package-integrity checks.

5. Replace the no-op autonomous worker default.
   - Require a valid backend adapter or explicit worker command.
   - Fail preflight before creating state when no worker can emit the required
     artifact.
   - Make the documented command runnable as written.

6. Enforce the phase state machine:

```text
recon -> hunter -> skeptic -> referee -> scan-report
                                         |
                                   explicit --fix
                                         v
                              strategy -> plan -> fixer
```

7. Join Referee verdicts by stable finding ID.
   - Reject duplicate and missing IDs.
   - Keep unmatched findings visible as `UNREVIEWED`.
   - Build strategy and plan only from `REAL_BUG`.
   - Use Referee severity and confidence, not Hunter confidence.
   - Derive `executionStage` after canary and rollout placement.

8. Make report generation complete.
   - Render confirmed, dismissed, and unreviewed findings.
   - Make counts derive from the rendered sets.
   - Fail on an artifact/schema mismatch instead of showing an empty report.

## Verification

```bash
node --test scripts/tests/payload-guard.test.cjs
node --test scripts/tests/render-report.test.cjs
node --test scripts/tests/run-bug-hunter.test.cjs
pnpm test
```

Add one fixture that executes each documented phase command and validates every
written artifact. Add one negative fixture for each current mismatch.

## Acceptance criteria

- No canonical path accepts two shapes.
- Every role instruction matches its enforced schema.
- Every internal mode reference resolves in the packed package.
- The documented autonomous command either runs or fails at preflight with a
  precise capability error.
- A dismissed, missing, or malformed Referee verdict can never reach Fixer.
- Reports cannot silently lose findings.

## Migration

For one minor release, detect old `.bug-hunter/findings.json` shapes and print a
clear migration message. Do not mutate old artifacts automatically. Remove the
adapter in the next major release.
