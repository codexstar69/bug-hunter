<p align="center">
  <h1 align="center">🐛 Bug Hunter</h1>
  <p align="center"><strong>An AI-powered bug finding system that argues with itself to find real bugs in your code.</strong></p>
</p>

---

## What is Bug Hunter?

Bug Hunter is an **automated code auditing tool** that uses multiple AI agents working together — and against each other — to find real bugs in your codebase. Think of it as a team of expert code reviewers who check each other's work.

Instead of one AI scanning your code and flooding you with false alarms, Bug Hunter uses an **adversarial pipeline**: one agent hunts for bugs, another tries to disprove them, and a third makes the final call. Only bugs that survive all three stages make it into your report.

**It works with any AI coding agent** — Pi, Claude Code, Codex, Cursor, or anything that can read files and run commands.

### The Problem It Solves

Traditional AI code review tools have two big problems:

1. **Too many false positives.** Developers waste hours reviewing "bugs" that aren't real — the code is actually fine, or the framework already handles it.
2. **Fixes that break things.** Automated fixers often introduce new bugs or regressions because they don't understand the full context.

Bug Hunter solves both:
- **False positives** are eliminated by making AI agents argue with each other. The Hunter finds bugs, the Skeptic tries to disprove them, and the Referee makes the final call — just like a real code review, but automated.
- **Broken fixes** are prevented by a strategic fix plan that tests every change, reverts anything that fails, and re-scans fixed code for new issues the fixer may have introduced.

---

## How It Works (The Big Picture)

```
Your Code
    ↓
🔍 Triage          — Scans your files in <2 seconds, zero AI cost
    ↓
🗺️  Recon           — Maps your tech stack, identifies high-risk areas
    ↓
🎯 Hunter          — Deep scan for real bugs (logic errors, security holes, race conditions)
    ↓                  ↕ checks official docs to verify claims
🛡️  Skeptic         — Tries to DISPROVE every finding (adversarial challenge)
    ↓                  ↕ checks official docs to verify dismissals
⚖️  Referee         — Final independent judge, re-reads code, makes verdict
    ↓
📋 Report          — Only confirmed real bugs, with severity and fix suggestions
    ↓
📝 Fix Plan        — Strategic plan: priority order, canary rollout, safety gates
    ↓
🔧 Fixer           — Executes fixes one by one on a safe git branch
    ↓                  ↕ checks official docs for correct API usage
✅ Verify          — Tests every fix, reverts failures, re-scans for new bugs
```

### Why Does This Work Better?

Each agent has **opposite incentives**:

| Agent | Earns Points For | Loses Points For |
|-------|-----------------|-----------------|
| 🎯 **Hunter** | Finding real bugs | Reporting false positives |
| 🛡️ **Skeptic** | Disproving false positives | Dismissing real bugs (2× penalty) |
| ⚖️ **Referee** | Accurate final verdicts | Trusts neither side blindly |

This creates a self-correcting system. The Hunter doesn't spam low-quality findings because false positives hurt its score. The Skeptic doesn't dismiss everything because missing a real bug costs double.

---

## Quick Start

```bash
# Install
git clone https://github.com/codexstar69/bug-hunter.git ~/.agents/skills/bug-hunter

# Basic usage — scan your project and auto-fix bugs
/bug-hunter

# Scan a specific folder
/bug-hunter src/

# Scan a single file
/bug-hunter lib/auth.ts

# Scan only files changed in a branch
/bug-hunter -b feature-xyz

# Scan staged files before committing
/bug-hunter --staged

# Report only — don't change any code
/bug-hunter --scan-only src/

# Find bugs AND fix them, but ask before each fix
/bug-hunter --fix --approve src/

# Full security audit with dependency scanning and threat modeling
/bug-hunter --deps --threat-model src/
```

---

## Features

### 🔍 Zero-Token Triage (Instant)

Before any AI agent runs, a lightweight Node.js script scans your entire codebase in under 2 seconds. It classifies every file by risk level (CRITICAL → HIGH → MEDIUM → LOW), computes a context budget, and picks the right scanning strategy. This means **zero wasted AI tokens** on file discovery.

