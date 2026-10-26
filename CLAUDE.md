# Lift fitness app: standing rules for every agent

The app is in `lift/` (Next.js 15 PWA). The spec is `PLAN.md` (this folder). Both are hand-built and valued.

## Project overview
Lift is a personal workout tracker in the style of Lyfta. It is an offline-first PWA: the user logs workouts, plans training by date on a This Week strip, builds splits and routines, tracks progress and goals, and can use optional AI helpers (coach, plan generator, workout import). Everything works without an AI key; AI features are opt-in and always have a rule-based fallback. The user trains a x-day split with a pool of exercises per muscle and no fixed gym weekdays, so planning is tied to dates, not weekdays.

## Technical details
- Framework: Next.js 15 (App Router), React 19, TypeScript, installable PWA.
- Styling: Tailwind CSS 4.
- Local data: Dexie (IndexedDB) is the source of truth, with an outbox that syncs to Supabase (auth and Postgres) when it is configured.
- AI: Anthropic SDK called only from server routes under `app/api/ai/`; prompts live in `lift/prompts/`.
- Charts and visuals: Recharts, react-body-highlighter.
- Push reminders: web-push.
- Tests: Vitest with Testing Library and fake-indexeddb for unit tests, Playwright (Edge) for end-to-end tests.

## Styling details and rules
- White background, black accent, monochrome greys for everything else. No other accent colours (no green, no pink), no gradients, no heatmap on Progress.
- Mirror Lyfta's layout and flow, never its branding or artwork.
- Never use emojis anywhere: not in UI text, not as graphics, not in code comments, commit messages or docs. Use icons (inline SVG or the existing icon components) for graphics.
- Keep new screens consistent with the existing ones: same spacing, rounded corners, type sizes and the existing `Collapsible` pattern for optional sections.
- The This Week strip uses round circle tiles, never rectangles.
- Layout is mobile first (about 390px wide) and must also work on desktop.

## Coding standards
- Use the latest stable versions of libraries and the idiomatic approach for them as of today. Check the current docs before using an API from memory.
- Keep it simple. Never overengineer: no extra abstractions, options or layers that the task does not need.
- Match the surrounding code: naming, comment density and idiom.
- Keep the README minimal and concise. Do not use emojis ever.

## Rule 1: the built app wins over PLAN.md
PLAN.md only ADDS features. Never delete, rename or rework an existing screen, route, export or behaviour because PLAN.md describes it differently. If they conflict, keep what exists and ask. PLAN.md is partly stale: read `.claude/plan-errata.md` first. Never edit PLAN.md.

## Rule 2: style
Mirror Lyfta's layout and flow, never its branding or artwork. White background, black accent, monochrome. No emojis in new UI text, no green or pink accents, no heatmap on Progress.

## Commands (run from `lift/`)
`npm test` (vitest run), `npx tsc --noEmit`, `npm run lint`, `npm run build`. Never run bare `vitest` (watch mode hangs) or `npm run dev`.

## Never run
`git clean`, `git reset`, `git checkout`, `git restore`, `git stash`, `rm -rf`. The tree has no remote, so these are unrecoverable.

## AI prompts
System prompts for the AI features live in `lift/prompts/*.md`, not inline in `lift/lib/ai/`. Each feature file keeps its `SYSTEM_PROMPT` export, built with `loadPrompt("name", { ...limits })` from `lift/prompts/load.ts`. Limits are `{{placeholders}}` in the `.md`. Edit the wording in the `.md` file.

## Autonomous loop
Backlog and state live in `.claude/state/`. See `.claude/commands/build-cycle.md`.


