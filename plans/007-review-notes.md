---
title: Review Notes and Patch Proposal for the Complete Fix Plan
description: >
  Independent second-pass review of @plans/007-complete-fix-plan.md, with a
  proposed patch set, the evidence behind each claim, and counter-arguments.
  Written to be evaluated cold by a reviewer with no prior conversation context.
prompt: |
  add extra notes - on patch plan so I can ask other model if it agrees
---

# Review Notes and Patch Proposal for @plans/007-complete-fix-plan.md

## How to use this document

You are being asked to agree or disagree with the patch set below. You do not
need any prior conversation context. Everything needed is here: the claim, the
exact file and line, a command you can rerun, the proposed change, and the
strongest argument **against** the proposal.

Rules for your review:

- Verify before agreeing. Every claim tagged `VERIFIED` has a reproduction
  command. Rerun it. Do not accept a claim you did not check.
- Argue with the counter-arguments. Each item has a `Counter-argument` section
  written deliberately against the proposal. If the counter-argument wins, say
  so.
- Answer the open questions in the final section explicitly.
- Flag anything this review **missed**. A patch proposal that only confirms the
  original plan's blind spots is not useful.

Repository state when these notes were written:

- HEAD `4564ffc`, working tree has only untracked @CLAUDE.md and @plans/.
- No source file was modified to produce this review.
- Package version 3.0.10; newest git tag v3.0.7.

## Verdict on the master plan

The master plan is **structurally correct and worth executing**. Do not rewrite
it. The wave dependency graph, the fail-closed defaults, the "regression proof
before destructive change" rule, and the stop conditions are all right.

Three parts are worth protecting from any rewrite:

1. Assumption 6 — an unsupported ecosystem returns `scanner-unsupported`, never
   clean. Correct and uncommon.
2. Wave 5 item 1 — "priority is order, never silent exclusion of maintained
   source." This is root-cause framing rather than a sort patch.
3. The rollout table's closing rule — rollback reverts the reviewed diff only,
   never worktree deletion, state deletion, or `git reset`.

The objection is not to the plan's shape. It is to one broken command, the
sequencing of four trivial fixes, one bundled refactor, one architectural
assumption, and six missing rows.

---

## P0-1 — Wave 0's own safety command does not do what it says

**Status:** VERIFIED. This is the only item that blocks execution outright.

@plans/007-complete-fix-plan.md lines 262-267 define the "known-safe baseline"
that Wave 0 exists to establish:

```bash
git ls-files 'scripts/tests/*.test.cjs' \
  | rg -v 'experiment-loop\\.test\\.cjs$' \
  | xargs node --test
```

The exclusion fails. `\\.` inside single quotes reaches `rg` as a literal
`\\.`, which as a regex means "a backslash followed by any character." It never
matches `experiment-loop.test.cjs`.

Reproduction:

```bash
git ls-files 'scripts/tests/*.test.cjs' | rg -v 'experiment-loop\\.test\\.cjs$' | rg 'experiment-loop'
# → scripts/tests/experiment-loop.test.cjs
```

Consequence: running Wave 0 verbatim executes the one test the wave exists to
avoid. That test performs `git add -A` and `git commit` against the parent
repository. Both prior audit passes already triggered this accidentally, per
@plans/audit-report.md and @plans/validation-report.md.

**Proposed patch.** Replace the command with a form that fails loudly rather
than silently under-excluding:

```bash
# Wave 0 step 3 — safe baseline. The count assertion is the actual guard.
FILES=$(git ls-files 'scripts/tests/*.test.cjs' | rg -v 'experiment-loop\.test\.cjs$')
TOTAL=$(git ls-files 'scripts/tests/*.test.cjs' | rg -c .)
SAFE=$(printf '%s\n' "$FILES" | rg -c .)
test "$TOTAL" -eq 13 || { echo "test file inventory changed: $TOTAL"; exit 1; }
test "$SAFE"  -eq 12 || { echo "exclusion failed: $SAFE of $TOTAL"; exit 1; }
printf '%s\n' "$FILES" | xargs node --test
```

Add to Wave 0 as a new step: **never rely on a negative filter without asserting
the count it produced.** A silent under-exclusion in a safety gate is worse than
no gate, because it is trusted.

**Related, same root cause.** @package.json declares:

```json
"prepack": "node --test scripts/tests/*.test.cjs"
```

