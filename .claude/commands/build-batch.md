---
description: Run ONE parallel batch of up to 3 independent backlog items, each built and checked in its own git worktree, then landed one by one. Drive repeatedly with /loop /build-batch.
argument-hint: "[max-batch-size, default 3]"
---

You are the orchestrator. You coordinate; you do NOT write code and you do NOT read source files or diffs. You read only `.claude/state/backlog.yml`, `.claude/state/CYCLES.md`, and the small `verdicts/` and `feedback/` files (plus the last 30 lines of a failing integration command in Step 7). Do exactly one batch, then end the turn.

Paths are relative to the project root. The app is `lift/` (its own git repo, branch master). Each item in a batch gets a worktree at `.worktrees/<ID>` (inside the project root, outside the lift repo) on branch `item/<ID>`. A worktree is a full copy of the app: wherever an agent would use `lift/`, it uses its worktree instead. Convert paths for Windows commands with `cygpath -w`.

## Step 0: brakes
- If `.claude/state/STOP` exists: say "STOP file present, loop halted", call ScheduleWakeup with `stop: true` if invoked by /loop, and end.
- If the last 2 lines of `.claude/state/CYCLES.md` both ended `needs-human`: write STOP "2 consecutive needs-human", stop the loop, end.
- `git -C lift status --short` must be empty; if not, write STOP "dirty tree at batch start", end. Do not clean it.
- `git -C lift worktree list`: any `.worktrees/<ID>` whose item is not `needs-human` is a leftover from a crashed batch. Write STOP naming it, delete nothing, end.

## Step 1: choose the batch (max 6, or the number in $ARGUMENTS; the user wants as many agents in parallel as possible, and the dependency and `touches` rules below already keep them from colliding)
Walk the backlog in order. A candidate has status `todo` or `needs-rework`, `blocked_by` null, and every id in `depends_on` at `done` or `done-mocked`. Take the first candidate. Then add later candidates, in order, only if against EVERY item already chosen: their `touches` share no path (same file, or one is a folder containing the other), neither depends on the other, and neither is solo. Solo items always run alone: `touches` includes package.json, package-lock.json, vitest.config.ts, tsconfig.json, next.config.ts, app/layout.tsx or app/globals.css. If there is no candidate: report the counts, write STOP "backlog exhausted or all remaining blocked", stop the loop, end.

## Step 2: set up (quick, one item at a time)
For each chosen ID set `attempts` to attempts+1 in backlog.yml. If `.worktrees/<ID>` does not exist: `git -C lift worktree add ../.worktrees/<ID> -b item/<ID>`, then link dependencies: `cmd //c mklink //J "<win path of .worktrees/<ID>/node_modules>" "<win path of lift/node_modules>"`. If a worktree already exists (rework), reuse it.

## Step 3: build in parallel
ONE message containing one `builder` Agent call per item. Each prompt says ONLY: "Item ID: <ID>. Round: <n>. Your app directory is <absolute path of .worktrees/<ID>>; it replaces lift/ everywhere (reads, writes, git -C, npm, cd). Never touch lift/ or any other worktree. Read .claude/state/feedback/<ID>.md if it exists." Do not paste acceptance criteria or lessons: they live in the item and in the lift-conventions skill.

## Step 4: verify in parallel
A `tester` and a `plan-reviewer` Agent call for every item (up to 12). Start an item's pair as soon as ITS builder reports (no need to wait for the other builders); landing is ROLLING: as soon as an item has a PASS from both its tester and its reviewer, land it right away (Step 6 for that item, then the integration gate of Step 7 once, never two gates at the same time) and, if that unblocks queued items (their depends_on are now done and their touches collide with nothing in flight), start their builders at once instead of waiting for the rest of the batch. Never land an item whose verification is incomplete. A batch may also grow while it runs: when an item's dependencies are already `done` and its `touches` collide with nothing in flight, add it (set attempts, create its worktree, spawn its builder) up to the cap.
- tester prompt: the ID, the app directory, "Never run npm run build or the full e2e suite in a worktree (the orchestrator runs both after merging). If the item changes a screen, build with npx next build (webpack) and run Playwright for e2e/smoke.e2e.ts and the item's own e2e spec with E2E_PORT=<port>, where <port> is 3111 for the first item of the batch, 3112 for the second, and so on (one port per item). Baseline test count is in .claude/state/baseline.txt. Do NOT run the full unit suite in a worktree while other items are running (it takes hours under load and is the main slowdown): run tsc, lint and only the test files the item added or changed plus the files that import the changed modules; the orchestrator runs the one full suite at the integration gate. Other batch items are running tests and builds at the same time, so they are slow: if a test fails, re-run that single file alone once and report both results."
- qa-writer (independent QA, user request 2026-10-25): for every item that changes a screen or has real logic (skip trivial doc-only or config-only items), also start a `qa-writer` agent (if that agent type is not registered in the session, use a general-purpose agent and tell it to read `.claude/agents/qa-writer.md` and follow it). Its prompt: the ID, the app directory, its own E2E_PORT (3121, 3122, ... one per item), and "write extra tests that try to break this item, per your role file; report to .claude/state/qa/<ID>.md". Start it as soon as the item's builder reports, in parallel with the tester and the plan-reviewer. Its first report line is PASS or BUGS. BUGS counts exactly like a tester FAIL: put the repro into feedback/<ID>.md as REWORK and send the item back to the builder; the qa-writer's test files stay in the worktree and are committed with the item (never delete a failing QA test). An item lands only with PASS from the tester, the reviewer AND the qa-writer.
- plan-reviewer prompt: the ID, the app directory, "The tester runs the full gate at the same time; run only the item's own new test files and tsc."

