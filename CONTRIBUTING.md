---
title: Contributing to Bug Hunter
description: >
  Set up the source checkout, change runtime or prompt contracts, and validate
  a pull request.
prompt: |
  Keep contributor setup aligned with @package.json,
  @.github/workflows/ci.yml, @scripts/tests/, and @SKILL.md.
---

# Contributing to Bug Hunter

Thanks for your interest in contributing. Bug Hunter is an open-source adversarial code auditing skill for AI coding agents.

## Ways to Contribute

- **Report bugs** — open an issue with reproduction steps
- **Improve role skills** — the agent instructions in `skills/` are the core of Bug Hunter's accuracy; PRs that reduce false positives or catch more real bugs are highly valued
- **Add calibration examples** — `skills/hunter/examples.md` and `skills/skeptic/examples.md` tune agent behavior; more real-world examples improve precision
- **Improve scripts** — the Node.js helpers in `scripts/` handle triage, state, and orchestration; performance and reliability improvements welcome
- **Documentation** — fix typos, clarify instructions, add usage examples

## Development Setup

```bash
git clone https://github.com/codexstar69/bug-hunter.git
cd bug-hunter
pnpm install --frozen-lockfile

# Verify generated runtime files and run the suite
pnpm check:generated
pnpm test

# Run the runtime preflight
node scripts/run-bug-hunter.cjs preflight --skill-dir .

# Inspect the npm package allowlist
pnpm verify:package

# Optional: install Context Hub CLI for doc verification testing
npm install -g @aisuite/chub
```

## Pull Request Guidelines

1. Keep PRs focused — one concern per PR
2. Test your changes against the `test-fixture/` directory
3. If modifying agent prompts, explain the reasoning and expected impact on false positive / true positive rates
4. Run `pnpm check:generated` and `pnpm test`
5. Run `node scripts/run-bug-hunter.cjs preflight --skill-dir .` to verify preflight checks
6. Update `CHANGELOG.md` with your changes

## Code Style

- Scripts use CommonJS (`.cjs`) for maximum compatibility across agent runtimes
- Runtime scripts use Node.js built-ins; generation and validation commands
  use the development dependencies declared in `package.json`
- Prompts are markdown — keep them concise and structured

## Prompt Changes

Changes to role skills (`skills/*/SKILL.md`) have outsized impact. The files in
`prompts/` are generated compatibility copies and must not be edited directly.
When submitting role-skill changes:

- Describe the false positive or missed bug that motivated the change
- Show before/after behavior if possible
- Consider impact on all three agents (Hunter, Skeptic, Referee) — they form an adversarial system

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
