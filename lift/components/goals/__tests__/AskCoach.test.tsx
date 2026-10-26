// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { loadCatalogue } from "@/lib/catalogue";
import { MUSCLE_GROUPS } from "@/lib/muscles";
import { DEFAULT_GOALS, type Goals } from "@/lib/goals";
import type { Exercise } from "@/lib/exercises";
import type { WorkoutLite } from "@/lib/progress";
import type { Split } from "@/lib/splits";
import * as route from "@/lib/ai/ask-coach";
import {
  ASK_ROUTE,
  AskCoach,
  HINTS_TITLE,
  MAX_ANSWER_LINE,
  MAX_ANSWER_LINES,
  MAX_EXERCISES,
  MAX_QUESTION,
  MAX_REFERENCED,
  MAX_REPS,
  MAX_SESSIONS,
  MAX_SETS_PER_SESSION,
  MAX_TURNS,
  MAX_TURN_TEXT,
  MAX_WEIGHT,
  MAX_WORKOUTS_28D,
  MSG_CANCELLED,
  MSG_FAILED,
  MSG_INVALID,
  MSG_OFFLINE,
  MSG_RATE_LIMITED,
  MSG_TRUNCATED,
  MSG_UNAVAILABLE,
  askRequestBody,
  exerciseHistories,
  failureMessage,
  historyTurns,
  minimalRequestBody,
  parseAskAnswer,
  ruleHints,
  workoutsIn28Days,
} from "@/components/goals/AskCoach";

// ---------- helpers ----------

const ex = (id: string, name: string, muscle: Exercise["muscle_groups"][number], over: Partial<Exercise> = {}): Exercise => ({
  id,
  name,
  muscle_groups: [muscle],
  secondary_groups: [],
  equipment: "Barbell",
  category: "strength",
  mechanic: "compound",
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
  ...over,
});

const CATALOGUE: Exercise[] = [
  ex("bench", "Bench Press", "Chest"),
  ex("squat", "Squat", "Quads"),
  ex("row", "Barbell Row", "Lats"),
  ex("fly", "Cable Fly", "Chest", { equipment: "Machine/Cable", mechanic: "isolation" }),
  ex("curl", "Dumbbell Curl", "Biceps", { equipment: "Dumbbell", mechanic: "isolation" }),
  ex("pushup", "Push-Up", "Chest", { equipment: "Bodyweight" }),
];
const byId = new Map(CATALOGUE.map((e) => [e.id, e]));
const get = (id: string) => byId.get(id);

const goals = (over: Partial<Goals> = {}): Goals => ({ ...DEFAULT_GOALS, ...over });

// Wednesday 14 Oct 2026, noon; weeks start Monday (12 Oct).
const NOW = new Date(2026, 9, 14, 12);

