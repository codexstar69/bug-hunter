# Enterprise Security Pack End-to-End Integration Plan

## Objective

Make Bug Hunter's bundled local security skills fully end-to-end connected, portable, and enterprise-grade.

The bundled local skills already exist under `skills/`, but the main Bug Hunter orchestration flow does not yet actively route into them. This plan closes that gap by wiring the main `SKILL.md`, documentation, tests, and evals so the companion skills are not just packaged assets — they become part of the operating system of the product.

## Target outcomes

1. Main Bug Hunter flow explicitly routes into bundled local security skills when relevant.
2. Security entrypoints are easy to invoke and enterprise-friendly.
3. Docs, tests, and evals all reflect the integrated flow.
4. The repository remains fully portable with no external marketplace dependency.
5. After integration, run a focused Bug Hunter audit on the repository, fix any real bugs found, and summarize the net result.

## Integration model

Bug Hunter remains the top-level orchestrator.

Bundled local skills become capability modules:
- `skills/commit-security-scan/` → diff-scoped PR/commit/staged security review
- `skills/security-review/` → full security workflow (threat model + code + deps + validation)
- `skills/threat-model-generation/` → authoritative threat model bootstrap/refresh
- `skills/vulnerability-validation/` → exploitability/reachability/CVSS/PoC validation for security findings

The main skill should load these on demand from local paths and keep all artifacts under `.bug-hunter/`.

## Work plan

### Milestone 1 — Main skill routing
- Add security-oriented flags and aliases to `SKILL.md` / `README.md`
- Add explicit routing rules for when to read bundled local security skills
- Make threat model generation explicitly delegate to bundled `threat-model-generation`
- Make PR security review explicitly delegate to bundled `commit-security-scan`
- Make severe security validation explicitly delegate to bundled `vulnerability-validation`
- Make full security audit explicitly delegate to bundled `security-review`

### Milestone 2 — Enterprise UX surface
- Add enterprise-grade usage examples and a security-pack section in docs
- Keep behavior portable and artifact-native (`.bug-hunter/*` only)

### Milestone 3 — Guardrails
- Add regression tests proving the main skill references and exposes the bundled skills
- Add evals for the new end-to-end security flows

### Milestone 4 — Cross verification and self-audit
- Run the full script test suite
- Run a focused Bug Hunter audit on the repository
- Fix any real bugs uncovered by that audit
- Summarize all shipped changes briefly

## Definition of done

- Main `SKILL.md` actively routes to the bundled local security skills
- `README.md` documents the integrated security pack as a real workflow, not just a packaged extra
- tests and evals cover the integrated paths
- full test suite passes
- self-audit completes and any confirmed bugs are fixed
