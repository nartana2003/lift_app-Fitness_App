// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type ActiveSet, type SetRow } from "@/lib/offline/db";
import type { Exercise } from "@/lib/exercises";
import type { PrType } from "@/lib/prs";
import { restTimer } from "@/lib/restTimer";
import { saveSettings } from "@/lib/settings";
import {
  ExerciseCard,
  OVERLOAD_AI,
  buildOverloadRequest,
  parseOverloadResponse,
  resetOverloadAi,
} from "@/components/workout/ExerciseCard";
import type { ExerciseSession } from "@/lib/history";
import { dayKey } from "@/lib/planner";

const EX_ID = "bench";
const CARD_ID = "card-1";

const bench: Exercise = {
  id: EX_ID,
  name: "Bench Press",
  muscle_groups: ["Chest"],
  secondary_groups: [],
  equipment: "Barbell",
  category: "strength",
  mechanic: null,
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
};

const set = (id: string, over: Partial<ActiveSet> = {}): ActiveSet => ({
  id,
  reps: "",
  weight: "",
  is_warmup: false,
  rir: null,
  done: false,
  ...over,
});

async function seedActive(sets: ActiveSet[], target_reps = "8-12") {
  await db.active.put({
    key: "active",
    id: "w-live",
    started_at: "2026-10-16T09:00:00.000Z",
    routine_id: null,
    name: null,
    exercises: [{ id: CARD_ID, exercise_id: EX_ID, sets, target_reps }],
  });
}

/** Last session: a 40kg warm-up, then 3x12 @ 60kg. */
async function seedHistory() {
  await db.workouts.put({
    id: "w-old",
    started_at: "2026-10-10T09:00:00.000Z",
    ended_at: "2026-10-10T10:00:00.000Z",
    notes: null,
    routine_id: null,
  });
  await db.workout_exercises.put({ id: "we-old", workout_id: "w-old", exercise_id: EX_ID, position: 0 });
  const row = (n: number, weight: number, warm = false): SetRow => ({
    id: `s-old-${n}`,
    workout_exercise_id: "we-old",
    set_no: n,
    reps: 12,
    weight,
    is_warmup: warm,
    rir: null,
    completed_at: "2026-10-10T10:00:00.000Z",
  });
  await db.sets.bulkPut([row(1, 40, true), row(2, 60), row(3, 60), row(4, 60)]);
}

const liveSets = async () => (await db.active.get("active"))!.exercises[0].sets;

/** Re-renders the card from Dexie the way the workout page does. */
function Harness({ onPr }: { onPr: (name: string, prs: PrType[]) => void }) {
  const w = useLiveQuery(() => db.active.get("active"), []);
  const ex = w?.exercises[0];
  return ex ? <ExerciseCard ex={ex} info={bench} onPr={onPr} /> : null;
}

function renderCard() {
  const onPr = vi.fn();
  render(<Harness onPr={onPr} />);
  return onPr;
}

/** Set rows, in order, found via their tick button. */
const rows = () =>
  screen.getAllByRole("button", { name: /^(Complete|Undo) set$/ }).map((b) => b.parentElement as HTMLElement);

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  restTimer.stop();
});

describe("ExerciseCard: previous-set column", () => {
  it("shows a baseline hint and dashes when there is no history", async () => {
    await seedActive([set("a"), set("b")]);
    renderCard();
    expect(await screen.findByText("First time — set a baseline")).toBeInTheDocument();
    for (const r of rows()) expect(within(r).getByText("—")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Today:/ })).toBeNull();
  });

  it("shows last time's working sets per row, skipping last time's warm-up", async () => {
    await seedHistory();
    await seedActive([set("a"), set("b"), set("c"), set("d")]);
    renderCard();
    expect(await screen.findByText("Last time: 3×12 @ 60kg")).toBeInTheDocument();
    await waitFor(() => expect(within(rows()[0]).getByText("60×12")).toBeInTheDocument());
    const r = rows();
    expect(within(r[1]).getByText("60×12")).toBeInTheDocument();
    expect(within(r[2]).getByText("60×12")).toBeInTheDocument();
    // Only three working sets last time, so the fourth row has nothing to compare against.
    expect(within(r[3]).getByText("—")).toBeInTheDocument();
    // Previous values become the input placeholders.
    const [weight, reps] = within(r[0]).getAllByRole("textbox");
    expect(weight).toHaveAttribute("placeholder", "60");
    expect(reps).toHaveAttribute("placeholder", "12");
  });

  it("shows previous weights in the user's unit", async () => {
    await saveSettings({ unit: "lb" });
    await seedHistory();
    await seedActive([set("a")]);
    renderCard();
    expect(await screen.findByText("Last time: 3×12 @ 132.3lb")).toBeInTheDocument();
    expect(within(rows()[0]).getByText("132.3×12")).toBeInTheDocument();
  });
});