const workout = (id: string, day: Date, exs: [string, number, number][], warm = 0): WorkoutLite => ({
  id,
  started_at: day.toISOString(),
  ended_at: day.toISOString(),
  notes: null,
  volume: 0,
  setCount: 0,
  exercises: exs.map(([exercise_id, sets, kg]) => ({
    exercise_id,
    sets: [
      ...Array.from({ length: warm }, () => ({ reps: 10, weight: 20, is_warmup: true })),
      ...Array.from({ length: sets }, () => ({ reps: 8, weight: kg })),
    ],
  })),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(handler: (init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/exercises.json")) return json(CATALOGUE);
    if (u === ASK_ROUTE) return handler(init);
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const routeCalls = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls.filter((c) => String(c[0]) === ASK_ROUTE);
const sentBody = (fn: ReturnType<typeof mockFetch>, i = 0) => JSON.parse(String(routeCalls(fn)[i][1]?.body));

function setOnline(v: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v });
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  setOnline(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- caps match the route ----------

describe("caps", () => {
  it("match lib/ai/ask-coach.ts", () => {
    expect(MAX_QUESTION).toBe(route.MAX_QUESTION);
    expect(MAX_TURNS).toBe(route.MAX_TURNS);
    expect(MAX_TURN_TEXT).toBe(route.MAX_TURN_TEXT);
    expect(MAX_EXERCISES).toBe(route.MAX_EXERCISES);
    expect(MAX_SESSIONS).toBe(route.MAX_SESSIONS);
    expect(MAX_SETS_PER_SESSION).toBe(route.MAX_SETS_PER_SESSION);
    expect(MAX_REPS).toBe(route.MAX_REPS);
    expect(MAX_WEIGHT).toBe(route.MAX_WEIGHT);
    expect(MAX_WORKOUTS_28D).toBe(route.MAX_WORKOUTS_28D);
    expect(MAX_ANSWER_LINES).toBe(route.MAX_ANSWER_LINES);
    expect(MAX_ANSWER_LINE).toBe(route.MAX_ANSWER_LINE);
    expect(MAX_REFERENCED).toBe(route.MAX_REFERENCED);
  });
});

// ---------- request body ----------

describe("askRequestBody", () => {
  const workouts = [
    workout("a", new Date(2026, 9, 13, 9), [["bench", 3, 60], ["squat", 2, 80]], 1),
    workout("b", new Date(2026, 9, 6, 9), [["bench", 3, 57.5], ["custom-xyz", 3, 10]]),
    workout("c", new Date(2026, 8, 1, 9), [["row", 3, 50]]),
  ];

  it("passes the route's own validation", () => {
    const body = askRequestBody({
      question: "Why is my bench press stalling?",
      unit: "kg",
      goals: goals({ targets: { Chest: 12 } }),
      workouts,
      get,
      weekStart: 1,
      now: NOW,
      turns: [{ role: "user", text: "Hi" }, { role: "coach", text: "Hello." }],
    });
    const checked = route.validateInput(JSON.parse(JSON.stringify(body)), byId);
    expect(checked.ok).toBe(true);
  });

  it("counts this week's hard sets against the targets and the last 28 days", () => {
    const body = askRequestBody({ question: "How am I doing?", unit: "lb", goals: goals({ targets: { Chest: 12 } }), workouts, get, weekStart: 1, now: NOW, turns: [] });
    expect(body.unit).toBe("lb");
    expect(body.muscles).toHaveLength(MUSCLE_GROUPS.length);
    expect(body.muscles.find((m) => m.muscle === "Chest")).toEqual({ muscle: "Chest", sets: 3, target: 12 });
    expect(body.muscles.find((m) => m.muscle === "Quads")?.sets).toBe(2);
    expect(body.workouts_28d).toBe(2);
    expect(body.history).toEqual([]);
  });

  it("never sends custom exercises", () => {
    const body = askRequestBody({ question: "x", unit: "kg", goals: goals(), workouts, get, weekStart: 1, now: NOW, turns: [] });
    expect(body.exercises.map((e) => e.exercise_id).sort()).toEqual(["bench", "row", "squat"]);
  });

  it("minimal body is accepted too", () => {
    expect(route.validateInput(minimalRequestBody("  why? ", "kg", goals()), byId).ok).toBe(true);
    expect(minimalRequestBody("  why? ", "kg", goals()).question).toBe("why?");
  });
});

describe("exerciseHistories", () => {
  it("puts exercises the question names first, then the most recent", () => {
    const ws = [
      workout("a", new Date(2026, 9, 13, 9), [["squat", 3, 80]]),
      workout("b", new Date(2026, 9, 10, 9), [["curl", 3, 12]]),
      workout("c", new Date(2026, 8, 1, 9), [["bench", 3, 60]]),
    ];
    expect(exerciseHistories(ws, "why is my bench press stuck", get).map((x) => x.exercise_id)).toEqual(["bench", "squat", "curl"]);
  });

  it("merges one day, keeps sessions oldest first and caps sessions and sets", () => {
    const ws: WorkoutLite[] = [];
    for (let i = 0; i < 12; i++) ws.push(workout(`w${i}`, new Date(2026, 8, 1 + i * 2, 9), [["bench", 3, 50 + i]]));
    ws.push(workout("same-day", new Date(2026, 8, 23, 18), [["bench", 9, 70]]));
    const [h] = exerciseHistories(ws, "", get);
    expect(h.sessions).toHaveLength(MAX_SESSIONS);
    const dates = h.sessions.map((s) => s.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
    expect(h.sessions.every((s) => s.sets.length <= MAX_SETS_PER_SESSION)).toBe(true);
    expect(h.sessions.find((s) => s.date === "2026-09-23")?.sets).toHaveLength(MAX_SETS_PER_SESSION);
  });

  it("drops invalid sets and caps the exercise count", () => {
    const many = Array.from({ length: 10 }, (_, i) => ex(`e${i}`, `Move ${i}`, "Chest"));
    const g = (id: string) => many.find((e) => e.id === id);
    const ws = [workout("a", new Date(2026, 9, 13, 9), many.map((e) => [e.id, 1, 20] as [string, number, number]))];
    ws.push({ ...workout("bad", new Date(2026, 9, 12, 9), []), exercises: [{ exercise_id: "e0", sets: [{ reps: 500, weight: 20 }, { reps: 5, weight: 5000 }] }] });
    const out = exerciseHistories(ws, "", g);
    expect(out).toHaveLength(MAX_EXERCISES);
    expect(out.find((x) => x.exercise_id === "e0")?.sessions).toHaveLength(1);
  });
});

describe("workoutsIn28Days and historyTurns", () => {
  it("counts finished workouts in 28 days, capped", () => {
    const ws = Array.from({ length: 70 }, (_, i) => workout(`w${i}`, new Date(2026, 9, 13, 9), []));
    ws.push(workout("old", new Date(2026, 7, 1, 9), []));
    expect(workoutsIn28Days(ws, NOW)).toBe(MAX_WORKOUTS_28D);
    expect(workoutsIn28Days([{ ...workout("u", new Date(2026, 9, 13), []), ended_at: null }], NOW)).toBe(0);
  });

  it("keeps the last turns, each capped", () => {
    const turns = Array.from({ length: 9 }, (_, i) => ({ role: (i % 2 ? "coach" : "user") as "user" | "coach", text: `t${i} ${"x".repeat(2000)}` }));
    const out = historyTurns(turns);
    expect(out).toHaveLength(MAX_TURNS);
    expect(out[0].text.startsWith("t3")).toBe(true);
    expect(out.every((t) => t.text.length <= MAX_TURN_TEXT)).toBe(true);
  });
});

// ---------- response ----------

describe("parseAskAnswer", () => {
  const sent = new Set(["bench", "squat"]);
  const nameOf = (id: string) => byId.get(id)?.name;

  it("keeps clean lines and only ids that were sent", () => {
    const out = parseAskAnswer(
      { answer: ["Line one.", "Line one.", "  Line\u0007 two  "], exercise_ids: ["bench", "row", "made-up", 3, "bench"], source: "ai", adjusted: 0 },
      sent,
      nameOf,
    );
    expect(out).toEqual({ lines: ["Line one.", "Line two"], exercises: ["Bench Press"], source: "ai" });
  });

  it("caps lines and length", () => {
    const out = parseAskAnswer({ answer: Array.from({ length: 9 }, (_, i) => `${i}${"y".repeat(400)}`), exercise_ids: [] }, sent, nameOf);
    expect(out?.lines).toHaveLength(MAX_ANSWER_LINES);
    expect(out?.lines.every((l) => l.length <= MAX_ANSWER_LINE)).toBe(true);
  });

  it("returns null for unusable shapes", () => {
    expect(parseAskAnswer(null, sent, nameOf)).toBeNull();
    expect(parseAskAnswer({ answer: "text" }, sent, nameOf)).toBeNull();
    expect(parseAskAnswer({ answer: ["", 4] }, sent, nameOf)).toBeNull();
  });

  it("marks rule answers", () => {
    expect(parseAskAnswer({ answer: ["a"], exercise_ids: [], source: "rule" }, sent, nameOf)?.source).toBe("rule");
  });
});

describe("failureMessage", () => {
  it("maps statuses to plain messages", () => {
    expect(failureMessage(503, { unavailable: true })).toBe(MSG_UNAVAILABLE);
    expect(failureMessage(400, null)).toBe(MSG_INVALID);
    expect(failureMessage(413, null)).toBe(MSG_INVALID);
    expect(failureMessage(429, { error: "rate_limited" })).toBe(MSG_RATE_LIMITED);
    expect(failureMessage(502, { error: "truncated" })).toBe(MSG_TRUNCATED);
    expect(failureMessage(502, { error: "error" })).toBe(MSG_FAILED);
  });
});

describe("ruleHints", () => {
  const base = { goals: goals(), favorites: [] as string[], catalogue: CATALOGUE, equipment: [] };
  const PUSH: Split = { name: "Push", days: [{ name: "Push", muscles: ["Chest", "Triceps"] }] };

  it("says there is no split when none is set", () => {
    const hints = ruleHints({ ...base, question: "What should I do?", split: { name: "", days: [] } });
    expect(hints[0]).toMatch(/no split yet/);
  });

  it("only talks about the muscles the question names", () => {
    const hints = ruleHints({ ...base, question: "How do I grow my chest?", split: PUSH });
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.length).toBeLessThanOrEqual(3);
    expect(hints.every((h) => !h.startsWith("Triceps"))).toBe(true);
    expect(hints.some((h) => h.startsWith("Chest"))).toBe(true);
  });

  it("is empty with no catalogue", () => {
    expect(ruleHints({ ...base, catalogue: [], question: "x", split: PUSH })).toEqual([]);
  });
});

// ---------- component ----------

const noWorkouts = async () => [] as WorkoutLite[];

async function openCard() {
  render(<AskCoach loadWorkouts={noWorkouts} />);
  fireEvent.click(screen.getByRole("button", { name: /Ask the coach/ }));
  return screen.getByLabelText("Your question for the coach") as HTMLTextAreaElement;
}

describe("AskCoach", () => {
  it("is collapsed and sends nothing until Ask is tapped", async () => {
    const fn = mockFetch(() => json({ answer: ["x"], exercise_ids: [] }));
    render(<AskCoach loadWorkouts={noWorkouts} />);
    expect(screen.getByRole("button", { name: /Ask the coach/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Your question for the coach")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Ask the coach/ }));
    const ask = screen.getByRole("button", { name: "Ask" });
    expect(ask).toBeDisabled();
    expect(screen.getByLabelText("Your question for the coach")).toHaveAttribute("maxLength", String(MAX_QUESTION));
    await new Promise((r) => setTimeout(r, 20));
    expect(routeCalls(fn)).toHaveLength(0);
  });

  it("shows the answer as plain text", async () => {
    const fn = mockFetch(() => json({ answer: ["Add 2.5kg next time.", "Sleep more."], exercise_ids: [], source: "ai", adjusted: 0 }));
    const box = await openCard();
    fireEvent.change(box, { target: { value: "Why is my bench stalling?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const answer = await screen.findByRole("region", { name: "Coach answer" });
    expect(within(answer).getByText("Add 2.5kg next time.")).toBeInTheDocument();
    expect(within(answer).getByText("You asked: Why is my bench stalling?")).toBeInTheDocument();
    expect(sentBody(fn).question).toBe("Why is my bench stalling?");
    expect(screen.getByRole("button", { name: "Start over" })).toBeInTheDocument();
  });

  it("sends earlier turns with a follow-up", async () => {
    const fn = mockFetch(() => json({ answer: ["Answer."], exercise_ids: [], source: "ai", adjusted: 0 }));
    const box = await openCard();
    fireEvent.change(box, { target: { value: "First?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await screen.findByRole("region", { name: "Coach answer" });
    fireEvent.change(box, { target: { value: "Second?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(routeCalls(fn)).toHaveLength(2));
    expect(sentBody(fn, 1).history).toEqual([
      { role: "user", text: "First?" },
      { role: "coach", text: "Answer." },
    ]);
  });

  it("on 503 shows a plain message and rule hints, no citations", async () => {
    mockFetch(() => json({ unavailable: true }, 503));
    await loadCatalogue();
    const box = await openCard();
    fireEvent.change(box, { target: { value: "What should I train?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(MSG_UNAVAILABLE)).toBeInTheDocument();
    const hints = await screen.findByRole("list", { name: HINTS_TITLE });
    expect(within(hints).getByText(/no split yet/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Coach answer" })).toBeNull();
    expect(screen.queryByText(/\[1\]/)).toBeNull();
  });

  it("offline: no request, plain message", async () => {
    const fn = mockFetch(() => json({ answer: ["x"], exercise_ids: [] }));
    setOnline(false);
    const box = await openCard();
    fireEvent.change(box, { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(MSG_OFFLINE)).toBeInTheDocument();
    expect(routeCalls(fn)).toHaveLength(0);
  });

  it("network error shows the failed message", async () => {
    mockFetch(() => {
      throw new TypeError("network");
    });
    const box = await openCard();
    fireEvent.change(box, { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(MSG_FAILED)).toBeInTheDocument();
  });

  it("a bad 200 body falls back", async () => {
    mockFetch(() => json({ nope: true }));
    const box = await openCard();
    fireEvent.change(box, { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(MSG_FAILED)).toBeInTheDocument();
  });

  it("can be cancelled", async () => {
    const fn = mockFetch(
      (init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const box = await openCard();
    fireEvent.change(box, { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(routeCalls(fn)).toHaveLength(1));
    fireEvent.click(cancel);
    expect(await screen.findByText(MSG_CANCELLED)).toBeInTheDocument();
    expect((routeCalls(fn)[0][1]?.signal as AbortSignal).aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Ask" })).toBeInTheDocument();
  });

  it("retries once with the question alone when the data is refused", async () => {
    await db.workouts.put({ id: "w1", started_at: new Date().toISOString(), ended_at: new Date().toISOString(), notes: null, routine_id: null });
    await db.workout_exercises.put({ id: "we1", workout_id: "w1", exercise_id: "bench", position: 0 });
    await db.sets.put({ id: "s1", workout_exercise_id: "we1", set_no: 1, reps: 8, weight: 60, is_warmup: false, rir: null, completed_at: new Date().toISOString() });
    let n = 0;
    const fn = mockFetch(() => (n++ === 0 ? json({ error: "invalid_request" }, 400) : json({ answer: ["Ok."], exercise_ids: ["bench"] })));
    await loadCatalogue();
    render(<AskCoach />);
    fireEvent.click(screen.getByRole("button", { name: /Ask the coach/ }));
    fireEvent.change(screen.getByLabelText("Your question for the coach"), { target: { value: "Bench?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await screen.findByRole("region", { name: "Coach answer" });
    expect(routeCalls(fn)).toHaveLength(2);
    expect(sentBody(fn, 0).exercises.map((e: { exercise_id: string }) => e.exercise_id)).toEqual(["bench"]);
    expect(Object.keys(sentBody(fn, 1)).sort()).toEqual(["experience", "goal_type", "question", "sessions_per_week", "unit"]);
    // The retry sent no exercises, so no exercise is named.
    expect(screen.queryByText(/About:/)).toBeNull();
  });
});
