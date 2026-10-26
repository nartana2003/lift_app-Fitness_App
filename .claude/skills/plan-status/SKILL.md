---
name: plan-status
description: Refresh the loop-generated status block at the end of PLAN.md from backlog.yml and CYCLES.md (done, in progress, remaining, blocked, parked). Used by the orchestrator after a cycle lands.
---

# Plan status refresh

PLAN.md is hand-written and partly stale. This skill never edits any of it. It maintains ONE generated block at the very end of PLAN.md, between these two marker lines:

    <!-- loop-status:start -->
    <!-- loop-status:end -->

If the markers do not exist yet, append them (with the block between) to the end of PLAN.md. If they exist, replace only what is between them. Do not touch a single character outside the markers. The ground rule still holds: the built app wins over the plan, and this block only reports.

## Inputs (read only)
- `.claude/state/backlog.yml` for every item's id, title, status, blocked_by, plan_ref.
- `.claude/state/CYCLES.md` for the commit sha and rounds of each landed item.

## Block contents (keep it short, plain text, no emojis)
1. A heading `## Loop build status (auto-updated, <date>)` and one line of counts, e.g. `11 done, 3 done-mocked, 10 queued, 3 blocked, 5 parked`.
2. `### Done by the build loop`: one bullet per item with status `done` or `done-mocked`: `id: title (commit sha)`. Mark `done-mocked` items with `mocked only: not confirmed against the real Claude API until a key exists`.
3. `### Queued (the loop will build these, in order)`: items with status `todo` or `needs-rework`, with their `plan_ref`.
4. `### Needs you`: items with status `blocked` (say what they need: Vercel account, Supabase project, Anthropic key), `needs-human` (say why), and `parked` (say they will not run until promoted to todo).
5. One closing line: `Generated from .claude/state/backlog.yml. Hand-written sections above are unchanged.`

## Rules
- Never edit PLAN.md anywhere except between the markers.
- If the Edit or Write tool is denied for PLAN.md, stop, say so in one line, and do NOT work around it (no shell redirection, no copies). The orchestrator reports that PLAN.md could not be updated.
- Do not invent status. Only report what the backlog and cycle log say.

## How to run it
Do not write the block by hand. From the project root run `node .claude/skills/plan-status/update.js`. It builds the block from backlog.yml and CYCLES.md and writes only between the two markers (appending them the first time). Afterwards check the output line it prints. If PLAN.md cannot be written, stop and report; do not work around it.
