# Changelog

## 2026-03-07

### Added
- **Auto-fix pipeline** (`--fix`): Parallel Fixers in isolated git worktrees, checkpoint commits, test verification, auto-revert on regression, post-fix re-scan
- **Loop mode** (`--loop`): Iterates until 100% coverage, tracks state in checksummed coverage files
- **Combined fix-loop** (`--loop --fix`): Find, fix, and verify until clean
- **Staged file mode** (`--staged`): Scan staged files as a pre-commit check
- **Recon agent**: Maps architecture, trust boundaries, and computes dynamic context budget
- **Dual-lens Hunters**: Security Hunter + Logic Hunter scan in parallel with different focuses
- **Security checklist sweep**: Mandatory per-file pass in Hunter for hardcoded secrets, JWT expiry, input validation, auth gaps, data exposure
- **Context7 doc verification**: Verifies library/framework behavior claims against real documentation
- **Modular architecture**: SKILL.md split into slim core + mode files loaded on demand
- **Preflight checks**: Validates Context7 API key and Node.js availability at startup
- **Self-test fixture**: Express app with 6 planted bugs for pipeline validation
- **Portability**: All paths use `~/.claude/skills/bug-hunter`, Context7 script bundled in `scripts/`

### Changed
- Extended and Scaled modes for larger codebases (41-80 and 81-120 files)
- Skeptic directory clustering for efficient file reads
- Referee re-check pass for high-severity Skeptic disproves
- Evidence anchoring: Hunter must quote exact code; Referee spot-checks quotes

## 2026-03-05

- Added branch diff mode: `/bug-hunter -b <branch> [--base <base>]`
## 2026-03-05 -- Initial Release

- 3-agent adversarial bug hunting (Hunter, Skeptic, Referee)
- Supports scanning full project, specific directories, or individual files
