---
name: feature-verify
description: Ordered verification gate for a Lift backlog item (typecheck, lint, tests, build). Used by the tester agent.
---

# Verification gate

Run from `lift/`. Stop at the first hard failure; later steps need the earlier ones.

1. `npx tsc --noEmit`
2. `npm run lint`
3. `npm test`
4. `npm run build` (slowest; catches server/client boundary errors). In a git worktree (parallel batch) never run `npm run build`: it uses Turbopack, which cannot build there. Instead, when the item changes a screen (it adds or changes a `.tsx` file under `app/` or `components/`, or ships an `e2e/<id>.e2e.ts` spec) build with `npx next build` (the normal webpack build; it works in a worktree but can take up to about 10 minutes when other agents are running, so use a 600000 ms Bash timeout). For an item with no screen (pure lib, API route, test-only) record "build: deferred to the orchestrator merge gate". SKIP it (record "build: skipped, test-only change") when `git -C lift status --short` shows that every changed or new file is a test file (under a `__tests__` folder or named `*.test.ts`/`*.test.tsx`) or `vitest.config.ts`/`vitest.setup.ts`. Also skip if steps 1-3 already failed. Otherwise run it with a 10-minute Bash timeout (600000 ms); a timeout is a FAIL with the note "build timed out".

5. `npm run test:e2e` (Playwright, real Edge browser against `next start` on port 3100). It needs a production build, so run it only AFTER a successful build. In `lift/` run the whole suite. In a worktree run ONLY the smoke spec and the item's own spec(s) on the port your prompt gives you, so parallel testers never collide: `E2E_PORT=<port> npx playwright test e2e/smoke.e2e.ts e2e/<id>.e2e.ts` (the full suite runs at the orchestrator merge gate). It is skipped, with the note "e2e: deferred to the orchestrator merge gate", only when the item has no screen or the build was skipped (test-only change). Kill nothing you did not start; the Playwright config starts and stops its own server. Specs live in `lift/e2e/*.e2e.ts` (the `.e2e.ts` suffix keeps Vitest from picking them up). Any failure is a FAIL; keep the failing test name and its error lines.
   - If the item adds or changes a user-facing screen or flow (see `touches` for `app/` or `components/`), the item must ship an e2e spec for it, even a small one (page loads, key element visible, main click path works). Missing e2e coverage for a new screen is a FAIL. API-only, lib-only and test-only items need none.
   - Selectors: prefer `getByRole`/`getByText`/`getByLabel`. Never `next dev`. Never add a browser download; the config uses the installed Edge.

## Checks beyond the commands
- Compare the test count to the number in `.claude/state/baseline.txt` (updated after every landed batch). A LOWER count is a FAIL (tests were deleted); a higher one is expected. If a test fails, re-run that single file alone once before reporting: report FAIL only if it fails alone too, and mention a pass-alone as a possible flake with the file and test name. A drop in the number of tests is a FAIL (tests were deleted).
- Find the item's new modules (see `touches`). Each new module in `lib/` or `components/` needs a test file that imports it. Missing tests for new code is a FAIL, otherwise the builder learns to skip them.
- If lint reports only pre-existing issues in files the builder did not touch, say so and do not fail on them; confirm with `git -C lift stash`-free means (read the files, do not stash).

## Output trimming
Never paste full logs. Keep the failing command, the error message, file and line, and at most about 30 lines. For Vitest keep the failed test names and assertion diffs. For Next build keep the first error block.

## Verdict file
Write `.claude/state/verdicts/<ID>.md`. Line 1: `PASS` or `FAIL`. Then one line per gate with its result and, for any failure, the trimmed output.
