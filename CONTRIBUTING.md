# Contributing to Bug Hunter

Thanks for your interest in contributing. Bug Hunter is an open-source adversarial code auditing skill for AI coding agents.

## Ways to Contribute

- **Report bugs** — open an issue with reproduction steps
- **Improve prompts** — the agent prompts in `prompts/` are the core of Bug Hunter's accuracy; PRs that reduce false positives or catch more real bugs are highly valued
- **Add calibration examples** — `prompts/examples/` contains few-shot examples that tune agent behavior; more real-world examples improve precision
- **Improve scripts** — the Node.js helpers in `scripts/` handle triage, state, and orchestration; performance and reliability improvements welcome
- **Documentation** — fix typos, clarify instructions, add usage examples

## Development Setup

```bash
git clone https://github.com/codexstar69/bug-hunter.git
cd bug-hunter

# Run the test suite (25 tests)
node --test scripts/tests/*.test.cjs

# Run the self-test against the test fixture
node scripts/run-bug-hunter.cjs preflight --skill-dir .

# Optional: install Context Hub CLI for doc verification testing
npm install -g @aisuite/chub
```

## Pull Request Guidelines

1. Keep PRs focused — one concern per PR
2. Test your changes against the `test-fixture/` directory
3. If modifying agent prompts, explain the reasoning and expected impact on false positive / true positive rates
4. Run `node --test scripts/tests/*.test.cjs` to verify all tests pass
5. Run `node scripts/run-bug-hunter.cjs preflight --skill-dir .` to verify preflight checks
6. Update `CHANGELOG.md` with your changes

## Code Style

- Scripts use CommonJS (`.cjs`) for maximum compatibility across agent runtimes
- No external dependencies in scripts — Node.js built-ins only
- Prompts are markdown — keep them concise and structured

## Prompt Changes

Changes to agent prompts (`prompts/*.md`) have outsized impact. When submitting prompt changes:

- Describe the false positive or missed bug that motivated the change
- Show before/after behavior if possible
- Consider impact on all three agents (Hunter, Skeptic, Referee) — they form an adversarial system

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
