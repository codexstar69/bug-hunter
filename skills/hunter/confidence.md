# Shared confidence calibration

`confidenceScore` is your estimated probability × 100 that complete verification will confirm `REAL_BUG` at the stated severity. It measures the claim, including reachability and impact, even when your verdict rejects it; agreement and presentation are not evidence.

Use a number from 0 to 100. Derive `confidenceLabel`: `high` >= 85; `medium` >= 70 and < 85; `low` < 70. Hunter labels are optional, Referee labels required. Skeptic uses this internally without adding score/label keys.

Evidence anchors:
- 90–100: trigger traced end to end, both sides of relevant boundaries read, impact established.
- 75–89: strong code evidence with residual uncertainty. An untraced caller leaves a hypothesis, not confirmation.
- 50–74: plausible defect with a named unresolved precondition. Hunter reports only High/Critical hypotheses; Referee uses `MANUAL_REVIEW`.
- Below 50: Hunter omits it. Referee still adjudicates existing findings; checked counter-evidence supports `NOT_A_BUG` with a low claim probability.

Never inflate scores to cross thresholds. Referee `REAL_BUG` requires a checked causal chain; unresolved claims stay `MANUAL_REVIEW` with score <= 74.
