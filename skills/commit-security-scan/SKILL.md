---
name: commit-security-scan
description: Scan code changes for security vulnerabilities using Bug Hunter-native artifacts and STRIDE context. Use whenever the user asks for PR security review, commit-diff scanning, staged-change security checks, branch-comparison security review, or pre-merge security analysis of changed code.
---

# Commit Security Scan

This is a bundled local Bug Hunter companion skill. It is portable and self-contained: use `.bug-hunter/*` artifacts, never `.factory/*` paths.

## Purpose

Review *changed code* for security issues only. This skill is optimized for:
- PR review
- staged diff review
- branch diff review
- commit / commit-range security scanning

## Inputs

Resolve the scan scope from the user request:
- PR review → use `scripts/pr-scope.cjs`
- staged review → use `git diff --cached --name-only`
- branch diff → use `git diff --name-only <base>...<head>`
- commit range → use `git diff --name-only <base>..<head>`

## Workflow

1. Ensure threat-model context exists.
   - Preferred artifacts:
     - `.bug-hunter/threat-model.md`
     - `.bug-hunter/security-config.json`
   - If missing, run the bundled `threat-model-generation` skill first.

2. Resolve the changed-file scope.

3. Read the full contents of the changed source files, not just the patch.

4. Focus on STRIDE-oriented issues in changed code:
   - Spoofing: auth/session/token mistakes
   - Tampering: SQLi, XSS, path traversal, command injection, mass assignment
   - Repudiation: security-sensitive actions with no auditability
   - Information Disclosure: IDOR, secret exposure, verbose errors
   - DoS: unbounded input, missing limits, expensive regex/queries
   - Elevation of Privilege: missing authorization, role bypass, privilege escalation

5. Reuse Bug Hunter-native security conventions:
   - findings should be compatible with `.bug-hunter/findings.json`
   - use STRIDE + CWE labels
   - include confidence scores

6. If the user wants only a focused security diff review, stop after the findings report.
   If the user wants deeper validation, hand off to the bundled `vulnerability-validation` skill.

## Output

Preferred outputs:
- `.bug-hunter/findings.json` when integrating with the main Bug Hunter pipeline
- `.bug-hunter/report.md` as a rendered companion if needed

## Notes

- This skill is intentionally diff-scoped; it does not replace full-repository audits.
- Use it as the lightweight security fast-path before invoking the broader `security-review` flow.