### 🎯 Deep Bug Hunting

The Hunter agent reads your code file by file and looks for bugs that will cause **real problems at runtime**:

- **Logic errors** — wrong comparisons, off-by-one, inverted conditions
- **Security vulnerabilities** — SQL injection, XSS, path traversal, IDOR, auth bypass
- **Race conditions** — concurrent access bugs, deadlocks
- **Error handling gaps** — swallowed errors, unhandled edge cases
- **Data integrity issues** — truncation, encoding bugs, timezone errors, overflow
- **API contract violations** — callers and callees disagreeing on types/behavior
- **Resource leaks** — unclosed connections, file handles, event listeners

What it does NOT report: style issues, naming preferences, unused code, TODO comments, or suggestions. Only real behavioral bugs.

### 📚 Official Documentation Verification

This is one of Bug Hunter's most important features. AI models often make wrong assumptions about how libraries and frameworks work — "Express sanitizes input by default" (it doesn't), "Prisma parameterizes `$queryRaw` automatically" (it depends). Wrong assumptions lead to false positives AND missed real bugs.

Bug Hunter solves this by **checking official documentation** before making any claim about library behavior.

#### How it works

Bug Hunter includes a built-in documentation lookup system (`scripts/context7-api.cjs`) that connects to the [Context7](https://context7.com) documentation API. Three agents use it:

| Agent | When It Checks Docs | Example |
|-------|---------------------|---------|
| 🎯 **Hunter** | When claiming a framework doesn't protect against something | "Does Express.js escape HTML in responses by default?" → checks Express docs → confirms it doesn't → reports XSS as a real finding |
| 🛡️ **Skeptic** | When trying to disprove a finding based on framework behavior | "Does Prisma parameterize `$queryRaw`?" → checks Prisma docs → finds it uses tagged template literals for parameterization → dismisses false SQL injection finding |
| 🔧 **Fixer** | When implementing a fix that uses a library API | "What's the correct way to use `helmet()` middleware in Express?" → checks docs → implements fix using the documented API pattern |

#### What it looks like in practice

When the Hunter finds a potential SQL injection:
```
1. Hunter reads the code: db.query(`SELECT * FROM users WHERE id = ${userId}`)
2. Hunter checks: "Does this database library parameterize template literals?"
   → Runs: node context7-api.cjs search "pg" "parameterized queries template literals"
   → Runs: node context7-api.cjs context "/node-postgres/node-pg" "template literal queries"
   → Docs say: pg does NOT auto-parameterize template literals
3. Hunter reports: "SQL injection — per pg docs, template literals are interpolated directly"
```

When the Skeptic reviews the same finding:
```
1. Skeptic re-reads the code independently
2. Skeptic checks the same docs to verify the Hunter's claim
3. Skeptic confirms: "pg docs agree — this is a real injection point"
4. Finding survives to Referee
```

#### Rules to prevent doc-lookup abuse

- Agents only look up docs when they have a **specific claim to verify** — not speculatively for every library
- **One lookup per claim** — no chaining 5 searches
- If the API returns nothing useful, agents say so: "Could not verify from docs — proceeding based on code analysis only"
- Agents **cite what they found**: "Per Express docs: [quote]" — so you can verify their reasoning

#### Supported ecosystems

The doc-lookup system works for any library indexed by Context7 — this includes the vast majority of popular packages across npm, pip, Go modules, Rust crates, and more.

### 🔐 STRIDE + CWE Security Classification

Every security finding is tagged with industry-standard identifiers:

- **STRIDE category** — Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, or Elevation of Privilege
- **CWE ID** — the specific weakness type (e.g., CWE-89 for SQL Injection, CWE-639 for IDOR)

This means your findings speak the same language as professional security tools and compliance frameworks.

### 🗺️ Threat Model Generation (`--threat-model`)

Run with `--threat-model` and Bug Hunter generates a **STRIDE threat model** for your codebase:

- Maps trust boundaries (public → authenticated → internal)
- Identifies entry points and data flows
- Lists tech-stack-specific vulnerability patterns (vulnerable vs. safe code examples)
- Prioritizes components by security criticality

The threat model is saved to `.bug-hunter/threat-model.md` and automatically feeds into the Hunter and Recon agents for more targeted security analysis. It's reused across runs (regenerated if older than 90 days).

### 📦 Dependency CVE Scanning (`--deps`)

Run with `--deps` and Bug Hunter audits your third-party packages for known vulnerabilities:

- **Supports**: npm, pnpm, yarn, bun (Node.js), pip (Python), go (Go), cargo (Rust)
- **Filters**: only HIGH and CRITICAL severity CVEs (no noise from low-severity advisories)
- **Lockfile-aware**: automatically detects whether you use npm, pnpm, yarn, or bun and runs the correct audit command
- **Reachability analysis**: searches your source code to check if you actually *use* the vulnerable API — a vulnerable package you never import is flagged as `NOT_REACHABLE`

Results are saved to `.bug-hunter/dep-findings.json` and fed into the Hunter so it can verify whether vulnerable APIs are actually called in your scanned code.

### 🛡️ Adversarial Skeptic with Hard Exclusion Rules

The Skeptic agent doesn't just rubber-stamp findings. It re-reads the actual code for every reported bug and tries to disprove it. Before deep analysis, it applies **15 hard exclusion rules** — settled false-positive classes that get instantly dismissed:

1. DoS claims without demonstrated amplification
2. Rate limiting concerns (informational, not bugs)
3. Memory safety in memory-safe languages (Rust safe code, Go, Java)
4. Findings in test files
5. Log injection concerns
6. SSRF with attacker controlling only the path
7. LLM prompt injection (out of scope)
8. ReDoS without a demonstrated >1s payload
9. Documentation/config-only findings
10. Missing audit logging (informational)
11. Environment variables treated as untrusted
12. UUIDs treated as guessable
13. Client-side-only auth checks (server enforces)
14. Secrets on disk with proper permissions
15. Memory/CPU exhaustion without external attack path

Everything else gets full adversarial analysis with code re-reading, framework verification (using doc-lookup), and confidence-gated decisions.

### ⚖️ Enriched Referee Verdicts

For confirmed security bugs, the Referee adds professional-grade enrichment:

| Field | What It Tells You |
|-------|------------------|
| **Reachability** | Can an attacker reach this? (EXTERNAL / AUTHENTICATED / INTERNAL / UNREACHABLE) |
| **Exploitability** | How hard is it to exploit? (EASY / MEDIUM / HARD) |
| **CVSS 3.1 Score** | Industry-standard severity score (0.0–10.0) for Critical/High bugs |
| **Proof of Concept** | A minimal benign PoC showing the payload, request, expected vs. actual behavior |

Example enriched verdict:
```
VERDICT: REAL BUG | Confidence: High
- Reachability: EXTERNAL
- Exploitability: EASY
- CVSS: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N (9.1)
- Proof of Concept:
  - Payload: ' OR '1'='1
  - Request: GET /api/users?search=test' OR '1'='1
  - Expected: Returns matching users only
  - Actual: Returns ALL users (SQL injection bypasses WHERE clause)
```

### 📊 Structured JSON Output

Every run produces machine-readable output at `.bug-hunter/findings.json`:

```json
{
  "version": "3.0.0",
  "confirmed": [
    {
      "id": "BUG-1",
      "severity": "CRITICAL",
      "stride": "Tampering",
      "cwe": "CWE-89",
      "file": "src/api/users.ts",
      "reachability": "EXTERNAL",
      "cvss_score": 9.1,
      "poc": { "payload": "...", "request": "...", "expected": "...", "actual": "..." }
    }
  ],
  "summary": {
    "total_reported": 12,
    "confirmed": 5,
    "dismissed": 7,
    "by_severity": { "CRITICAL": 2, "HIGH": 1, "MEDIUM": 1, "LOW": 1 }
  }
}
```

Use this for **CI/CD pipeline gating** (block merges on CRITICAL findings), **security dashboards**, or **automated ticket creation**.

### 📝 Strategic Fix Planning

Bug Hunter doesn't just find bugs and throw fixes at your codebase. Once the Referee confirms real bugs, the system builds a **strategic fix plan** before touching any code. This is the difference between "an AI that edits your files" and "an AI that thinks before it acts."

#### The planning process

Here's what happens after bugs are confirmed, step by step:

**Step 1: Safety Setup**
- Checks if you're in a git repository (warns if not — no rollback without git)
- Captures your current branch and commit hash as a **restore point**
- If you have uncommitted changes, **stashes them safely** so nothing is lost
- Creates a dedicated fix branch: `bug-hunter-fix-20260310-083000`
- Acquires a **single-writer lock** — prevents multiple fixers from editing simultaneously

**Step 2: Establish Baseline**
- Detects your project's test, typecheck, and build commands automatically
- Runs your test suite once to record the **baseline** — which tests pass, which already fail
- This baseline is critical: later, if a fix causes a test to fail that was passing before, it's reverted

**Step 3: Build the Fix Queue**
- Applies a **confidence gate**: only bugs the Referee confirmed with ≥75% confidence are eligible for auto-fix
- Bugs below 75% are marked `MANUAL_REVIEW` — reported but not auto-fixed
- Checks for conflicts: if two bugs point at the same lines, resolves them before editing
- Sorts by severity: **Critical → High → Medium → Low**
- Groups same-file bugs together to prevent conflicting edits

**Step 4: Canary Rollout**
- Picks the 1–3 highest-severity, highest-confidence bugs as the **canary group**
- Fixes the canary bugs first
- Runs targeted tests immediately after
- If the canary fixes break something → stops and reverts. No further fixes attempted.
- If canary passes → continues with the rest of the fix queue

#### What a fix looks like

```
Fix Plan: 7 eligible bugs, canary=2, rollout=5, manual-review=3

Canary Phase:
  BUG-1 (CRITICAL) → fix SQL injection in users.ts:45 → checkpoint commit → run tests → ✅ pass
  BUG-2 (CRITICAL) → fix auth bypass in auth.ts:23 → checkpoint commit → run tests → ✅ pass
  Canary passed — continuing rollout

Rollout Phase:
  BUG-3 (HIGH) → fix XSS in template.ts:89 → checkpoint commit → run tests → ✅ pass
  BUG-4 (MEDIUM) → fix race condition in queue.ts:112 → checkpoint commit → run tests → ❌ FAIL
    → Auto-reverting BUG-4 fix → re-running tests → ✅ pass (failure cleared)
    → BUG-4 status: FIX_REVERTED
  BUG-5 (MEDIUM) → fix error swallow in api.ts:67 → checkpoint commit → run tests → ✅ pass
  ...

Post-Fix Re-Scan:
  Running lightweight Hunter on changed code only...
  No fixer-introduced bugs detected ✅

Final Status:
  FIXED: 5 | FIX_REVERTED: 1 | MANUAL_REVIEW: 3 | FIXER_BUG: 0
```

#### Post-fix safety checks

After all fixes are applied, three things happen:

1. **Full test suite** runs again — compared against the baseline to find new failures
2. **Typecheck and build** run if available — catches compile errors the fixer may have introduced
3. **Post-fix re-scan** — a lightweight Hunter runs on ONLY the lines the Fixer changed, specifically looking for bugs the Fixer itself may have introduced (e.g., an off-by-one in validation logic that was supposed to fix an off-by-one)

#### Final bug statuses

Every bug gets one of these final statuses:

| Status | What It Means |
|--------|--------------|
| **FIXED** | Fix applied, all tests pass, no fixer-introduced issues |
| **FIX_REVERTED** | Fix was applied but caused a test failure — cleanly reverted |
| **FIX_FAILED** | Fix caused failures and could not be cleanly reverted — needs manual intervention |
| **PARTIAL** | Minimal patch applied, but a larger refactor is needed for a complete fix |
| **SKIPPED** | Bug confirmed but fix was not attempted (too risky, architectural, etc.) |
| **FIXER_BUG** | The post-fix re-scan found that the Fixer introduced a new bug |
| **MANUAL_REVIEW** | Referee confidence was below 75% — reported but not auto-fixed |

#### What happens to your working tree

- If Bug Hunter stashed your changes at the start, it **restores them** at the end
- If the restore causes merge conflicts, it stops and gives you clear instructions — it never discards your stash
- Your original branch is preserved — fixes live on the `bug-hunter-fix-*` branch for review
- Review command is printed: `git diff <base-commit>..HEAD` — shows exactly what changed

### 🔧 Fixer with Documentation Verification

The Fixer doesn't just guess at fixes. When implementing a fix that depends on a library API — like the correct way to parameterize a query in Prisma, or the right middleware pattern in Express — it **looks up the official documentation** first.

```
Example: Fixing a SQL injection (BUG-1)

1. Fixer reads the Referee's verdict: "SQL injection via string concatenation in pg query"
2. Fixer checks: "What's the correct way to parameterize queries in node-postgres?"
   → Runs: node context7-api.cjs context "/node-postgres/node-pg" "parameterized queries"
   → Docs say: Use db.query('SELECT * FROM users WHERE id = $1', [userId])
3. Fixer implements the documented pattern — not a guess from training data
4. Checkpoint commit → tests run → pass ✅
```

This prevents a common failure mode: the Fixer "fixes" a bug by using an API pattern that doesn't actually exist or works differently than expected.

### 📐 Few-Shot Calibration Examples

Hunter and Skeptic agents receive **worked examples** before scanning — real findings with full analysis showing the expected reasoning process. This calibrates their judgment:

- **Hunter examples**: 3 confirmed bugs (SQL injection, IDOR, command injection) + 2 correctly-identified false positives
- **Skeptic examples**: 2 accepted real bugs + 2 correctly disproved false positives + 1 manual-review case

### 🔄 Automatic Scaling

Bug Hunter automatically picks the right strategy based on your codebase size:

| Your Codebase | What Happens |
|---------------|-------------|
| **1 file** | Direct single-file scan — fast, no overhead |
| **2–10 files** | Quick recon + single deep pass |
| **11–60 files** | Parallel scanning with optional dual-lens verification |
| **60–120 files** | Sequential chunked scanning with progress checkpoints |
| **120–180 files** | State-driven chunks with resume capability |
| **180+ files** | Domain-scoped pipelines with boundary audits — use `--loop` for full coverage |

For large codebases, use `--loop` mode. It runs iteratively until every critical and high-risk file has been scanned, with persistent state so you can stop and resume.

---

## Output Files

Every run creates a `.bug-hunter/` directory (add it to `.gitignore`) with:

| File | Always? | What's In It |
|------|---------|-------------|
| `report.md` | ✅ | Human-readable final report with confirmed bugs, dismissed findings, and coverage stats |
| `findings.json` | ✅ | Machine-readable JSON for CI/CD pipelines and dashboards |
| `triage.json` | ✅ | File classification, risk map, and strategy selection |
| `recon.md` | ✅ | Tech stack analysis and scan order |
| `findings.md` | ✅ | Raw Hunter findings before Skeptic review |
| `skeptic.md` | ✅ | Skeptic's challenge decisions |
| `referee.md` | ✅ | Referee's final verdicts |
| `fix-report.md` | Only when fixing | Fix details, status per bug, verification results |
| `threat-model.md` | Only with `--threat-model` | STRIDE threat model for your codebase |
| `dep-findings.json` | Only with `--deps` | Dependency CVE scan results with reachability |
| `state.json` | Only for large scans | Progress checkpoint for resume |

---

## Supported Languages

TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Ruby, PHP.

The pipeline works with any language that has source files — the triage, Hunter, Skeptic, and Referee agents adapt to whatever they find.

---

## All Flags

| Flag | What It Does |
|------|-------------|
| *(no flags)* | Scan current directory, auto-fix confirmed bugs |
| `src/` or `file.ts` | Scan specific path |
| `-b branch-name` | Scan files changed in a branch (vs. main) |
| `-b branch --base dev` | Scan branch diff against a specific base |
| `--staged` | Scan git-staged files (great for pre-commit hooks) |
| `--scan-only` | Report only, don't change code |
| `--fix` | Find and auto-fix bugs (this is the default) |
| `--approve` | Ask before applying each fix |
| `--autonomous` | Full auto-fix with no intervention |
| `--loop` | Iterative mode for large codebases — runs until 100% critical coverage |
| `--deps` | Include dependency CVE scanning |
| `--threat-model` | Generate or use a STRIDE threat model |

Flags can be combined: `/bug-hunter --deps --threat-model --loop --fix src/`

---

## Self-Test

Bug Hunter ships with a test fixture containing an Express app with **6 intentionally planted bugs** (2 Critical, 3 Medium, 1 Low):

```bash
/bug-hunter test-fixture/
```

Expected results:
- ✅ All 6 bugs found
- ✅ At least 1 false positive challenged by Skeptic
- ✅ All 6 confirmed by Referee

If fewer than 5 are found, the prompts need tuning. If more than 3 false positives survive to the Referee, the Skeptic needs tightening.

---

## Project Structure

```
bug-hunter/
├── SKILL.md                              # Main orchestration logic (the "brain")
├── README.md                             # This file
├── CHANGELOG.md                          # Version history
│
├── modes/                                # Execution strategies by codebase size
│   ├── single-file.md                    #   1 file
│   ├── small.md                          #   2–10 files
│   ├── parallel.md                       #   11–FILE_BUDGET files
│   ├── extended.md                       #   chunked scanning
│   ├── scaled.md                         #   state-driven chunks
│   ├── large-codebase.md                 #   domain-scoped pipelines
│   ├── local-sequential.md               #   run everything in one agent
│   ├── loop.md                           #   iterative coverage
│   ├── fix-pipeline.md                   #   auto-fix orchestration
│   ├── fix-loop.md                       #   fix + re-scan loop
│   └── _dispatch.md                      #   shared dispatch patterns
│
├── prompts/                              # Agent instructions
│   ├── recon.md                          #   reconnaissance agent
│   ├── hunter.md                         #   bug hunting agent
│   ├── skeptic.md                        #   adversarial reviewer
│   ├── referee.md                        #   final judge
│   ├── fixer.md                          #   auto-fix agent
│   ├── doc-lookup.md                     #   documentation verification instructions
│   ├── threat-model.md                   #   STRIDE threat model generator
│   └── examples/                         #   calibration examples
│       ├── hunter-examples.md            #     3 real bugs + 2 false positives
│       └── skeptic-examples.md           #     2 accepted + 2 disproved + 1 review
│
├── scripts/                              # Node.js helpers (no AI tokens)
│   ├── triage.cjs                        #   file classification (<2s)
│   ├── dep-scan.cjs                      #   dependency CVE scanner
│   ├── context7-api.cjs                  #   documentation lookup API
│   ├── run-bug-hunter.cjs                #   chunk orchestrator
│   ├── bug-hunter-state.cjs              #   persistent state for resume
│   ├── delta-mode.cjs                    #   changed-file scope reduction
│   ├── payload-guard.cjs                 #   validates agent payloads
│   ├── fix-lock.cjs                      #   prevents concurrent fixers
│   └── code-index.cjs                    #   cross-domain analysis (optional)
│
├── templates/
│   └── subagent-wrapper.md               # Template for launching sub-agents
│
└── test-fixture/                         # 6 planted bugs for self-testing
    ├── server.js
    ├── auth.js
    ├── db.js
    └── users.js
```

---

## Install

```bash
# Clone into your agent's skills directory
git clone https://github.com/codexstar69/bug-hunter.git ~/.agents/skills/bug-hunter

# Update to latest version
cd ~/.agents/skills/bug-hunter && git pull
```

**Requirements:** Node.js 18+ (for triage and helper scripts). No other dependencies.

**Works with:** Pi, Claude Code, Codex, Cursor, Windsurf, or any AI agent that has file-reading and shell-command tools.

---

## License

MIT — use it however you want.
