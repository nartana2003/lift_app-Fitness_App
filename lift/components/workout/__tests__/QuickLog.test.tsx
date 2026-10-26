// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import catalogueJson from "@/data/exercises.json";
import type { Exercise } from "@/lib/exercises";
import * as ai from "@/lib/ai/parse-log";
import {
  MAX_ALTERNATES,
  MAX_EXERCISES,
  MAX_REPS,
  MAX_SETS,
  MAX_TEXT,
  MAX_WEIGHT_KG,
  MSG_EMPTY,
  MSG_FAILED,
  MSG_OFFLINE,
  MSG_SAVE_FAILED,
  MSG_UNAVAILABLE,
  QuickLog,
  ROUTE,
  logToWorkout,
  parseQuickLog,
  setsSummary,
  toActiveExercises,
  type QuickLogSet,
} from "@/components/workout/QuickLog";

// ---------- helpers ----------

const NAMES: Record<string, string> = {
  bench: "Bench Press",
  incline: "Incline Dumbbell Press",
  curl: "Barbell Curl",
  row: "Barbell Row",
};
const nameOf = (id: string) => NAMES[id];
const known = (id: string) => id in NAMES;

const set = (reps: number, weight_kg: number | null = 60) => ({ reps, weight_kg });

function okBody() {
  return {
    exercises: [
      { name: "bench", exercise_id: "bench", confidence: "high", alternates: ["incline"], sets: [set(8), set(8), set(8)], source: "ai" },
      { name: "rows thing", exercise_id: null, confidence: "none", alternates: ["row", "curl"], sets: [set(10, 40)], source: "ai" },
    ],
    unit: "kg",
    adjusted: 0,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(route: (init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === ROUTE) return route(init);
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function setup(onLog = vi.fn(async () => true)) {
  render(<QuickLog unit="kg" nameOf={nameOf} onLog={onLog} />);
  fireEvent.click(screen.getByRole("button", { name: "Quick log" }));
  fireEvent.change(screen.getByLabelText("Quick log text"), { target: { value: "bench 3x8 at 60, rows 1x10 at 40" } });
  return onLog;
}

const preview = () => fireEvent.click(screen.getByRole("button", { name: "Preview" }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- pure helpers ----------

describe("constants", () => {
  it("match the route's caps in lib/ai/parse-log.ts", () => {
    expect(MAX_TEXT).toBe(ai.MAX_TEXT);
    expect(MAX_EXERCISES).toBe(ai.MAX_EXERCISES);
    expect(MAX_SETS).toBe(ai.MAX_SETS);
    expect(MAX_REPS).toBe(ai.MAX_REPS);
    expect(MAX_WEIGHT_KG).toBe(ai.MAX_WEIGHT_KG);
    expect(MAX_ALTERNATES).toBe(ai.MAX_ALTERNATES);
  });
});

describe("parseQuickLog", () => {
  it("keeps known ids, sets and alternates", () => {
    const items = parseQuickLog(okBody(), known)!;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ name: "bench", exercise_id: "bench", confidence: "high", alternates: ["incline"], sets: [set(8), set(8), set(8)] });
    expect(items[1]).toMatchObject({ exercise_id: null, confidence: "none", alternates: ["row", "curl"] });
  });

  it("returns null for an unusable shape", () => {
    expect(parseQuickLog(null, known)).toBeNull();
    expect(parseQuickLog({}, known)).toBeNull();
    expect(parseQuickLog({ exercises: "x" }, known)).toBeNull();
    expect(parseQuickLog([], known)).toBeNull();
  });

  it("drops unknown ids, makes them null and filters alternates", () => {
    const items = parseQuickLog(
      { exercises: [{ name: "x", exercise_id: "evil", confidence: "high", alternates: ["evil", "row", "row", 5], sets: [set(5)] }] },
      known,
    )!;
    expect(items[0]).toMatchObject({ exercise_id: null, confidence: "none", alternates: ["row"] });
  });

  it("caps alternates, sets and exercises", () => {
    const many = Array.from({ length: 30 }, () => ({ name: "b", exercise_id: "bench", alternates: ["incline", "curl", "row", "incline"], sets: Array.from({ length: 30 }, () => set(5)) }));
    const items = parseQuickLog({ exercises: many }, known)!;
    expect(items).toHaveLength(MAX_EXERCISES);
    expect(items[0].sets).toHaveLength(MAX_SETS);
    expect(items[0].alternates).toEqual(["incline", "curl", "row"]);
  });

  it("clamps reps and weights and drops unusable sets", () => {
    const items = parseQuickLog(
      {
        exercises: [
          {
            name: "bench",
            exercise_id: "bench",
            confidence: "high",
            alternates: [],
            sets: [{ reps: 500, weight_kg: 5000 }, { reps: 0, weight_kg: 10 }, { reps: "8" }, { reps: 7.6, weight_kg: -1 }, { reps: 5, weight_kg: Infinity }, "x"],
          },
        ],
      },
      known,
    )!;
    expect(items[0].sets).toEqual([{ reps: MAX_REPS, weight_kg: MAX_WEIGHT_KG }, { reps: 8, weight_kg: null }, { reps: 5, weight_kg: null }]);
  });

  it("drops exercises with no sets or no name and id; low confidence stays low", () => {
    const items = parseQuickLog(
      {
        exercises: [
          { name: "a", exercise_id: "bench", sets: [] },
          { name: 7, exercise_id: null, sets: [set(5)] },
          { name: "<b>\u0000", exercise_id: "curl", confidence: "weird", sets: [set(5)] },
          { name: null, exercise_id: "row", confidence: "high", sets: [set(5)] },
          "junk",
        ],
      },
      known,
    )!;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ name: "b", exercise_id: "curl", confidence: "low" });
    expect(items[1]).toMatchObject({ name: "Exercise", exercise_id: "row", confidence: "high" });
  });

  it("accepts the route's real rule-parse output", () => {
    const catalogue = catalogueJson as unknown as Exercise[];
    const ids = new Set(catalogue.map((e) => e.id));
    const checked = ai.validateInput({ text: "bench 3x8 at 60", unit: "kg" });
    if (!checked.ok) throw new Error("bad input");
    const result = ai.ruleParse(ai.buildContext(checked.input, catalogue));
    const items = parseQuickLog(JSON.parse(JSON.stringify(result)), (id) => ids.has(id))!;
    expect(items).toHaveLength(1);
    expect(items[0].sets).toEqual([set(8), set(8), set(8)]);
    expect(items[0].exercise_id === null || ids.has(items[0].exercise_id)).toBe(true);
  });
});

describe("setsSummary", () => {
  it("groups equal sets and shows the unit", () => {
    expect(setsSummary([set(8), set(8), set(6)], "kg")).toBe("2 x 8 @ 60kg, 1 x 6 @ 60kg");
    expect(setsSummary([set(10, null)], "kg")).toBe("1 x 10");
    expect(setsSummary([set(5, 100)], "lb")).toBe("1 x 5 @ 220.5lb");
  });
});

describe("toActiveExercises", () => {
  it("builds done sets in kg, bodyweight as 0", () => {
    let n = 0;
    const rows = toActiveExercises([{ exercise_id: "bench", sets: [set(8), set(10, null)] }], () => `id${n++}`);
    expect(rows).toEqual([
      {
        id: "id0",
        exercise_id: "bench",
        sets: [
          { id: "id1", reps: 8, weight: 60, is_warmup: false, rir: null, done: true },
          { id: "id2", reps: 10, weight: 0, is_warmup: false, rir: null, done: true },
        ],
      },
    ]);
  });
});

describe("logToWorkout", () => {
  beforeEach(async () => {
    await db.active.clear();
  });

  it("appends to the running workout and keeps what was there", async () => {
    await db.active.put({ key: "active", id: "w", started_at: new Date().toISOString(), routine_id: null, name: null, exercises: [{ id: "e0", exercise_id: "curl", sets: [] }] });
    const sets: QuickLogSet[] = [set(8)];
    expect(await logToWorkout([{ exercise_id: "bench", sets }])).toBe(true);
    const w = await db.active.get("active");
    expect(w!.exercises.map((e) => e.exercise_id)).toEqual(["curl", "bench"]);
    expect(w!.exercises[1].sets[0]).toMatchObject({ reps: 8, weight: 60, done: true });
  });

  it("returns false with no workout running", async () => {
    expect(await logToWorkout([{ exercise_id: "bench", sets: [set(8)] }])).toBe(false);
    expect(await db.active.get("active")).toBeUndefined();
  });
});

// ---------- component ----------

describe("QuickLog", () => {
  it("starts collapsed and makes no request until Preview", () => {
    const fetchFn = mockFetch(() => json(okBody()));
    render(<QuickLog unit="kg" nameOf={nameOf} onLog={vi.fn()} />);
    expect(screen.queryByLabelText("Quick log text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Quick log" }));
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("success: previews matched sets and only logs after confirmation", async () => {
    const fetchFn = mockFetch(() => json(okBody()));
    const onLog = setup();
    preview();

    const list = await screen.findByRole("list", { name: "Parsed sets" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const init = fetchFn.mock.calls[0][1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "bench 3x8 at 60, rows 1x10 at 40", unit: "kg" });

    expect(within(list).getByText("Bench Press")).toBeInTheDocument();
    expect(within(list).getByText("3 x 8 @ 60kg")).toBeInTheDocument();
    expect(within(list).getByText(/No match for "rows thing"/)).toBeInTheDocument();
    expect(onLog).not.toHaveBeenCalled();

    // Unmatched row: pick from the "Did you mean" list.
    fireEvent.change(within(list).getByLabelText("Exercise for rows thing"), { target: { value: "row" } });
    const logBtn = screen.getByRole("button", { name: "Log 2 exercises" });
    fireEvent.click(logBtn);

    await waitFor(() => expect(onLog).toHaveBeenCalledTimes(1));
    expect(onLog).toHaveBeenCalledWith([
      { exercise_id: "bench", sets: [set(8), set(8), set(8)] },
      { exercise_id: "row", sets: [set(10, 40)] },
    ]);
    await waitFor(() => expect(screen.queryByRole("list", { name: "Parsed sets" })).toBeNull());
  });

  it("success: unticking a row leaves it out; unmatched rows are not logged unless picked", async () => {
    mockFetch(() => json(okBody()));
    const onLog = setup();
    preview();
    await screen.findByRole("list", { name: "Parsed sets" });
    expect(screen.getByRole("button", { name: "Log 1 exercise" })).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Log Bench Press"));
    expect(screen.getByRole("button", { name: "Log 0 exercises" })).toBeDisabled();
    expect(onLog).not.toHaveBeenCalled();
  });

  it("503: plain unavailable message, nothing logged", async () => {
    mockFetch(() => json({ unavailable: true }, 503));
    const onLog = setup();
    preview();
    expect(await screen.findByText(MSG_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Parsed sets" })).toBeNull();
    expect(onLog).not.toHaveBeenCalled();
  });

  it("failure: error status, thrown fetch, bad body and empty result each show a message", async () => {
    mockFetch(() => json({ error: "error" }, 502));
    setup();
    preview();
    expect(await screen.findByText(MSG_FAILED)).toBeInTheDocument();

    mockFetch(() => {
      throw new TypeError("network");
    });
    preview();
    // The message is cleared on loading and set again.
    await waitFor(() => expect(screen.getByText(MSG_FAILED)).toBeInTheDocument());

    mockFetch(() => json({ nope: 1 }));
    preview();
    await waitFor(() => expect(screen.getByText(MSG_FAILED)).toBeInTheDocument());

    mockFetch(() => json({ exercises: [] }));
    preview();
    expect(await screen.findByText(MSG_EMPTY)).toBeInTheDocument();
  });

  it("offline: no request, offline message", async () => {
    const fetchFn = mockFetch(() => json(okBody()));
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    setup();
    preview();
    expect(await screen.findByText(MSG_OFFLINE)).toBeInTheDocument();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("save failure keeps the preview and shows a message", async () => {
    mockFetch(() => json(okBody()));
    setup(vi.fn(async () => false));
    preview();
    await screen.findByRole("list", { name: "Parsed sets" });
    fireEvent.click(screen.getByRole("button", { name: "Log 1 exercise" }));
    expect(await screen.findByText(MSG_SAVE_FAILED)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Parsed sets" })).toBeInTheDocument();
  });

  it("Cancel closes the box", () => {
    mockFetch(() => json(okBody()));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Quick log text")).toBeNull();
    expect(screen.getByRole("button", { name: "Quick log" })).toBeInTheDocument();
  });
});