So `pnpm pack` — including the `pnpm pack --dry-run` in the master plan's Gate 6
checks at line 485 — runs the full unsafe suite. Wave 0 step 4 warns about this
in prose but nothing enforces it. The dependency ordering does eventually make
it safe, because Wave 1 fixes the tests. But between now and Gate 1 there is a
destructive npm lifecycle hook with no guard. Add an explicit note at the
@package.json script and a Wave 1 acceptance check that `prepack` is safe.

**Counter-argument.** An executor might not copy the command literally, and a
careful one would notice. Also, `tmp/` is gitignored, so the sandboxes
themselves are not committed — only pre-existing untracked files like
@CLAUDE.md are swept in.

**Response.** The plan's entire premise is that it is executed literally by an
agent, and it says so at line 24. The blast radius is confirmed, not
theoretical: it has already happened twice. "A careful executor would catch it"
is not a safety property.

---

## P0-2 — Four trivial fixes are stranded behind three XL waves

**Status:** VERIFIED at runtime.

The master plan assigns BUG-8, 24, 25, 27, 28, 39, 40 to Wave 5, which is gated
behind Waves 1 through 4 (all XL, per the effort field at line 39). None of
those seven fixes has any dependency on mutation safety, trust boundaries,
artifact contracts, or run state. Each touches exactly one file.

The most costly is BUG-25 at @scripts/triage.cjs:205-206:

```javascript
const tierOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, 'CONTEXT-ONLY': 4 };
domains.sort((a, b) => (tierOrder[a.tier] || 99) - (tierOrder[b.tier] || 99));
```

`tierOrder.CRITICAL` is `0`, which is falsy, so `0 || 99` yields `99`. CRITICAL
domains sort **last**. Reproduction on a synthetic tree with one file each in
`api/`, `ui/`, `scripts/`, `bin/`:

```
domains:  [["ui","MEDIUM"],["scripts","LOW"],["api","CRITICAL"]]
totalFiles: 3   # bin/cli.js never discovered at all
```

The fix is `??` instead of `||`. One character. Until it lands, every scan on
every repository reads the least risky code first, and under a file budget may
never reach the critical domain. This silently defeats the product's primary
function on every single run.

Runtime-confirmed alongside it:

| Bug | Site | Reproduction | Fix size |
|---|---|---|---|
| BUG-25 | @scripts/triage.cjs:206 | domain order `MEDIUM, LOW, CRITICAL` | 1 char |
| BUG-27 | @scripts/triage.cjs:47 (`bin` in `SKIP_DIRS`) | `bin/cli.js` absent from a 4-file tree | 1 line |
| BUG-26 | @scripts/triage.cjs:54 (`scripts` in `LOW_VALUE_DIRS`) | `scripts/tool.js` excluded from `scanOrder` | 1 line |
| BUG-28 | @scripts/triage.cjs:483 | `--max-depth -1` → `totalFiles: 0`, strategy silently `single-file` | ~3 lines |
| BUG-24 | @scripts/run-bug-hunter.cjs:57-63 | `toPositiveInt('0', 1)` → `0 <= 0` → returns fallback `1` → 2 attempts | ~3 lines |
| BUG-38 | @scripts/payload-guard.cjs:116 | payload `null` → `TypeError: Cannot use 'in' operator` | ~4 lines |

And one security item, BUG-8 at @scripts/dep-scan.cjs:189:

```javascript
command: `rg -l "${importPattern}" "${targetDir}" --type-add "src:*.{js,ts,jsx,tsx,py,go,rs}" -t src`
```

`targetDir` is interpolated into a `bash -lc` string. A command-injection sink
deferred behind an orchestrator refactor.

**Proposed patch.** Insert **Wave 1b — isolated single-file corrections**,
executing immediately after Gate 1, before Wave 2:

- Scope: BUG-8, 24, 25, 26, 27, 28, 38, 39, 40.
- Constraint: each fix touches exactly one production file and adds one
  regression test. Any fix requiring a second file is out of scope and returns
  to its original wave.
