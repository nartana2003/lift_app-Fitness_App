PASS

File added: lib/ai/__tests__/evidence-picks.qa.test.ts (67 tests, all pass, mocked client only).

Scenarios: 27 look-alike/hostile URLs rejected (http, subdomain tricks, userinfo, ports, backslash, punycode/cyrillic, fragments, huge host); table-only labels; forged/off-list citations and URLs never become sources; search error shapes (null, string, missing code, markup code) fall to rules; titles/quotes clipped and cleaned; marker edge cases ([0],[100],[1,2],[1-2],[ 1 ],[01]); single-pass renumbering swap; rejected claims consume no ids; seeded fuzz of validateCitations; pick clamping (muscle, candidate set, dedupe, per-muscle cap, __proto__); evidence lowering; rules fallback never has sources, markers, or URLs across all goals x experience x muscles; JSON in tool blocks/titles ignored; prompt independence; input validation bounds; route: malformed/oversize 400/413, forged URL absent from response, injected publisher ignored, refusal/truncation/throw -> rules.

Observations (not failures):
- A claim containing "</user_data>" is returned as text unchanged (angle brackets not stripped). It never re-enters a prompt, so low risk, but the UI must render it as text.
- null sessionsPerWeek and null equipment are accepted as defaults.
- An exercise that is a candidate for two requested muscles can only be picked once (second pick silently dropped).
