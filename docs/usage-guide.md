---
title: Usage guide
description: >
  Request scans, complete-coverage loops, pull-request/security reviews, plans,
  and explicitly authorized fixes from any coding agent.
prompt: |
  Translate the user's audit intent into the narrowest safe Bug Hunter request,
  preserve scan-only defaults unless edits are explicit, and require unresolved
  review, coverage, and verification state to remain visible.
---

# Usage guide

## The portable request format

Tell the agent four things:

1. use the `bug-hunter` skill;
2. name the scope;
3. state whether edits are allowed;
4. state the required result/completion condition.

Example:

```text
Use the bug-hunter skill to scan src/auth.
Do not edit files.
Return confirmed, dismissed, manual-review, and unreviewed counts.
Report any coverage or required-verification failure.
```

This format works even when the agent does not expose slash commands.

## Understand the defaults

No flags means:

- scan-only;
- single-pass;
- no source edits;
- no commit permission.

Use `--loop` when you want the queued scope worked until every file has a
terminal coverage outcome. Loop authority changes completion behavior, not
mutation authority.

## Scan without edits

Whole repository:

```text
Use the bug-hunter skill to scan this repository. Do not edit files.
```

Complete queued coverage:

```text
Use the bug-hunter skill to scan this repository until queued coverage is complete.
Do not edit files.
```

Slash forms:

```text
/bug-hunter
/bug-hunter --loop
/bug-hunter src/payments
/bug-hunter src/auth/session.ts
```

## Review changes

Staged changes:

```text
/bug-hunter --staged
```

Current pull request:

```text
/bug-hunter --pr
```

Specific/recent pull request:

```text
/bug-hunter --pr 123
/bug-hunter --pr recent
```

Branch diff:

```text
/bug-hunter -b feature/auth-refresh --base main
```

Changed-code scope still scans the resolved source files rather than treating a
patch hunk as enough context to prove runtime behavior.

## Security review

Pull-request security review:

```text
/bug-hunter --pr-security
```

Repository security workflow:

```text
/bug-hunter --security-review
```

Threat model:

```text
/bug-hunter --threat-model
```

Supported Node.js dependency audit:

```text
/bug-hunter --deps
```

Dependency parsing/reachability currently covers JavaScript and TypeScript
projects using npm, pnpm, Yarn, or Bun lockfiles. Unsupported ecosystems return
`scanner-unsupported`; do not read that as “no vulnerabilities.”

## Precision-first behavior

The current runtime can use adaptive/retrieval/verification layers internally:

- deterministic risk ordering before model work;
- token-bounded chunks from actual assigned file estimates;
- `fast`, `balanced`, or `assurance` adaptive policy when the runner is driven
  with adaptive inputs;
- hypothesis-directed symbol/dependency context under hard budgets;
- exact evidence reuse keyed to current source hashes;
- optional required hybrid verification before Fixer authorization.

These layers never broaden the user's source scope or mutation permission.

## Plan before editing

```text
Use the bug-hunter skill to scan this repository and build a fix plan.
Do not edit files.
```

```text
/bug-hunter --plan
```

This produces strategy/plan artifacts and stops before Fixer mutation.

## Preview remediation

```text
/bug-hunter --preview
```

Preview/dry-run mode builds remediation output without source edits or commit
permission. Treat its output as a plan to review, not proof that a patch was
applied.

## Apply fixes with approval

```text
Use the bug-hunter skill to fix confirmed executable findings.
Ask for approval before edits. Do not commit.
```

```text
/bug-hunter --fix --approve
```

`--safe` is an alias for the reviewed fix mode:

```text
/bug-hunter --safe
```

Only Referee-confirmed findings that survive remediation classification may
enter executable Fixer scope. Manual-review/larger-refactor/architectural work
remains non-writable.

## Grant autonomous permissions

Only when unattended edits are intended:

```text
/bug-hunter --autonomous
```

Commit permission remains separate:

```text
/bug-hunter --autonomous --auto-commit
```

Review resulting paths and verification evidence before merging. Autonomous
mode does not waive source-integrity, Fixer-scope, canary, circuit-breaker, or
rollback safeguards.

## Ask the agent to prove completion

Add this to a request when you need an auditable finish:

```text
Before finishing, validate every canonical artifact, report coverage gaps and
required-verification failures, run the relevant repository checks, and state
whether source files, Git state, or commits changed.
```

The final response should distinguish:

- confirmed bugs;
- dismissed claims;
- manual-review items;
- unreviewed findings;
- coverage failures/pending scope;
- hybrid verification status when used;
- files edited;
- checks run/results;
- commits created.

## Useful canonical artifacts

- `.bug-hunter/adaptive-plan.json` — bounded execution policy;
- `.bug-hunter/retrieval-plan.json` — selected evidence/context;
- `.bug-hunter/hunter-findings.json` — Hunter claims;
- `.bug-hunter/referee.json` — final verdicts;
- `.bug-hunter/verification-report.json` — hybrid verification evidence;
- `.bug-hunter/scan-report.json` — joined result;
- `.bug-hunter/coverage.json` — per-file coverage;
- `.bug-hunter/fixer-scope.json` — immutable writable scope;
- `.bug-hunter/fix-report.json` — remediation outcome.

## If the agent does not find the skill

Do not ask it to imitate Bug Hunter from memory. Verify the exact installed
target/package source, restart the agent, and follow
[troubleshooting](troubleshooting.md).
