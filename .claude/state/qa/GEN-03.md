PASS

Files added
- components/routines/__tests__/GeneratePlan.qa.test.tsx (49 tests, all pass; run together with the builder's GeneratePlan.test.tsx: 93 pass)
- e2e/gen-03-qa.e2e.ts (written but NOT RUN, see below)

Scenarios covered (unit, mocked fetch, no real AI)
- cleanRequest / combineRequest: 400 boundary, whitespace, fixed-seed fuzz (result <= 400, new text kept whole), repeated refines accumulate.
- sendableFavorites (custom, malformed, duplicate, non-string, cap 30), searchExercises (blank, multi-word, regex characters literal, real catalogue), planDaysFor for 0..20 day splits.
- Request bodies are accepted by the routes' own validators; injection-looking request is rejected by the route validators.
- parseSplit with hostile shapes, one-day answers, 12 days trimmed to 6, control characters and emoji stripped.
- Card: with saved favourites but nothing opened, no favorites/request/plan_days sent; labels and plan_days for 2,4,5,6 and 9 (shown as 6) day splits; no-split old message, no Build button.
- Typed request: whitespace counts as unused, over-cap paste sent as 400, survives collapse.
- Favourites picker: custom-only never sent and no Build button, remove all sends no field and keeps saved list, no double add, closing keeps picks, Add disabled at cap.
- Refine: two refines accumulate and re-send favourites, failed refine (500 and thrown error) keeps plan and does not pollute the request, rapid double tap sends one request, ticks reset, discard saves nothing.
- Build a split: label updates after saving, replace confirm also for a split passed by prop, double taps (build, use, replace) are safe, discard then rebuild, network error and 400 fall back to a local proposal, no custom ids sent, nothing saved without an explicit tap.
- Offline and 503 leave the extras filled and the card retryable; no emoji in the new UI text.

Bugs
- None found.

Observations (not asserted)
- Text whose NFKC form is longer than 400 characters (for example 400 ligature characters) passes the UI cap but is rejected by the route, so the user gets the rule-based fallback with the "failed" message. Minor.

E2E not run
- The coordinator asked for unit tests only. Also, while I was building, another process (a playwright run of smoke and gen-03 in this same worktree) was using .next, and my `next build` runs failed with missing .next files (required-server-files.json, .next/export). So e2e/gen-03-qa.e2e.ts is unverified; it needs a clean `npx next build` and `E2E_PORT=3124 npx playwright test e2e/gen-03-qa.e2e.ts` with no other runner using this worktree.
