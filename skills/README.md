# Bundled Skills

Bug Hunter ships with all agent skills under `skills/` so the repository stays portable and self-contained.

## Core Agent Skills

These are the primary pipeline agents — migrated from `prompts/` to be first-class skills:

| Skill | Purpose |
|-------|---------|
| `hunter/` | Deep behavioral code analysis — finds logic errors, security vulnerabilities, race conditions |
| `skeptic/` | Adversarial code reviewer — challenges each finding to kill false positives |
| `referee/` | Independent final arbiter — delivers verdicts with CVSS scoring and PoC generation |
| `fixer/` | Surgical code repair — implements minimal, precise fixes for verified bugs |
| `recon/` | Codebase reconnaissance — maps architecture, trust boundaries, and risk priorities |
| `doc-lookup/` | Unified documentation access — Context Hub (chub) + Context7 API for framework verification |

## Security Skills

Specialized security workflows that integrate with the main Bug Hunter orchestration:

| Skill | Purpose | Trigger |
|-------|---------|---------|
| `commit-security-scan/` | Diff-scoped PR/commit/staged security review | `--pr-security` |
| `security-review/` | Full security workflow (threat model + code + deps + validation) | `--security-review` |
| `threat-model-generation/` | STRIDE threat model bootstrap/refresh | `--threat-model` |
| `vulnerability-validation/` | Exploitability/reachability/CVSS/PoC validation | `--validate-security` |

## How They Connect

Bug Hunter remains the top-level orchestrator (`SKILL.md`). The orchestrator reads agent skills at each pipeline phase:

```
Recon (skills/recon/)
  → Hunter (skills/hunter/) + doc-lookup (skills/doc-lookup/)
    → Skeptic (skills/skeptic/) + doc-lookup
      → Referee (skills/referee/)
        → Fix Strategy + Fix Plan
          → Fixer (skills/fixer/) + doc-lookup
```

All doc-lookup calls use Context Hub (chub) as the primary documentation source with Context7 API as automatic fallback.

All artifacts are written under `.bug-hunter/` using Bug Hunter-native conventions.
