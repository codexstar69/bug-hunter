## What does this PR do?

Brief description of the change.

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Prompt improvement (changes to agent prompts in `prompts/`)
- [ ] Script improvement (changes to `scripts/*.cjs`)
- [ ] Documentation update
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)

## Checklist

- [ ] `node scripts/run-bug-hunter.cjs preflight --skill-dir .` passes
- [ ] Changes tested against `test-fixture/` directory
- [ ] `CHANGELOG.md` updated
- [ ] No new external dependencies added to scripts

## For prompt changes

- [ ] Described the false positive or missed bug that motivated the change
- [ ] Considered impact on all three agents (Hunter, Skeptic, Referee)
- [ ] Added calibration example to `prompts/examples/` if applicable
