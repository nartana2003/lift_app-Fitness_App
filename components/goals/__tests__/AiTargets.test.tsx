// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import { DEFAULT_GOALS, defaultTarget, saveGoals, type Goals } from "@/lib/goals";
import { saveSplit, type Split } from "@/lib/splits";
import type { WorkoutLite } from "@/lib/progress";
import {
  AiTargets,
  MSG_FAILED,
  MSG_OFFLINE,
  MSG_UNAVAILABLE,
  ROUTE,
  acceptedTargets,
  buildRequestBody,
  loadRecentWeeks,
  parseTargets,
  recentWeekSets,
} from "@/components/goals/AiTargets";
import { GoalsSection } from "@/components/goals/GoalsSection";

// ---------- helpers ----------

const goals = (over: Partial<Goals> = {}): Goals => ({ ...DEFAULT_GOALS, ...over });
const PPL: Split = {
  name: "Push Pull Legs",
  days: [
    { name: "Push", muscles: ["Chest", "Shoulders", "Triceps"] },
    { name: "Pull", muscles: ["Lats", "Biceps"] },
    { name: "Legs", muscles: ["Quads", "Hamstrings", "Glutes"] },
  ],
};

/** A route answer covering every muscle: 10 sets each, Chest 15. */
function okBody() {
  return {
    targets: MUSCLE_GROUPS.map((m) => ({
      muscle: m,
      sets: m === "Chest" ? 15 : 10,
      reason: m === "Chest" ? "Focus muscle, so it gets extra sets." : `Steady volume for ${m}.`,
      source: "ai",
    })),
    adjusted: 0,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CATALOGUE = [
  { id: "bench", name: "Bench press", muscle_groups: ["Chest"], secondary_groups: ["Triceps"] },
  { id: "squat", name: "Squat", muscle_groups: ["Quads", "Glutes"], secondary_groups: [] },
];

/** fetch mock: the catalogue always loads; the AI route answers with `route`. */
function mockFetch(route: (init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/exercises.json")) return json(CATALOGUE);
    if (u === ROUTE) return route(init);
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const routeCalls = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls.filter((c) => String(c[0]) === ROUTE);
const noWeeks = async () => [];

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

// ---------- pure helpers ----------

describe("recentWeekSets", () => {
  // Wednesday 14 Oct 2026; weeks start Monday, so the current week is 12 Oct.
  const NOW = new Date(2026, 9, 14, 12);
  const w = (id: string, day: Date, ex: [string, number, number?][]): WorkoutLite => ({
    id,
    started_at: day.toISOString(),
    ended_at: day.toISOString(),
    notes: null,
    volume: 0,
    setCount: 0,
    exercises: ex.map(([exercise_id, work, warm = 0]) => ({
      exercise_id,
      sets: [
        ...Array.from({ length: work }, () => ({ reps: 8, weight: 50 })),
        ...Array.from({ length: warm }, () => ({ reps: 8, weight: 20, is_warmup: true })),
      ],
    })),
  });
  const muscleOf = (id: string) => (id === "bench" ? ["Chest", "Triceps"] : id === "odd" ? ["Not a muscle"] : []);

  it("returns the 4 full weeks before this one, oldest first", () => {
    const weeks = recentWeekSets([], muscleOf, 1, NOW);
    expect(weeks.map((x) => x.week_start)).toEqual(["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"]);
    expect(weeks.every((x) => Object.keys(x.sets).length === 0)).toBe(true);
  });

  it("counts hard sets per muscle, ignores warm-ups, this week and unknown muscles", () => {
    const weeks = recentWeekSets(
      [
        w("a", new Date(2026, 9, 6, 9), [["bench", 3, 2], ["odd", 4]]),
        w("b", new Date(2026, 9, 8, 9), [["bench", 2]]),
        w("c", new Date(2026, 8, 15, 9), [["bench", 1]]),
        w("now", new Date(2026, 9, 13, 9), [["bench", 9]]),
      ],
      muscleOf,
      1,
      NOW,
    );
    expect(weeks[3].sets).toEqual({ Chest: 5, Triceps: 5 });
    expect(weeks[0].sets).toEqual({ Chest: 1, Triceps: 1 });
    expect(weeks[1].sets).toEqual({});
  });

  it("honours a Sunday week start", () => {
    expect(recentWeekSets([], muscleOf, 0, NOW)[3].week_start).toBe("2026-10-04");
  });
});

describe("buildRequestBody", () => {
  it("sends goals, the split and the weeks in the route's shape", () => {
    const body = buildRequestBody(goals({ focusMuscles: ["Chest"], targets: { Biceps: 9 } }), PPL, []);
    expect(body).toEqual({
      goals: { goalType: "build_muscle", experience: "intermediate", sessionsPerWeek: 3, focusMuscles: ["Chest"], targets: { Biceps: 9 } },
      split: { name: "Push Pull Legs", days: PPL.days },
      recent_weeks: [],
    });
    expect(Object.keys(body.goals)).not.toContain("note");
  });

  it("drops an empty split and clamps stored numbers into the route's ranges", () => {
    const body = buildRequestBody(goals({ sessionsPerWeek: 9, targets: { Chest: 55 } }), { name: "", days: [{ name: "Day 1", muscles: [] }] }, []);
    expect(body.split).toBeNull();
    expect(body.goals.sessionsPerWeek).toBe(7);
    expect(body.goals.targets).toEqual({ Chest: 40 });
    expect(buildRequestBody(goals(), null, []).split).toBeNull();
  });
});

describe("parseTargets", () => {
  it("returns one row per muscle in MUSCLE_GROUPS order", () => {
    const rows = parseTargets(okBody(), goals())!;
    expect(rows.map((r) => r.muscle)).toEqual([...MUSCLE_GROUPS]);
    expect(rows[0]).toEqual({ muscle: "Chest", sets: 15, reason: "Focus muscle, so it gets extra sets." });
  });

  it("clamps numbers, drops unknown and duplicate muscles, fills gaps from the rule default", () => {
    const g = goals();
    const rows = parseTargets(
      {
        targets: [
          { muscle: "Chest", sets: 99, reason: "too many\nsets" },
          { muscle: "Chest", sets: 5, reason: "duplicate" },
          { muscle: "Wings", sets: 10, reason: "unknown" },
          { muscle: "Biceps", sets: 1, reason: 7 },
          { muscle: "Lats", sets: "12", reason: "not a number" },
        ],
      },
      g,
    )!;
    const by = (m: MuscleGroup) => rows.find((r) => r.muscle === m)!;
    expect(by("Chest")).toEqual({ muscle: "Chest", sets: 24, reason: "too many sets" });
    expect(by("Biceps")).toEqual({ muscle: "Biceps", sets: 4, reason: "" });
    expect(by("Lats").sets).toBe(defaultTarget("Lats", g));
    expect(rows).toHaveLength(MUSCLE_GROUPS.length);
  });

  it("returns null for an unusable body", () => {
    expect(parseTargets(null, goals())).toBeNull();
    expect(parseTargets({ targets: "x" }, goals())).toBeNull();
    expect(parseTargets({ targets: [] }, goals())).toBeNull();
    expect(parseTargets({ unavailable: true }, goals())).toBeNull();
  });
});

describe("acceptedTargets", () => {
  it("stores only numbers that differ from the rule default", () => {
    const g = goals();
    const rows = MUSCLE_GROUPS.map((m) => ({ muscle: m, sets: m === "Chest" ? 20 : defaultTarget(m, g), reason: "" }));
    expect(acceptedTargets(rows, g)).toEqual({ Chest: 20 });
  });
});

describe("loadRecentWeeks", () => {
  it("reads finished workouts from the local store and maps muscles via the catalogue", async () => {
    mockFetch(() => json({}, 500));
    const day = new Date(2026, 9, 6, 9).toISOString();
    await db.workouts.add({ id: "w1", started_at: day, ended_at: day, notes: null, routine_id: null });
    await db.workout_exercises.add({ id: "we1", workout_id: "w1", exercise_id: "squat", position: 0 });
    for (const n of [1, 2, 3])
      await db.sets.add({ id: `s${n}`, workout_exercise_id: "we1", set_no: n, reps: 5, weight: 100, is_warmup: n === 1, rir: null, completed_at: day });
    const weeks = await loadRecentWeeks(1, new Date(2026, 9, 14, 12));
    expect(weeks).toHaveLength(4);
    expect(weeks[3]).toEqual({ week_start: "2026-10-05", sets: { Quads: 2, Glutes: 2 } });
  });
});

// ---------- component ----------

async function suggest() {
  fireEvent.click(screen.getByRole("button", { name: "Suggest" }));
}

describe("AiTargets", () => {
  it("success: shows every muscle with its reason, lets the user tweak, saves only on accept", async () => {
    const g = goals({ focusMuscles: ["Chest"] });
    const fetchFn = mockFetch(() => json(okBody()));
    render(<AiTargets goals={g} split={PPL} loadWeeks={noWeeks} />);
    await suggest();

    const list = await screen.findByRole("list", { name: "Suggested weekly targets" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(MUSCLE_GROUPS.length);
    expect(screen.getByText("Focus muscle, so it gets extra sets.")).toBeInTheDocument();
    expect(screen.getByTestId("ai-target-Chest")).toHaveTextContent("15");

    // Request went to the route as JSON with the split.
    const [, init] = routeCalls(fetchFn)[0];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body)).split.name).toBe("Push Pull Legs");

    // Nothing is saved before Accept.
    expect(await db.meta.get("goals")).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "More suggested Chest sets" }));
    fireEvent.click(screen.getByRole("button", { name: "More suggested Chest sets" }));
    fireEvent.click(screen.getByRole("button", { name: "Fewer suggested Biceps sets" }));
    expect(screen.getByTestId("ai-target-Chest")).toHaveTextContent("17");
    expect(screen.getByTestId("ai-target-Biceps")).toHaveTextContent("9");

    fireEvent.click(screen.getByRole("button", { name: "Accept targets" }));
    expect(await screen.findByText("Targets saved.")).toBeInTheDocument();
    const saved = (await db.meta.get("goals"))!.value as Goals;
    expect(saved.targets.Chest).toBe(17);
    expect(saved.targets.Biceps).toBe(9);
    for (const m of MUSCLE_GROUPS) {
      const want = m === "Chest" ? 17 : m === "Biceps" ? 9 : 10;
      expect(saved.targets[m] ?? defaultTarget(m, g)).toBe(want);
    }
  });

  it("discard closes the review and saves nothing", async () => {
    mockFetch(() => json(okBody()));
    render(<AiTargets goals={goals()} split={null} loadWeeks={noWeeks} />);
    await suggest();
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suggest" })).toBeInTheDocument();
    expect(await db.meta.get("goals")).toBeUndefined();
  });

  it("503 unavailable: shows a short plain message and keeps the stored targets", async () => {
    await saveGoals({ targets: { Chest: 13 } });
    mockFetch(() => json({ unavailable: true }, 503));
    render(<AiTargets goals={goals({ targets: { Chest: 13 } })} split={PPL} loadWeeks={noWeeks} />);
    await suggest();
    expect(await screen.findByText(MSG_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(((await db.meta.get("goals"))!.value as Goals).targets).toEqual({ Chest: 13 });
  });

  it("failure: a 502, a malformed body or a network error show a short message", async () => {
    mockFetch(() => json({ error: "error" }, 502));
    const { unmount } = render(<AiTargets goals={goals()} split={null} loadWeeks={noWeeks} />);
    await suggest();
    expect(await screen.findByText(MSG_FAILED)).toBeInTheDocument();
    unmount();

    mockFetch(() => json({ targets: [{ muscle: "Wings", sets: 3 }] }));
    const r2 = render(<AiTargets goals={goals()} split={null} loadWeeks={noWeeks} />);
    await suggest();
    expect(await screen.findByText(MSG_FAILED)).toBeInTheDocument();
    r2.unmount();

    mockFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    render(<AiTargets goals={goals()} split={null} loadWeeks={noWeeks} />);
    await suggest();
    expect(await screen.findByText(MSG_FAILED)).toBeInTheDocument();
    expect(await db.meta.get("goals")).toBeUndefined();
  });

  it("offline: does not call the route and says so", async () => {
    setOnline(false);
    const fetchFn = mockFetch(() => json(okBody()));
    render(<AiTargets goals={goals()} split={null} loadWeeks={noWeeks} />);
    await suggest();
    expect(await screen.findByText(MSG_OFFLINE)).toBeInTheDocument();
    expect(routeCalls(fetchFn)).toHaveLength(0);
  });

  it("retries once without the split when the route rejects the request", async () => {
    const fetchFn = mockFetch((init) => (JSON.parse(String(init?.body)).split ? json({ error: "invalid_request" }, 400) : json(okBody())));
    render(<AiTargets goals={goals()} split={PPL} loadWeeks={noWeeks} />);
    await suggest();
    expect(await screen.findByRole("list", { name: "Suggested weekly targets" })).toBeInTheDocument();
    expect(routeCalls(fetchFn)).toHaveLength(2);
  });

  it("can try again after a failure", async () => {
    let n = 0;
    mockFetch(() => (n++ === 0 ? json({ unavailable: true }, 503) : json(okBody())));
    render(<AiTargets goals={goals()} split={null} loadWeeks={noWeeks} />);
    await suggest();
    await screen.findByText(MSG_UNAVAILABLE);
    await suggest();
    expect(await screen.findByRole("list", { name: "Suggested weekly targets" })).toBeInTheDocument();
  });

  it("uses no emoji characters", async () => {
    mockFetch(() => json(okBody()));
    const { container } = render(<AiTargets goals={goals()} split={null} loadWeeks={noWeeks} />);
    await suggest();
    await screen.findByRole("list");
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("GoalsSection with AiTargets", () => {
  it("keeps the existing controls and adds the Suggest weekly targets control", async () => {
    await saveSplit(PPL);
    const fetchFn = mockFetch(() => json({ unavailable: true }, 503));
    render(<GoalsSection />);
    expect(screen.getByText("What are you training for?")).toBeInTheDocument();
    expect(screen.getByText("Weekly set targets")).toBeInTheDocument();
    expect(screen.getByText("Suggest weekly targets")).toBeInTheDocument();
    // The split loads from the local store and is sent with the request.
    await waitFor(async () => expect((await db.meta.get("split"))?.value).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    await suggest();
    expect(await screen.findByText(MSG_UNAVAILABLE)).toBeInTheDocument();
    const body = JSON.parse(String(routeCalls(fetchFn)[0][1]?.body));
    expect(body.split?.name).toBe("Push Pull Legs");
    expect(body.recent_weeks).toHaveLength(4);
    // Existing rule-based editor still works.
    fireEvent.click(screen.getByRole("button", { name: /Weekly set targets/ }));
    expect(screen.getByRole("button", { name: "More Chest sets" })).toBeInTheDocument();
  });
});
