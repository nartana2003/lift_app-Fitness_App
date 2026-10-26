---
name: plan-pending
description: Method for listing which PLAN.md features are still pending in the Lift app, by checking the plan against the built code, the errata and the backlog. Used by plan-auditor.
---

# Pending-features method

Read-only. Produce a list of what PLAN.md asks for that the app does not yet do.

## 1. Read in this order
1. `.claude/plan-errata.md`. Superseded, NOT DOING, PARKED and BLOCKED rows are never "pending work". Never report green accents, a dark-only theme, a History or Workout tab, `body_weights`, or a Progress heatmap as missing.
2. `PLAN.md`, especially "Features by screen", "Where AI is used", "Changes since approval" and "Build status". The Build status "Done" list is a claim, not proof.
3. `.claude/state/backlog.yml` for item ids and statuses.

## 2. Verify against the code
For every feature, look in `lift/` (Glob/Grep) for the route, component or lib module that implements it. Classify:
- `built`: code exists and is clearly wired in. Do not list it.
- `partial`: some of it exists; say what is missing.
- `pending`: no evidence in the code.

Do not trust the plan's Done list or the backlog status alone; cite the file you found, or the absence of one.

## 3. Group the pending items
- **Buildable now**: no external account needed. Map to a backlog id where one exists, and note if the feature has no backlog item.
- **Blocked**: needs Vercel, Supabase, VAPID keys or an Anthropic key. State which. These are not failures, only waiting on the user.
- **Parked / not doing**: one line each, so the user sees they were seen and skipped on purpose.

## 4. Output format
A compact markdown list, no preamble. Per item: `- [id or "no backlog item"] Feature name (PLAN.md:line-range): status. Evidence or gap.` End with counts per group and a one-line suggestion of what to build next, following backlog order. No emojis. Do not edit any file.
