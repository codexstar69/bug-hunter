# Large Codebase Strategy (> FILE_BUDGET×3 files)

This mode handles truly large codebases (monorepos, enterprise apps, 200+ source files) that cannot be audited in a single pass or even a single `--loop` run. It replaces the naive "flat chunk by position" approach with domain-aware, multi-tier scanning.

## Why the standard modes fail at scale

1. **Recon overflows**: Classifying 1,000+ files in one pass exhausts context before scanning starts.
2. **Flat chunking loses domain context**: A Hunter scanning `auth/login.ts` + `billing/invoice.ts` in the same chunk has no coherent understanding of either domain.
3. **Cross-service bugs are invisible**: The most dangerous bugs live at service boundaries (auth → payments, orders → inventory), but flat chunks never group these together.
4. **Skeptic/Referee see everything at once**: Merging 50+ findings into one Skeptic pass is itself a context overflow.

## The Strategic Approach: Domain-First, Tiered Scanning

### Tier 0: Rapid Recon (lightweight, always first)

Instead of classifying every file, do a **structural scan only**:

1. **Discover the domain map** using directory structure:
   ```bash
   # Find top-level domains (packages, services, modules)
   fd -t d --max-depth 2 . <target> | head -50
   ```
2. **Count files per domain**:
   ```bash
   for dir in <domains>; do
     echo "$dir: $(fd -e ts -e js -e py -e go -e rs . "$dir" | wc -l) files"
   done
   ```
3. **Classify domains (not files) by risk**:
   - CRITICAL domains: auth, payments, security, API gateways, middleware
   - HIGH domains: core business logic, database models, state management
   - MEDIUM domains: utilities, helpers, formatting, UI components
   - LOW domains: tests, docs, config, scripts, migrations

4. **Write the domain map** to `.claude/bug-hunter-domain-map.json`:
   ```json
   {
     "domains": [
       { "path": "packages/auth", "tier": "CRITICAL", "fileCount": 42 },
       { "path": "packages/billing", "tier": "CRITICAL", "fileCount": 38 },
       { "path": "packages/api-gateway", "tier": "CRITICAL", "fileCount": 25 },
       { "path": "packages/orders", "tier": "HIGH", "fileCount": 56 },
       { "path": "packages/notifications", "tier": "MEDIUM", "fileCount": 31 },
       { "path": "packages/ui-components", "tier": "LOW", "fileCount": 120 }
     ],
     "totalFiles": 512,
     "criticalFiles": 105,
     "highFiles": 156,
     "mediumFiles": 131,
     "lowFiles": 120
   }
   ```

This is fast — no file reading, just directory listing and heuristic classification.

### Tier 1: Domain-Scoped Deep Audits

Process ONE domain at a time, running the **full pipeline** (Recon → Hunter → Skeptic → Referee) within each domain:

```
For each domain (CRITICAL first, then HIGH, then MEDIUM):
  1. Run Recon on THIS domain only → domain-specific risk map
  2. Run Hunter on THIS domain only → domain-specific findings
  3. Run Skeptic on THIS domain's findings only → challenges
  4. Run Referee on THIS domain only → confirmed bugs

  Write domain results to:
    .claude/domains/<domain-name>/recon.md
    .claude/domains/<domain-name>/findings.md
    .claude/domains/<domain-name>/skeptic.md
    .claude/domains/<domain-name>/referee.md

  Record in state:
    node "$SKILL_DIR/scripts/bug-hunter-state.cjs" record-findings ...
```

**Why this works**: Each domain audit is self-contained. The Hunter scanning `packages/auth` has full context of the auth domain — middleware, models, routes, utils — all in one coherent pass. The Skeptic only has to validate 3-8 findings from that domain, not 50 from everywhere.

**Domain size handling**: If a single domain exceeds FILE_BUDGET, chunk it using the existing Extended mode chunking, but WITHIN the domain boundary. This keeps domain coherence even when chunking.

### Tier 2: Cross-Domain Boundary Audit

After all individual domains are audited, run a **boundary-focused pass** that specifically targets service interaction points:

1. **Identify boundary files**: Files that import from or are imported by other domains:
   ```bash
   # Find cross-domain imports
   rg -l "from ['\"]\.\./(auth|billing|orders)" packages/api-gateway/
   rg -l "import.*from.*@packages/(auth|billing)" packages/orders/
   ```

2. **Build boundary pairs**: Group files by the domains they connect:
   ```
   auth ↔ api-gateway: [gateway/auth-middleware.ts, auth/token-service.ts]
   billing ↔ orders: [orders/checkout.ts, billing/charge.ts]
   auth ↔ billing: [billing/subscription-guard.ts, auth/permissions.ts]
   ```

