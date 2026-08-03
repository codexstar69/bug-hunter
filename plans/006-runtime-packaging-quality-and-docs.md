---
title: Runtime, Packaging, Quality, and Documentation
description: >
  Ship a smaller, reproducible package with real end-to-end quality gates and
  accurate docs.
prompt: |
  I want you to do a complete end to end Audit for the possible improvements
  of the entire bug-hunter plugin. First understand what it does, then
  understand the logic and see what if we can actually improve everything
  end-to-end. If there's any slightly chance of improvements in the system,
  build a complete end-to-end plan. But ensure do audit every perspective,
  every logic, and do in everything that you want to do.
---

# Runtime, Packaging, Quality, and Documentation

## Goal

The packed package, installed skill, CI suite, eval system, release provenance,
and public documentation must all describe and exercise the same product.

## Scope

Modify:

- @package.json
- @bin/bug-hunter
- @.github/workflows/ci.yml
- @.github/workflows/publish.yml
- @scripts/prepublish-guard.cjs
- @scripts/tests
- @evals
- @test-fixture
- @README.md
- @CONTRIBUTING.md
- @CHANGELOG.md
- @llms.txt
- @llms-full.txt
- @prompts and @skills after eval baselines exist

## Implementation steps

1. Move to a supported Node baseline.
   - Choose a currently supported minimum, preferably Node 22.
   - Test active LTS and current releases in CI.
   - Make `doctor` parse the major version and fail below the package engine.
   - Keep CommonJS compatibility explicit.

2. Decide reproducibility policy.
   - The package has no declared dependencies, but CI and release tooling still
     need a documented package-manager and lockfile policy.
   - Make `pnpm audit` behavior explicit when no lockfile exists.

3. Make installation atomic.
   - Define one runtime allowlist shared by npm packing and skill installation.
   - Copy into a sibling staging directory.
   - Validate preflight there.
   - Atomically swap the managed installation and keep a rollback copy.
   - Remove stale managed files but preserve documented user-owned files.

4. Slim the package.
   - Exclude screenshots, historical plans, and test fixtures from runtime
     installation.
   - Keep README images at stable hosted URLs.
   - Add maximum packed and installed size checks.

5. Test the real adapters.
   - Pack the tarball and inspect its inventory.
   - Install into a sandbox twice, including an upgrade with a removed file.
   - Run doctor, info, preflight, and one safe scan-contract smoke test from the
     installed copy.
   - Test external adapters with fake local executables and fixture output.
   - Verify every Markdown file and internal mode reference resolves.

6. Build an executable evaluation system.
   - Move expected answers outside the scanned fixture.
   - Include positive and negative examples.
   - Score finding ID, file, line tolerance, category, severity, and verdict.
   - Report Hunter recall, false-positive rate, Referee precision, runtime,
     token use, and cost.
   - Run deterministic contracts in every PR.
   - Run model-backed repeated trials on prompt changes or scheduled CI.
   - Record model, prompt hash, seed where available, date, and confidence
     interval.

7. Consolidate role sources after the benchmark exists.
   - Make @skills the canonical role definitions.
   - Keep only examples or generated compatibility assets under @prompts.
   - Add a check that no runtime mode references a removed legacy prompt.

8. Bind release to source.
   - Require exact `v${package.version}` at `HEAD` for every publish path.
   - Remove or protect unrestricted manual publication.
   - Use the actual upstream branch instead of hard-coded `origin/main`.
   - Fail closed when upstream or tag checks cannot run.
   - Enable npm provenance where supported.

9. Generate volatile documentation.
   - Test counts come from discovery.
   - Package tree comes from the pack inventory.
   - Supported backends and capabilities come from one registry.
   - Ecosystem claims come from executable fixtures.
   - Update README, contributor guide, llms files, and changelog together.

10. Prepare the public package release only after all earlier plans pass.
    - Follow the repository's public-package version and changelog rules.
    - Do not publish or commit; hand the verified release diff to the user.

## Verification

```bash
pnpm test
pnpm pack --dry-run
node bin/bug-hunter doctor
node scripts/run-bug-hunter.cjs preflight --skill-dir .
git status --short
```

CI must run supported Node versions and include:

- Unit and integration tests.
- Pack inventory and size limits.
- Isolated install and upgrade.
- Internal link and capability consistency.
- Deterministic eval contracts.
- Tag and source provenance checks in release jobs.

## Acceptance criteria

- The package and installed skill contain only runtime-required assets.
- Upgrade removes stale managed files and is recoverable after interruption.
- CI tests supported Node releases, not only EOL releases.
- Every advertised capability has an executable check.
- Quality claims include measured precision and recall with provenance.
- Publication is impossible without an exact source tag.
- Public docs contain no hand-maintained test count or stale package tree.

## References

- @package.json
- @.github/workflows/ci.yml
- @.github/workflows/publish.yml
- @bin/bug-hunter
- @evals/evals.json
- https://nodejs.org/en/about/eol
