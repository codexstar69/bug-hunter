## Documentation Lookup (Context7)

When you need to verify a claim about how a library, framework, or API actually behaves — do NOT guess from training data. Look it up.

### When to use this

- "This framework includes X protection by default" — verify it
- "This ORM parameterizes queries automatically" — verify it
- "This function validates input" — verify it
- "The docs say to do X" — verify it
- Any claim about library behavior that affects your bug verdict

### How to use it

**Step 1: Search for the library**
```bash
node ~/.claude/skills/bug-hunter/scripts/context7-api.cjs search "<library>" "<what you need to know>"
```
Example: `node ~/.claude/skills/bug-hunter/scripts/context7-api.cjs search "prisma" "SQL injection parameterized queries"`

This returns a list of matching libraries with IDs. Pick the best match (highest trust score, correct version).

**Step 2: Fetch documentation**
```bash
node ~/.claude/skills/bug-hunter/scripts/context7-api.cjs context "<library-id>" "<specific question>"
```
Example: `node ~/.claude/skills/bug-hunter/scripts/context7-api.cjs context "/prisma/prisma" "are raw queries parameterized by default"`

This returns relevant documentation snippets with code examples.

### Rules

- Only look up docs when you have a SPECIFIC claim to verify. Do not speculatively fetch docs for every library in the codebase.
- One lookup per claim. Don't chain 5 searches — pick the most impactful one.
- If the API fails or returns nothing useful, say so explicitly: "Could not verify from docs — proceeding based on code analysis."
- Cite what you found: "Per Express docs: [quote]" or "Prisma docs confirm that $queryRaw uses parameterized queries."
