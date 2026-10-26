PASS

File added: components/routines/__tests__/link03.qa.test.ts (27 tests, all pass, jsdom + fake-indexeddb, no browser).

Scenarios
- planDayLinks vs planDays: sweep of split sizes 1..7 and plan lengths 2..6 (repeated and merged days link to split day i mod n and match the generated day name); muscle-less days skipped; original index kept for dropped days; missing/empty ids, negative/NaN/fractional indices, empty split, 9-day split capped at 7; input not mutated.
- parsePlanIndexed: indices survive dropped (unknown ids, junk, empty) days; default names use original position; maxDays slicing; junk inputs return null.
- savePlanDays: links by position; null/undefined/empty/missing write no field; repeated ids link several routines to one day; no links, extra links, no days.
- saveRoutineFromLink: split_day_id stored with social fields kept; undefined/null/empty write no field.
- nextRoutineForDay: never-done first, then longest ago, tie to oldest; minis never chosen; lastDoneByRoutine ignores null routine ids.
- planChoices (WeekStrip): no links, empty inputs, split-order groups with next-due first and minis listed last, mini-only day, stale/removed day ids fall into others (nothing lost or duplicated), days with no id / repeated id / blank name, no mutation, end-to-end via createRoutine.

Bugs: none found.
