---
title: Precision-first bug hunting protocol
description: >
  Deterministic scoping, evidence gates, adaptive context budgeting, and
  adversarial verification rules for fast Bug Hunter runs with fewer false
  positives and fewer missed high-impact bugs.
prompt: |
  Explain or apply Bug Hunter's precision-first scanning protocol.
---

# Precision-first bug hunting protocol

Bug Hunter now treats context as a bounded evidence budget rather than a fixed
file count. The goal is not to maximize findings; it is to maximize confirmed,
reachable bugs per token and per minute.

## 1. Deterministic scope before model work

Triage and code-index share one source-extension catalog. The risk-ordered file
list is preserved exactly through state initialization and later expansion, so
critical trust boundaries are scanned before lower-risk helpers.

## 2. Adaptive source-token chunks

Unless the caller supplies `--chunk-size`, the runtime estimates source tokens
from every assigned file and greedily builds risk-ordered 1-30 file chunks whose
combined estimate stays within a 48,000-source-token budget. A single oversized
file is isolated and explicitly marked oversized instead of silently inflating a
mixed chunk. Use `--max-source-tokens` to tune the budget for a model or agent.

The budget intentionally leaves room for role instructions, cross-file reads,
reasoning, structured output, Skeptic challenges, and Referee verification.

## 3. Fail-closed coverage

An assigned file that disappears is a scope-integrity failure. The chunk is
marked failed and fix planning is blocked. Unchanged files may be skipped only
when their current hash matches prior scan evidence.

## 4. Evidence contract

Every finding needs a concrete runtime trigger and at least one cross-reference
entry. Security findings additionally require a non-N/A STRIDE class and a
specific `CWE-<number>`. Invalid artifacts are retried or rejected before they
enter the bug ledger.

## 5. Adversarial verification without blind exclusions

Generic hardening suggestions remain cheap to dismiss, but rate-limit findings
with reachable credential stuffing, reset/OTP abuse, lockout bypass, measurable
amplification, or attacker-triggered expensive work receive normal analysis.
This removes a contradiction that could suppress real authentication bugs.

## 6. Progressive calibration

Hunter and Skeptic examples are optional calibration material. Load them only
for ambiguous cases, lower-confidence judgments, or explicit requests. Settled
cases use the compact role contract and current code evidence only.

## Completion gate

A protocol change is accepted only when generated validators are current, all
Node tests pass, preflight succeeds, and the npm package inventory contains all
runtime dependencies and documentation.

## 7. Scope and evidence integrity

Run scope is canonicalized through real paths and must remain inside the Git
repository. Hunter findings are accepted only for the exact files assigned to
the current chunk. The source hashes captured before dispatch are verified again
before findings, fact cards, hashes, and chunk completion are committed in one
state transaction. Source mutation, deletion, unreadability, or symlink escape
fails the chunk closed.

Fixer scope contains only canary and rollout entries. Confirmed findings that are
classified for manual review or report-only remediation never become writable
Fixer authorization.

## 8. Stable evidence merge

Duplicate observations retain the strongest confidence-backed evidence, union
cross-references, preserve security STRIDE/CWE metadata, and receive unique
stable IDs when separate bugs collide on a worker-provided ID. Large-file cache
keys use streaming SHA-256 rather than size and timestamp surrogates.
