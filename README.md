<p align="center">
  <img src="assets/pipeline-diagram.png" alt="Bug Hunter Pipeline Diagram" width="100%" />
</p>

<h1 align="center">/bug-hunter</h1>

<p align="center">
  <strong>Adversarial bug finding &amp; auto-fix skill for AI coding agents</strong><br/>
  Uses parallel isolated AI agent teams to find, verify, and optionally fix real bugs with high fidelity.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" /></a>
</p>

---

## The Problem

LLMs are sycophantic code reviewers. Ask one to find bugs and it over-reports. Ask it to verify those bugs and it agrees with itself. The result: noise, false positives, wasted time.

## The Solution

**Bug Hunter** pits multiple AI agents against each other in isolated contexts. Each agent has competing incentives that exploit their desire to maximize a score. The adversarial tension produces high-fidelity results.

---

## How It Works

### Phase 1 — Find & Verify

```
                    +-- Hunter-A (Security lens) --+       +-- Skeptic-A (cluster 1) --+
Recon (map) ------->|                              |-- merge ->|                          |-- merge --> Referee
                    +-- Hunter-B (Logic lens)    --+       +-- Skeptic-B (cluster 2) --+
```

| Step | Agent | Role | Incentive |
|------|-------|------|-----------|
| 1 | **Recon** | Maps architecture, identifies trust boundaries, computes context budget | Accurate risk map = better Hunter coverage |
| 2 | **Hunters** | Dual-lens scan (security + logic) with mandatory security checklist sweep | +1/+5/+10 per real bug found. -3 per false positive |
| 3 | **Skeptics** | Adversarially challenge each finding, verify against real docs via Context7 | +points for disproving false positives. **-2x penalty** for wrongly dismissing real bugs |
| 4 | **Referee** | Reads code independently, spot-checks evidence quotes, makes final verdicts | Symmetric +1/-1 scoring. Ground truth framing |

Every agent runs in **completely isolated context** — they cannot see each other's reasoning, only structured findings. This prevents anchoring bias.

### Phase 2 — Fix & Verify (with `--fix`)

```
                  +-- Fixer-A (worktree 1) --+
Git branch ------>|                          |-- merge --> Test diff --> Report
                  +-- Fixer-B (worktree 2) --+
```

| Step | Agent | Role |
|------|-------|------|
| 5 | **Fixers** | Apply minimal surgical fixes in isolated git worktrees, one checkpoint commit per bug |
| 6 | **Verify** | Run test suite, diff against baseline, auto-revert fixes that introduce regressions |
| 7 | **Re-scan** | Lightweight Hunter scans only changed lines to catch fixer-introduced bugs |

Each fix is an individual commit that can be reverted independently. Failed fixes are auto-reverted — the codebase stays clean.

---

## Compatibility

Bug Hunter works with any terminal or IDE that supports coding agent skills:

| Platform | Status |
|----------|--------|
| **VS Code** / **Cursor** / **Windsurf** | Full support |
| **JetBrains** (IntelliJ, PyCharm, WebStorm) | Full support |
| **Antigravity** (Google) | Full support — skills compatible |
| **Kiro** (AWS) | Full support — skills compatible |
| **Gemini CLI** | Full support — skills compatible |
| **OpenAI Codex CLI** | Full support — skills compatible |
| **Amp** | Full support — skills compatible |
| **Neovim** / **Vim** | Full support via terminal |
| **Any terminal** (iTerm2, Ghostty, Warp, Alacritty, Kitty, Hyper, Windows Terminal) | Full support |

> **Works everywhere.** If your terminal or IDE supports coding agent skills, Bug Hunter works out of the box.

---

## Install

```bash
git clone https://github.com/codexstar69/bug-hunter.git ~/.claude/skills/bug-hunter
```

Coding agents auto-discover skills in `~/.claude/skills/`.

### Setup Context7 (recommended)

The pipeline verifies claims about library/framework behavior against real documentation using the [Context7](https://context7.com) API. This significantly reduces false positives from hallucinated framework assumptions.

1. Get a free API key from [context7.com](https://context7.com)
2. Add to your shell profile (`.zshrc`, `.bashrc`, etc.):

```bash
export CONTEXT7_API_KEY="your-api-key-here"
```

3. Restart your terminal

On first run, Bug Hunter checks for the key and runs a smoke test. If missing, it will prompt you to set it up.

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
/bug-hunter --loop src/                  # Loop mode: audit until 100% coverage
/bug-hunter --loop --fix src/            # Loop mode: find + fix until clean
```

### Auto-scaling Modes

The pipeline auto-selects the right mode based on codebase size. Recon dynamically computes the context budget per agent based on average file sizes.

| Mode | Source Files | Agents Launched |
|------|-------------|-----------------|
| **Single-file** | 1 | 1 Hunter + 1 Skeptic + 1 Referee |
| **Small** | 2-10 | 1 Hunter + 1 Skeptic + 1 Referee |
| **Parallel** | 11-40 | Recon + 2 Hunters + 2 Skeptics + Referee |
| **Extended** | 41-80 | Recon + 4 Hunters + 2 Skeptics + Referee |
| **Scaled** | 81-120 | Recon + 6 Hunters + 3 Skeptics + Referee |
| **Loop** | 120+ | Iterates until full coverage achieved |

---

## What It Catches

Bug Hunter scans for **behavioral bugs** — things that cause incorrect behavior at runtime:

- **Security vulnerabilities** — SQL injection, auth bypass, SSRF, path traversal, hardcoded secrets, JWT without expiry
- **Logic errors** — off-by-one, wrong comparisons, inverted conditions, broken pagination
- **Error handling gaps** — silent error swallowing, missing null checks, unhandled promise rejections
- **Type safety issues** — type coercion traps across boundaries, non-string inputs to string-only APIs
- **Race conditions** — async I/O interleaving, shared mutable state without coordination
- **API contract violations** — wrong status codes, missing required fields, broken callers
- **Data integrity** — truncation, encoding issues, timezone bugs, integer overflow
- **Cross-file bugs** — assumption mismatches across module boundaries, auth gaps in call chains

### What It Skips (by design)

Style, formatting, naming conventions, unused imports, missing types, TODO comments, test coverage gaps, dependency versions. Those are linter and type-checker jobs.

---

## How the Scoring Works

The scoring incentives are **load-bearing** — they exploit each agent's desire to maximize its score:

| Agent | Scoring | Effect |
|-------|---------|--------|
| **Hunter** | +1/+5/+10 per real Low/Medium/Critical bug. -3 per false positive | Motivates thoroughness but penalizes sloppiness |
| **Skeptic** | +points for valid disproves. **-2x points** for wrongly dismissing real bugs | Creates calibrated caution — only disprove when >67% confident |
| **Referee** | Symmetric +1/-1 with ground truth framing | Makes it precise rather than biased toward either side |

Five real bugs beat twenty false positives. Quality over quantity.

---

## Fix Pipeline Safety

When using `--fix`, Bug Hunter takes extensive precautions:

1. **Git safety** — stashes uncommitted changes, creates a dedicated fix branch
2. **Test baseline** — captures pre-fix test results for accurate diffing
3. **Checkpoint commits** — each bug fix is a separate `fix(bug-hunter): BUG-N` commit
4. **Auto-revert** — if a fix causes new test failures, it's automatically reverted via `git revert`
5. **Post-fix re-scan** — a lightweight Hunter scans only changed lines to catch fixer-introduced bugs
6. **Individual revertability** — any fix can be surgically reverted without affecting others

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

MIT - see [LICENSE](LICENSE) for details.