describe("ExerciseCard: logging a set", () => {
  it("entering weight and reps then ticking marks the set done and starts the rest timer", async () => {
    await seedActive([set("a"), set("b")]);
    const onPr = renderCard();
    await screen.findByText("Bench Press");

    const [weight, reps] = within(rows()[0]).getAllByRole("textbox");
    fireEvent.change(weight, { target: { value: "62.5" } });
    fireEvent.change(reps, { target: { value: "8" } });
    await waitFor(async () => expect((await liveSets())[0]).toMatchObject({ weight: 62.5, reps: 8 }));

    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Complete set" }));
    await waitFor(async () => expect((await liveSets())[0]).toMatchObject({ done: true, weight: 62.5, reps: 8 }));
    expect(await within(rows()[0]).findByRole("button", { name: "Undo set" })).toBeInTheDocument();
    expect(restTimer.get()).toMatchObject({ total: 90, label: "Rest · Bench Press" });
    // First time logging this exercise: no PR celebration.
    expect(onPr).not.toHaveBeenCalled();
    // The other set is untouched.
    expect((await liveSets())[1]).toMatchObject({ done: false, weight: "", reps: "" });
  });

  it("asks how the set felt and stores the rating", async () => {
    await seedActive([set("a", { weight: 60, reps: 10 })]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Complete set" }));
    expect(await screen.findByText("How many more reps could you have done?")).toBeInTheDocument();
    for (const n of [1, 2, 3, 4, 5]) expect(screen.getByRole("button", { name: `${n} more reps` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "2 more reps" }));
    await waitFor(async () => expect((await liveSets())[0].rir).toBe(2));
    await waitFor(() => expect(screen.queryByText("How many more reps could you have done?")).toBeNull());
  });

  it("undo un-ticks a done set", async () => {
    await seedActive([set("a", { weight: 60, reps: 10, done: true, rir: 2 })]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Undo set" }));
    await waitFor(async () => expect((await liveSets())[0].done).toBe(false));
    expect(await screen.findByRole("button", { name: "Complete set" })).toBeInTheDocument();
  });

  it("reports a PR when the set beats history", async () => {
    await seedHistory();
    await seedActive([set("a", { weight: 70, reps: 5 })]);
    const onPr = renderCard();
    await screen.findByText("Last time: 3×12 @ 60kg");
    fireEvent.click(screen.getByRole("button", { name: "Complete set" }));
    await waitFor(() => expect(onPr).toHaveBeenCalled());
    const [name, prs] = onPr.mock.calls[0] as [string, PrType[]];
    expect(name).toBe("Bench Press");
    expect(prs).toContain("weight");
  });

  it("+ Add set appends a set copying the last one", async () => {
    await seedActive([set("a", { weight: 50, reps: 10 })]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "+ Add set" }));
    await waitFor(async () => expect(await liveSets()).toHaveLength(2));
    expect((await liveSets())[1]).toMatchObject({ weight: 50, reps: 10, done: false, is_warmup: false });
    await waitFor(() => expect(rows()).toHaveLength(2));
  });
});

describe("ExerciseCard: warm-up toggle", () => {
  it("tapping the set number marks it a warm-up, renumbers working sets, and toggles back", async () => {
    await seedActive([set("a"), set("b"), set("c")]);
    renderCard();
    await screen.findByText("Bench Press");
    const numbers = () => rows().map((r) => within(r).getByTitle("Tap to toggle warm-up").textContent);
    expect(numbers()).toEqual(["1", "2", "3"]);

    fireEvent.click(within(rows()[0]).getByTitle("Tap to toggle warm-up"));
    await waitFor(() => expect(numbers()).toEqual(["W", "1", "2"]));
    expect((await liveSets()).map((s) => s.is_warmup)).toEqual([true, false, false]);

    fireEvent.click(within(rows()[0]).getByTitle("Tap to toggle warm-up"));
    await waitFor(() => expect(numbers()).toEqual(["1", "2", "3"]));
    expect((await liveSets())[0].is_warmup).toBe(false);
  });
});

