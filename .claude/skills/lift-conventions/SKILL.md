---
name: lift-conventions
description: Stack, code patterns and the two standing rules for the Lift fitness app (lift/). Load before writing any Lift code.
---

# Lift conventions

## Stack
Next.js 15 App Router, React 19, TypeScript strict, Tailwind 4, Vitest. Path alias `@/*` maps to `lift/*`. Commands run from `lift/`: `npm test` (vitest run), `npm run lint`, `npm run build`, and `npx tsc --noEmit` (there is no typecheck script).

## Local-first
All workout writes go to Dexie (`lib/offline/db.ts`) first, then the outbox in `lib/offline/sync.ts` pushes to Supabase when online. Use client-generated UUIDs so re-sends are idempotent. The app must work with no Supabase and no API key.

## Code shape (match what exists)
- Pure logic in `lib/*.ts`; UI in `components/` (subfolders: goals, planner, progress, routines, workout); routes in `app/`.
- Tests in `lib/__tests__/*.test.ts` (and colocated, e.g. `lib/lyfta/*.test.ts`). Small factory helpers, real values, no mocks for pure logic. `lib/__tests__/goals.test.ts` is the model.
- Vitest runs in `node` by default. Dexie tests import `fake-indexeddb/auto`.
- Reuse before writing: `lib/muscles.ts` (MUSCLE_GROUPS), `stats.ts`, `overload.ts`, `prs.ts`, `plateau.ts`, `goals.ts`, `suggest.ts`, `swap.ts`, `splits.ts`, `planner.ts`, `components/MuscleIcon.tsx`, `components/PageHeader.tsx`.
- Rule-based fallbacks must keep working when AI is unavailable.

## STANDING RULE 1: the built app wins over PLAN.md
The plan only ADDS. Never delete, rename or rework an existing screen, route, export or behaviour because PLAN.md describes it differently. PLAN.md is partly stale. Known traps:
- PLAN.md says dark theme. The app is white background, black accent.
- PLAN.md says tabs Workout, History, Exercises, Progress, Profile. The app has 4 tabs: Home, Exercises, Progress, Profile. History lives on Home. The live workout is full screen with no tab bar.
- `body_weights` was replaced by `measurements`. `profiles.age` was replaced by `birth_date`.
If a plan item conflicts with what exists, keep what exists and note the conflict in your report.

## STANDING RULE 2: style
Mirror Lyfta's layout and flow, never its branding or artwork. Monochrome: white background, black accent. No emojis in UI text, no green or pink accents, no decorative clutter. No heatmap on Progress.

## Not available to agents
Do not attempt anything needing a Vercel account, a Supabase project, or a real `ANTHROPIC_API_KEY`. Code against mocks and mark the item accordingly.

## AI routes (from AI-00 onward)
- All Claude calls go through `lib/ai/client.ts` (`getAiClient`, `runAi`) and `lib/ai/respond.ts` (`withAiClient`, `aiOk`, `aiFailure`). Never import `@anthropic-ai/sdk` anywhere else, and never import `lib/ai` from `components/` or `app/` client code.
- Model is `claude-sonnet-5-5`. Never send `thinking: {type: "disabled"}` to it: that returns a 400.
- `runAi` treats `model_context_window_exceeded` and `pause_turn` as success. A route that sends long history (e.g. ask-coach) must map `model_context_window_exceeded` to "truncated".
- Each route needs pure `buildPrompt(input)` and `parseResponse(json)` functions tested with hand-written fixtures (including malformed output and catalogue-id clamping), and must return the 503 unavailable response when there is no key. Tests use `setAiClientFactory` with a fake client. Never use or print a real key.
- Mocked tests cannot show the model's output is good. Items are `done-mocked` until the user adds a key.

## Lessons from earlier reviews (apply by default to every AI route)
- Use the shared helpers in `lib/ai/validate.ts` (isObj, onlyKeys, isInt, isNum, isMuscle, escapeForTag, parseJsonText) and `cleanNote` from `lib/ai/generate-routines.ts`. Never add a private copy. Do not modify older lib/ai feature files; report any follow-up instead.
- Reuse existing rule-based logic (for example `ruleTarget` from `lib/ai/goal-targets.ts`, `suggestForMuscle` from `lib/suggest.ts`, `increment()` from `lib/overload.ts`) instead of a new copy. If a module is client-only (it imports Dexie or starts with 'use client'), take types only and add an equality test against the copy.
- Any local copy of a type or list from a client-only module needs a compile-time check in BOTH directions: `satisfies readonly T[]` and an `Exclude<T, ...> extends [never]` assertion. Prove it: temporarily remove one entry, confirm `npx tsc --noEmit` fails, then restore the file exactly.
- Every route needs an injection test: put a closing `</user_data>` tag plus an instruction into every string field and key the route accepts. Validation must reject it, and a forged unvalidated input must still give one closed fenced block with no raw `<` or `>`. A real escape is `\\u003c`, not `.replace(/</g, "<")`, which is a no-op.
- No free text may reach the prompt unless the item explicitly needs it. Routes that must accept text (parse-log, social-import, ask-coach) need escape, hard length caps, output id clamping and the two-part injection test.
- Route order: withAiClient (503 before the body is read), readJsonBody with a byte cap, invalidRequest, strict validation with unknown keys rejected, runAi, parse with clamping, fixed error shapes. Output must always be clamped and fall back to the rule-based answer.
- Finish by running tsc and the full test suite and confirm `git status --short` shows only new files unless the item says otherwise.
- Free-text validation order: clean and normalise FIRST (NFKC, strip control, format, variation-selector and zero-width characters, ignore combining marks), THEN run the tag-like check on the cleaned text, and reject lookalike angle brackets (fullwidth U+FF1C/U+FF1E and small-form U+FE64/U+FE65). A check that runs before cleaning can be bypassed by characters that cleaning removes. Add tests for each of these for every free-text field.
- Output clamping must be to the candidates the app actually offered, not the whole catalogue: a fallback that rule-matches a model-supplied name against the full catalogue lets the model steer to ids the app never sent.
- Binary parsers (image metadata stripping and the like) must be an ALLOW list of known-safe segments, not a deny list, must walk the whole file including data between scans, and need tests for hostile lengths (huge segment length, 0xFFFFFFFF chunk length, absurd dimensions, long runs of fill bytes).
