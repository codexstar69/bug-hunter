<p align="center">
  <img src="assets/pipeline-diagram.png" alt="Bug Hunter — adversarial AI bug detection pipeline diagram showing Recon, Hunters, Skeptics, Referee, and Fixer agents" width="100%" />
</p>

<h1 align="center">/bug-hunter</h1>

<p align="center">
  <strong>Adversarial AI bug detection and auto-fix for coding agents</strong><br/>
  Multi-agent pipeline that finds security vulnerabilities, logic errors, and runtime bugs — then fixes them autonomously on a safe branch.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" /></a>
</p>

---

## Why Bug Hunter?

LLMs are sycophantic code reviewers. Ask one to find bugs and it over-reports. Ask it to verify those bugs and it agrees with itself. The result: noise, false positives, wasted time.

**Bug Hunter** solves this by pitting multiple AI agents against each other in isolated contexts. Each agent has competing incentives — adversarial tension that produces high-fidelity bug reports with minimal false positives.

Unlike traditional static analysis tools, Bug Hunter understands runtime behavior, cross-file dependencies, and framework-specific patterns. It catches the bugs that linters miss.

---

## How Adversarial Bug Detection Works

### Phase 1 — Find and Verify Bugs

```
                    +-- Hunter-A (Security lens) --+       +-- Skeptic-A (cluster 1) --+
Recon (map) ------->|                              |-- merge ->|                          |-- merge --> Referee
                    +-- Hunter-B (Logic lens)    --+       +-- Skeptic-B (cluster 2) --+
```

| Step | Agent | What it does | Scoring incentive |
|------|-------|--------------|-------------------|
| 1 | **Recon** | Maps codebase architecture, identifies trust boundaries, computes context budget | Accurate risk map = better Hunter coverage |
| 2 | **Hunters** | Dual-lens scan (security + logic) with mandatory security checklist per file | +1/+5/+10 per real bug. -3 per false positive |
| 3 | **Skeptics** | Adversarially challenge every finding, verify claims against real docs via Context7 | +points for disproving false positives. **-2x penalty** for wrongly dismissing real bugs |
| 4 | **Referee** | Reads code independently, spot-checks evidence quotes, makes final verdicts | Symmetric +1/-1 scoring. Ground truth framing |

Every agent runs in **completely isolated context** — they cannot see each other's reasoning, only structured findings. This prevents anchoring bias and forces independent verification.

### Phase 2 — Auto-Fix and Verify

```
                  +-- Fixer-A (worktree 1) --+
Git branch ------>|                          |-- merge --> Test diff --> Report
                  +-- Fixer-B (worktree 2) --+
```

| Step | Agent | What it does |
|------|-------|--------------|
| 5 | **Fixers** | Apply minimal surgical fixes in isolated git worktrees, one checkpoint commit per bug |
| 6 | **Verify** | Run test suite, diff against baseline, auto-revert any fix that introduces regressions |
| 7 | **Re-scan** | Lightweight Hunter scans only changed lines to catch fixer-introduced bugs |

Each fix is an individual commit that can be reverted independently. Failed fixes are auto-reverted — the codebase stays clean.

---

## Supported Editors and Terminals

Bug Hunter works with any IDE or terminal that supports coding agent skills:

| Platform | Status |
|----------|--------|
| **VS Code** / **Cursor** / **Windsurf** | Full support |
| **JetBrains** (IntelliJ, PyCharm, WebStorm) | Full support |
| **Antigravity** (Google) | Full support |
| **Kiro** (AWS) | Full support |
| **Gemini CLI** | Full support |
| **OpenAI Codex CLI** | Full support |
| **Amp** | Full support |
| **Neovim** / **Vim** | Full support via terminal |
| **Any terminal** (iTerm2, Ghostty, Warp, Alacritty, Kitty, Hyper, Windows Terminal) | Full support |

> Works everywhere. If your editor or terminal supports coding agent skills, Bug Hunter works out of the box.

---

## Installation

```bash
git clone https://github.com/codexstar69/bug-hunter.git ~/.claude/skills/bug-hunter
```

Coding agents auto-discover skills in `~/.claude/skills/`.

### Set Up Context7 (Recommended)

