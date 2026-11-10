// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef } from "react";
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
function Harness({ onPr, closed = false }: { onPr: (name: string, prs: PrType[]) => void; closed?: boolean }) {
  const w = useLiveQuery(() => db.active.get("active"), []);
  const ex = w?.exercises[0];
  const box = useRef<HTMLDivElement>(null);
  // Cards start collapsed; open it once, as a tap on the title does, unless the test is about the closed card.
  const opened = useRef(false);
  useEffect(() => {
    const btn = box.current?.querySelector<HTMLButtonElement>("button[aria-expanded='false']");
    if (!closed && !opened.current && btn) {
      opened.current = true;
      btn.click();
    }
  });
  return <div ref={box}>{ex ? <ExerciseCard ex={ex} info={bench} onPr={onPr} /> : null}</div>;
}

function renderCard(closed = false) {
  const onPr = vi.fn();
  render(<Harness onPr={onPr} closed={closed} />);
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

describe("ExerciseCard: exercise detail link", () => {
  it("links the picture to the exercise page marked as coming from the workout", async () => {
    await seedActive([set("a")]);
    renderCard();
    await screen.findByText("First time — set a baseline");
    const link = document.querySelector('a[href^="/exercises/"]');
    expect(link).toHaveAttribute("href", expect.stringContaining("?from=workout"));
  });
});

describe("ExerciseCard: previous-set column", () => {
  it("shows a baseline hint and dashes when there is no history", async () => {
    await seedActive([set("a"), set("b")]);
    renderCard();
    expect(await screen.findByText("First time — set a baseline")).toBeInTheDocument();
    for (const r of rows()) expect(within(r).getByText("—")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Use suggestion/ })).toBeNull();
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

describe("ExerciseCard: collapse", () => {
  it("starts collapsed to the picture, name and sets done, until opened", async () => {
    await seedActive([set("a", { weight: 50, reps: 8, done: true }), set("b")]);
    renderCard(true);
    await screen.findByRole("heading", { name: "Bench Press" });
    expect(screen.getByRole("button", { name: "Expand Bench Press" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("1 of 2 sets done")).toHaveTextContent("1/2");
    expect(screen.queryByRole("button", { name: /^(Complete|Undo) set$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add set" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand Bench Press" }));
    expect(rows()).toHaveLength(2);
  });

  it("tapping the title folds the card to the picture and name, and again unfolds it", async () => {
    await seedActive([set("a"), set("b")]);
    renderCard();
    await screen.findByRole("heading", { name: "Bench Press" });
    expect(rows()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Bench Press" }));
    expect(screen.queryByRole("button", { name: /^(Complete|Undo) set$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add set" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Bench Press" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand Bench Press" }));
    expect(rows()).toHaveLength(2);
  });

  it("shows how many sets are done while folded, and updates as sets are ticked", async () => {
    await seedActive([set("a", { weight: 50, reps: 8, done: true }), set("b"), set("c")]);
    renderCard();
    await screen.findByRole("heading", { name: "Bench Press" });
    expect(screen.queryByLabelText(/sets done/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Bench Press" }));
    expect(screen.getByLabelText("1 of 3 sets done")).toHaveTextContent("1/3");
    fireEvent.click(screen.getByRole("button", { name: "Expand Bench Press" }));
    fireEvent.click(rows()[1].querySelector("button[aria-label='Complete set']") ?? screen.getAllByRole("button", { name: "Complete set" })[0]);
    await waitFor(async () => expect((await liveSets()).filter((s) => s.done)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Bench Press" }));
    expect(screen.getByLabelText("2 of 3 sets done")).toHaveTextContent("2/3");
  });

  it("keeps the entered values while folded", async () => {
    await seedActive([set("a", { reps: 8, weight: 50 })]);
    renderCard();
    await screen.findByRole("heading", { name: "Bench Press" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse Bench Press" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Bench Press" }));
    expect(screen.getByDisplayValue("8")).toBeInTheDocument();
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

  it("does not ask how the set felt by default", async () => {
    await seedActive([set("a", { weight: 60, reps: 10 })]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Complete set" }));
    await screen.findByRole("button", { name: "Undo set" });
    expect(screen.queryByText("How many more reps could you have done?")).toBeNull();
  });

  it("asks how the set felt and stores the rating when the preference is on", async () => {
    await saveSettings({ rirPrompt: true });
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
    expect(await screen.findByRole("button", { name: "Use suggestion: 3×8 @ 62.5kg" })).toHaveTextContent("Use");
    expect(screen.getByText("Suggestion")).toBeInTheDocument();
    // No explanation text under it.
    expect(screen.queryByText(/Hit 12 on every set/)).toBeNull();
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
    fireEvent.click(await screen.findByRole("button", { name: /Use suggestion: 3×8 @ 62.5kg/ }));
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
    expect(screen.queryByRole("button", { name: /Use suggestion/ })).toBeNull();
  });

  it("shows nothing when the Suggestions preference is off, but keeps the Last time line", async () => {
    await saveSettings({ suggestions: false });
    await seedHistory();
    await seedActive([set("a"), set("b"), set("c")]);
    renderCard();
    await screen.findByText("Last time: 3×12 @ 60kg");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: /Use suggestion/ })).toBeNull();
    expect(screen.queryByText("Suggestion")).toBeNull();
  });

  it("shows the suggestion again when the preference is turned back on", async () => {
    await saveSettings({ suggestions: false });
    await seedHistory();
    await seedActive([set("a"), set("b"), set("c")]);
    renderCard();
    await screen.findByText("Last time: 3×12 @ 60kg");
    await saveSettings({ suggestions: true });
    expect(await screen.findByRole("button", { name: "Use suggestion: 3×8 @ 62.5kg" })).toBeInTheDocument();
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

  it("hides the suggestion when the AI answer just repeats last session", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(200, { ...AI_BODY, suggestion: { sets: 3, reps: 12, weight: 60, reason: "Repeat.", source: "ai" } }),
    );
    await seedHistory();
    await seedActive([set("a"), set("b"), set("c")]);
    renderCard();
    await screen.findByText("Last time: 3×12 @ 60kg");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await settle();
    expect(screen.queryByRole("button", { name: /Use suggestion/ })).toBeNull();
    expect(screen.queryByText("Suggestion")).toBeNull();
  });

  it("shows the AI numbers as the single suggestion", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, AI_BODY));
    await seedHistory();
    await seedActive([set("a"), set("b"), set("c")]);
    renderCard();

    // One suggestion card, with the AI numbers and no explanation text.
    await screen.findByRole("button", { name: "Use suggestion: 3×8 @ 65kg" });
    expect(screen.getAllByText("Suggestion")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /62.5kg/ })).toBeNull();
    expect(screen.queryByText(/Steady progress over three sessions/)).toBeNull();

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

  it("tapping Use on the AI suggestion fills undone working sets with the AI numbers", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, AI_BODY));
    await seedHistory();
    await seedActive([set("done", { weight: 60, reps: 12, done: true, rir: 2 }), set("todo")]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /Use suggestion: 3×8 @ 65kg/ }));
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
    expect(await screen.findByRole("button", { name: /Use suggestion: 3×8 @ 62.5kg/ })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryByRole("button", { name: /65kg/ })).toBeNull();

    first.unmount();
    render(<Harness onPr={vi.fn()} />);
    await screen.findByRole("button", { name: /Use suggestion: 3×8 @ 62.5kg/ });
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
  ])("on %s the rule suggestion is the one shown", async (_label, make) => {
    fetchMock.mockImplementation(make);
    await seedHistory();
    await seedActive([set("a"), set("b")]);
    renderCard();
    await screen.findByRole("button", { name: "Use suggestion: 3×8 @ 62.5kg" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryByRole("button", { name: /65kg/ })).toBeNull();
  });

  it("does not ask while offline", async () => {
    const spy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      await seedHistory();
      await seedActive([set("a")]);
      renderCard();
      await screen.findByRole("button", { name: /Use suggestion: 3×8 @ 62.5kg/ });
      await settle();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /65kg/ })).toBeNull();
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

describe("ExerciseCard: swipe a set to delete it", () => {
  beforeEach(() => {
    // jsdom has no PointerEvent, so clientX would be dropped.
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
  });
  afterEach(() => vi.unstubAllGlobals());

  const swipeLeft = (row: HTMLElement, dx = -90) => {
    fireEvent.pointerDown(row, { clientX: 200, clientY: 10 });
    fireEvent.pointerMove(row, { clientX: 200 + dx, clientY: 10 });
    fireEvent.pointerUp(row, { clientX: 200 + dx, clientY: 10 });
  };

  it("has no - Set button any more", async () => {
    await seedActive([set("a"), set("b")]);
    renderCard();
    await screen.findAllByRole("button", { name: "Complete set" });
    expect(screen.queryByRole("button", { name: /− Set/ })).toBeNull();
  });

  it("swiping a row left and pressing Delete removes that set only", async () => {
    await seedActive([set("a"), set("b", { done: true }), set("c")]);
    renderCard();
    await screen.findAllByRole("button", { name: /set$/ });
    swipeLeft(rows()[1].parentElement as HTMLElement);
    const del = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(del);
    await waitFor(async () => expect((await liveSets()).map((s) => s.id)).toEqual(["a", "c"]));
  });

  it("a short drag snaps back and deletes nothing", async () => {
    await seedActive([set("a"), set("b")]);
    renderCard();
    await screen.findAllByRole("button", { name: "Complete set" });
    const wrap = rows()[0].parentElement as HTMLElement;
    swipeLeft(wrap, -20);
    expect(wrap.style.transform).toBe("translateX(0px)");
    expect((await liveSets()).length).toBe(2);
  });

  it("tapping an open row closes it without ticking the set", async () => {
    await seedActive([set("a"), set("b")]);
    renderCard();
    await screen.findAllByRole("button", { name: "Complete set" });
    const wrap = rows()[0].parentElement as HTMLElement;
    swipeLeft(wrap);
    expect(wrap.style.transform).toBe("translateX(-80px)");
    fireEvent.click(screen.getAllByRole("button", { name: "Complete set" })[0]);
    expect(wrap.style.transform).toBe("translateX(0px)");
    expect((await liveSets())[0].done).toBe(false);
  });
});

describe("ExerciseCard: options menu", () => {
  it("is closed at first and opens with Rest, Swap exercise and Remove exercise, no Move up or Move down", async () => {
    await seedActive([set("a")]);
    renderCard();
    await screen.findByText("Bench Press");
    expect(screen.queryByRole("button", { name: /Swap exercise/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    expect(screen.getByRole("combobox", { name: "Rest timer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Swap exercise/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove exercise" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move up/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move down/ })).not.toBeInTheDocument();
  });

  it("opens as a floating popover under the dots and shows the current rest time", async () => {
    await seedActive([set("a")]);
    renderCard();
    await screen.findByText("Bench Press");
    const dots = screen.getByRole("button", { name: "Options" });
    expect(dots).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(dots);
    expect(dots).toHaveAttribute("aria-expanded", "true");
    const popover = screen.getByRole("group", { name: "Exercise options" });
    expect(popover).toHaveClass("absolute", "right-0");
    expect(popover.parentElement).toBe(dots.parentElement);
    // The visible value plus the matching option in the hidden picker.
    expect(within(popover).getAllByText("1:30")).toHaveLength(2);
    expect(within(popover).getByRole("combobox", { name: "Rest timer" })).toHaveValue("90");
    expect(within(popover).getByRole("button", { name: "Remove exercise" })).toHaveClass("text-bad");
  });

  it("closes on Escape and on a tap outside, but not on a tap inside", async () => {
    await seedActive([set("a")]);
    renderCard();
    await screen.findByText("Bench Press");
    const dots = screen.getByRole("button", { name: "Options" });

    fireEvent.click(dots);
    fireEvent.pointerDown(screen.getByRole("group", { name: "Exercise options" }));
    expect(screen.getByRole("group", { name: "Exercise options" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Exercise options" })).not.toBeInTheDocument();

    fireEvent.click(dots);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group", { name: "Exercise options" })).not.toBeInTheDocument();
  });

  it("changing the rest timer saves it for the exercise and shows the new value", async () => {
    await seedActive([set("a")]);
    renderCard();
    await screen.findByText("Bench Press");
    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Rest timer" }), { target: { value: "120" } });
    const popover = screen.getByRole("group", { name: "Exercise options" });
    await waitFor(() => expect(within(popover).getByRole("combobox", { name: "Rest timer" })).toHaveValue("120"));
    await waitFor(() => expect(within(popover).getAllByText("2:00")).toHaveLength(2));
    const { getRestSec } = await import("@/lib/workout");
    expect(await getRestSec(EX_ID)).toBe(120);
  });

  it("Swap exercise closes the popover and opens the swap sheet", async () => {
    // The swap sheet loads the exercise catalogue; answer it with an empty list.
    const fetchStub = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      await seedActive([set("a")]);
      renderCard();
      await screen.findByText("Bench Press");
      fireEvent.click(screen.getByRole("button", { name: "Options" }));
      fireEvent.click(screen.getByRole("button", { name: /Swap exercise/ }));
      expect(screen.queryByRole("group", { name: "Exercise options" })).not.toBeInTheDocument();
      await waitFor(() => expect(fetchStub).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Remove exercise removes the card from the workout", async () => {
    await seedActive([set("a")]);
    renderCard();
    await screen.findByText("Bench Press");
    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove exercise" }));
    await waitFor(async () => expect((await db.active.get("active"))?.exercises ?? []).toHaveLength(0));
  });
});
