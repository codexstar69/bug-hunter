# Bug Hunter Skill — End-to-End Fix Plan

## Executive Summary

The bug-hunter skill has a well-designed multi-phase pipeline (Recon → Hunter → Skeptic → Referee → Fixer) with 1,760 lines of prompt/mode/orchestration instructions and ~830 lines of helper scripts. But when an LLM agent actually tries to execute it, **it fails silently at the first decision point** and collapses into doing manual analysis without any pipeline at all.

This plan diagnoses every root cause, proposes concrete fixes, and provides an implementation order.

---

## Part 1: Root Cause Analysis — Why the Skill Breaks

### Problem 1: "Launch subagent" is never defined concretely

**Where it breaks:** Every mode file (small.md, parallel.md, extended.md, scaled.md) says things like:

> "Launch one general-purpose subagent with the recon prompt."

But **nowhere** does the skill tell the orchestrating agent HOW to launch a subagent. There's no:
- Tool name to call (`subagent`, `teams`, `interactive_shell`)
- Payload format showing how to pass the prompt content as a system prompt
- Example of a complete tool invocation
- Mapping from `AGENT_BACKEND` values to actual tool calls

The skill says to "detect available orchestration primitives" (Step 0.6), but gives zero code showing what detection looks like. The agent has access to `subagent()`, `teams()`, and `interactive_shell()` tools — but the skill never mentions any of them by name.

**Result:** The agent doesn't know how to dispatch subagents, so it falls through all backends to `local-sequential`, and then there are **no instructions for how local-sequential mode works**. So the agent just starts reading code manually, abandoning the pipeline entirely.

### Problem 2: `local-sequential` mode has no implementation

**Where it breaks:** SKILL.md line 170:

> `4. local-sequential (no subagents; run all phases in the main agent)`

This is listed as the final fallback, but there is no `modes/local-sequential.md` file and no instructions anywhere for how to run the pipeline phases sequentially within the main agent's context. When all subagent backends fail (which they will — see Problem 1), the agent has no instructions to follow.

### Problem 3: The payload-guard.cjs creates a chicken-and-egg problem

**Where it breaks:** Every mode step requires:

```
node "$SKILL_DIR/scripts/payload-guard.cjs" validate "<role>" "<payload-json-path>"
```

