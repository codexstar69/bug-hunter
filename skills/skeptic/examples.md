---
title: Skeptic Validation Examples
description: Checked acceptance, counter-evidence, and unresolved boundaries.
---

# Skeptic calibration examples

These illustrative cases exercise both defects and negative controls. Accept only a traced defect; disprove only a checked mechanism. Missing proof of either leaves manual review.

## Example 1: ACCEPT — public SQL interpolation

Read `src/api/users.py:45-49` and `src/routes.py:8-12`: public `q` reaches an interpolated query and execution without a guard. Walking the quote payload changes the query and returns other users' rows.

```json
[
  {
    "bugId": "BUG-1",
    "response": "ACCEPT",
    "analysisSummary": "src/routes.py:8-12 passes public q to src/api/users.py:47-48, where SQL interpolation then execution changes the predicate for q=' OR '1'='1. The traced path exposes other rows."
  }
]
```

## Example 2: DISPROVE — allowlist before interpolation

Read the route mounting, the guard implementation, and the query. `middleware/validation.js:23` rejects every category except four fixed strings; the route at `routes/products.js:15` invokes it before the query. The rejected payload never reaches the sink.

```json
[
  {
    "bugId": "BUG-2",
    "response": "DISPROVE",
    "analysisSummary": "The SQL payload is rejected before the query on this route.",
    "counterEvidence": "routes/products.js:15 calls validateRequest before the handler; middleware/validation.js:23 accepts only electronics, clothing, food, or other."
  }
]
```

## Example 3: MANUAL_REVIEW — command arguments from a queue

Read `src/workers/imageProcessor.js:56-60`: the consumer interpolates `inputPath` into `exec()`. The publisher is in an unavailable service. A server-generated path and an attacker-supplied filename imply different outcomes; neither is established by the consumer.

```json
[
  {
    "bugId": "BUG-3",
    "response": "MANUAL_REVIEW",
    "analysisSummary": "The unresolved fact is who controls inputPath at the publisher. Inspect that service's producer and validation before deciding whether src/workers/imageProcessor.js:56-60 permits command injection."
  }
]
```

## Example 4: Nullable contract — unsafe caller and narrowed control

Read the producer at `src/client.ts:4`: `getProfile(): Promise<Profile | null>` returns null for valid accounts without profiles. In the vulnerable version, `src/profile.ts:8` directly reads `.name`. In the fixed version, lines 8–10 return an empty state for null before dereferencing. These are two separate fixture findings:

```json
[
  {
    "bugId": "BUG-4-vulnerable",
    "response": "ACCEPT",
    "analysisSummary": "src/client.ts:4 returns null for a valid no-profile account; src/profile.ts:8 immediately dereferences .name. Opening this account crashes the view."
  },
  {
    "bugId": "BUG-4-fixed",
    "response": "DISPROVE",
    "analysisSummary": "The caller narrows the nullable result before dereferencing it.",
    "counterEvidence": "src/profile.ts:8-10 checks profile === null and returns the empty state before profile.name."
  }
]
```

## Example 5: Go map — concurrent writes and synchronized control

Read `cache.go:7-12` and `server.go:9`: ordinary net/http handler goroutines write one shared map. In the fixed version, `cache.go:8-16` uses a `sync.Mutex`; inspect all readers/writers to confirm they hold that same lock. Go memory safety does not exclude this concurrency defect.

```json
[
  {
    "bugId": "BUG-5-vulnerable",
    "response": "ACCEPT",
    "analysisSummary": "server.go:9 registers put as an HTTP handler; cache.go:7 shares the map and cache.go:12 writes without a lock. Concurrent valid requests can terminate the server."
  },
  {
    "bugId": "BUG-5-fixed",
    "response": "DISPROVE",
    "analysisSummary": "Every access is protected by the same mutex in this version.",
    "counterEvidence": "cache.go:8-16 locks mu before the map write and defers unlock; all reads at cache.go:20-25 also hold mu."
  }
]
```

## Boundary calibration

Fixed initial hosts, administrator-looking flags, log strings, short regex runs, and UI auth guards do not establish defenses. Check URL redirects and credentials, actual input provenance, downstream log consumers, reachable input cost, and server authorization respectively. If the relevant fact cannot be traced, use `MANUAL_REVIEW` and name it. A checked bound, encoder, trusted source, or server guard can support `DISPROVE` only for the path it actually protects.
