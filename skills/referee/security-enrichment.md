# Security enrichment

For each finding with `category: security` that you confirm as `REAL_BUG`,
include the security enrichment details in `analysisSummary` and
`suggestedFix`. Until the schema grows extra typed security fields, do not emit
out-of-contract keys.

**Reachability** (required for all security findings):
- `EXTERNAL` — reachable from unauthenticated external input (public API, form, URL)
- `AUTHENTICATED` — requires valid user session to reach
- `INTERNAL` — only reachable from internal services / admin
- `UNREACHABLE` — dead code or blocked by conditions (should not be REAL_BUG)

**Exploitability** (required for all security findings):
- `EASY` — standard technique, no special conditions, public knowledge
- `MEDIUM` — requires specific conditions, timing, or chained vulns
- `HARD` — requires insider knowledge, rare conditions, advanced techniques

**CVSS** (required for Critical/High security only):
Calculate CVSS 3.1 base score. Metrics: AV=Attack Vector (N/A/L/P), AC=Complexity (L/H), PR=Privileges (N/L/H), UI=User Interaction (N/R), S=Scope (U/C), C/I/A=Impact (N/L/H).
Format: `CVSS:3.1/AV:_/AC:_/PR:_/UI:_/S:_/C:_/I:_/A:_ (score)`

**Proof of Concept** (required for Critical/High security only):
Generate a minimal, benign PoC:
- **Payload:** [the malicious input]
- **Request:** [HTTP method + URL + body, or CLI command]
- **Expected:** [what should happen (secure behavior)]
- **Actual:** [what does happen (vulnerable behavior)]

Example canonical verdict (enrichment stays inside existing fields):

```json
[
  {
    "bugId": "BUG-1",
    "verdict": "REAL_BUG",
    "trueSeverity": "Critical",
    "confidenceScore": 94,
    "confidenceLabel": "high",
    "verificationMode": "INDEPENDENTLY_VERIFIED",
    "analysisSummary": "Critical: unauthenticated SQL injection exposes protected rows. Reachability: EXTERNAL. Exploitability: EASY. src/routes.ts:8 passes public search input to src/users.ts:47-48, which interpolates then executes SQL. CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N (9.1). PoC payload: ' OR '1'='1; request: GET /users?search=%27%20OR%20%271%27%3D%271; expected: matching users only; actual: other users' rows returned.",
    "suggestedFix": "Replace src/users.ts:47-48 interpolation with bound query parameters."
  }
]
```

Non-security findings use the parent output format without enrichment.
