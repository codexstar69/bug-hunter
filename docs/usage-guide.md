---
title: Usage guide
description: >
  Request scans, pull-request reviews, security audits, plans, and approved
  fixes from any coding agent.
prompt: |
  can we do that so everything is end to end seamless and anyone and
  specially agents can understand easily how to use it all properly

  you removed a lot of content that helped rank it om google - bring it back

  Use @README.md, @SKILL.md, @docs/getting-started.md,
  @docs/cli-reference.md, and @docs/how-it-works.md as source material.
---

# Usage guide

## The portable request format

Tell the agent four things:

1. Use the `bug-hunter` skill.
2. Name the scope.
3. State whether edits are allowed.
4. State the required result.

Example:

```text
Use the bug-hunter skill to scan src/auth.
Do not edit files.
Return confirmed, dismissed, manual-review, and unreviewed counts.
```

This format works even when the agent does not expose slash commands.

## Scan without edits

Whole repository:

```text
Use the bug-hunter skill to scan this repository. Do not edit files.
```

One directory:

```text
Use the bug-hunter skill to scan src/payments. Do not edit files.
```

One file:

```text
Use the bug-hunter skill to scan src/auth/session.ts. Do not edit files.
```

Slash forms:

```text
/bug-hunter
/bug-hunter src/payments
/bug-hunter src/auth/session.ts
```

## Review changes

Staged changes:

```text
Use the bug-hunter skill to review the staged changes. Do not edit files.
```

```text
/bug-hunter --staged
```

Current pull request:

```text
Use the bug-hunter skill to review the current pull request. Do not edit files.
```

```text
/bug-hunter --pr
```

Specific pull request:

```text
/bug-hunter --pr 123
```

Branch diff:

```text
/bug-hunter -b feature/auth-refresh --base main
```

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

Node.js dependency audit:

```text
/bug-hunter --deps
```

Dependency parsing and reachability currently cover JavaScript and TypeScript
projects using npm, pnpm, Yarn, or Bun lockfiles. Other ecosystems return
`scanner-unsupported`.

## Plan before editing

```text
Use the bug-hunter skill to scan this repository and build a fix plan.
Do not edit files.
```

```text
/bug-hunter --plan
```

This produces strategy and plan artifacts, then stops before the Fixer.

## Preview changes

```text
Use the bug-hunter skill to build a remediation strategy and fix plan.
Do not edit files.
```

```text
/bug-hunter --preview
```

Current preview mode produces strategy and plan output without source edits.
It does not yet produce a schema-backed patch diff.

## Apply fixes with approval

```text
Use the bug-hunter skill to fix confirmed findings.
Ask for approval before every edit.
Do not commit.
```

```text
/bug-hunter --fix --approve
```

`--approve` requests the host's reviewed/default permission mode. Approval
prompts depend on the coding agent.

`--safe` is an alias:

```text
/bug-hunter --safe
```

## Grant autonomous permissions

Only use this mode when unattended edits are intended:

```text
Use the bug-hunter skill to scan and fix confirmed bugs autonomously.
You may edit files. Do not commit.
```

```text
/bug-hunter --autonomous
```

Commit permission is separate:

```text
/bug-hunter --autonomous --auto-commit
```

The commit flag grants commit permission for the approved plan. Review the
harvested commit paths before merging; current validation does not independently
enforce every committed path after a Fixer creates a commit.

## Ask the agent to prove completion

Add this to any request:

```text
Before finishing, validate every generated artifact, report coverage gaps,
run the repository's relevant checks, and state whether any source files,
Git state, or commits changed.
```

The final response should distinguish:

- confirmed bugs
- dismissed claims
- manual-review items
- unreviewed findings
- files edited
- checks run and their results
- commits created

## If the agent does not find the skill

Do not ask it to imitate Bug Hunter from memory. Verify the installed target,
restart the agent, and follow [troubleshooting](troubleshooting.md).
