---
title: Coverage, Dependency, and Index Correctness
description: >
  Stop omitting maintained code and stop converting unsupported analysis into
  clean results.
prompt: |
  I want you to do a complete end to end Audit for the possible improvements
  of the entire bug-hunter plugin. First understand what it does, then
  understand the logic and see what if we can actually improve everything
  end-to-end. If there's any slightly chance of improvements in the system,
  build a complete end-to-end plan. But ensure do audit every perspective,
  every logic, and do in everything that you want to do.
---

# Coverage, Dependency, and Index Correctness

## Goal

All maintained source should remain in the scan queue, even if it has lower
priority. Dependency support must be truthful per ecosystem, and analysis
failures must remain unknown rather than being reported clean.

## Scope

Modify:

- @scripts/triage.cjs
- @scripts/dep-scan.cjs
- @scripts/code-index.cjs
- @README.md
- @SKILL.md
- Relevant tests and local fixtures under @scripts/tests

## Implementation steps

1. Define coverage semantics.
   - Priority controls order, not inclusion.
   - Context-only tests can be excluded from bug reporting but remain readable.
   - Generated and vendored code is excluded by verified project rules.
   - Maintained `bin`, `scripts`, and `tools` code stays eligible.

2. Fix triage correctness.
   - Use nullish fallback for tier rank so CRITICAL remains zero.
   - Remove blanket `bin` exclusion.
   - Evaluate security and execution patterns before low-directory hints.
   - Append low-tier production files after medium files.
   - Validate depth as a nonnegative bounded integer.
   - Expose excluded files with explicit reasons.

3. Remove shell construction from dependency scanning.
   - Spawn every external tool with argument arrays.
   - Escape regular expressions for the search tool, not for a shell.
   - Validate target realpath and keep it inside the requested scan root.

4. Define dependency status as:

```text
vulnerable-reachable
vulnerable-not-found-in-source
vulnerable-reachability-unknown
scanner-clean
scanner-unsupported
scanner-failed
```

Never collapse unsupported, missing tool, timeout, malformed output, or search
failure into clean or not reachable.

5. Implement or de-advertise ecosystems.
   - Add versioned JSON fixtures and parsers for npm/pnpm/yarn/bun.
   - Add pip, Go, and Rust only when their actual supported tool output is
     parsed and tested.
   - Until then, return `scanner-unsupported` and update docs.
   - De-duplicate advisories found through multiple lockfiles.

6. Use ecosystem-specific reachability.
   - JavaScript: static, side-effect, dynamic, require, export, subpath.
   - Python: import, from-import, relative import, normalized package name.
   - Go: module and imported package path.
   - Rust: crate name normalization and source use.
   - Mark ambiguous or dynamic use as unknown.

7. Fix the general code index.
   - Add JavaScript side-effect imports.
   - Resolve Python relative imports by package depth and `__init__.py`.
   - Keep unresolved imports visible with a reason.

8. Add mixed-language local fixtures. Use fake executables for scanner output;
   do not require network access in the deterministic suite.

## Verification

```bash
node --test scripts/tests/triage.test.cjs
node --test scripts/tests/dep-scan.test.cjs
node --test scripts/tests/code-index.test.cjs
pnpm test
```

## Acceptance criteria

- Mixed-tier scans queue CRITICAL, HIGH, MEDIUM, then LOW maintained source.
- @bin/bug-hunter appears in this repository's own scan scope.
- Scanner or search failure is never shown as clean or not reachable.
- Every advertised ecosystem has parser and reachability fixtures.
- Shell metacharacters in a repository path remain inert.
- Index tests cover side-effect JavaScript and Python relative imports.
