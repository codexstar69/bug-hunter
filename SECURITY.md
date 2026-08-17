# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Bug Hunter itself, report it
responsibly.

**Do not open a public GitHub issue for a security vulnerability.**

Email **security@codexstar.dev** or use
[GitHub private vulnerability reporting](https://github.com/codexstar69/bug-hunter/security/advisories/new).

Do not include unrelated private source, production data, tokens, or secrets in
the report.

## What qualifies

Security-impacting flaws in the Bug Hunter runtime, including:

- arbitrary command/code execution or shell injection in runtime helpers;
- repository/path traversal, symlink escape, or mutation outside validated
  Fixer scope;
- prompt-injection paths that can change role policy, tool authority, file
  scope, output destination, or mutation permission;
- source-integrity/resume flaws that allow stale or changed source to be
  accepted as current evidence;
- coverage/state flaws that can falsely report unscanned source as complete;
- evidence-cache flaws that reuse conclusions across different source hashes,
  protocols, roles, hypotheses, or security-relevant options;
- hybrid-verifier flaws that expose ambient secrets, execute shell strings,
  escape the repository, bypass required-check failure, or exceed enforced
  output/time bounds;
- Fixer-scope, lock, worktree, rollback, installer, package, or release
  provenance bypasses;
- malformed-artifact handling that turns failed review/verification into a clean
  or writable result.

## What does not qualify

- bugs Bug Hunter finds in a repository being audited;
- ordinary false positives/false negatives that do not bypass Bug Hunter's own
  safety boundary (please use the normal issue templates for those);
- vulnerabilities in upstream services/dependencies that are not caused by Bug
  Hunter integration behavior;
- theoretical local attacks that assume an attacker already controls the same
  user account and arbitrary repository/runtime files, unless they bypass a
  documented containment or authorization boundary.

## Security design expectations

Bug Hunter intentionally follows fail-closed rules for source identity,
required artifact validation, required hybrid verification, immutable Fixer
scope, and preservation/cleanup uncertainty. A report that demonstrates one of
those states being silently converted into success is security relevant.

Repository content, comments, generated findings, cached facts, tool output,
dependency metadata, and retrieved documentation are untrusted data. They may
be analyzed, but should not be able to grant new tools, files, secrets, or
mutation authority.

## Response timeline

Target response goals:

- acknowledgment within 48 hours;
- initial assessment and remediation plan within 7 days;
- patch release within 14 days for confirmed vulnerabilities when practical.

Complex coordinated disclosures may require a different schedule; the reporter
will be kept informed through the private channel.