Bug Hunter verifies claims about library and framework behavior against real documentation using the [Context7](https://context7.com) API. This significantly reduces false positives from hallucinated framework assumptions.

1. Get a free API key from [context7.com](https://context7.com)
2. Add to your shell profile (`.zshrc`, `.bashrc`, etc.):

```bash
export CONTEXT7_API_KEY="your-api-key-here"
```

3. Restart your terminal

On first run, Bug Hunter checks for the key and runs a smoke test. If missing, it prompts you to set it up.

---

## Usage

```bash
/bug-hunter                              # Scan entire project
/bug-hunter src/                         # Scan specific directory
/bug-hunter lib/auth.ts                  # Scan specific file
/bug-hunter -b feature-xyz              # Scan files changed in feature-xyz vs main
/bug-hunter -b feature-xyz --base dev   # Scan files changed in feature-xyz vs dev
/bug-hunter --staged                    # Scan staged files (pre-commit check)
/bug-hunter --fix src/                   # Find bugs AND auto-fix them
/bug-hunter --fix -b feature-xyz        # Find + fix on branch diff
/bug-hunter --fix --approve src/        # Find + fix, but approve each fix manually
/bug-hunter --loop src/                  # Loop mode: audit until 100% coverage
/bug-hunter --loop --fix src/            # Loop mode: find + fix until clean
```

### Auto-Scaling Modes

The pipeline auto-selects the right mode based on codebase size. Recon dynamically computes the context budget per agent based on average file sizes.

| Mode | Source files | Agents launched |
|------|-------------|-----------------|
| **Single-file** | 1 | 1 Hunter + 1 Skeptic + 1 Referee |
| **Small** | 2-10 | 1 Hunter + 1 Skeptic + 1 Referee |
| **Parallel** | 11-40 | Recon + 2 Hunters + 2 Skeptics + Referee |
| **Extended** | 41-80 | Recon + 4 Hunters + 2 Skeptics + Referee |
| **Scaled** | 81-120 | Recon + 6 Hunters + 3 Skeptics + Referee |
| **Loop** | 120+ | Iterates in batches until full coverage achieved |

---

## What Bugs Does It Catch?

Bug Hunter scans for **behavioral bugs** — issues that cause incorrect behavior at runtime:

- **Security vulnerabilities** — SQL injection, authentication bypass, SSRF, path traversal, hardcoded secrets, JWT without expiry
- **Logic errors** — off-by-one, wrong comparisons, inverted conditions, broken pagination
- **Error handling gaps** — silent error swallowing, missing null checks, unhandled promise rejections
- **Type safety issues** — type coercion traps across boundaries, non-string inputs to string-only APIs
- **Race conditions** — async I/O interleaving, shared mutable state without coordination
- **API contract violations** — wrong status codes, missing required fields, broken callers
- **Data integrity bugs** — truncation, encoding issues, timezone bugs, integer overflow
- **Cross-file bugs** — assumption mismatches across module boundaries, auth gaps in call chains

### What It Skips (By Design)

Style, formatting, naming conventions, unused imports, missing types, TODO comments, test coverage gaps, dependency versions. Those are linter and type-checker responsibilities.

---

## Scoring System

The scoring incentives are **load-bearing** — they exploit each agent's desire to maximize its score:

| Agent | Scoring | Effect |
|-------|---------|--------|
| **Hunter** | +1/+5/+10 per real Low/Medium/Critical bug. -3 per false positive | Motivates thoroughness but penalizes sloppiness |
| **Skeptic** | +points for valid disproves. **-2x points** for wrongly dismissing real bugs | Creates calibrated caution — only disproves when >67% confident |
| **Referee** | Symmetric +1/-1 with ground truth framing | Precise rather than biased toward either side |

Five real bugs beat twenty false positives. Quality over quantity.

---

## Autonomous Fix Pipeline

By default, the fix pipeline is **fully autonomous** — no human intervention needed. Bugs are found, fixed, tested, and verified end-to-end.

**All fixes happen on a separate branch.** Your working branch is never touched. Review the diff, then merge when you're ready.

| Mode | Behavior |
|------|----------|
| `--fix` (default) | Fully autonomous — creates branch, applies fixes, runs tests, auto-reverts failures |
| `--fix --approve` | Pauses before each fix for manual approval |

### Git Safety and Branch Protection

1. **Dedicated fix branch** — creates `bug-hunter-fix-<timestamp>` from your current branch. Your code stays untouched until you merge.
2. **Stashes uncommitted work** — any dirty working tree is stashed before fixes begin, restored after
3. **Test baseline** — captures pre-fix test results for accurate regression diffing
4. **Checkpoint commits** — each bug fix is a separate `fix(bug-hunter): BUG-N` commit
5. **Auto-revert on regression** — if a fix causes new test failures, it is automatically reverted via `git revert`
6. **Post-fix re-scan** — a lightweight Hunter scans only changed lines to catch fixer-introduced bugs
7. **Individual revertability** — any single fix can be surgically reverted without affecting others
8. **Test hook auto-detection** — auto-detects test runner, typecheck, and build commands from your project config

---

## Supported Languages

Bug Hunter works with any language your coding agent can read. It has been tested extensively with:

- TypeScript / JavaScript (Node.js, React, Next.js, Express)
- Python (Django, Flask, FastAPI)
- Go
- Rust
- Java / Kotlin
- Ruby
- PHP

---

## Project Structure

```
bug-hunter/
  SKILL.md              # Core dispatcher (argument parsing, mode routing, report)
  prompts/              # Agent prompt files
    recon.md            # Architecture mapper
    hunter.md           # Bug finder (dual-lens: security + logic)
    skeptic.md          # Adversarial challenger
    referee.md          # Final arbiter
    fixer.md            # Surgical code fixer
    doc-lookup.md       # Context7 doc verification reference
  modes/                # Execution mode files (loaded on demand)
    single-file.md      # 1 file
    small.md            # 2-10 files
    parallel.md         # 11-40 files
    extended.md         # 41-80 files
    scaled.md           # 81-120 files
    loop.md             # Coverage tracking across iterations
    fix-pipeline.md     # Phase 2: fix + verify
    fix-loop.md         # Combined find + fix loop
  scripts/
    context7-api.cjs    # Context7 doc lookup CLI
    init-test-fixture.sh # Initialize test fixture git repo
  test-fixture/         # Self-test app with planted bugs
  assets/               # Images and diagrams
```

---

## Self-Test

Bug Hunter ships with a test fixture — a small Express app with 6 intentionally planted bugs (2 Critical, 2 Medium, 2 Low). Run it to validate the pipeline:

```bash
/bug-hunter test-fixture/
```

Expected results:
- Recon classifies 3 files as CRITICAL, 1 as HIGH
- Hunters find all 6 bugs
- Skeptic challenges at least 1 false positive
- Referee confirms all planted bugs

---

## FAQ

### How is this different from a linter or static analysis tool?

Linters check syntax and style. Static analysis tools check type safety and simple patterns. Bug Hunter finds **runtime behavioral bugs** — logic errors, security vulnerabilities, race conditions, and cross-file assumption mismatches that no linter can detect. It understands what your code *does*, not just how it looks.

### Does it modify my code directly?

No. All fixes are applied on a **dedicated branch** (`bug-hunter-fix-<timestamp>`). Your working branch is never modified. You review the diff and merge when ready.

### What if a fix breaks something?

Each fix is a separate checkpoint commit. If a fix causes new test failures, it is **automatically reverted** — no manual cleanup needed. The codebase stays clean.

### How do I review fixes before they're applied?

Use `--approve` mode: `/bug-hunter --fix --approve src/`. The system pauses before each fix and waits for your approval.

### What languages does it support?

Any language your coding agent can read. Tested with TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Ruby, and PHP.

### How does it reduce false positives?

Three mechanisms: (1) adversarial Skeptic agents that challenge every finding, (2) Context7 doc verification against real library documentation, and (3) an independent Referee that reads code from scratch before making final verdicts. Agents are scored with asymmetric penalties that make false positives expensive.

---

## Update

```bash
cd ~/.claude/skills/bug-hunter && git pull
```

## Uninstall

```bash
rm -rf ~/.claude/skills/bug-hunter
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