- Gate 1b: the self-scan of this repository lists CRITICAL domains first and
  includes @bin/bug-hunter and @scripts/*.cjs in scope.
- Traceability table rows for those bugs change wave 5 → 1b (BUG-8 stays
  cross-referenced to Wave 5's broader `dep-scan` rework).

This delivers most of the user-visible correctness win in roughly a day rather
than after three XL waves, without weakening any gate.

**Counter-argument.** The strict ordering at lines 70-95 exists precisely to
stop opportunistic patching, and every exception erodes it. BUG-8's proper fix
is part of Wave 5's wholesale replacement of command strings with argv arrays;
patching it in isolation creates a fix that gets rewritten weeks later. Fixing
triage early also changes scan scope, which changes what every later wave's
fixtures see — arguably a reason to do it late, once contracts are stable.

**Response.** The ordering rationale at lines 91-95 is specifically about
mutation safety, authority, and artifact contracts. None of the seven fixes
touch those. The scope-churn objection is real but inverted: fixing triage late
means every wave's fixtures were built against a scan scope known to be wrong.
On BUG-8, an isolated argv fix being superseded by Wave 5 is acceptable — the
alternative is leaving an injection sink open for the duration. Partial
agreement is reasonable here: **if you accept only one item from this document
beyond P0-1, take BUG-25.**

---

## P1-1 — Wave 4 lets a P2 refactor hold P1 safety fixes hostage

**Status:** Judgment, not a defect.

Wave 4 (lines 368-411) bundles two different kinds of work:

- Correctness and reliability, required for a safe release: atomic state
  (BUG-13), lock leases (BUG-12), process-group supervision (BUG-19), retry
  parsing (BUG-24), schema keyword support (BUG-1, BUG-2, BUG-20), JSONL
  integrity (BUG-31, BUG-32).
- Architecture, item 10: extracting @scripts/process-runner.cjs,
  @scripts/state-store.cjs, @scripts/artifact-planner.cjs, and
  @scripts/chunk-scheduler.cjs from a 1,547-line orchestrator. This is A35,
  classified **P2** in @plans/audit-report.md line 108.

Gate 4 at lines 409-411 covers both. A stalled four-module extraction therefore
blocks shipping process supervision and lock correctness.

**Proposed patch.** Split into:

- **Wave 4a** — items 1 through 9. Required for release. Gate 4a as currently
  written.
- **Wave 4b** — item 10 only. Explicitly optional for release. Entry condition:
  the characterization suite from item 1 passes and is green for a full wave.
  Exit condition: CLI output and journal shape are byte-identical to 4a.

The plan already contains the correct instinct at lines 394-396 ("Do not change
CLI output and journal shape in the extraction step"). Making it a separate
gated wave enforces what that sentence only requests.

**Counter-argument.** Deferring the extraction means Wave 5 and 6 build against
the 1,547-line module, and the refactor becomes permanently deferred — the
standard fate of "optional" cleanup waves. Doing it inside Wave 4, while the
characterization suite is fresh, is when it is cheapest.

**Response.** Both are true. The disagreement is about which risk is worse: a
refactor that never happens, or safety fixes that ship late because a refactor
stalled. For a tool whose defaults currently auto-commit, the second is worse.
4b should still be scheduled, just not gated with 4a.

---

## P1-2 — Assumption 3 builds a JSON Schema validator by hand

**Status:** Open architectural decision. Needs a human or reviewer call.

Line 56-58 of the master plan:

> The package keeps its zero-runtime-dependency design. Runtime schema
> validation will support every JSON Schema keyword currently used by @schemas
> and will reject unknown keywords during package checks.

Current gap, verified. @scripts/schema-runtime.cjs implements `$ref`, `const`,
`enum`, `object`, `array`, `string`, `number`, `integer`, `boolean`. It does not
implement `allOf`, `if`, `then`, `oneOf`, `anyOf`, `not`, or schema-valued
`additionalProperties`. @schemas/experiment.schema.json uses `allOf` + `if`/
`then` for its conditional requirements and `additionalProperties: {"type":
"number"}` for `secondaryMetrics`. Both are silently ignored today — that is
BUG-1 and BUG-2.

Satisfying assumption 3 as written means hand-writing conditional application,
subschema composition, and correct `additionalProperties` handling with no
dependency. That is a real validator, with its own bug surface, inside the
component whose entire purpose is catching bugs.

**Proposed alternative.** `ajv` as a **devDependency**, with `ajv/standalone`
compiling each schema to a self-contained CommonJS validator module committed to
the repository. This preserves zero runtime dependencies at install time, uses a
battle-tested implementation, and makes "reject unknown keywords" free via
`strict: true` rather than a bespoke feature. The build step becomes a checked-in
codegen artifact with a CI check that regenerating produces no diff.

**Counter-argument.** Committed generated code is its own maintenance burden and
review-noise problem. The schema surface here is small and fully controlled — a
handful of files that the project itself authors — so the general-purpose
validator is overkill, and hand-rolling the four missing keywords is maybe 150
lines against schemas that will never use the exotic parts of the spec. Adding a
build step to a project that currently has none is a real cost.

**Response.** The counter-argument is strong and I hold this position with lower
confidence than the others. The deciding factor is assumption 3's second clause:
"reject unknown keywords during package checks." That is a schema-linting
feature, and building it by hand alongside the validator roughly doubles the
bespoke surface. If the plan dropped the unknown-keyword rejection requirement,
hand-rolling becomes defensible.

**This is the main question for the reviewing model.**

---

## P2-1 — Six defects have no row in the traceability table

The master plan's table at lines 162-203 claims complete coverage of the 40
accepted bugs. These are not in it.

### (a) "Missing files can be counted as scanned" — dropped entirely

Listed in @plans/audit-report.md line 116 under "smaller confirmed defects" but
never assigned a BUG number, and absent from the traceability table. It is the
only smaller-defect entry with no corresponding row.

The audit's phrasing also points at the wrong place. `hash-update` in
@scripts/bug-hunter-state.cjs:403-408 handles missing files correctly — it skips
them and reports them under `missing`. The actual over-count is at
@scripts/bug-hunter-state.cjs:260:

```javascript
state.metrics.filesScanned = state.chunks
  .filter((entry) => entry.status === 'done')
  .flatMap((entry) => entry.files)
  .length;
```

This counts every file in every done chunk, including files `hash-filter`
skipped as unchanged and files that do not exist. Reported coverage exceeds
actual coverage. Assign a bug ID, add to Wave 4, require a regression proving
`filesScanned` equals the count of files actually handed to a worker.

### (b) `assertOwner` returns true for a token-less lock

@scripts/fix-lock.cjs:75-80:

```javascript
function assertOwner(existing, ownerToken) {
  if (!existing || !existing.ownerToken) {
    return true;
  }
  return ownerToken === existing.ownerToken;
}
```

A lock file lacking `ownerToken` can be renewed or released by any caller. This
sits directly beside BUG-12 and BUG-13, which Wave 4 already covers, and should
be folded into the same atomic-lease rework. Neither audit report caught it.

### (c) `harvestCore` writes its harvest record inside the worktree it protects

@scripts/worktree-harvest.cjs:269 writes `.harvest-result.json` to
`harvestPath(absDir)` — inside the worktree. Cleanup then force-removes that
directory at line 362, destroying the only record of what was preserved and
where the stash went. This undercuts the entire preservation design that Wave 1
is built around. The harvest record must live outside the removal target.

### (d) The sandbox root is the repository itself

@scripts/tests/test-utils.cjs:33-36:

```javascript
function makeSandbox(prefix = 'bug-hunter-test-') {
  const tmpBase = path.resolve('tmp');
  ...
}
```

`path.resolve('tmp')` is `<repo>/tmp`. Every test sandbox is created **inside
the bug-hunter git repository**. That is why the comment at
@scripts/tests/experiment-loop.test.cjs:807 — "In sandbox (no git repo),
auto-commit will fail" — is a false premise: git walks up and finds the real
repo, the commit succeeds, and `git add -A` sweeps in unrelated untracked files.

Wave 1 item 1 says fixtures should create "its own repository below a test
sandbox," which is directionally right but too vague to be executable. Name the
fix: `makeSandbox` must root at `os.tmpdir()`, and every fixture must assert its
resolved path is outside the repository root before writing.

This single line is the root cause of BUG-30's blast radius. It deserves to be
called out by name, not implied.

### (e) 687 stale sandbox directories

`ls tmp | wc -l` → 687. Tests never clean up after themselves. Not mentioned
anywhere in the plan. Add teardown to Wave 1's test-helper rework and a check
that a full suite run leaves `tmp/` at its prior entry count.

### (f) BUG-8's second injection source

The traceability row for BUG-8 addresses `targetDir` only. In
@scripts/dep-scan.cjs:186-189, `escapedPackage` is regex-escaped but not
shell-escaped, and it flows from package-manager audit output rather than from
the caller. Realism is low — npm naming rules exclude quote characters — but the
Wave 5 fix must cover both interpolations, not just the path.

---

## P2-2 — Wave 5's checks reference files that do not exist

Lines 435-439 list `node --test scripts/tests/triage.test.cjs` and
`dep-scan.test.cjs` as required checks. Lines 442-444 then acknowledge that both
files may not exist and instruct creating them. An executor running the checks
block top-down hits two immediate failures. Move the acknowledgement above the
checks block. Cosmetic, but this plan is written to be executed literally.

---

## Corrections to the two upstream reports

These do not change any verdict, but the patch plan should not inherit them.

1. **BUG-34's narrowing is applied to the wrong function.**
   @plans/validation-report.md lines 27-29 states Node caps synchronous child
   output at 1 MiB. True for @scripts/experiment-loop.cjs, which uses
   `spawnSync`. But audit item A18 points at @scripts/run-bug-hunter.cjs:218,
   `runCommandOnce`, which uses **asynchronous `spawn`** — `maxBuffer` does not
   exist on that path. Accumulation there is genuinely unbounded. The master
   plan's BUG-34 row correctly names both files; the narrowing note should be
   scoped to the `spawnSync` path only.

2. **A18's second half is understated.** `runCommandOnce` has no
   `child.on('error')` listener. A spawn failure emits `error` with no listener
   attached, which throws. The plan's item 6 ("bounded, one-settlement process
   runner") covers it, but the traceability row does not mention it.

---

## Summary of the proposed patch

| # | Change | Severity | Confidence |
|---|---|---|---|
| P0-1 | Fix Wave 0's exclusion regex; assert the file count; note the `prepack` hazard | Blocker | Verified |
| P0-2 | Add Wave 1b for seven isolated single-file fixes; move BUG-8/24/25/26/27/28/38/39/40 | High | Verified |
| P1-1 | Split Wave 4 into 4a (required) and 4b (optional extraction) | Medium | Judgment |
| P1-2 | Reconsider assumption 3: ajv devDependency + standalone codegen | Medium | Low, open |
| P2-1 | Add six missing traceability rows (a) through (f) | Medium | Verified |
| P2-2 | Reorder Wave 5's checks block after the file-creation note | Low | Verified |

Nothing in this patch set changes the wave graph's direction, the gates, the
stop conditions, or the definition of done. It fixes one broken command,
re-sequences work that has no dependencies, unbundles one refactor, reopens one
assumption, and closes six gaps.

---

## Questions for the reviewing model

Answer each explicitly. Disagreement is more useful than agreement.

1. **P0-1:** Is the regex analysis correct? Rerun the reproduction. Is there any
   reading under which `rg -v 'experiment-loop\\.test\\.cjs$'` excludes the file?
2. **P0-2:** Does inserting Wave 1b violate the plan's ordering rationale at
   lines 91-95, or is that rationale scoped to mutation, authority, and
   artifacts only? If you reject the full wave, do you still accept BUG-25 alone?
3. **P1-1:** Is deferring A35 to an optional 4b the right call, or does that
   guarantee the refactor never happens — and is that acceptable?
4. **P1-2 (the main one):** Hand-rolled validator to preserve zero runtime
   dependencies, or ajv devDependency with committed standalone codegen? Does
   your answer change if the "reject unknown keywords" requirement is dropped?
5. **P2-1:** Are (a) through (f) real? (b), (c), and (d) were missed by both the
   original audit and its validation pass — confirm or refute each from source.
6. **Coverage:** What does this review itself miss? Specifically — are there
   defects in @scripts/delta-mode.cjs, @scripts/pr-scope.cjs,
   @scripts/doc-lookup.cjs, or @scripts/context7-api.cjs? Those four files
   appear in no finding, in no traceability row, and in neither audit report.
   That silence is suspicious and nobody has checked it.
7. **Sequencing overall:** Is six-to-eight waves the right granularity, or
   should the P0 safety work (Waves 0, 1, 1b) ship as one reviewable unit and
   the rest be replanned afterward against a repository that can safely run its
   own test suite?

## Verification commands used in this review

```bash
# P0-1
git ls-files 'scripts/tests/*.test.cjs' | rg -v 'experiment-loop\\.test\\.cjs$' | rg 'experiment-loop'

# P0-2 (triage; run against a scratch tree, not this repo)
node scripts/triage.cjs scan <scratch-tree> --format json
node scripts/triage.cjs scan <scratch-tree> --max-depth -1 --format json

# P0-2 (fixer contract)
node scripts/schema-validate.cjs fix-report <the example from skills/fixer/SKILL.md>

# P0-2 (payload guard)
echo 'null' > p.json && node scripts/payload-guard.cjs validate hunter p.json

# A08 / BUG-5 (report rendering)
node scripts/render-report.cjs report <object-shaped findings.json> <referee.json>

# P2-1(e)
ls tmp | wc -l
```

Do not run `pnpm test`, `pnpm pack`, or `node --test scripts/tests/experiment-loop.test.cjs`
in this repository until Wave 1 lands. Those paths commit to the parent
repository.
