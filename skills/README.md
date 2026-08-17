# Bundled Skills

Bug Hunter ships its role and security skills under `skills/` so the runtime is
portable, self-contained, and reviewable. The files in `skills/*/SKILL.md` are
the canonical role instructions; compatibility copies under `prompts/` are
generated and must stay in sync through `pnpm check:generated`.

## Core role skills

| Skill | Purpose |
|---|---|
| `recon/` | Maps architecture, entry points, trust boundaries, and risk context |
| `hunter/` | Finds reachable runtime, logic, data, concurrency, and security bugs |
| `skeptic/` | Adversarially challenges each Hunter finding to reduce false positives |
| `referee/` | Independently owns final verdicts and security enrichment |
| `fixer/` | Applies only immutable-scope, Referee-authorized remediation |
| `doc-lookup/` | Verifies version-sensitive framework behavior through Context Hub with Context7 fallback |

## Security workflow skills

| Skill | Purpose | Trigger |
|---|---|---|
| `commit-security-scan/` | PR/commit/staged security review | `--pr-security` |
| `security-review/` | Repository security workflow | `--security-review` |
| `threat-model-generation/` | STRIDE threat-model generation/refresh | `--threat-model` |
| `vulnerability-validation/` | Reachability, exploitability, CVSS, and PoC validation | `--validate-security` |

## How the current pipeline connects

The top-level `SKILL.md` remains the public orchestration contract. Deterministic
runtime helpers surround the role skills with measurable context and integrity
gates:

```text
source scope
  -> deterministic triage
  -> adaptive plan (fast | balanced | assurance, when requested/available)
  -> Recon
  -> hypothesis-directed retrieval
  -> Hunter + documentation verification
  -> Skeptic
  -> Referee
  -> optional required hybrid verification
  -> scan report
  -> optional fix strategy + immutable Fixer scope
  -> optional Fixer + post-fix verification
```

Supporting runtime layers include:

- `scripts/adaptive-policy.cjs` — bounded context/reviewer/verification policy
- `scripts/retrieval-planner.cjs` — hypothesis-ranked evidence under hard
  file/token budgets
- `scripts/evidence-cache.cjs` — exact content-addressed fact reuse
- `scripts/hybrid-verifier.cjs` — bounded argv-only tests/type/static/fuzz checks
- `scripts/benchmark-suite.cjs` — precision, recall, calibration, stability,
  cost, latency, and Pareto-quality measurement

These helpers do not replace the role boundary: Hunter proposes, Skeptic
challenges, Referee decides, and only explicitly authorized Fixer work may
mutate source.

## Artifact model

All runtime artifacts live under `.bug-hunter/`. Important canonical JSON
contracts include `adaptive-plan.json`, `retrieval-plan.json`,
`hunter-findings.json`, `skeptic.json`, `referee.json`,
`verification-report.json`, `scan-report.json`, `fixer-scope.json`, and
`benchmark-report.json`.

JSON is the automation source of truth. Markdown output is explanatory or a
rendered human-readable view.

## Contributor rule

Edit canonical role skills under `skills/`, then regenerate/check compatibility
prompts. Do not hand-edit generated `prompts/hunter.md`, `prompts/skeptic.md`,
`prompts/referee.md`, `prompts/fixer.md`, `prompts/recon.md`, or
`prompts/doc-lookup.md`.