But the skill never tells the agent:
1. How to construct the payload JSON file
2. What the exact schema for each role looks like (beyond the field names in payload-guard.cjs)
3. Where to write the JSON file
4. What `outputSchema` should contain (it's required for every role)

The agent is supposed to create `.claude/payloads/hunter-small.json` etc., but has no template or example showing what goes inside. The payload-guard validates structure but the skill never shows how to BUILD the structure.

### Problem 4: Mode files assume subagent dispatch but don't explain the handoff

Each mode file (e.g., small.md) says:

> "Launch one general-purpose subagent with the hunter prompt. Include the risk map and scan order."

This leaves critical questions unanswered:
- Does "include" mean inject into the task string? Into the system prompt? Into a file the subagent reads?
- How does the orchestrator get the subagent's output back?
- What format is the output in — structured JSON or freeform text?
- How does the orchestrator know when the subagent is done?

### Problem 5: No concrete examples anywhere

The reference subagent prompts you showed me (from the Factory system) demonstrate the gold standard:

```
---BEGIN SUBAGENT SYSTEM PROMPT---
# Worker Droid
Complete the requested task and report back concisely...
---END SUBAGENT SYSTEM PROMPT---

---BEGIN TASK FROM PARENT AGENT---
Goal: ...
Context: ...
Steps: ...
Expected output format: ...
---END TASK FROM PARENT AGENT---
```

The bug-hunter skill has none of this. It has raw prompts (hunter.md, skeptic.md, etc.) that are meant to BE the subagent's personality, but no wrapping that tells the subagent:
- What its mission boundaries are
- What files/context to read
- What output format to produce
- When to stop

### Problem 6: The scripts don't get triggered because the orchestrator doesn't know when/how

The scripts (run-bug-hunter.cjs, bug-hunter-state.cjs, code-index.cjs, delta-mode.cjs) are well-written Node.js utilities. But:
- `run-bug-hunter.cjs` is designed to orchestrate via shell commands (`workerCmd` template), not via LLM tool calls
- Its `selectBackend()` defaults to `['local-sequential']` when no env var is set
- It writes journal/state files, but the SKILL.md doesn't tell the agent to READ those files to decide next actions
- The agent never runs `run-bug-hunter.cjs run ...` because Step 3 presents it as optional ("prefer" this command) rather than mandatory

### Problem 7: Coverage tracking doesn't force continuation

The `--loop` mode with ralph-loop integration is well-designed on paper. But:
- The agent was never told to use `--loop`
- Even without `--loop`, there's no mechanism that says "if you haven't covered all files, keep going"
- The Context Budget table at the bottom says `> FILE_BUDGET*3: Loop mode required` but this is a recommendation, not a hard enforcement
- The `> FILE_BUDGET*3` row says to "force LOOP_MODE=true" but this only happens if the agent reaches Step 3 and correctly counts files — which requires Recon to complete first

### Problem 8: `disable-model-invocation: true` hides the skill

The SKILL.md frontmatter has `disable-model-invocation: true`, which means Pi will NOT inject this skill into the system prompt automatically. The user MUST use `/bug-hunter` or `/skill:bug-hunter` explicitly. If the user just says "audit this codebase for bugs," the agent won't know the skill exists.

---

## Part 2: The Fix Architecture

### Design Principles (learned from the Factory examples)

1. **Every subagent gets a complete, self-contained prompt** — not a reference to a file to read, but the actual instructions inline with clear `---BEGIN/END---` delimiters
2. **Every subagent has explicit scope boundaries** — what to do, what NOT to do, when to stop
3. **Every subagent has a concrete output contract** — exact format, where to write it, what fields are required
4. **The orchestrator has concrete tool call examples** — not "launch a subagent" but `subagent({ agent: "worker", task: "..." })`
5. **State is file-based and machine-parseable** — so the orchestrator can read it back and decide what to do next
6. **The orchestrator never has to guess** — every decision point has explicit if/then logic

### Fix Scope

| File | Change Type | What |
|------|-------------|------|
| `SKILL.md` | Major rewrite of Steps 0-3 | Add concrete tool mapping, local-sequential instructions, payload construction |
| `modes/local-sequential.md` | **New file** | Full instructions for running pipeline in main agent context |
| `modes/small.md` | Rewrite | Add complete subagent invocation examples |
| `modes/parallel.md` | Rewrite | Same |
| `modes/extended.md` | Rewrite | Same |
| `modes/scaled.md` | Rewrite | Same |
| `prompts/recon.md` | Minor | Add output file path instruction |
| `prompts/hunter.md` | Minor | Add output file path + scope delimiter |
| `prompts/skeptic.md` | Minor | Add output file path + scope delimiter |
| `prompts/referee.md` | Minor | Add output file path + scope delimiter |
| `prompts/fixer.md` | Minor | Add output file path + scope delimiter |
| `scripts/payload-guard.cjs` | Enhance | Add `generate` command that creates template payloads |
| `scripts/run-bug-hunter.cjs` | Minor | Fix default backend detection |
| `templates/` | **New directory** | Subagent task templates with `{variables}` |
| `templates/subagent-wrapper.md` | **New file** | Standard wrapper for all subagent dispatches |

---

## Part 3: Detailed Fixes

### Fix 1: Add Concrete Backend-to-Tool Mapping (SKILL.md Step 0.6)

**Current (broken):**
```
Set AGENT_BACKEND using this priority:
1. spawn_agent + wait
2. native subagent delegation
3. team-agent orchestration tools
4. local-sequential
```

**Fixed:**
```markdown
### Step 0.6: Select orchestration backend

Detect which tools are available in your runtime and set AGENT_BACKEND:

**Detection (run in order, use first that works):**

1. Check if `subagent` tool is available (Pi agent):
   - Test: Can you call `subagent({ action: "list" })`?
   - If yes: set `AGENT_BACKEND = "subagent"`
   - Dispatch pattern:
     ```
     subagent({
       agent: "worker-name",
       task: "<full task prompt with system prompt + mission + task>",
       output: ".claude/outputs/<phase>-output.md"
     })
     ```

2. Check if `teams` tool is available:
   - Test: Does the `teams` tool exist?
   - If yes: set `AGENT_BACKEND = "teams"`
   - Dispatch pattern:
     ```
     teams({
       tasks: [{ text: "<full task prompt>" }],
       maxTeammates: 1
     })
     ```

3. Check if `interactive_shell` is available (for Claude Code, Codex, etc.):
   - Set `AGENT_BACKEND = "interactive_shell"`
   - Dispatch pattern:
     ```
     interactive_shell({
       command: 'pi "<task prompt>"',
       mode: "dispatch"
     })
     ```

4. If none of the above work:
   - Set `AGENT_BACKEND = "local-sequential"`
   - Read `SKILL_DIR/modes/local-sequential.md` for how to run
     all phases (Recon, Hunter, Skeptic, Referee) inside the
     main agent's own context, sequentially.
   - This is the most common mode — most agents will land here.

**IMPORTANT**: `local-sequential` is NOT a degraded mode. It is the
expected default for most environments. The skill is designed to work
fully in this mode. Subagent dispatch is an optimization, not a requirement.
```

### Fix 2: Create `modes/local-sequential.md`

**New file** that tells the orchestrator exactly how to run each phase itself:

```markdown
# Local-Sequential Mode (no subagents)

Run all pipeline phases in the main agent's context. This is the
default and most common mode.

## How it works

You (the orchestrating agent) play each role yourself, sequentially.
Between phases, write outputs to files so you can reference them later
without holding everything in working memory.

## Phase execution

### Phase A: Recon (map the codebase)
1. Read `SKILL_DIR/prompts/recon.md`
2. Follow its instructions yourself:
   - Use bash to run `fd` / `rg` to discover source files
   - Classify files into CRITICAL / HIGH / MEDIUM / CONTEXT-ONLY
   - Compute FILE_BUDGET from average file sizes
3. Write output to `.claude/bug-hunter-recon.md` in the format
   specified by recon.md
4. Parse your own output: extract the risk map and FILE_BUDGET

### Phase B: Hunter (deep scan)
1. Read `SKILL_DIR/prompts/hunter.md`
2. Follow its instructions yourself:
   - Read files in risk-map order (CRITICAL → HIGH → MEDIUM)
   - Apply the security checklist sweep per file
   - Track which files you've actually read
3. Respect context limits: if your working memory gets hazy on
   earlier files, STOP and record your coverage honestly
4. Write findings to `.claude/bug-hunter-findings.md` in the format
   specified by hunter.md
5. Track: FILES SCANNED, FILES SKIPPED, SCAN COVERAGE

### Phase C: Skeptic (challenge findings)
1. Read `SKILL_DIR/prompts/skeptic.md`
2. **Switch mindset**: you are now the adversary of your own findings
3. For each finding from Phase B:
   - Re-read the actual code (mandatory — don't rely on memory)
   - Apply the risk calculation: only DISPROVE when confidence > 67%
   - Check for framework-level protections you may have missed
4. Write output to `.claude/bug-hunter-skeptic.md`

### Phase D: Referee (final verdict)
1. Read `SKILL_DIR/prompts/referee.md`
2. **Switch mindset again**: you are the impartial judge
3. For each finding, compare your Hunter claim vs your Skeptic challenge
4. For Tier 1 (all Critical + top findings): re-read the code a THIRD time
5. Make final REAL BUG / NOT A BUG verdicts
6. Write the final report per Step 7 in SKILL.md

### Context management for local-sequential

The biggest risk in local-sequential is context exhaustion. Mitigate:

- **Write phase outputs to files** — don't try to hold everything in memory
- **Between phases, summarize** — after Hunter, write a compact finding list
  (not the full reasoning) to pass to Skeptic
- **Chunk large codebases** — if > FILE_BUDGET files, process in chunks of
  20-30 files. After each chunk, write findings to the state file, then
  start the next chunk with a fresh mental model
- **Use `.claude/bug-hunter-state.json`** — same state scripts as other modes
  work here too. Initialize state, track chunks, record findings.

### When to use chunked local-sequential

If total source files > FILE_BUDGET (default 40):
1. Initialize state: `node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init ...`
2. For each chunk:
   a. Get next chunk: `node "$SKILL_DIR/scripts/bug-hunter-state.cjs" next-chunk ...`
   b. Run Hunter on chunk files
   c. Record findings: `node "$SKILL_DIR/scripts/bug-hunter-state.cjs" record-findings ...`
   d. Mark chunk done
3. After all chunks: run Skeptic on all accumulated findings
4. Then Referee

### Coverage enforcement

After Phase D, check your coverage:
- If any CRITICAL/HIGH files are in FILES SKIPPED: report partial coverage
  and suggest `--loop` mode
- Do NOT claim "full coverage" unless every CRITICAL and HIGH file was
  actually read with the Read tool
```

### Fix 3: Add Subagent Task Templates

Create `templates/subagent-wrapper.md` — the standard wrapping for every subagent dispatch:

```markdown
# Subagent Task Wrapper Template

Use this template when dispatching any subagent. Fill in the {variables}.

---

## Context
You are a specialized analysis agent. You operate in your own context
window. Your work feeds into a multi-phase bug-hunting pipeline.

## Your Role
{ROLE_DESCRIPTION}

## Your System Prompt
---BEGIN SYSTEM PROMPT---
{PROMPT_CONTENT}
---END SYSTEM PROMPT---

## Non-negotiable Rules
- Stay strictly within scope. Only analyze the files assigned to you.
- Do NOT fix code. Do NOT add tests. Report findings only.
- Do NOT report style issues, unused imports, or refactoring ideas.
- If you run out of context reading files, STOP and report partial
  coverage honestly in your output.
- Use the output format specified in your system prompt EXACTLY.

## Your Assignment
---BEGIN ASSIGNMENT---
Target: {TARGET_DESCRIPTION}
Files to scan: {FILE_LIST}
Risk map: {RISK_MAP}
Tech stack: {TECH_STACK}

{PHASE_SPECIFIC_CONTEXT}
---END ASSIGNMENT---

## Output Requirements
Write your complete output to: {OUTPUT_FILE_PATH}
Follow the output format specified in your system prompt.

## Completion
When you have finished your analysis, output your report and stop.
Do not continue to other phases or expand your scope.
```

### Fix 4: Make Payload Construction Explicit

Add a `generate` command to `payload-guard.cjs`:

```javascript
// Add to payload-guard.cjs
function generate(role) {
  const templates = {
    recon: {
      skillDir: '/absolute/path/to/bug-hunter',
      targetFiles: ['src/file1.ts', 'src/file2.ts'],
      outputSchema: { format: 'risk-map', version: 1 }
    },
    hunter: {
      skillDir: '/absolute/path/to/bug-hunter',
      targetFiles: ['src/file1.ts'],
      riskMap: { critical: [], high: [], medium: [] },
      techStack: { framework: '', auth: '', database: '' },
      outputSchema: { format: 'findings', version: 1 }
    },
    skeptic: {
      skillDir: '/absolute/path/to/bug-hunter',
      bugs: [{ bugId: 'BUG-1', severity: '', file: '', lines: '',
               claim: '', evidence: '', runtimeTrigger: '',
               crossReferences: '' }],
      techStack: { framework: '', auth: '', database: '' },
      outputSchema: { format: 'challenges', version: 1 }
    },
    referee: {
      skillDir: '/absolute/path/to/bug-hunter',
      findings: [{ bugId: 'BUG-1' }],
      skepticResults: { accepted: [], disproved: [] },
      outputSchema: { format: 'verdicts', version: 1 }
    },
    fixer: {
      skillDir: '/absolute/path/to/bug-hunter',
      bugs: [{ bugId: 'BUG-1', severity: '', file: '',
               lines: '', description: '', suggestedFix: '' }],
      techStack: { framework: '', auth: '', database: '' },
      outputSchema: { format: 'fix-report', version: 1 }
    }
  };
  return templates[role] || null;
}
```

### Fix 5: Rewrite Mode Files with Concrete Invocations

**Example: `modes/small.md` rewritten:**

```markdown
# Small Mode (2-10 files)

### Step 4m: Run Recon

**If AGENT_BACKEND = "local-sequential":**
1. Read `SKILL_DIR/prompts/recon.md` with the Read tool
2. Execute the recon instructions yourself on the target files
3. Write output to `.claude/bug-hunter-recon.md`

**If AGENT_BACKEND = "subagent":**
1. Read `SKILL_DIR/prompts/recon.md` with the Read tool
2. Read `SKILL_DIR/templates/subagent-wrapper.md` with the Read tool
3. Construct payload:
   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" generate recon \
     > .claude/payloads/recon-small.json
   ```
4. Fill in the payload with actual values (skillDir, targetFiles)
5. Validate: `node "$SKILL_DIR/scripts/payload-guard.cjs" validate recon .claude/payloads/recon-small.json`
6. Dispatch:
   ```
   subagent({
     agent: "recon-agent",
     task: "<wrapper template filled with recon.md content + file list>",
     output: ".claude/bug-hunter-recon.md"
   })
   ```
7. Read `.claude/bug-hunter-recon.md` to get the risk map

Wait for completion. Parse the risk map.

### Step 5m: Run Hunter
[Same pattern — concrete tool calls for each backend]

### Step 6m: Run Skeptic
[Same pattern]

### Step 7m: Run Referee
[Same pattern]
```

### Fix 6: Add Inline Examples to SKILL.md Step 2

**Current:**
> **MANDATORY**: You MUST read prompt files using the Read tool before passing them to subagents.

**Fixed — add a concrete example:**

```markdown
**MANDATORY**: You MUST read prompt files using the Read tool before
passing them to subagents. Do NOT act from memory.

**Example (Step 5, launching a Hunter in local-sequential mode):**

1. Read the prompt:
   ```
   read({ path: "$SKILL_DIR/prompts/hunter.md" })
   ```

2. You now have the Hunter's instructions. Execute them yourself:
   - Read each file in risk-map order using the Read tool
   - Apply the security checklist sweep
   - Write findings in the BUG-N format specified in hunter.md

3. Write your findings to `.claude/bug-hunter-findings.md`

**Example (Step 5, launching a Hunter via subagent tool):**

1. Read the prompt:
   ```
   read({ path: "$SKILL_DIR/prompts/hunter.md" })
   ```

2. Read the wrapper template:
   ```
   read({ path: "$SKILL_DIR/templates/subagent-wrapper.md" })
   ```

3. Construct the full task by filling the template:
   - {ROLE_DESCRIPTION} = "You are a Bug Hunter agent..."
   - {PROMPT_CONTENT} = <contents of hunter.md>
   - {FILE_LIST} = <files from Recon risk map>
   - {RISK_MAP} = <risk map from Recon output>
   - {TECH_STACK} = <tech stack from Recon>
   - {OUTPUT_FILE_PATH} = ".claude/bug-hunter-findings.md"

4. Dispatch:
   ```
   subagent({
     agent: "bug-hunter-worker",
     task: "<the filled template>",
     output: ".claude/bug-hunter-findings.md"
   })
   ```
```

### Fix 7: Add Coverage Enforcement to Step 7

**Add to Step 7 (Final Report), after the coverage assessment:**

```markdown
### 7b. Coverage enforcement (mandatory)

If the coverage assessment shows ANY CRITICAL or HIGH files were not
scanned, the pipeline is NOT complete:

1. If `--loop` was specified: the ralph-loop will automatically
   continue to the next iteration covering missed files.

2. If `--loop` was NOT specified AND missed files exist:
   - If total files ≤ FILE_BUDGET * 3:
     Output the report with a WARNING:
     "⚠️ Partial coverage: [N] CRITICAL/HIGH files were not scanned.
     Run `/bug-hunter --loop [path]` for complete coverage."
   - If total files > FILE_BUDGET * 3:
     The report MUST include this:
     "🚨 This codebase has [N] files (FILE_BUDGET: [B]).
     A single-pass audit covered only [X]%. Use `--loop` for full coverage."

3. Do NOT claim "audit complete" unless all CRITICAL and HIGH files
   show status DONE.
```

### Fix 8: Fix the run-bug-hunter.cjs Default Backend

**Current (`getAvailableBackends`):**
```javascript
return ['local-sequential'];
```

This is correct as a default — but the script's `run` command tries to execute a `workerCmd` template via shell, which won't work for LLM subagent dispatch. The script needs a mode where it just plans the chunks and writes the plan, leaving actual execution to the LLM agent.

**Add a `plan` command:**

```javascript
// New command: plan
// Outputs the chunk plan as JSON without executing anything
// The LLM agent reads this plan and executes chunks itself
function plan(options) {
  const skillDir = resolveSkillDir(options);
  const filesJson = options['files-json'];
  const mode = options.mode || 'extended';
  const chunkSize = toPositiveInt(options['chunk-size'], DEFAULT_CHUNK_SIZE);
  
  const files = readJson(filesJson);
  const chunks = buildChunks(files, chunkSize);
  
  const planOutput = {
    mode,
    skillDir,
    totalFiles: files.length,
    chunkSize,
    chunks: chunks.map((chunk, i) => ({
      id: `chunk-${i + 1}`,
      files: chunk,
      status: 'pending'
    })),
    phases: ['recon', 'hunter', 'skeptic', 'referee'],
    createdAt: nowIso()
  };
  
  writeJson('.claude/bug-hunter-plan.json', planOutput);
  console.log(JSON.stringify(planOutput, null, 2));
}
```

### Fix 9: Add Phase-Specific Context to Prompts

Each prompt file (hunter.md, skeptic.md, etc.) needs a small addition at the top that tells the agent WHERE to write output:

**Add to hunter.md (top):**
```markdown
## Output Destination
Write your complete findings report to the file path provided in
your assignment. If no path was provided, output to stdout.
The orchestrator will read this file to pass your findings to the
Skeptic phase.
```

**Add to skeptic.md (top):**
```markdown
## Input
You will receive a findings file from the Hunter phase. Read it
completely before starting your evaluation.

## Output Destination
Write your challenge report to the file path provided in your
assignment. The Referee will read both the Hunter's findings and
your challenges.
```

### Fix 10: Make `disable-model-invocation` configurable

The `disable-model-invocation: true` prevents the skill from being auto-invoked. This is fine for preventing false triggers, but the skill should document this clearly:

**Add to SKILL.md top section:**
```markdown
> **Note:** This skill requires explicit invocation: `/bug-hunter [args]`.
> It will not activate automatically from natural language requests
> like "find bugs." This is intentional — the pipeline is heavy and
> should only run when the user explicitly requests it.
```

---

## Part 4: Implementation Order

### Phase 1: Core Fixes (unblocks basic execution)
1. [ ] Create `modes/local-sequential.md` — **highest priority**, this is where 90% of executions will land
2. [ ] Rewrite SKILL.md Step 0.6 with concrete tool mapping
3. [ ] Add inline examples to SKILL.md Step 2
4. [ ] Add coverage enforcement to Step 7

### Phase 2: Subagent Infrastructure (enables parallel execution)
5. [ ] Create `templates/subagent-wrapper.md`
6. [ ] Add `generate` command to `payload-guard.cjs`
7. [ ] Rewrite `modes/small.md` with concrete invocations for each backend
8. [ ] Rewrite `modes/parallel.md` with concrete invocations
9. [ ] Rewrite `modes/extended.md` with concrete invocations
10. [ ] Rewrite `modes/scaled.md` with concrete invocations

### Phase 3: Script Improvements (better automation)
11. [ ] Add `plan` command to `run-bug-hunter.cjs`
12. [ ] Fix `getAvailableBackends` to detect Pi tools
13. [ ] Add output destination headers to all prompt files

### Phase 4: Polish
14. [ ] Add the `disable-model-invocation` documentation note
15. [ ] Run self-test on the test-fixture to validate the pipeline
16. [ ] Update CHANGELOG.md

---

## Part 5: Key Insight — Why the Factory Examples Work

The Factory subagent prompts you showed me succeed because they follow a rigid contract:

| Element | Factory Does | Bug Hunter Does (broken) |
|---------|-------------|------------------------|
| Identity | `---BEGIN SUBAGENT SYSTEM PROMPT---` with clear role | Raw prompt file with no wrapping |
| Boundaries | "Stay strictly within scope. Do not add features." | Nothing — no scope limits |
| Kill switch | "Stop immediately once the task is done." | Nothing — no stopping rule |
| Safety | "NEVER run rm -rf" | Nothing |
| Task | `---BEGIN TASK FROM PARENT AGENT---` with Goal, Context, Steps | "Launch subagent with the hunter prompt" (vague) |
| Output | "Write your test report to: {exact path}" | "Output format: BUG-[number]..." (where?) |
| State | Files in `.factory/validation/` | `.claude/` files (good but not explained to subagents) |
| Context | Full context passed inline: repo root, already-fixed items, tech stack | "Inject findings + file list" (how?) |

The fix is to adopt this exact contract for every bug-hunter subagent dispatch.

---

## Part 6: Validation Criteria

After implementing all fixes, the skill passes validation when:

1. **Self-test passes**: `/bug-hunter SKILL_DIR/test-fixture/ --scan-only` finds ≥5 of 6 planted bugs with ≤3 false positives surviving to Referee
2. **Local-sequential works**: The pipeline completes without any subagent dispatch, using only the main agent's context
3. **Subagent dispatch works**: When `subagent` tool is available, the pipeline dispatches and collects results
4. **Coverage is enforced**: Partial coverage produces a warning, not a silent "done"
5. **State files are written**: `.claude/bug-hunter-recon.md`, `.claude/bug-hunter-findings.md`, `.claude/bug-hunter-skeptic.md` are created during execution
6. **Loop mode works**: `--loop` correctly iterates until all CRITICAL/HIGH files are covered

---

*This plan was created by auditing all 1,760 lines of skill instructions, all 6 prompt files, all 10 mode files, and all 6 helper scripts. Every fix addresses a specific failure observed during actual execution.*
