<p align="center">
  <img src="docs/images/hero.png" alt="Bug Hunter — Adversarial Bug Finding for Coding Agents" width="720">
</p>

<h1 align="center">Bug Hunter</h1>
<p align="center"><strong>Three AI agents argue about your code. Only bugs that survive all three make the report.</strong></p>
<p align="center">
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#what-it-finds">What It Finds</a> ·
  <a href="#auto-fix-pipeline">Auto-Fix</a> ·
  <a href="#cli-reference">CLI Reference</a>
</p>

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

Or clone manually:

```bash
git clone https://github.com/codexstar69/bug-hunter.git ~/.agents/skills/bug-hunter
```

> **Requirements:** Node.js 18+ recommended. Core pipeline works without it.
>
> **Works with:** Claude Code, Cursor, Codex CLI, Windsurf, Kiro, Copilot, Opencode, [Pi](https://github.com/mariozechner/pi-coding-agent) — or any AI agent that can read files and run shell commands.

---

## Usage

```bash
/bug-hunter                      # scan project, auto-fix confirmed bugs
/bug-hunter src/                 # scan a specific directory
/bug-hunter --scan-only src/     # report only, no code changes
/bug-hunter --pr                 # review the current PR
/bug-hunter --pr-security        # PR security review + threat model + CVEs
/bug-hunter -b feature-xyz       # scan files changed in branch vs main
/bug-hunter --deps --threat-model # full audit: CVEs + STRIDE threat model
```

---

## How It Works

<p align="center">
  <img src="docs/images/pipeline-overview.png" alt="Bug Hunter pipeline" width="100%">
</p>

```
Triage  → Recon → Hunter → Skeptic → Referee → Fix Plan → Fixer → Verify
  (<2s)              ↕ doc verify    ↕ doc verify
```

1. **Triage** classifies every file by risk in <2 seconds (zero AI cost)
2. **Recon** maps the tech stack and attack surfaces
3. **Hunter** deep-scans for logic errors, security holes, race conditions
4. **Skeptic** tries to *disprove* every finding with counter-evidence
5. **Referee** re-reads the code independently and delivers final verdicts
6. **Fixer** applies canary-first patches with per-fix rollback

The adversarial debate between Hunter, Skeptic, and Referee eliminates false positives. The canary rollout with auto-revert prevents regressions from fixes.

<p align="center">
  <img src="docs/images/adversarial-debate.png" alt="Hunter vs Skeptic vs Referee" width="100%">
</p>

| Agent | Earns Points For | Loses Points For |
|-------|-----------------|-----------------|
| **Hunter** | Reporting real bugs | False positives |
| **Skeptic** | Disproving false positives | Dismissing real bugs (2x penalty) |
| **Referee** | Accurate verdicts | Blind trust in either side |

---

## What It Finds

**Runtime behavioral bugs only** — not style, naming, or TODOs:

- Logic errors, off-by-one, inverted conditions
- SQL injection, XSS, path traversal, IDOR, auth bypass, SSRF
- Race conditions, TOCTOU, deadlocks
- Swallowed exceptions, unhandled rejections
- Data integrity issues, resource leaks, API contract violations

Every security finding gets **STRIDE classification**, **CWE ID**, and **CVSS 3.1 scoring** with proof-of-concept payloads for Critical/High findings.

**Languages:** TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Ruby, PHP

**Frameworks:** Express, Next.js, Django, Flask, FastAPI, Gin, Spring Boot, Rails, Laravel, and anything indexed by Context7 for doc verification.

---

## Auto-Fix Pipeline

When bugs are confirmed, the Fixer doesn't just edit files — it engineers patches:

1. **Git branch** — dedicated `bug-hunter-fix-*` branch with restore point
2. **Test baseline** — captures passing tests before any edits
3. **Strategy classification** — clusters bugs into safe-autofix / manual-review / larger-refactor / architectural
4. **Confidence gate** — only fixes bugs the Referee confirmed at >=75% confidence
5. **Canary rollout** — top 1-3 Critical bugs fixed first; if they break tests, pipeline halts
6. **Per-fix checkpoint** — each fix is committed individually; failures auto-revert
7. **Post-fix re-scan** — checks if the Fixer introduced new bugs

Use `--plan-only` to see the strategy without executing fixes. Use `--dry-run` to preview diffs.

---

## Security Features

- `--threat-model` — generates STRIDE threat model saved to `.bug-hunter/threat-model.md`
- `--deps` — scans npm/pip/go/cargo/bun lockfiles for HIGH/CRITICAL CVEs with reachability analysis
- `--pr-security` — PR-scoped security review with threat model + dependency context
- `--security-review` — enterprise security workflow with full validation pipeline

Bundled security skills: `commit-security-scan`, `security-review`, `threat-model-generation`, `vulnerability-validation`.

---

## CLI Reference

| Flag | Behavior |
|------|----------|
| *(no flags)* | Scan + auto-fix confirmed bugs |
| `src/` or `file.ts` | Scan specific path |
| `--scan-only` / `--review` | Report only, no edits |
| `--fix --approve` / `--safe` | Ask before each fix |
| `--plan-only` / `--plan` | Generate fix strategy, don't edit |
| `--dry-run` / `--preview` | Preview fixes as diffs |
| `-b branch` | Scan branch diff vs main |
| `--pr` / `--pr 123` / `--pr recent` | Review a PR |
| `--pr-security` | PR security review |
| `--staged` | Scan staged files (pre-commit) |
| `--deps` | Dependency CVE scan |
| `--threat-model` | STRIDE threat model |
| `--security-review` | Enterprise security workflow |
| `--no-loop` | Single-pass (loop is on by default) |
| `--autonomous` | Zero-intervention auto-fix |

All flags compose: `/bug-hunter --deps --threat-model --fix src/`

---

## Output

Every run creates `.bug-hunter/` (add to `.gitignore`):

| File | Contents |
|------|----------|
| `findings.json` | Machine-readable findings for CI/CD |
| `report.md` | Human-readable report |
| `referee.json` | Final verdicts with CVSS scores |
| `fix-strategy.json` | Remediation plan (safe-autofix vs manual-review vs refactor) |
| `fix-plan.json` | Execution plan with canary rollout |
| `fix-report.json` | Fix results for CI/CD gating |
| `triage.json` | File classification and risk map |
| `threat-model.md` | STRIDE threat model (if `--threat-model`) |
| `dep-findings.json` | Dependency CVEs (if `--deps`) |

---

## Self-Test

Ships with 6 planted bugs in `test-fixture/` and **113 regression tests**:

```bash
/bug-hunter test-fixture/     # validate pipeline finds all 6 bugs
npm test                      # run regression suite
```

---

## Project Structure

```
bug-hunter/
├── SKILL.md                    # Pipeline orchestration logic
├── bin/bug-hunter              # CLI (install, doctor, info)
├── skills/                     # Agent skills (hunter, skeptic, referee, fixer, recon, + 4 security)
├── modes/                      # Execution strategies (single-file → large-codebase, loop, fix)
├── schemas/                    # JSON artifact contracts
├── scripts/                    # Node.js helpers (triage, state, locking, worktrees, experiments)
│   ├── shared.cjs              #   Shared utilities
│   └── tests/                  #   113 tests
├── templates/                  # Subagent dispatch template
└── test-fixture/               # 6 planted bugs for validation
```

---

## License

MIT
