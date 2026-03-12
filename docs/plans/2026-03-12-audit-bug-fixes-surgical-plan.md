# Surgical Fix Plan for Confirmed Audit Bugs

## Objective

Fix the four confirmed runtime bugs without changing the surrounding product behavior, public UX, or broader pipeline design beyond what is necessary for correctness and safety.

Confirmed bugs:
- `BUG-1` — `scripts/run-bug-hunter.cjs`
- `BUG-2` — `scripts/pr-scope.cjs`
- `BUG-3` — `scripts/fix-lock.cjs`
- `BUG-4` — `scripts/code-index.cjs`

## Fix order

1. `BUG-3` `scripts/fix-lock.cjs`
2. `BUG-4` `scripts/code-index.cjs`
3. `BUG-2` `scripts/pr-scope.cjs`
4. `BUG-1` `scripts/run-bug-hunter.cjs`

Rationale:
- `BUG-3` and `BUG-4` are isolated utility-level correctness fixes with low blast radius.
- `BUG-2` changes PR scope resolution behavior and needs targeted tests around fallback semantics.
- `BUG-1` touches orchestration behavior and should land last after the supporting utilities are stable.

---

## BUG-3 — fix-lock can steal a live lock

### Problem
`acquire()` treats TTL expiry as sufficient proof of staleness and does not check whether the recorded PID is still alive.

### Surgical fix
- Keep the existing lock file format.
- Change stale recovery logic so a lock is auto-recovered only when:
  - TTL expired **and**
  - owner PID is absent or not alive.
- If TTL expired but owner is still alive, return a failure payload such as:
  - `reason: "lock-held-by-live-owner"`
  - include `stale: true` and `ownerAlive: true` for observability.

### Files
- `scripts/fix-lock.cjs`
- tests in `scripts/tests/fix-lock.test.cjs`

### Test additions
- acquiring a fresh lock from another process still fails
- acquiring an expired lock whose PID is dead succeeds
- acquiring an expired lock whose PID is alive fails
- `status` remains consistent with acquire behavior

### Risk
Low. Pure locking behavior change.

---

## BUG-4 — code-index query-bugs temp file collision

### Problem
`queryBugs()` always writes `.seed-files.tmp.json` in the same directory and only deletes it on success.

### Surgical fix
- Replace fixed temp filename with a unique invocation-scoped filename, e.g. based on:
  - `process.pid`
  - timestamp
  - random suffix
- Wrap temp-file lifecycle in `try/finally` so cleanup runs even if `query()` throws.
- Preserve current command contract and output shape.

### Files
- `scripts/code-index.cjs`
- tests in `scripts/tests/code-index.test.cjs`

### Test additions
- `query-bugs` cleans up temp file after success
- `query-bugs` cleans up temp file after a thrown query path
- parallel invocations do not reuse the same temp file name

### Risk
Low. Local helper behavior only.

---

## BUG-2 — pr-scope silent wrong-base fallback

### Problem
For `selector === "current"`, any `gh` failure falls back to `git diff <base or main>...HEAD` and reports success. This can silently produce the wrong review scope.

### Surgical fix
Preferred minimal behavior:
- Keep git fallback only for `current`.
- Before fallback, determine base branch more safely:
  1. explicit `--base` if supplied
  2. repo default branch if discoverable
  3. otherwise fail explicitly instead of assuming `main`
- If `gh` fails and no trustworthy base is available, return an error rather than a successful but potentially wrong scope.

### Implementation notes
- Add a small helper to resolve default branch via git when possible, e.g. from:
  - `refs/remotes/origin/HEAD`
  - or another safe git source
- Do **not** broaden fallback for numbered/recent PRs.
- Preserve existing JSON output contract, but add metadata when fallback is used.

### Files
- `scripts/pr-scope.cjs`
- tests in `scripts/tests/pr-scope.test.cjs`

### Test additions
- `current` with explicit `--base` still falls back correctly
- `current` with discoverable default branch falls back correctly
- `current` with no trustworthy base fails explicitly
- `recent` and numbered PRs still require GitHub metadata

### Risk
Medium. Scope-selection behavior changes and could affect user workflows, but the change is correctness-oriented and bounded.

---

## BUG-1 — fix strategy ignored by executable fix queue

### Problem
`fix-strategy.json` is generated, but `buildFixPlan()` still computes eligibility directly from confidence alone. Strategy classes such as `manual-review`, `larger-refactor`, and `architectural-remediation` do not actually gate execution.

### Surgical fix
- Keep `fix-strategy.json` as the source of truth for execution eligibility.
- Update the executable queue builder so only findings/clusters marked safe for autofix enter:
  - `safe-autofix`
  - and `autofixEligible === true`
- Ensure `manual-review`, `larger-refactor`, and `architectural-remediation` never flow into canary/rollout.
- Preserve current `fix-plan.json` shape as much as possible to minimize downstream breakage.

### Recommended implementation shape
Option A, lowest risk:
- Refactor `buildFixPlan()` to accept preclassified entries from `buildFixStrategy()`.
- Derive eligible/canary/rollout only from strategy entries where `autofixEligible === true`.

Also fix cluster-stage ambiguity:
- Either include `executionStage` in the cluster grouping key, or
- compute cluster stage conservatively from all entries instead of taking `entries[0]`.

### Files
- `scripts/run-bug-hunter.cjs`
- tests in `scripts/tests/run-bug-hunter.test.cjs`
- possibly `schemas/fix-strategy.schema.json` only if contract refinement is needed

### Test additions
- high-confidence `architectural-remediation` finding does not enter `fixPlan.canary/rollout`
- high-confidence `larger-refactor` finding does not enter executable queue
- `safe-autofix` findings still enter canary/rollout
- mixed-stage safe-autofix entries in same directory do not collapse incorrectly

### Risk
Medium-high. This changes executable orchestration, but still within the intended design and existing artifact model.

---

## Verification plan

Run after each bug fix if practical, and again at the end:

```bash
node --test scripts/tests/*.test.cjs
```

Recommended focused sequence during implementation:

```bash
node --test scripts/tests/fix-lock.test.cjs
node --test scripts/tests/code-index.test.cjs
node --test scripts/tests/pr-scope.test.cjs
node --test scripts/tests/run-bug-hunter.test.cjs
node --test scripts/tests/*.test.cjs
```

## Definition of done

- [x] All 4 confirmed bugs have targeted code fixes.
- [x] Regression tests exist for each bug.
- [x] Full script test suite passes.
- [x] No public CLI contract is changed except where necessary to avoid silent wrong behavior.
- [x] `fix-strategy` becomes behaviorally authoritative for execution gating, not just informational.

## Outcome

Implemented and verified on 2026-03-12.

Fresh verification evidence:

```bash
node --test scripts/tests/*.test.cjs
```

Result: 44/44 tests passing.
