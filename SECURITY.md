# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Bug Hunter, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email the maintainer directly at **security@codexstar.dev** or use [GitHub's private vulnerability reporting](https://github.com/codexstar69/bug-hunter/security/advisories/new).

## What Qualifies

- Vulnerabilities in Bug Hunter's scripts (`scripts/*.cjs`) that could lead to arbitrary code execution, path traversal, or data exfiltration
- Issues in the subagent dispatch pipeline that could allow prompt injection or scope escape
- Flaws in `fix-lock.cjs` or `payload-guard.cjs` that bypass safety mechanisms

## What Does NOT Qualify

- Bugs found *by* Bug Hunter in your codebase — those are features, not vulnerabilities
- Issues in upstream dependencies (Context7 API, Context Hub) — report those to their maintainers
- Theoretical attacks requiring local filesystem access (Bug Hunter already runs with full local access)

## Response Timeline

- Acknowledgment within 48 hours
- Assessment and fix plan within 7 days
- Patch release within 14 days for confirmed vulnerabilities
