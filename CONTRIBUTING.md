---
title: Contributing to Bug Hunter
description: >
  Set up the source checkout, change runtime or role contracts, and validate a
  pull request against the measurable precision-first quality gate.
prompt: |
  Keep contributor changes aligned with package scripts, generated artifacts,
  canonical role skills, benchmark gates, source-integrity invariants, and the
  current Bug Hunter orchestration contract.
---

# Contributing to Bug Hunter

Thanks for contributing to Bug Hunter, an open-source adversarial code-audit
skill for AI coding agents.

## Ways to contribute

- **Report bugs** with reproducible behavior and affected version/commit.
- **Improve role skills** under `skills/` when evidence shows a false positive
  or missed real bug.
- **Improve deterministic scope/retrieval** without weakening source-integrity
  or coverage truthfulness.
- **Improve verification** with bounded, argv-only checks and clear required vs
  optional semantics.
- **Improve benchmarks** with stronger blinded fixtures, metrics, and baselines.
- **Improve scripts** for reliability, performance, portability, and safety.
- **Improve documentation** while keeping package/source and public/internal
  interfaces accurate.

## Development setup

```bash
git clone https://github.com/codexstar69/bug-hunter.git
cd bug-hunter
pnpm install --frozen-lockfile

# Full repository quality gate
pnpm quality:world-class
```

`quality:world-class` currently covers:

- generated schema validators and compatibility prompts;
- the complete Node test suite;
- the deterministic benchmark quality gate;
- runtime preflight;
- npm package inventory verification.

Individual commands remain useful while iterating:

```bash
pnpm check:generated
pnpm test
pnpm benchmark:gate
node scripts/run-bug-hunter.cjs preflight --skill-dir .
pnpm verify:package
```

Optional Context Hub CLI for documentation-verification development:

```bash
npm install -g @aisuite/chub
```

## Pull request guidelines

1. Keep the change focused and explain the behavioral contract it changes.
2. Run `pnpm quality:world-class` before requesting review.
3. If changing role behavior, describe the real false positive/missed bug that
   motivates it and the expected precision/recall tradeoff.
4. If changing adaptive policy, retrieval, caching, or verification, add a
   deterministic regression that proves the safety/cost invariant.
5. If changing artifact shape, update the schema, generated validator, docs,
   examples, and consumers together.
6. Update `CHANGELOG.md` for user-visible behavior.
7. Do not claim “world-class” from the bundled fixture alone; external claims
   require unseen/blinded evaluation as described in
   `docs/world-class-protocol.md`.

## Code style

- Runtime scripts use CommonJS (`.cjs`) for broad agent-runtime compatibility.
- Prefer Node.js built-ins for runtime paths; development-only generation and
  validation may use declared dev dependencies.
- Pass untrusted values as argv/data, not interpolated shell strings.
- Preserve repository containment, exact source identity, output/time bounds,
  and fail-closed behavior in security-sensitive helpers.
- Keep canonical JSON machine-readable; derive Markdown views from it.

## Role and prompt changes

Canonical role instructions live in `skills/*/SKILL.md`. Compatibility prompt
files under `prompts/` are generated copies and must not be edited directly.
After changing a canonical role skill:

```bash
pnpm generate:compat-prompts
pnpm check:generated
```

When submitting role changes:

- show the prior false positive or missed real bug;
- show why the new rule does not suppress an adjacent real bug class;
- consider Hunter, Skeptic, and Referee together as one adversarial system;
- keep examples progressive/conditional rather than loading calibration text
  into every assignment;
- preserve immutable scope and Referee-only fix authorization.

## Benchmark and protocol changes

The bundled benchmark is calibration/regression data, not an external ranking.
Protocol changes should keep measurements reproducible and disclose any changed
thresholds or cost assumptions.

Read:

- `docs/precision-protocol.md` for evidence/scope invariants;
- `docs/world-class-protocol.md` for metrics, adaptive policy, retrieval,
  evidence cache, and hybrid verification;
- `modes/dispatch.md` for backend-neutral delegation boundaries.

## License

By contributing, you agree that your contributions are licensed under the MIT
License.
