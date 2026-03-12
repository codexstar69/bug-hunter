# Local Security Skills Integration Plan

## Objective

Vendor the security-engineer marketplace capabilities into Bug Hunter as local, portable companion skills so the repository is self-contained and does not depend on external machine-specific skill paths.

Target local skills:
- `skills/commit-security-scan/`
- `skills/security-review/`
- `skills/threat-model-generation/`
- `skills/vulnerability-validation/`

## Design

Use Bug Hunter as the orchestrator and package the imported capabilities as local skills with Bug Hunter-native artifact paths and schemas.

Principles:
- No references to `.factory/` or external marketplace paths
- Reuse Bug Hunter-native artifacts under `.bug-hunter/`
- Keep skill bodies focused on capability/workflow; keep runtime logic in existing prompts/scripts
- Make the new skills portable by including them in the package `files` list and documenting them in the repo

## Work items

1. Create local skill directories with adapted `SKILL.md` files
2. Point all skill outputs/inputs to `.bug-hunter/*` artifacts and existing Bug Hunter concepts
3. Add a packaging/regression test to verify the local skills are present and packaged
4. Add `skills/` to `package.json` publish files
5. Document the bundled companion skills in `README.md`
6. Update `CHANGELOG.md`
7. Run tests

## Definition of done

- `skills/` exists with the four local security skills
- no vendored skill references point to `.factory/` paths
- package metadata includes `skills/`
- tests verify the packaged skills exist
- docs explain the bundled local security pack
