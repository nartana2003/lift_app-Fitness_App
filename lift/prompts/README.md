# AI prompts

Index of the system prompts in this folder. Each prompt is loaded by its feature file in `lib/ai/` with `loadPrompt("name", { ...limits })`, called from a route under `app/api/ai/`, and shown in the UI listed below. Every feature works without AI: when there is no key or the call fails, the route returns 503 and the screen uses its rule-based fallback.

Why prompts exist at all: the rule-based code is good at arithmetic and fixed thresholds, but it cannot read free text, weigh several signals at once, or explain itself in plain words. The prompt hands the model one narrow job, tells it which data it may use, and fixes the output shape so the app can validate and discard anything out of bounds.

Prompts without an `.md` file (inline arrays in `lib/ai/`): `suggest-split` (Coach setup, split suggestion) and `review-setup` (Coach setup, review step).

| Prompt | Feature | Screen |
| --- | --- | --- |
| `ask-coach.md` | Ask the coach | Goals: `components/goals/AskCoach.tsx` |
| `goal-gaps.md` | Catch-up picks for weekly goals | Goals: `components/goals/WeeklyGoalsCard.tsx` |
| `goal-targets.md` | AI weekly set targets | Goals: `components/goals/AiTargets.tsx` |
| `overload-suggestion.md` | Progressive overload suggestion | Workout: `components/workout/ExerciseCard.tsx` |
| `parse-log.md` | Quick log from typed or dictated text | Workout: `components/workout/QuickLog.tsx` |
| `photo-analysis.md` | Monthly photo comment | Progress, Photos: `components/progress/PhotosTab.tsx` |
| `plateau-fix.md` | Plateau fix | Progress: `components/progress/PlateauCard.tsx` |
| `social-import.md` | Save from link | Routines: `components/routines/SaveFromLink.tsx` |
| `summary.md` | Weekly or monthly recap | Progress: `components/progress/RecapCard.tsx` |
| `swap-exercise.md` | Swap an exercise mid-workout | Workout: `components/workout/SwapSheet.tsx` |
| `generate-routines.md` | Generate plan | Routines: `components/routines/GeneratePlan.tsx` |
| `evidence-picks.md` | Evidence-backed exercise picks | Goals: `components/goals/EvidencePicks.tsx` |

## ask-coach

- Interaction: the user types a question about their training and reads a short answer, with links to the exercises it mentions.
- How the prompt helps: it answers from the user's own numbers (weekly sets, best estimated 1RM, stalls, next targets) and refuses to drift into general advice or injuries.
- Why a prompt: questions are free text. Rules cannot match "why is my squat stuck" to the right data; the model can, and the guardrails keep it from inventing numbers or giving medical advice.

## goal-gaps

- Interaction: the user sees muscles behind their weekly set target and taps to accept suggested exercises on the days left this week.
- How the prompt helps: it picks exercises from each muscle's candidate list, assigns dates and set counts, and spreads the work across the remaining days.
- Why a prompt: choosing which exercise on which day, with limits per day and focus muscles first, is a small planning problem with many valid answers. The fixed output shape lets the app check every pick against the candidate list.

## goal-targets

- Interaction: the user asks the app to set weekly hard-set targets and can accept or edit each number.
- How the prompt helps: it starts from the rule-based target and moves it only for a clear reason (recent volume, split, focus muscles), with a one-line explanation per muscle.
- Why a prompt: the rule target ignores context such as a muscle the split never trains. The model weighs that context and explains the number, while the allowed range keeps it sane.

## overload-suggestion

- Interaction: when the user opens an exercise to log, they see today's suggested sets, reps and weight and can take or change them.
- How the prompt helps: it refines the rule-based default using the trend across recent sessions and the rir ratings, with hard safety rules after failure or a hard session.
- Why a prompt: a fixed formula cannot tell steady progress from slow fatigue. The model reads the trend, but the rules in the prompt and the limits checked by the app stop it from ever pushing too fast.

## parse-log

- Interaction: the user types or dictates what they did ("squat 3x8 at 60") and reviews the parsed exercises and sets before saving.
- How the prompt helps: it splits the text into exercises and sets, matches each to a catalogue exercise, and leaves out anything not mentioned.
- Why a prompt: people write logs in many formats and abbreviations. A regex covers a few; the model covers the rest, and the review step catches mistakes.

## photo-analysis

- Interaction: from Progress, Photos, the user asks for a monthly comment on their first and last photo and reads the comment and next-month focus items.
- How the prompt helps: it compares the photos cautiously, ties the comment to the month's training stats, and suggests focus muscles.
- Why a prompt: reading photos needs a vision model. The prompt limits it to cautious, kind observations and forbids body-fat estimates, appearance judgements, medical claims and describing the person or background.

## plateau-fix

- Interaction: when a lift has stalled, the Progress card shows one recommended fix (new rep range, a swap, an extra set or a deload) that the user can apply.
- How the prompt helps: it picks exactly one kind of fix from the history and fills only that fix's fields, defaulting to the rule-based fix unless the history says otherwise.
- Why a prompt: telling fatigue from a missing stimulus needs judgement over several sessions. The prompt narrows the model to four fix kinds with bounded numbers.

## social-import

- Interaction: the user pastes a TikTok, Instagram or YouTube link with its caption and notes, and gets a workout to review and save.
- How the prompt helps: it lists the exercises the post describes, matches them to the catalogue, and applies default sets and reps when the post gives none.
- Why a prompt: captions are unstructured text written for people. The text is untrusted, so the prompt also tells the model to treat it as data and never follow instructions in it.

## summary

- Interaction: the user opens the weekly or monthly recap on Progress and reads a short recap with overload advice.
- How the prompt helps: it turns the period's numbers and repeated highlights into a few plain sentences and next-step advice per exercise.
- Why a prompt: the numbers are computed by the app. The prompt only adds readable wording and prioritises the advice, and it may not invent numbers.

## swap-exercise

- Interaction: mid-workout, the user taps swap on an exercise and picks from a ranked list of replacements, each with a reason.
- How the prompt helps: it ranks the candidates by how well they train the same muscles and fit the reason for swapping (busy equipment, sore joint).
- Why a prompt: matching "same muscles, different equipment, no shoulder strain" is fuzzy. The model ranks and explains, while the app only accepts ids from its candidate list.

## generate-routines

- Interaction: the user chooses a number of days (and optional requests) and gets a draft plan to review and save as routines.
- How the prompt helps: it fills each day with exercises that cover that day's muscles, compound lifts first, preferring what the user already does.
- Why a prompt: building a balanced, varied plan under per-day limits is hard to hard-code. The prompt keeps the model inside each day's candidate list and the exact number of days.

## evidence-picks

- Interaction: the user asks for the best exercises per muscle for their goal and reads each pick with its cited sources.
- How the prompt helps: it searches the web, picks exercises from the fixed list, and attaches a claim and source links, with an honest strength-of-evidence rating.
- Why a prompt: only a model with search can gather and summarise research. The prompt forces every claim to carry a citation copied from real search results and forbids overstating weak evidence.

## Editing a prompt

Follow `CLAUDE.md`: matching XML tags around each section, multi-shot examples including edge cases, guardrails, and numbered steps for any workflow. Limits are `{{placeholders}}` filled by `loadPrompt`. Several unit tests pin parts of the prompt text, so run `npx vitest run lib/ai` after any change.
