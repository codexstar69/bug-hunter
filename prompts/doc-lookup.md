## Documentation Lookup (Context Hub + Context7 fallback)

When you need to verify a claim about how a library, framework, or API actually behaves — do NOT guess from training data. Look it up.

### When to use this

- "This framework includes X protection by default" — verify it
- "This ORM parameterizes queries automatically" — verify it
- "This function validates input" — verify it
- "The docs say to do X" — verify it
- Any claim about library behavior that affects your bug verdict

### How to use it

`SKILL_DIR` is injected by the orchestrator. Use it for all helper script paths.

The lookup script tries **Context Hub (chub)** first for curated, versioned docs, then falls back to **Context7** when chub doesn't have the library.

**Step 1: Search for the library**
```bash
node "$SKILL_DIR/scripts/doc-lookup.cjs" search "<library>" "<what you need to know>"
```
Example: `node "$SKILL_DIR/scripts/doc-lookup.cjs" search "prisma" "SQL injection parameterized queries"`

This returns results from both sources with a `recommended_source` and `recommended_id`.

**Step 2: Fetch documentation**
```bash
node "$SKILL_DIR/scripts/doc-lookup.cjs" get "<library-or-id>" "<specific question>"
```
Example: `node "$SKILL_DIR/scripts/doc-lookup.cjs" get "prisma/orm" "are raw queries parameterized by default"`

This fetches curated docs from chub if available, otherwise Context7 documentation snippets with code examples.

**Optional flags:**
- `--lang js|py` — language variant (for chub docs with multiple languages)
- `--source chub|context7` — force a specific source

### Rules

- Only look up docs when you have a SPECIFIC claim to verify. Do not speculatively fetch docs for every library in the codebase.
- One lookup per claim. Don't chain 5 searches — pick the most impactful one.
- If the API fails or returns nothing useful, say so explicitly: "Could not verify from docs — proceeding based on code analysis."
- Cite what you found: "Per Express docs: [quote]" or "Prisma docs confirm that $queryRaw uses parameterized queries."
