# PLAN.md errata (precedence table)

PLAN.md is partly stale. Read this BEFORE judging anything against PLAN.md. Where this file and PLAN.md disagree, this file wins. Builder and reviewer must both honour it. Only the user edits this file.

| PLAN.md says | App truth | Verdict |
|---|---|---|
| "mobile-first dark UI" (line 22) | White background | superseded |
| "White theme with a green accent" (line 263) | `--accent: #111111` (black). No green anywhere in the source | superseded: do NOT add green |
| Tabs: Workout, History, Exercises, Progress, Profile (line 22) | 4 tabs: Home, Exercises, Progress, Profile. History is on Home. Live workout is full screen, no tab bar | superseded |
| Key files list `app/(tabs)/{workout,history,calendar,...}` (line 225) | Those folders do not all exist. The planner lives on Home (`components/planner/WeekStrip.tsx`) | superseded |
| `body_weights` table | `measurements` table | superseded |
| `profiles.age` | `birth_date`, `gender`, `phone`, `email` | superseded |
| Heatmap on Progress | Deliberately not built | NOT DOING, never add |
| PR celebration (feature 9 / "Done" list) | `components/workout/PrToast.tsx` shows an emoji | approved as-is; the no-emoji rule applies to NEW or CHANGED lines only. Do not remove it |
| Import from Lyfta (Parked section) | Built, unused | PARKED: do not touch |
| "Candidate additions (not yet decided)" (line 282) | theme toggle, import/export | user has since asked for these as a first target; see backlog |
| Feature numbering `9.` twice, `9b.`, `16b.` with no `16.` | n/a | cosmetic; refer to PLAN.md by line range, never by number |
| Vercel / Supabase / Claude API key items | not available | BLOCKED: agents must not fake them |
