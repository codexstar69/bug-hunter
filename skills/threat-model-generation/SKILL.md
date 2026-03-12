---
name: threat-model-generation
description: Generate or refresh a STRIDE-based threat model for the current repository using Bug Hunter-native artifacts. Use whenever the repository has no threat model yet, the architecture changed materially, a security review needs fresh trust-boundary context, or the user explicitly asks for a threat model.
---

# Threat Model Generation

This is a bundled local Bug Hunter companion skill. It generates portable threat-model artifacts under `.bug-hunter/`.

## Purpose

Create the security context that the other security skills depend on:
- trust boundaries
- major components
- STRIDE threats
- vulnerability pattern library
- severity/config defaults

## Required outputs

Write:
- `.bug-hunter/threat-model.md`
- `.bug-hunter/security-config.json`

## Workflow

1. Read `.bug-hunter/triage.json` if available for file structure and domain hints.
2. Inspect the repository to identify:
   - languages and frameworks
   - public/authenticated/internal entry points
   - data stores and external integrations
   - sensitive assets and trust boundaries
3. Generate a concise STRIDE threat model.
4. Generate a matching security config with thresholds and tech-stack metadata.

## Existing implementation hooks

Bug Hunter already has a native prompt for this capability:
- `prompts/threat-model.md`

Prefer reusing that prompt structure and artifact conventions rather than inventing a second format.

## Output rules

- Keep the threat model short enough for downstream agents to consume.
- Be specific about trust boundaries and vulnerable code patterns.
- Keep all artifacts under `.bug-hunter/`, never `.factory/`.