describe("ExerciseCard: suggestion tap-to-apply", () => {
  it("shows today's suggestion from last time's sets", async () => {
    await seedHistory();
    await seedActive([set("a"), set("b"), set("c")]);
    renderCard();
    // 3x12 at the top of 8-12 on a barbell: add 2.5kg and drop to 8 reps.
    const sug = await screen.findByRole("button", { name: /Today: 3×8 @ 62.5kg/ });
    expect(sug).toHaveTextContent("tap to use");
    expect(sug).toHaveTextContent("Hit 12 on every set — go up to 62.5.");
  });

  it("tapping fills only undone working sets", async () => {
    await seedHistory();
    await seedActive([
      set("warm", { is_warmup: true, weight: 40, reps: 10 }),
      set("done", { weight: 60, reps: 12, done: true, rir: 2 }),
      set("todo1"),
      set("todo2", { weight: 55, reps: 6 }),
    ]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /Today: 3×8 @ 62.5kg/ }));
    await waitFor(async () => {
      const s = await liveSets();
      expect(s[2]).toMatchObject({ weight: 62.5, reps: 8 });
      expect(s[3]).toMatchObject({ weight: 62.5, reps: 8 });
    });
    const s = await liveSets();
    expect(s[0]).toMatchObject({ weight: 40, reps: 10, is_warmup: true });
    expect(s[1]).toMatchObject({ weight: 60, reps: 12, done: true });
    // The inputs reflect the applied values.
    await waitFor(() => {
      const [w, r] = within(rows()[2]).getAllByRole("textbox");
      expect(w).toHaveValue("62.5");
      expect(r).toHaveValue("8");
    });
  });

  it("hides the suggestion once every set is done", async () => {
    await seedHistory();
    await seedActive([set("a", { weight: 60, reps: 12, done: true, rir: 2 })]);
    renderCard();
    await screen.findByText("Last time: 3×12 @ 60kg");
    expect(screen.queryByRole("button", { name: /Today:/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UI-05: AI refinement line (POST /api/ai/overload-suggestion), mocked fetch.
// ---------------------------------------------------------------------------

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const AI_BODY = {
  exercise_id: EX_ID,
  suggestion: { sets: 3, reps: 8, weight: 65, reason: "Steady progress over three sessions allows a bigger jump.", source: "ai" },
  rule: { sets: 3, reps: 8, weight: 62.5, reason: "Hit 12 on every set — go up to 62.5." },
  adjusted: 0,
};

const session = (id: string, started_at: string, sets: Partial<SetRow>[]): ExerciseSession => ({
  workout: { id, started_at, ended_at: started_at, notes: null, routine_id: null },
  sets: sets.map((s, i) => ({
    id: `${id}-${i}`,
    workout_exercise_id: `we-${id}`,
    set_no: i + 1,
    reps: 10,
    weight: 60,
    is_warmup: false,
    rir: null,
    completed_at: started_at,
    ...s,
  })),
});

describe("ExerciseCard: AI refinement", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetOverloadAi();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("adds an AI line with a one-line reason under the unchanged rule suggestion", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, AI_BODY));
    await seedHistory();
    await seedActive([set("a"), set("b"), set("c")]);
    renderCard();

    const ai = await screen.findByRole("button", { name: /AI refined: 3×8 @ 65kg/ });
    expect(ai).toHaveTextContent("Steady progress over three sessions allows a bigger jump.");
    // Rule-based suggestion is still there, unchanged.
    const rule = screen.getByRole("button", { name: /Today: 3×8 @ 62.5kg/ });
    expect(rule).toHaveTextContent("Hit 12 on every set — go up to 62.5.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ai/overload-suggestion");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      exercise_id: EX_ID,
      equipment: "Barbell",
      rep_range: { min: 8, max: 12 },
      sessions: [
        {
          date: dayKey(new Date("2026-10-10T09:00:00.000Z")),
          sets: [
            { reps: 12, weight: 40, rir: null, is_warmup: true },
            { reps: 12, weight: 60, rir: null, is_warmup: false },
            { reps: 12, weight: 60, rir: null, is_warmup: false },
            { reps: 12, weight: 60, rir: null, is_warmup: false },
          ],
        },
      ],
    });
  });

  it("tapping the AI line fills undone working sets with the AI numbers", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, AI_BODY));
    await seedHistory();
    await seedActive([set("done", { weight: 60, reps: 12, done: true, rir: 2 }), set("todo")]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /AI refined:/ }));
    await waitFor(async () => expect((await liveSets())[1]).toMatchObject({ weight: 65, reps: 8 }));
    expect((await liveSets())[0]).toMatchObject({ weight: 60, reps: 12, done: true });
  });

  it("sends the user's goals when they are saved", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, AI_BODY));
    await db.meta.put({
      key: "goals",
      value: { goalType: "strength", experience: "advanced", sessionsPerWeek: 4, focusMuscles: ["Chest"], targets: {}, note: "x" },
    });
    await seedHistory();
    await seedActive([set("a")]);
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.goals).toEqual({ goalType: "strength", experience: "advanced", sessionsPerWeek: 4, focusMuscles: ["Chest"] });
  });

  it("on 503 unavailable shows only the rule suggestion and stops asking", async () => {
    fetchMock.mockResolvedValue(jsonRes(503, { unavailable: true }));
    await seedHistory();
    await seedActive([set("a"), set("b")]);
    const first = render(<Harness onPr={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Today: 3×8 @ 62.5kg/ })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryByRole("button", { name: /AI refined/ })).toBeNull();

    first.unmount();
    render(<Harness onPr={vi.fn()} />);
    await screen.findByRole("button", { name: /Today: 3×8 @ 62.5kg/ });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 502 error", () => jsonRes(502, { error: "error" })],
    ["a 429 rate limit", () => jsonRes(429, { error: "rate_limited" })],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["an unusable body", () => jsonRes(200, { nope: true })],
    ["a rule-only answer", () => jsonRes(200, { ...AI_BODY, suggestion: { ...AI_BODY.suggestion, source: "rule" } })],
    ["another exercise", () => jsonRes(200, { ...AI_BODY, exercise_id: "squat" })],
    ["out-of-range numbers", () => jsonRes(200, { ...AI_BODY, suggestion: { ...AI_BODY.suggestion, sets: 99 } })],
    ["invalid JSON", () => new Response("not json", { status: 200 })],
  ])("on %s the rule suggestion is unchanged and no AI line shows", async (_label, make) => {
    fetchMock.mockImplementation(make);
    await seedHistory();
    await seedActive([set("a"), set("b")]);
    renderCard();
    const rule = await screen.findByRole("button", { name: /Today: 3×8 @ 62.5kg/ });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryByRole("button", { name: /AI refined/ })).toBeNull();
    expect(rule).toHaveTextContent("Hit 12 on every set — go up to 62.5.");
  });

  it("does not ask while offline", async () => {
    const spy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      await seedHistory();
      await seedActive([set("a")]);
      renderCard();
      await screen.findByRole("button", { name: /Today: 3×8 @ 62.5kg/ });
      await settle();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /AI refined/ })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not ask without history or once every set is done", async () => {
    await seedActive([set("a")]);
    const first = render(<Harness onPr={vi.fn()} />);
    await screen.findByText("First time — set a baseline");
    await settle();
    first.unmount();

    await seedHistory();
    await seedActive([set("a", { weight: 60, reps: 12, done: true, rir: 2 })]);
    render(<Harness onPr={vi.fn()} />);
    await screen.findByText("Last time: 3×12 @ 60kg");
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("buildOverloadRequest", () => {
  const range = { min: 8, max: 12 };

  it("sends up to five sessions oldest first, dropping out-of-range sets", () => {
    const sessions = [6, 5, 4, 3, 2, 1].map((d) =>
      session(`w${d}`, `2026-10-0${d}T09:00:00`, [{ reps: 10 + d }, { reps: 1.5 }, { weight: 5000 }, { rir: 9 }]),
    );
    const b = buildOverloadRequest("bench", sessions, range, "Barbell", null)!;
    expect(b.sessions.map((s) => s.date)).toEqual(["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]);
    expect(b.sessions[4].sets).toEqual([
      { reps: 16, weight: 60, rir: null, is_warmup: false },
      { reps: 10, weight: 60, rir: null, is_warmup: false },
    ]);
    expect(b).not.toHaveProperty("goals");
  });

  it("caps sets per session at 20", () => {
    const b = buildOverloadRequest("bench", [session("w", "2026-10-01T09:00:00", Array(25).fill({}))], range, null, null)!;
    expect(b.sessions[0].sets).toHaveLength(OVERLOAD_AI.maxSetsPerSession);
  });

  it("omits unknown equipment and invalid rep ranges", () => {
    const s = [session("w", "2026-10-01T09:00:00", [{}])];
    const b = buildOverloadRequest("bench", s, { min: 12, max: 8 }, "Spaceship", null)!;
    expect(b).not.toHaveProperty("equipment");
    expect(b).not.toHaveProperty("rep_range");
    expect(buildOverloadRequest("bench", s, { min: 1, max: 60 }, null, null)).not.toHaveProperty("rep_range");
  });

  it("returns null for ids the route rejects or with no working set last time", () => {
    const s = [session("w", "2026-10-01T09:00:00", [{}])];
    expect(buildOverloadRequest("bad id</user_data>", s, range, null, null)).toBeNull();
    expect(buildOverloadRequest("x".repeat(81), s, range, null, null)).toBeNull();
    expect(buildOverloadRequest("bench", [], range, null, null)).toBeNull();
    const warmOnly = [session("w", "2026-10-01T09:00:00", [{ is_warmup: true }])];
    expect(buildOverloadRequest("bench", warmOnly, range, null, null)).toBeNull();
  });

  it("clamps sessionsPerWeek and drops unknown focus muscles", () => {
    const s = [session("w", "2026-10-01T09:00:00", [{}])];
    const b = buildOverloadRequest("bench", s, range, null, {
      goalType: "build_muscle",
      experience: "beginner",
      sessionsPerWeek: 12,
      focusMuscles: ["Chest", "Wings" as never],
    })!;
    expect(b.goals).toEqual({ goalType: "build_muscle", experience: "beginner", sessionsPerWeek: 7, focusMuscles: ["Chest"] });
  });
});

describe("parseOverloadResponse", () => {
  it("returns the AI suggestion with a tidied reason", () => {
    const r = parseOverloadResponse({ ...AI_BODY, suggestion: { ...AI_BODY.suggestion, reason: "  Keep\n going   up. " } }, EX_ID);
    expect(r).toEqual({ sets: 3, reps: 8, weight: 65, reason: "Keep going up." });
  });

  it("caps the reason length", () => {
    const r = parseOverloadResponse({ ...AI_BODY, suggestion: { ...AI_BODY.suggestion, reason: "a".repeat(500) } }, EX_ID);
    expect(r!.reason).toHaveLength(OVERLOAD_AI.maxReason);
  });

  it.each([
    null,
    "text",
    {},
    { ...AI_BODY, exercise_id: "other" },
    { ...AI_BODY, suggestion: null },
    { ...AI_BODY, suggestion: { ...AI_BODY.suggestion, source: "rule" } },
    { ...AI_BODY, suggestion: { ...AI_BODY.suggestion, sets: 0 } },
    { ...AI_BODY, suggestion: { ...AI_BODY.suggestion, reps: 8.5 } },
    { ...AI_BODY, suggestion: { ...AI_BODY.suggestion, weight: -1 } },
    { ...AI_BODY, suggestion: { ...AI_BODY.suggestion, weight: Infinity } },
    { ...AI_BODY, suggestion: { ...AI_BODY.suggestion, weight: "65" } },
    { ...AI_BODY, suggestion: { ...AI_BODY.suggestion, reason: "   " } },
    { ...AI_BODY, suggestion: { ...AI_BODY.suggestion, reason: 5 } },
  ])("rejects %j", (json) => {
    expect(parseOverloadResponse(json, EX_ID)).toBeNull();
  });
});
