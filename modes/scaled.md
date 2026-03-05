# Scaled Mode (FILE_BUDGET*2+1 to FILE_BUDGET*3 files) — heavy partitioning

Same as Extended Mode but with THREE file partitions and SIX Hunters (3 security + 3 logic).

Partition logic:
- CRITICAL files in ALL partitions
- HIGH files split into thirds
- MEDIUM files split into thirds

For 120+ files without `--loop`, cap at 4 partitions (8 Hunters) and warn about potential MEDIUM file gaps.

All other steps (gap-fill, merge, reconciliation, Skeptics, Referee) follow extended mode patterns scaled to 3 partitions.