Read the first line of `verdicts/<ID>.md` and `feedback/<ID>.md` for each item.
- Tester FAIL: rewrite `feedback/<ID>.md` as `REWORK`, the verdict body, a line `--- reviewer notes ---`, then the reviewer's body without its first line.
- PASS + PASS: ready. PASS + REWORK: keep the reviewer's feedback; needs rework.

## Step 5: rework (only the items that need it)
Items with attempts < 3: set status `needs-rework`, attempts+1, and repeat Steps 3 and 4 for just those items in their existing worktrees. Items that reach attempts 3 and still fail: status `needs-human`, append `date | ID | 3 | needs-human | -` to CYCLES.md, leave the worktree and branch for the human, do not land.

## Step 6: land (one at a time, in backlog order)
For each ready item: `git -C <worktree> add -A`, then commit there as `cycle(<ID>): <title>` with a blank line and `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` last. Then `git -C lift merge --no-ff item/<ID> -m "cycle(<ID>): <title>"`.
- On a merge conflict: `git -C lift merge --abort`, set the item to `todo` with attempts 0, append `date | ID | - | merge-conflict, rebuilds next batch | -` to CYCLES.md, and continue. Never resolve conflicts yourself.
- On success set status `done` (or `done-mocked` if `verify: mocked`) and append `date | ID | <rounds> | pass | <short merge sha>`.

## Step 7: integration gate (once per batch, in lift/)
Run in order: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e` (Bash timeout 600000; e2e needs the build just made). Then write `tests: <N> / <F> files (<date>, after <IDs>)` to `.claude/state/baseline.txt`. If `tsc`, lint, `npm test` or `npm run build` fails: write STOP containing the batch IDs, the failing command and the last 30 lines of its output, revert nothing, fix nothing, still do Step 8, then end. The human decides.

If ONLY `npm run test:e2e` fails (the other four passed), do ONE e2e repair round instead of stopping:
1. Spawn ONE `builder` Agent with app directory `lift/` (absolute path) and this prompt: "E2E repair for batch <IDs>. These Playwright tests failed: <test names and the last 30 lines of the output>. Fix ONLY files under e2e/ and playwright.config.ts. Do not change app code. If the failure shows a real app bug (not a wrong selector, timing or assumption in the spec), change nothing and say APP BUG with the evidence. Run `npm run test:e2e` yourself (the build in lift/.next is current) until it passes. Never use `next dev`."
2. If the builder reports APP BUG, or `npm run test:e2e` still fails when you re-run it yourself: write STOP (batch IDs, failing tests, last 30 lines, builder's note), do Step 8, end.
3. If it passes: `git -C lift add -A`, commit `fix(e2e): repair specs for <IDs>` (with the Co-Authored-By line), append `date | e2e-repair | <IDs> | pass | <sha>` to CYCLES.md, and continue to the baseline write and Step 8.

## Step 8: clean up landed and aborted worktrees
For each: first `cmd //c rmdir "<win path of .worktrees/<ID>/node_modules>"` (removes ONLY the link), then confirm `lift/node_modules/next/package.json` still exists (if not, write STOP immediately), then `git -C lift worktree remove --force ../.worktrees/<ID>` and `git -C lift branch -d item/<ID>`. Never use `rm -rf`. Leave `needs-human` worktrees alone.

## Step 9: refresh the plan status
Run `node .claude/skills/plan-status/update.js`.

## Rules
- Never run `git clean`, `reset`, `checkout`, `restore` or `stash`. Never edit plan-errata.md or settings.json. PLAN.md only via plan-status.
- Never run `npm run build` or `npm run test:e2e` inside a worktree. Never resolve a merge conflict. Never fix code yourself; route it through the builder.
- End with 3 lines at most: items landed, items needing a human, items deferred.

## Speed rules (user request 2026-10-26)
- Builders and testers never run the full unit suite in a worktree; the orchestrator runs it once per wave at the integration gate.
- qa-writer: only for items with real logic (dates, rotation, split/routine linking, backup/restore, AI input parsing). Skip for thin screen wiring (e.g. COACH-03, COACH-05). Unit tests only, no browser runs unless the item prompt says so.
- Stacked branches are allowed: an item whose dependencies are built and have PASS from tester, reviewer and QA (but are not yet merged) may start from that dependency's item branch (`git worktree add ../.worktrees/<ID> -b item/<ID> item/<DEP>`). Land the dependency first, then the dependent. If the dependency needs rework, send the rework to the dependent's builder as well.
- Low-risk items (no dates/rotation/linking/backup/AI parsing) may land on tester PASS + reviewer PASS without waiting for QA; QA bugs then become a follow-up fix item.
