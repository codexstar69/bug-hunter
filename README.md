<p align="center">
  <img src="docs/images/hero.png" alt="Bug Hunter — AI-powered adversarial code review and security vulnerability scanner for Claude Code, Cursor, Codex, Copilot, Windsurf, and Kiro" width="720">
</p>

<h1 align="center">Bug Hunter</h1>
<p align="center"><strong>AI code review that argues with itself — adversarial multi-agent bug finding, security scanning, and auto-fix for any coding agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@codexstar/bug-hunter"><img src="https://img.shields.io/npm/v/@codexstar/bug-hunter" alt="npm version"></a>
  <a href="https://github.com/codexstar69/bug-hunter/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@codexstar/bug-hunter" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/tests-113%20passing-brightgreen" alt="113 tests passing">
  <img src="https://img.shields.io/badge/node-%3E%3D18-blue" alt="Node.js >= 18">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-adversarial-ai-code-review-works">How It Works</a> ·
  <a href="#bugs-and-vulnerabilities-detected">What It Finds</a> ·
  <a href="#safe-auto-fix-with-canary-rollout">Auto-Fix</a> ·
  <a href="#cli-flags">CLI Reference</a>
</p>

---

Bug Hunter is an open-source AI code review and security vulnerability scanner that works as a skill/plugin for AI coding agents. Three AI agents — a Hunter, a Skeptic, and a Referee — independently analyze your code in an adversarial pipeline. The Hunter finds bugs. The Skeptic tries to disprove them. The Referee delivers the final verdict. Only bugs that survive all three stages make the report, eliminating the false positive overload that plagues other AI code review tools.

It then auto-fixes confirmed bugs with a safe canary rollout pipeline — git branching, test baselines, per-fix commits, automatic rollback on failure, and post-fix re-scanning.

---

## Install

```bash
npx skills add codexstar69/bug-hunter
```

Or via npm:

```bash
npm install -g @codexstar/bug-hunter
bug-hunter install     # auto-detects your IDE/agent
bug-hunter doctor      # verify environment
```

Or clone:

```bash
git clone https://github.com/codexstar69/bug-hunter.git ~/.agents/skills/bug-hunter
```

