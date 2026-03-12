# Bundled Local Security Skills

Bug Hunter ships with a local security pack under `skills/` so the repository stays portable and self-contained.

Included skills:
- `commit-security-scan`
- `security-review`
- `threat-model-generation`
- `vulnerability-validation`

## How They Connect to Bug Hunter

These skills are part of the main Bug Hunter orchestration flow:
- PR-focused security review routes into `commit-security-scan`
- `--threat-model` routes into `threat-model-generation`
- `--security-review` routes into `security-review`
- `--validate-security` routes into `vulnerability-validation`

Bug Hunter remains the top-level orchestrator. These bundled skills provide focused security workflows and operate on Bug Hunter-native artifacts under `.bug-hunter/`.
