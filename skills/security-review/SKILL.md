---
name: security-review
description: Run a focused STRIDE-based security review using Bug Hunter-native artifacts. Use whenever the user asks for a full security audit, repository security review, weekly security scan, PR security review with deeper validation, or wants dependency CVEs and threat-model context combined into one workflow.
---

# Security Review

This is a bundled local Bug Hunter companion skill. It packages a security-focused review workflow without introducing any external marketplace dependency.

## Purpose

Use this skill for deeper security audits than a simple bug hunt, especially when the user wants:
- a full security review
- PR security validation
- weekly security scanning
- dependency reachability + code review together
- threat-model-driven analysis

## Workflow

1. Ensure `.bug-hunter/threat-model.md` exists.
   - If missing, invoke the bundled `threat-model-generation` skill.

2. Determine the scan mode from the request:
   - PR → diff-scoped review via `commit-security-scan`
   - staged → staged-only security review
   - weekly → recent commit range on the default branch
   - full → full repository security audit

3. If dependency scanning is relevant, run:
   - `node scripts/dep-scan.cjs --target <path> --output .bug-hunter/dep-findings.json`

4. Scan code for STRIDE threats using Bug Hunter-native conventions.
   Reuse:
   - `.bug-hunter/triage.json`
   - `.bug-hunter/threat-model.md`
   - `.bug-hunter/security-config.json`
   - `.bug-hunter/dep-findings.json`

5. Validate severe findings using the bundled `vulnerability-validation` skill.

6. Produce structured outputs compatible with the Bug Hunter pipeline.

## Outputs

Primary artifacts should stay inside `.bug-hunter/`:
- `.bug-hunter/findings.json`
- `.bug-hunter/referee.json`
- `.bug-hunter/report.md`
- `.bug-hunter/dep-findings.json` when dependency review is enabled
- `.bug-hunter/fix-strategy.json` if the user wants remediation planning

## Important constraints

- Keep all paths Bug Hunter-native; do not emit `.factory/*` artifacts.
- Prefer validated, exploitability-aware findings over raw volume.
- For patching requests, hand findings back to the normal Bug Hunter fix pipeline rather than inventing a second patch system.
