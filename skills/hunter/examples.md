---
title: Hunter Analysis Examples
description: Behavioral findings and checked negative controls.
---

# Hunter calibration examples

These are illustrative repositories. Trace the cited producer, caller, and guards; code shape alone does not prove a defect. JSON is canonical. Apply the shared severity rubric and confidence calibration.

## Example 1: SQL injection with a traced external input

`src/api/users.py:45-49` reads a public request's `q`, interpolates it into SQL, and executes the result. The route at `src/routes.py:8` has no input guard. The quote below matches the operation; a parameter tuple would instead make this a negative control.

```json
[
  {
    "bugId": "BUG-1",
    "severity": "Critical",
    "category": "security",
    "file": "src/api/users.py",
    "lines": "45-49",
    "claim": "Public search permits SQL injection.",
    "evidence": "src/api/users.py:47 sql = f\"SELECT * FROM users WHERE name = '{query}'\"; line 48 cursor.execute(sql)",
    "runtimeTrigger": "GET /users?q=' OR '1'='1 returns other users' rows.",
    "crossReferences": [
      "src/routes.py:8"
    ],
    "confidenceScore": 94,
    "confidenceLabel": "high",
    "stride": "Tampering",
    "cwe": "CWE-89"
  }
]
```

## Example 2: Nullable client contract and narrowed caller

The producer returns null for a valid account without a profile. The caller at `src/profile.ts:8` dereferences it:

```typescript
// src/client.ts:4
export async function getProfile(): Promise<Profile | null> { return api.profile(); }
// src/profile.ts:8
return (await getProfile()).name;
```

```json
[
  {
    "bugId": "BUG-2",
    "severity": "High",
    "category": "api-contract",
    "file": "src/profile.ts",
    "lines": "8",
    "claim": "A valid account without a profile crashes the profile view.",
    "evidence": "src/client.ts:4 permits null; src/profile.ts:8 immediately reads .name.",
    "runtimeTrigger": "Open the profile view for an account whose profile endpoint returns null.",
    "crossReferences": [
      "src/client.ts:4"
    ],
    "confidenceScore": 94,
    "confidenceLabel": "high",
    "stride": "N/A",
    "cwe": "N/A"
  }
]
```

Negative control: at `src/profile.ts:8-10`, `if (profile === null) return "No profile"` executes before `.name`. Reading the producer and this caller proves the nullable path is handled; emit `[]`.

## Example 3: Concurrent Go map and synchronized control

```go
// cache.go:7
var cache = map[string]string{}
// cache.go:12; registered as a net/http handler at server.go:9
func put(w http.ResponseWriter, r *http.Request) { cache[r.URL.Path] = "seen" }
```

`net/http` invokes handlers in goroutines. Read registration and every cache access: concurrent writes have no synchronization. Go's safe memory model does not prevent a fatal concurrent-map error.

```json
[
  {
    "bugId": "BUG-3",
    "severity": "High",
    "category": "concurrency",
    "file": "cache.go",
    "lines": "12",
    "claim": "Concurrent requests can crash the server on a shared map write.",
    "evidence": "cache.go:7 shares cache; cache.go:12 writes it from the handler.",
    "runtimeTrigger": "Two ordinary requests execute put concurrently, causing a fatal concurrent map write.",
    "crossReferences": [
      "server.go:9"
    ],
    "confidenceScore": 94,
    "confidenceLabel": "high",
    "stride": "N/A",
    "cwe": "N/A"
  }
]
```

Negative control: `cache.go:8-16` uses `sync.Mutex` and every read/write holds that same mutex, including other handlers. The claimed unguarded map access is disproved; emit `[]`. A mutex declaration alone is insufficient.

## Example 4: Checked guards and unresolved provenance

A query with bound parameters, or an ownership guard verified to run before the exact route's database lookup, blocks the claimed path; emit `[]`. Read guard implementations and route mounting, not just their names.

For a worker receiving shell arguments from an external queue, an unknown publisher leaves input control unresolved. Do not call the injection confirmed or assume internal messages are trusted. Report a High/Critical hypothesis only within the shared confidence policy, naming the missing publisher trace; downstream reviewers must preserve that uncertainty.