3. **For each boundary pair**: Run a focused Hunter scan that reads files from BOTH domains simultaneously. The Hunter prompt should emphasize:
   - Trust boundary violations (does domain A trust unvalidated data from domain B?)
   - Contract mismatches (does the caller assume a return type the callee doesn't guarantee?)
   - Race conditions across domain boundaries
   - Auth/permission gaps between services

4. **Challenge + Verify** boundary findings through the normal Skeptic → Referee pipeline.

Write boundary results to `.claude/domains/_boundaries/`.

### Tier 3: Merge and Report

After all domains + boundaries are audited:

1. Read all domain `referee.md` files and boundary results.
2. Merge findings, deduplicate by file + line + claim.
3. Renumber BUG-IDs globally.
4. Build the final report per Step 7 in SKILL.md.

## State Management for Large Codebases

Use `.claude/bug-hunter-state.json` with domain-aware structure:

```json
{
  "mode": "large-codebase",
  "domainMap": ".claude/bug-hunter-domain-map.json",
  "domains": {
    "packages-auth": { "status": "done", "findings": 5, "confirmed": 3 },
    "packages-billing": { "status": "in_progress", "findings": 0, "confirmed": 0 },
    "packages-orders": { "status": "pending", "findings": 0, "confirmed": 0 }
  },
  "boundaries": {
    "auth-billing": { "status": "pending" },
    "auth-api-gateway": { "status": "pending" }
  },
  "totalConfirmed": 3,
  "lastUpdated": "2026-03-10T00:00:00Z"
}
```

**Resume**: If the process is interrupted, read state and skip domains with status `done`. Resume from the first `pending` or `in_progress` domain.

## When to use `--loop` with large-codebase mode

`--loop` wraps the domain iteration in a ralph-loop. Each loop iteration processes ONE domain (or one boundary pair). This means:
- Iteration 1: Tier 0 (rapid recon + domain map)
- Iteration 2: Tier 1 domain "auth" (full pipeline)
- Iteration 3: Tier 1 domain "billing" (full pipeline)
- ...
- Iteration N-2: Tier 2 boundary audits
- Iteration N-1: Tier 3 merge and report
- Iteration N: Coverage check → DONE or continue with missed domains

The ralph-loop's coverage check reads the state file and only marks DONE when all CRITICAL and HIGH domains show status `done`.

## Optimization: Skip LOW domains

For truly huge codebases (1,000+ files), skip LOW-tier domains entirely unless `--exhaustive` is specified. UI components, test utilities, and formatting helpers rarely contain runtime bugs worth the context cost.

Report skipped domains in the final report:
```
ℹ️ Skipped [N] LOW-tier domains ([M] files) for efficiency.
Use `--exhaustive` to include all domains.
```

## Optimization: Delta-first for repeat scans

If `.claude/bug-hunter-state.json` exists from a previous run AND `--delta` is specified:
1. Run `git diff --name-only <last-commit>` to find changed files.
2. Map changed files to their domains.
3. Re-audit ONLY the affected domains (not the whole codebase).
4. Re-run boundary audit only for boundaries involving affected domains.

This makes repeat scans on large codebases take minutes instead of hours.

## Context Budget for Large Codebases

Each domain audit uses its own context budget independently:
- Domain Recon: lightweight (just this domain's files)
- Domain Hunter: FILE_BUDGET applies to this domain's files only
- Domain Skeptic: only this domain's findings
- Domain Referee: only this domain's findings + challenges

If a single domain exceeds FILE_BUDGET, it gets its own Extended-mode chunking within the domain boundary. The key insight is: **chunking happens within domains, not across them**.

## Checklist for the Orchestrator

When executing large-codebase mode:

- [ ] Tier 0: Run rapid recon, produce domain map
- [ ] Tier 1: For each CRITICAL domain, run full pipeline
- [ ] Tier 1: For each HIGH domain, run full pipeline
- [ ] Tier 1: For each MEDIUM domain, run full pipeline (or skip if --fast)
- [ ] Tier 2: Identify boundary pairs from cross-domain imports
- [ ] Tier 2: Run boundary-focused Hunter on each pair
- [ ] Tier 2: Challenge + verify boundary findings
- [ ] Tier 3: Merge all domain + boundary findings
- [ ] Tier 3: Deduplicate and renumber
- [ ] Tier 3: Build final report with per-domain breakdown
- [ ] Coverage: All CRITICAL/HIGH domains done? If not, continue.
