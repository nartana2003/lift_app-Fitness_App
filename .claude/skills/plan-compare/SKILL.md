---
name: plan-compare
description: Rubric for reviewing a built Lift backlog item against PLAN.md acceptance criteria, the regression guard and the style rules. Used by plan-reviewer.
---

# Plan comparison rubric

Work through all four passes. Be specific and cite file:line. Do not pass work you have not read.

## 0. Errata
Read `.claude/plan-errata.md`. A PLAN.md line marked superseded or not-doing is NOT an acceptance bullet. Example: PLAN.md says green accent; the app is black, so never demand green.

## 1. Acceptance pass
Read the PLAN.md lines in the item's `plan_ref` yourself. For every acceptance bullet give `met`, `partial` or `missing`, with evidence (file:line) or what is absent. Also check the item's own `acceptance` list in `.claude/state/backlog.yml`. A claim with no evidence in the code is `missing`.

## 2. Regression pass (hard gate)
From `git -C <app dir> diff` and `git -C <app dir> status --short` (the app directory named in your prompt, default lift/; in a worktree the item's changes are uncommitted, new files are untracked):
- Any deleted or renamed export, route, screen, component or test: FAIL.
- Any edited existing test whose assertions were weakened or removed: FAIL.
- Any change to a file outside the item's `touches` that is not clearly required: FAIL unless justified and harmless.
- Any change that makes the app match stale PLAN.md text (dark theme, Workout or History tab, five-tab bar): FAIL. Quote standing rule 1.
- New code with no tests: FAIL.

## 3. Style pass
Apply to ADDED or CHANGED lines only (pre-existing code such as the PR emoji is approved). Colour other than black and white and neutral greys, emoji in UI copy, a heatmap on Progress, or copied Lyfta branding or artwork: FAIL. Quote standing rule 2.

## 4. Verdict
First line of the feedback file: `PASS` only if all passes are clean and every acceptance bullet is `met` (or `partial` with a reason that is genuinely out of scope, stated). Otherwise `REWORK`, followed by a numbered list. Each point: the file, what is wrong, the concrete change wanted. Never write generic advice such as "improve error handling".

For items with `verify: mocked`, say plainly in the file that real behaviour is unconfirmed until the key exists.
