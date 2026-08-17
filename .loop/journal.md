# Journal

## Iteration 0 — repository audit — complete

Reviewed the orchestration scripts, schemas, role skills, tests, CI, and package inventory. Confirmed four correctness defects and two efficiency/protocol gaps:

- `bug-hunter-state.cjs` alphabetically sorts caller-provided files, discarding triage risk order.
- `code-index.cjs` supports fewer source extensions than `triage.cjs`, weakening delta scope for supported languages.
- `chunk-scheduler.cjs` ignores missing files and can mark a chunk done without scanning its assigned scope.
- `findings.schema.json` does not enforce non-empty cross-references or security STRIDE/CWE evidence.
- `run-bug-hunter.cjs` uses a fixed default chunk count rather than a source-token budget.
- Skeptic hard-excludes every rate-limit finding while Hunter explicitly searches for exploitable auth-rate-limit failures.

## Iteration 1 — loop setup — expected failing gate

Created the sealed completion check. On the setup tree it must fail with the assertion that `scripts/source-config.cjs` is missing. The one-shot patch workflow verifies this expected failure before applying changes.

## Iteration 2 — schema generation — failed

The setup assertion failed exactly as expected and the complete patch payload applied cleanly. Ajv then rejected the generated findings schema in strict mode because the conditional CWE `pattern` did not repeat its string `type`. The payload was corrected to use `{ "type": "string", "pattern": "^CWE-[0-9]+$" }`; the sealed check remains unchanged.

## Iteration 3 — patch transport — failed

The corrected payload was uploaded as one long compressed Base64 line, but GitHub Actions detected a gzip CRC/length mismatch before executing it. No repository source changes were applied. The transport is being replaced with ordered 1.8 KB parts that are locally concatenated, decoded, decompressed, and byte-compared before publication.

## Iteration 4 — regression gate — failed

The chunked patch transport and SHA check passed, the patch applied, and generated assets were current. The actual sealed check failed with four regressions: a newline-escaping SyntaxError in the new test, two existing security fixtures missing newly required STRIDE/CWE fields, and one resume fixture emitting an empty cross-reference list. The workflow also lacked `pipefail`, so its step metadata incorrectly reported success. The next retry fixes all four fixtures and makes pipeline failure propagation explicit.

## Iteration 5 — precision protocol test — failed

The exact reconstructed patcher passed its SHA-256 and syntax checks. All production changes and all 175 pre-existing tests passed. The sole remaining failure was a malformed regular expression in the new protocol regression test: the slash in `OTP/reset` was not preserved through the patcher's template literal. The patcher now emits an escaped slash, and the sealed gate remains unchanged.
