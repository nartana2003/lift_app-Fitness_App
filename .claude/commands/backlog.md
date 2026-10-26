---
description: Show build-loop status (counts by status, next item, blocked and needs-human items, recent cycles). Read-only.
---

Read `.claude/state/backlog.yml` and the last 10 lines of `.claude/state/CYCLES.md`. Check whether `.claude/state/STOP` exists and print its contents if so. Report:
- counts by status
- the next eligible item (first todo/needs-rework, unblocked, dependencies done)
- every `needs-human` and `blocked` item with its reason
- the last cycles
Keep it to about 15 lines. Change nothing.