> **Requirements:** Node.js 18+ recommended. Core pipeline works without it.
>
> **Compatible with:** Claude Code, Cursor, Codex CLI, Windsurf, Kiro, Copilot, Opencode, [Pi](https://github.com/mariozechner/pi-coding-agent) — or any AI agent that can read files and run shell commands.

---

## Quick Start

```bash
/bug-hunter                      # scan project, auto-fix confirmed bugs
/bug-hunter src/                 # scan a specific directory
/bug-hunter --scan-only src/     # report only, no code changes
/bug-hunter --pr                 # review the current pull request
/bug-hunter --pr-security        # PR security review + threat model + CVEs
/bug-hunter --deps --threat-model # full security audit
```

---

## How Adversarial AI Code Review Works

<p align="center">
  <img src="docs/images/pipeline-overview.png" alt="Bug Hunter adversarial AI code review pipeline — triage, recon, deep scan, skeptic challenge, referee verdict, auto-fix with canary rollout" width="100%">
</p>

```
Triage  → Recon → Hunter → Skeptic → Referee → Fix Plan → Fixer → Verify
  (<2s)              ↕ doc verify    ↕ doc verify
```

1. **Triage** — classifies every file by risk in <2 seconds, zero AI tokens
2. **Recon** — maps tech stack, auth mechanisms, attack surfaces
3. **Hunter** — deep behavioral scan for logic errors, security vulnerabilities, race conditions
4. **Skeptic** — adversarial review that tries to *disprove* every finding with counter-evidence
5. **Referee** — independent final judge, re-reads code, delivers CVSS-scored verdicts
6. **Fixer** — applies canary-first patches with per-fix rollback safety

Claims are verified against official library documentation via [Context Hub](https://github.com/andrewyng/context-hub) + [Context7](https://context7.com) before any agent asserts framework behavior.

<p align="center">
  <img src="docs/images/adversarial-debate.png" alt="Adversarial AI code review debate — Hunter finds bugs, Skeptic challenges with counter-evidence, Referee delivers independent verdict" width="100%">
</p>

| Agent | Rewarded For | Penalized For |
|-------|-------------|--------------|
| **Hunter** | Confirmed real bugs | False positives |
| **Skeptic** | Disproving false positives | Missing real bugs (2x penalty) |
| **Referee** | Accurate independent verdicts | Blind trust in either side |

---

## Bugs and Vulnerabilities Detected

**Runtime behavioral bugs only** — not style, naming, or TODOs:

- **Security** — SQL injection, XSS, command injection, path traversal, IDOR, auth bypass, SSRF
- **Logic** — wrong comparisons, off-by-one, inverted conditions, unreachable branches
- **Concurrency** — race conditions, TOCTOU, deadlocks
- **Error handling** — swallowed exceptions, unhandled promise rejections
- **Data integrity** — silent truncation, encoding corruption, resource leaks
- **API contracts** — type mismatches, incorrect callback signatures

Every security finding gets **STRIDE classification**, **CWE ID**, and **CVSS 3.1 scoring** with proof-of-concept payloads.

### Supported Languages and Frameworks

**Languages:** TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Ruby, PHP

**Frameworks:** Express, Next.js, Django, Flask, FastAPI, Gin, Spring Boot, Rails, Laravel — and any framework with docs in Context7.

---

## Safe Auto-Fix with Canary Rollout

When bugs are confirmed, the Fixer engineers patches — not just edits:

1. **Git branch** — dedicated fix branch with restore point
2. **Test baseline** — captures passing tests before any edits
3. **Strategy** — classifies each bug: safe-autofix / manual-review / larger-refactor / architectural
4. **Confidence gate** — only auto-fixes bugs confirmed at >=75% confidence
5. **Canary rollout** — top 1-3 Critical bugs fixed first; if tests break, pipeline halts
6. **Per-fix checkpoint** — each fix committed individually; failures auto-revert
7. **Post-fix re-scan** — catches bugs the Fixer itself introduced

`--plan-only` to see the strategy. `--dry-run` to preview diffs. `--safe` to approve each fix.

---

## Security Scanning Features

| Flag | Capability |
|------|-----------|
| `--threat-model` | STRIDE threat model generation |
| `--deps` | Dependency CVE scanning (npm, pip, go, cargo, bun) with reachability analysis |
| `--pr-security` | PR-scoped security review with threat model + CVE context |
| `--security-review` | Enterprise security audit workflow |
| `--validate-security` | Exploitability validation with CVSS scoring |

Bundled security skills: `commit-security-scan`, `security-review`, `threat-model-generation`, `vulnerability-validation`.

---

## CLI Flags

| Flag | Behavior |
|------|----------|
| *(no flags)* | Scan + auto-fix confirmed bugs |
| `src/` or `file.ts` | Scan specific path |
| `--scan-only` / `--review` | Report only, no edits |
| `--fix --approve` / `--safe` | Approve each fix interactively |
| `--plan-only` / `--plan` | Generate fix strategy without editing |
| `--dry-run` / `--preview` | Preview fixes as diffs |
| `-b branch` | Scan branch diff vs main |
| `--pr` / `--pr 123` / `--pr recent` | Review a pull request |
| `--staged` | Scan staged files (pre-commit hook) |
| `--deps` | Dependency CVE scan |
| `--threat-model` | STRIDE threat model |
| `--no-loop` | Single-pass scan (loop is on by default) |
| `--autonomous` | Zero-intervention auto-fix |

All flags compose: `/bug-hunter --deps --threat-model --fix src/`

---

## Output Files

Every run creates `.bug-hunter/` (add to `.gitignore`):

| File | Purpose |
|------|---------|
| `findings.json` | Machine-readable findings (CI/CD gating, dashboards) |
| `report.md` | Human-readable report |
| `referee.json` | Final verdicts with CVSS scores and PoC payloads |
| `fix-strategy.json` | Remediation classification |
| `fix-plan.json` | Canary rollout execution plan |
| `fix-report.json` | Fix results |
| `triage.json` | File risk classification |
| `threat-model.md` | STRIDE threat model |
| `dep-findings.json` | Dependency CVE results |

---

## Self-Test

Ships with 6 planted bugs and **113 regression tests**:

```bash
/bug-hunter test-fixture/     # validate pipeline
npm test                      # run test suite
```

---

## Project Structure

```
bug-hunter/
├── SKILL.md              # Pipeline orchestration
├── bin/bug-hunter         # CLI installer
├── skills/                # 10 agent skills (hunter, skeptic, referee, fixer, recon, + 5 more)
├── modes/                 # Execution strategies (single-file → large-codebase)
├── schemas/               # JSON artifact contracts
├── scripts/               # Node.js helpers + 113 tests
├── templates/             # Subagent dispatch template
└── test-fixture/          # 6 planted bugs for validation
```

---

## License

MIT
