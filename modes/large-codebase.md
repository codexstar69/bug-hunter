# Large-codebase mode

Use domain Hunters and bounded review batches; read `dispatch.md` for delegated
roles. Single-pass is the default; `--loop` continues queued coverage.

## Prepare once: triage, index, Recon

Use `.bug-hunter/triage.json` from
`SKILL.md › Deterministic triage before model work`; run triage if absent.
Use its `domainFileLists`, `domains`, `scanOrder`, and `fileBudget`.

Write the risk-ordered `.bug-hunter/source-files.json`. Set FILE_BUDGET from
triage and SOURCE_TOKEN_BUDGET from the caller or 48000. Initialize once;
resume preserves the original hashes:

```bash
node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init .bug-hunter/state.json large-codebase .bug-hunter/source-files.json "$FILE_BUDGET" "$SOURCE_TOKEN_BUDGET" true
node "$SKILL_DIR/scripts/code-index.cjs" build .bug-hunter/index.json .bug-hunter/source-files.json "$PWD"
```

Dispatch **one Recon per run** to enrich triage technology and trust boundaries.
Validate `.bug-hunter/recon.json` and share it with domain/boundary Hunters.
Reuse it under `modes/loop.md`; changed source hashes fail the current run.

## Tier 1: Domain Hunters and review

Process domains and their files in triage risk order:

1. Write its exact ordered `domainFileLists` array to the domain's
   source-files.json and initialize a domain state once with explicit budgets:

   ```bash
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" init ".bug-hunter/domains/<domain>/state.json" large-codebase ".bug-hunter/domains/<domain>/source-files.json" "$FILE_BUDGET" "$SOURCE_TOKEN_BUDGET" true
   ```

   Check domain source against the run ledger's hashes before initialization.
   Use that domain state for chunk commands; never take a global chunk spanning
   unrelated domains. Capacity limits split oversized domains automatically.
2. Get the next chunk and mark it in progress. Give each attempt a unique
   output: `.bug-hunter/domains/<domain>/chunks/<chunk-id>/<attempt>/findings.json`.
   Use globally unique bugIds. Dispatch Hunter with shared recon.json, then:

   ```bash
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" next-chunk ".bug-hunter/domains/<domain>/state.json"
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".bug-hunter/domains/<domain>/state.json" "<chunk-id>" in_progress
   node "$SKILL_DIR/scripts/schema-validate.cjs" findings ".bug-hunter/domains/<domain>/chunks/<chunk-id>/<attempt>/findings.json"
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" hash-verify .bug-hunter/state.json ".bug-hunter/domains/<domain>/chunks/<chunk-id>/<attempt>/read-files.json"
   ```

   Stop on nonzero hash-verify or nonempty changed/missing/unreadable arrays.
   Only after this check, record that attempt's findings, hash-update its actual
   read-file list in run/domain ledgers, then mark the chunk done:

   ```bash
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" record-findings ".bug-hunter/domains/<domain>/state.json" ".bug-hunter/domains/<domain>/chunks/<chunk-id>/<attempt>/findings.json" large-codebase
   node "$SKILL_DIR/scripts/bug-hunter-state.cjs" mark-chunk ".bug-hunter/domains/<domain>/state.json" "<chunk-id>" done
   ```

   Unread files remain pending; chunk completion alone is not file coverage.
3. Once the domain's chunks finish, write the ordered successful attempt paths
   to its `finding-paths.json`, then merge once before Skeptic:

   ```bash
   node "$SKILL_DIR/scripts/payload-guard.cjs" merge-findings ".bug-hunter/domains/<domain>/finding-paths.json" --out ".bug-hunter/domains/<domain>/findings.json"
   ```

   **Zero findings:** skip Skeptic and Referee for that domain, preserving its
   coverage, and continue. Otherwise dispatch Skeptic then Referee on the merged
   domain findings; validate `skeptic.json` and `referee.json`. Missing review
   stays unresolved. Do not run another Recon here.
4. Join findings with Referee verdicts by bugId into
   `.bug-hunter/reviewed-findings.json`, including dismissed/manual-review rows.

Three single-chunk domains, two nonempty, dispatch 1 Recon, 3 Hunters,
2 Skeptics, and 2 Referees; boundary Hunters follow actual index edges.

## Tier 2: Cross-domain boundaries

Derive pairs from the built index's reverseDependencies and exact triage domain
membership, rather than scanning import text or guessing prefix matches:

```bash
node "$SKILL_DIR/scripts/payload-guard.cjs" boundary-pairs \
  .bug-hunter/index.json .bug-hunter/triage.json --out .bug-hunter/boundary-pairs.json
```

For each pair, assign a stable pair-id and use its own state and chunk paths:
`.bug-hunter/domains/_boundaries/<pair-id>/chunks/<chunk-id>/<attempt>/findings.json`.
Dispatch Hunter with shared Recon and files from both domains. Follow Tier 1's
hash-verify-before-record/completion rule against the original run ledger, then
merge successful chunk artifacts once using `merge-findings` into
`.bug-hunter/domains/_boundaries/<pair-id>/findings.json`. An empty index edge
set means no indexed pairs; report unresolved/dynamic dependency limitations.

**Before boundary verification**, compare observations with the Tier-1 ledger:

```bash
node "$SKILL_DIR/scripts/payload-guard.cjs" dedup-boundaries \
  ".bug-hunter/domains/_boundaries/<pair-id>/findings.json" .bug-hunter/reviewed-findings.json \
  --out ".bug-hunter/domains/_boundaries/<pair-id>/dispatch.json"
```

Only reuse a verdict against the unchanged source baseline. The helper matches
same file, overlapping line range, same category and same claim with a unique
reviewed entry. It preserves the boundary observation and existing bugId/verdict under
`reused`. Invalid ranges, unresolved entries, and ambiguous overlaps remain in
`findings` for review. Retain evidence/security metadata when joining reused
observations; never renumber IDs before joining. The helper also writes
schema-valid `reused-findings.json` and `reused-referee.json` beside dispatch.json,
using each observation's bugId with the existing complete verdict. Incomplete
verdicts stay in the review queue.
Dispatch Skeptic and Referee only for the new `findings`; skip both if empty.
Reused manual-review verdicts stay non-writable.

## Tier 3: Join and report

Join domain and boundary artifacts by stable bugId, preserving unreviewed and
failed outcomes. Deduplicate before any optional final display renumbering.
Merge each pair's `reused-findings.json` and `reused-referee.json` with its new
Hunter/Referee rows and domain artifacts; include dismissed/manual-review rows
in the scan report. Write canonical merged Hunter/Referee artifacts, then follow
`SKILL.md › Join and present the scan result` with per-domain coverage.

When looping, reuse Recon and advance pending chunks/domains. Adaptive `fast`
may narrow optional context, never drop queued MEDIUM/LOW source.
