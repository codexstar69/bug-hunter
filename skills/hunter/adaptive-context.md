# Adaptive and retrieval context

Load only when the assignment provides an adaptive plan, retrieval plan, or cached fact card.

- Treat the adaptive plan as the bounded execution policy for context, reviewer depth, verification, and early stopping. Explicit user scope and safety rules still take precedence.
- Read mandatory retrieval entries and named symbol slices first. Expand optional files only for an unresolved named hypothesis; do not spend context on unrelated whole-file reads.
- Cached facts are hints bound to exact source hashes and protocol versions. Re-check them against assigned source before relying on them, and never treat cached findings as authorization to report a bug.
- Stop only when the adaptive early-stop conditions are all satisfied; coverage alone cannot close open critical hypotheses or unreviewed findings.

