# Local-Sequential Mode

Execute each role in the main agent context, one at a time. This is a complete
backend. Keep phase boundaries in canonical JSON rather than repeating role
instructions here. All artifacts are relative to the target repository.

## Prepare scope and state

Use `SKILL.md › Deterministic triage before model work`: retain triage's exact
scope, risk order, and FILE_BUDGET. Set SOURCE_TOKEN_BUDGET to the caller's
explicit value or 48000. Write `triage.scanOrder` as
`.bug-hunter/source-files.json` (a JSON array).

For chunked execution initialize once, never on resume:

```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init ".bug-hunter/state.json" "local-sequential" ".bug-hunter/source-files.json" "$FILE_BUDGET" "$SOURCE_TOKEN_BUDGET" true
```

State preserves the original source hashes. Obey
`SKILL.md › Evidence and source-integrity invariants`; missing/invalid evidence
is a failed phase, not a reason to invent a fallback file budget.

## Phase A: Recon

Read `skills/recon/SKILL.md` and switch to Recon. With triage present, use its
risk map and order; enrich only technology and trust-boundary patterns. Write
`.bug-hunter/recon.json` and validate it:

```bash
node "$SKILL_DIR/scripts/schema-validate.cjs" recon .bug-hunter/recon.json
```

Under `--loop`, reuse validated recon.json after the first iteration while
triage-listed source hashes remain unchanged, as specified in `modes/loop.md`.
Without triage, perform deterministic triage before continuing.

## Phase B: Hunter

Read `skills/hunter/SKILL.md`, switch to Hunter, and use Recon's stack context.
Read assigned source afresh. For one pass write
`.bug-hunter/hunter-findings.json`; for a chunk use a fresh attempt path.

For each chunk:

```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" next-chunk .bug-hunter/state.json
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk .bug-hunter/state.json "<chunk-id>" in_progress
```

Run Hunter only on that chunk's files. Write and validate its findings before
recording or marking completion:

```bash
node "$SKILL_DIR/scripts/schema-validate.cjs" findings ".bug-hunter/chunk-<id>-findings.json"
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" record-findings .bug-hunter/state.json ".bug-hunter/chunk-<id>-findings.json" local-sequential
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk .bug-hunter/state.json "<chunk-id>" done
```

Use per-file evidence for completion. If capacity is exhausted, leave unread
files pending and preserve the attempt. Merge valid chunk findings into
`.bug-hunter/hunter-findings.json`. Compare actual file coverage with the queue;
gap-fill missed files only within available capacity and the original scope.

```bash
node "$SKILL_DIR/scripts/schema-validate.cjs" findings .bug-hunter/hunter-findings.json
```

If there are zero findings, skip Phases C and D and return to
`SKILL.md › Join and present the scan result`. A clean chunk does not end a loop
while queued source remains.

## Phase C: Skeptic

Read `skills/skeptic/SKILL.md`, switch to Skeptic, and challenge the canonical
Hunter findings using current evidence. Write `.bug-hunter/skeptic.json`.

```bash
node "$SKILL_DIR/scripts/schema-validate.cjs" skeptic .bug-hunter/skeptic.json
```

## Phase D: Referee

Read `skills/referee/SKILL.md`, switch to Referee, and consume the Hunter and
Skeptic artifacts. Follow that skill's verification and verdict rules. Write
`.bug-hunter/referee.json`.

```bash
node "$SKILL_DIR/scripts/schema-validate.cjs" referee .bug-hunter/referee.json
node "$SKILL_DIR/scripts/render-report.cjs" report .bug-hunter/hunter-findings.json .bug-hunter/referee.json > .bug-hunter/report.md
```

Return to `SKILL.md › Join and present the scan result`. Report unresolved
review and pending/failed coverage. With `--loop`, use the shared loop contract
for the next queued assignment. Otherwise report the coverage of this pass.
