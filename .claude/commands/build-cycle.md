---
description: Run ONE autonomous build cycle on the next eligible backlog item (builder, tester, plan-reviewer, rework, commit). Drive repeatedly with /loop /build-cycle.
argument-hint: "[item-id]  (optional; default is the next eligible item)"
---

You are the orchestrator. You coordinate; you do NOT write code, and you do NOT read source files, diffs or test logs. You read only `.claude/state/backlog.yml`, `.claude/state/CYCLES.md`, and the small `verdicts/` and `feedback/` files. Do exactly one backlog item, then end the turn.

Paths are relative to the project root (the working directory). The app is `lift/`, its own git repo. Use `git -C lift ...`.

## Step 0: brakes
- If `.claude/state/STOP` exists: say "STOP file present, loop halted" and end. If you were invoked by /loop, call ScheduleWakeup with `stop: true`.
- Read the last 2 lines of `.claude/state/CYCLES.md`. If both ended `needs-human`, write `.claude/state/STOP` containing "2 consecutive needs-human", say so, stop the loop, and end.
- Run `git -C lift status --short`. It must be empty at the start of a fresh item (the last cycle must have committed). If it is dirty and the backlog has no item at `needs-rework`, write STOP with "dirty tree at cycle start", report it, and end. Do not clean it yourself.

## Step 1: choose the item
`$ARGUMENTS` if given; otherwise the FIRST item in `backlog.yml` where status is `todo` or `needs-rework`, `blocked_by` is null, and every id in `depends_on` has status `done` or `done-mocked`. If none exists: report the counts, write STOP with "backlog exhausted or all remaining blocked", stop the loop, and end.

## Step 2: build (round = attempts + 1)
Set the item's `attempts` to the round number in backlog.yml. Spawn the `builder` agent with ONLY: the item id, the round number, and "read .claude/state/feedback/<ID>.md if it exists". Do not paste the acceptance criteria or any feedback into the prompt.

## Step 3: verify (tester and plan-reviewer IN PARALLEL)
Both agents are read-only, so start them together: make BOTH Agent calls in ONE message.
- `tester` gets ONLY the item id (plus the baseline test count from the last CYCLES.md line).
- `plan-reviewer` gets ONLY the item id, plus this line: "The tester is running the full gate (tsc, lint, full test suite, build) at the same time, so do not re-run the full suite or the build; run only the item's own new test files and tsc."
When both return, read the first line of `.claude/state/verdicts/<ID>.md` (PASS or FAIL) and of `.claude/state/feedback/<ID>.md` (PASS or REWORK; anything else counts as REWORK with the note "reviewer returned an invalid verdict").
- Tester FAIL: rewrite `feedback/<ID>.md` as `REWORK`, then the verdict body, then a line `--- reviewer notes ---` and the reviewer's feedback body (without its first line). Go to Step 5.
- Tester PASS and reviewer REWORK: keep the reviewer's feedback as is. Go to Step 5.
- Both PASS: Step 6.

## Step 5: rework or give up
- If `attempts` < 3: set status `needs-rework` and go back to Step 2 (same turn).
- If `attempts` >= 3: set status `needs-human`, append `date | ID | 3 | needs-human | -` to CYCLES.md, and end. Leave the working tree as is for the human; the next cycle will see a dirty tree and halt. That is intended.

## Step 6: land it
1. `git -C lift add -A`
2. `git -C lift commit -m "cycle(<ID>): <title>"` with a blank line and `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` as the final line.
3. Set status to `done`, or `done-mocked` if the item has `verify: mocked`. Reset nothing else.
4. Append `<date> | <ID> | <rounds> | pass | <short sha>` to `.claude/state/CYCLES.md`.
4b. Run the `plan-status` skill to refresh the generated status block at the end of PLAN.md. If PLAN.md cannot be edited (denied), skip it, say so in one line, and do NOT work around it.
5. Delete nothing in `feedback/` or `verdicts/` (it is the audit trail).

## Rules
- Never run `git clean`, `reset`, `checkout`, `restore` or `stash`. Never edit plan-errata.md or settings.json. PLAN.md may only be changed by the plan-status skill (its generated block); never edit any other part of it.
- Never implement or fix anything yourself, even a one-line fix. Route it through the builder.
- End each cycle with 2 lines at most: item id, outcome, rounds used.
