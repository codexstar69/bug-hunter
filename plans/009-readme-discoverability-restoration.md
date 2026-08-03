---
title: README discoverability restoration
description: >
  Restore detailed product, security, workflow, and ecosystem coverage in the
  README without reintroducing stale or unsafe claims.
prompt: |
  you removed a lot of content that helped rank it om google - bring it back

  Use @README.md, @SKILL.md, @docs/how-it-works.md,
  @docs/usage-guide.md, @skills/hunter/SKILL.md,
  @skills/skeptic/SKILL.md, @skills/referee/SKILL.md,
  @modes/fix-pipeline.md, @scripts/dep-scan.cjs,
  @scripts/tests/documentation-contract.test.cjs, @CHANGELOG.md, and the
  README from git commit a61e5fd as source material.
---

# README discoverability restoration

## Goal

Keep the current fast installation and agent onboarding path at the top of the
README while restoring the detailed explanations that help people discover,
understand, evaluate, and safely use Bug Hunter.

## Accuracy boundaries

- Restore real topic coverage, not repeated keyword lists.
- Describe dependency scanning as JavaScript and TypeScript only.
- Describe source analysis separately from dependency parsing.
- State that fixes, unattended edits, and commits require separate permission.
- Do not claim that dirty work is automatically stashed.
- Do not claim that every failed change can always be reverted.
- Use the canonical artifact names from the current runtime.
- Keep test counts dynamic instead of copying a number into the README.
- Describe the Skeptic's current 14 hard exclusions, not the older count of 15.

## Implementation

1. Preserve the agent-first quick start and scan-only prompt.
2. Add a table of contents for the detailed product guide.
3. Restore the AI code-review problem statement and adversarial pipeline.
4. Restore detailed sections for triage, behavioral analysis, documentation
   verification, false-positive reduction, and evidence contracts.
5. Restore STRIDE, CWE, CVSS, threat-model, dependency, PR-review, fix-planning,
   and CI/CD artifact coverage.
6. Restore complete output, language, framework, argument, validation, and
   project-architecture references.
7. Reuse the existing product diagrams with accurate alt text.
8. Update the changelog and add a semantic coverage regression test.
9. Run focused documentation tests, the full suite, and package verification.
10. Commit and push the correction, then verify GitHub CI.

## Verification

```bash
node --test scripts/tests/documentation-contract.test.cjs
pnpm test
pnpm verify:package
pnpm pack --dry-run
git diff --check
```

## Acceptance criteria

- The first screen still answers how to install, verify, and run a safe scan.
- The README again explains the full product, security model, pipeline, and
  supported ecosystem in substantial detail.
- Important code-audit and security topics have dedicated headings and useful
  explanatory content.
- All restored claims match the current runtime contracts.
- Stale paths and unsupported dependency claims remain absent.
- Every local link resolves and every referenced image is reachable.
- The packaged README contains the restored content.
