# Shared Dispatch Patterns

This file defines how to dispatch each pipeline role (Recon, Hunter, Skeptic, Referee, Fixer) using any `AGENT_BACKEND`. Mode files reference this instead of duplicating dispatch boilerplate.

---

## Dispatch by Backend

### local-sequential

You execute the role yourself:

1. Read the prompt file: `read({ path: "$SKILL_DIR/prompts/<role>.md" })`
2. If the role needs doc-lookup: also read `$SKILL_DIR/prompts/doc-lookup.md`
3. **Switch mindset** to the role (important for Skeptic/Referee — genuinely adversarial)
4. Execute the role's instructions using the Read tool to examine source files
5. Write output to the role's output file (see Output Files table below)

### subagent

1. Read the prompt file: `read({ path: "$SKILL_DIR/prompts/<role>.md" })`
2. Read the wrapper template: `read({ path: "$SKILL_DIR/templates/subagent-wrapper.md" })`
3. Generate payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate <role> ".bug-hunter/payloads/<role>-<context>.json"
   ```
4. Edit the payload JSON — fill in `skillDir`, `targetFiles`, and role-specific fields
5. Validate:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" validate <role> ".bug-hunter/payloads/<role>-<context>.json"
   ```
6. Fill the subagent-wrapper template variables:
   - `{ROLE_NAME}` = role name (see table below)
   - `{ROLE_DESCRIPTION}` = role description (see table below)
   - `{PROMPT_CONTENT}` = full contents of the prompt .md file
   - `{TARGET_DESCRIPTION}` = what is being scanned
   - `{SKILL_DIR}` = absolute path to skill directory
   - `{FILE_LIST}` = files in scan order (CRITICAL first)
   - `{RISK_MAP}` = risk classification from triage or Recon
   - `{TECH_STACK}` = framework, auth, DB from Recon
   - `{PHASE_SPECIFIC_CONTEXT}` = role-specific context (see below)
   - `{OUTPUT_FILE_PATH}` = output file path
7. Dispatch:
   ```
   subagent({ agent: "<role>-agent", task: "<filled template>", output: "<output-path>" })
   ```
8. Read the output file after completion

### teams

Same as subagent, but dispatch with:
```
teams({ tasks: [{ text: "<filled template>" }], maxTeammates: 1 })
```

### interactive_shell

```
interactive_shell({ command: 'pi "<filled task prompt>"', mode: "dispatch" })
```

---

## Role Reference

| Role | Prompt File | Role Description | Output File | Phase-Specific Context |
|------|-------------|-----------------|-------------|----------------------|
| `recon` | `prompts/recon.md` | Reconnaissance agent — map the codebase and classify files by risk | `.bug-hunter/recon.md` | Triage JSON path (if exists) |
| `hunter` | `prompts/hunter.md` | Bug Hunter — find behavioral bugs in source code | `.bug-hunter/findings.md` | `doc-lookup.md` + risk map + tech stack |
| `skeptic` | `prompts/skeptic.md` | Skeptic — adversarial review to disprove false positives | `.bug-hunter/skeptic.md` | Hunter findings (compact: bugId, severity, file, lines, claim, evidence, runtimeTrigger) + `doc-lookup.md` |
| `referee` | `prompts/referee.md` | Referee — impartial final judge of all findings | `.bug-hunter/referee.md` | Hunter findings + Skeptic challenges |
| `fixer` | `prompts/fixer.md` | Surgical code fixer — implement minimal fixes for confirmed bugs | `.bug-hunter/fix-report.md` | Confirmed bugs from Referee + tech stack + `doc-lookup.md` |

---

## Fixer Dispatch: Worktree Isolation (subagent/teams only)

When `WORKTREE_MODE=true`, the Fixer runs in a managed git worktree for isolation. The orchestrator handles the full lifecycle — the Fixer just edits and commits.

**Key differences from other role dispatches:**

1. The worktree is created by the orchestrator via `worktree-harvest.cjs prepare` BEFORE dispatch.
2. The Fixer's working directory is set to the worktree's absolute path, not the project root.
3. The Fixer MUST `git add` + `git commit` each fix (uncommitted work = `FIX_FAILED`).
4. The orchestrator harvests commits via `worktree-harvest.cjs harvest` AFTER dispatch.
5. The orchestrator cleans up via `worktree-harvest.cjs cleanup` AFTER harvest.

**CRITICAL — do NOT use `isolation: "worktree"` on the Agent tool:**
The Agent tool's built-in worktree isolation creates an ephemeral branch and auto-cleans on exit, which loses Fixer commits. We manage worktrees ourselves so the Fixer commits land directly on the fix branch.

**Fixer-specific template variables for `{PHASE_SPECIFIC_CONTEXT}`:**
- `WORKTREE_DIR: <absolute path to worktree>`
- `FIX_BRANCH: <branch name>`
- `COMMIT_FORMAT: fix(bug-hunter): BUG-N — [description]`
- Worktree isolation rules (see `{WORKTREE_RULES}` in subagent-wrapper.md)

**Lifecycle diagram:**
```
Orchestrator                         Fixer (in worktree)
     |                                     |
     |-- prepare (worktree-harvest.cjs) -->|
     |                                     |-- read code
     |                                     |-- edit files
     |                                     |-- git add + commit per bug
     |                                     |-- report done
     |<-- harvest (worktree-harvest.cjs) --|
     |-- cleanup (worktree-harvest.cjs)    |
     |-- verify on fix branch              |
```

---

## Context Pruning Rules

When passing data between phases, include only what the receiving role needs:

**To Skeptic:** For each bug: BUG-ID, severity, file, lines, claim, evidence, runtimeTrigger, cross-references. Omit: Hunter's internal reasoning, scan coverage stats, FILES SCANNED/SKIPPED metadata.

**To Referee:** Full Hunter findings + full Skeptic challenges. The Referee needs both sides to judge.

**To Fixer:** For each confirmed bug: BUG-ID, severity, file, line range, description, suggested fix direction, tech stack context. Omit: Skeptic challenges, Referee reasoning.
