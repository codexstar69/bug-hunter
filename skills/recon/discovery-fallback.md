# Discovery fallback — missing triage only

Load only when assigned triage output is absent or invalid. Do not use this fallback for valid domain-only triage. Prefer regenerating authoritative triage with the existing classifier:

```bash
node "$SKILL_DIR/scripts/triage.cjs" scan "<TARGET_PATH>" --output .bug-hunter/triage.json
```

Read the result and return to `skills/recon/SKILL.md` for enrichment. Keep the assigned target and output path; do not overwrite an unrelated triage artifact.

If triage cannot run in this environment:

1. Enumerate files under the assigned target with the runtime's file listing tool (`rg --files`, `fd`, or equivalent). A truncated listing is incomplete, never a complete inventory.
2. Use the maintained classification and skip rules in `scripts/source-config.cjs` and `scripts/triage.cjs`. Read their source when execution is unavailable; do not invent extension allowlists. Keep tests context-only and exclude generated/vendor/docs/assets as the classifier directs.
3. Measure file counts and sizes from that inventory when tools permit. Unknown measurements stay unknown; do not extrapolate a precise total from a truncated listing.
4. For at most 200 source files, classify individual files using the existing risk rules. For larger targets, identify domains from directory structure and sample 2–3 files per high-risk domain to establish architecture; do not fabricate flat per-file tiers.
5. Keep the canonical Recon contract: critical/high/medium/contextOnly file arrays and notes. For domain-only discovery, leave arrays empty and describe domains, provenance, missing triage, and incomplete coverage in notes. Let the orchestrator generate domain artifacts and scheduling state.

This fallback discovers context, never bugs. Return to the parent instructions for trust boundaries, documentation checks, and JSON output.
