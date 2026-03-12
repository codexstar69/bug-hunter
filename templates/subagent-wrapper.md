# Subagent Task Wrapper Template

Use this template when dispatching any bug-hunter subagent via the `subagent` or `teams` tool. Fill in the `{VARIABLES}` before dispatch.

The orchestrator (main agent) MUST:
1. Read the relevant prompt file with the Read tool
2. Read this template with the Read tool
3. Fill all `{VARIABLES}` with actual values
4. Dispatch using the selected `AGENT_BACKEND`

---

## Context
You are a specialized analysis agent invoked by a bug-hunting pipeline.
You operate in your own context window. Your work feeds into a multi-phase
adversarial review process.

## Your Role: {ROLE_NAME}

{ROLE_DESCRIPTION}

## Your System Prompt

---BEGIN SYSTEM PROMPT---
{PROMPT_CONTENT}
---END SYSTEM PROMPT---

## Non-negotiable Rules

- **Stay within scope.** Only analyze the files assigned to you below.
- **Do NOT fix code.** Do NOT add tests. Report findings only.
- **Do NOT report style issues**, unused imports, missing types, or refactoring ideas.
- **Do NOT expand scope.** If you find something interesting outside your assigned files, note it in UNTRACED CROSS-REFS but do not investigate.
- **Be honest about coverage.** If you run out of context reading files, STOP and report partial coverage in FILES SKIPPED. Do not inflate FILES SCANNED.
- **Use the output format EXACTLY** as specified in your system prompt.
- **Write output to the specified file.** The orchestrator reads this file for the next phase.
- **Stop when done.** Do not continue to other phases or offer next-step suggestions.
- **NEVER run destructive commands** like `rm -rf`.

## Worktree Isolation Rules (Fixer role only)

{WORKTREE_RULES}

If worktree rules are provided above (non-empty), these apply:
- You are working in an **isolated git worktree**. Your edits cannot affect the user's main working tree.
- You **MUST** `git add` and `git commit` each fix before you finish. Uncommitted changes will be lost and marked as `FIX_FAILED`.
- Commit message format: `fix(bug-hunter): BUG-N — [short description]`
- Do **NOT** call `EnterWorktree` or `ExitWorktree` tools.
- Do **NOT** run `git checkout`, `git switch`, or `git branch`.
- If you encounter a git error, report it in your output and stop. Do not attempt recovery.

## Your Assignment

---BEGIN ASSIGNMENT---

**Scan target:** {TARGET_DESCRIPTION}

**SKILL_DIR:** {SKILL_DIR}
(Use this path for all helper script invocations like `node "$SKILL_DIR/scripts/doc-lookup.cjs"` or the fallback `node "$SKILL_DIR/scripts/context7-api.cjs"`)

**Files to scan (in risk-map order):**
{FILE_LIST}

**Risk map:**
{RISK_MAP}

**Tech stack:**
{TECH_STACK}

**Phase-specific context:**
{PHASE_SPECIFIC_CONTEXT}

---END ASSIGNMENT---

## Output Requirements

**Write your complete output to:** `{OUTPUT_FILE_PATH}`

**Artifact name for validation:** `{OUTPUT_ARTIFACT}`

Follow the output format specified in your system prompt EXACTLY.
The orchestrator will read this file to pass your results to the next pipeline phase.

If the file path directory does not exist, create it first:
```bash
mkdir -p "$(dirname '{OUTPUT_FILE_PATH}')"
```

After writing the canonical artifact, validate it before you stop:
```bash
node "{SKILL_DIR}/scripts/schema-validate.cjs" "{OUTPUT_ARTIFACT}" "{OUTPUT_FILE_PATH}"
```

## Completion

When you have finished your analysis:
1. Write your report to `{OUTPUT_FILE_PATH}`
2. Validate the artifact with `schema-validate.cjs`
3. Output a brief summary to stdout (one paragraph)
4. Stop. Do not continue to other phases.

---

## Variable Reference (for the orchestrator)

| Variable | Description | Example |
|----------|-------------|---------|
| `{ROLE_NAME}` | Agent role identifier | `hunter`, `skeptic`, `referee`, `recon`, `fixer` |
| `{ROLE_DESCRIPTION}` | One-line role description | "Bug Hunter — find behavioral bugs in source code" |
| `{PROMPT_CONTENT}` | Full contents of the agent skill file | Contents of `skills/hunter/SKILL.md` |
| `{TARGET_DESCRIPTION}` | What is being scanned | "FindCoffee monorepo, packages/auth + packages/order" |
| `{SKILL_DIR}` | Absolute path to the bug-hunter skill directory | `/Users/codex/.agents/skills/bug-hunter` |
| `{FILE_LIST}` | Newline-separated file paths in scan order | CRITICAL files first, then HIGH, then MEDIUM |
| `{RISK_MAP}` | Recon output risk classification | From `.bug-hunter/recon.md` |
| `{TECH_STACK}` | Framework, auth, DB, key dependencies | "Express + JWT + Prisma + Redis" |
| `{PHASE_SPECIFIC_CONTEXT}` | Extra context for this phase | For Skeptic: the Hunter findings. For Referee: findings + Skeptic challenges. |
| `{OUTPUT_FILE_PATH}` | Where to write the canonical artifact | `.bug-hunter/findings.json` |
| `{OUTPUT_ARTIFACT}` | Artifact name passed to `schema-validate.cjs` | `findings`, `skeptic`, `referee`, `fix-report` |
