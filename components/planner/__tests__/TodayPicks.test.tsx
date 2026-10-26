// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db, uuid } from "@/lib/offline/db";
import type { Exercise } from "@/lib/exercises";
import type { Equipment, MuscleGroup } from "@/lib/muscles";
import { saveSplit, type Split } from "@/lib/splits";
import { startWorkout } from "@/lib/workout";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push, back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const ex = (id: string, name: string, muscles: MuscleGroup[], mechanic: string | null = "isolation", equipment: Equipment = "Dumbbell"): Exercise => ({
  id,
  name,
  muscle_groups: muscles,
  secondary_groups: [],
  equipment,
  category: "strength",
  mechanic,
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
});

const CATALOGUE = [
  ex("zottman", "Zottman Curl", ["Biceps"]),
  ex("incline", "Incline Dumbbell Curl", ["Biceps"]),
  ex("hammer", "Hammer Curl", ["Biceps"]),
  ex("bench", "Bench Press", ["Chest"], "compound", "Barbell"),
  ex("fly", "Dumbbell Fly", ["Chest"]),
  ex("pushdown", "Triceps Pushdown", ["Triceps"], "isolation", "Machine/Cable"),
  ex("row", "Barbell Row", ["Back"], "compound", "Barbell"),
];

vi.mock("@/lib/catalogue", () => ({
  useCatalogue: () => ({
    loading: false,
    exercises: CATALOGUE,
    get: (id: string) => CATALOGUE.find((e) => e.id === id),
  }),
}));

import { TodayPicks, PER_MUSCLE_KEY, lastDoneLabel, normalizePerMuscle } from "@/components/planner/TodayPicks";

// "Today" is Wednesday 14 Oct 2026, noon.
const NOW = new Date(2026, 9, 14, 12, 0, 0);
const daysAgo = (n: number) => new Date(2026, 9, 14 - n, 10, 0, 0);

const ARMS: Split = { name: "Arms", days: [{ name: "Arms day", muscles: ["Biceps"] }] };
const PP: Split = {
  name: "Push / Pull",
  days: [
    { name: "Pull", muscles: ["Biceps"] },
    { name: "Push", muscles: ["Chest", "Triceps"] },
  ],
};

const star = (ids: string[]) => db.meta.put({ key: "favorites", value: ids });

/** A finished workout on `when` with one working set per exercise. */
async function logWorkout(when: Date, ids: string[]) {
  const id = uuid();
  const started = when.toISOString();
  await db.workouts.put({ id, started_at: started, ended_at: new Date(when.getTime() + 36e5).toISOString(), notes: null, routine_id: null });
  for (const [position, exercise_id] of ids.entries()) {
    const weId = uuid();
    await db.workout_exercises.put({ id: weId, workout_id: id, exercise_id, position });
    await db.sets.put({ id: uuid(), workout_exercise_id: weId, set_no: 1, reps: 10, weight: 20, is_warmup: false, rir: null, completed_at: started });
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  push.mockReset();
  await Promise.all(db.tables.map((t) => t.clear()));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function openCard() {
  render(<TodayPicks />);
  const header = await screen.findByRole("button", { name: /Today's exercises/ });
  fireEvent.click(header);
  return header;
}

/** Ids of exercises currently offered (one checkbox per slot). */
const shownNames = () => screen.queryAllByRole("checkbox").map((c) => c.getAttribute("aria-label"));

/** The user's example: Zottman last week, incline 10 days ago, hammer 3 days ago. */
async function seedBiceps() {
  await saveSplit(ARMS);
  await star(["zottman", "incline", "hammer"]);
  await logWorkout(daysAgo(10), ["incline"]);
  await logWorkout(daysAgo(7), ["zottman"]);
  await logWorkout(daysAgo(3), ["hammer"]);
}

describe("helpers", () => {
  it("lastDoneLabel", () => {
    expect(lastDoneLabel(null)).toBe("not done yet");
    expect(lastDoneLabel(0)).toBe("last done today");
    expect(lastDoneLabel(1)).toBe("last done 1 day ago");
    expect(lastDoneLabel(9)).toBe("last done 9 days ago");
  });

  it("normalizePerMuscle keeps 1 to 3 and defaults to 2", () => {
    expect([1, 2, 3].map(normalizePerMuscle)).toEqual([1, 2, 3]);
    for (const bad of [undefined, null, 0, 4, 1.5, "2", -1]) expect(normalizePerMuscle(bad)).toBe(2);
  });
});

describe("TodayPicks", () => {
  it("starts collapsed", async () => {
    await saveSplit(ARMS);
    render(<TodayPicks />);
    const header = await screen.findByRole("button", { name: /Today's exercises/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Start workout" })).toBeNull();
  });

  it("no split: offers the presets and saves the one picked", async () => {
    await openCard();
    expect(await screen.findByText(/Pick a split/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Build your own split in Profile" })).toHaveAttribute("href", "/profile");
    fireEvent.click(screen.getByRole("button", { name: "Use Push / Pull / Legs" }));
    await waitFor(async () => expect(((await db.meta.get("split"))?.value as Split).name).toBe("Push / Pull / Legs"));
    // The card now shows the first day (no history), with empty-pool links.
    expect(await screen.findByRole("link", { name: "Star some exercises for Chest to build your pool" })).toBeInTheDocument();
  });

  it("empty pool: a plain link to the Exercises screen for that muscle, nothing invented", async () => {
    await saveSplit(ARMS);
    await star(["bench"]); // a Chest favourite does not fill Biceps
    await openCard();
    const link = await screen.findByRole("link", { name: "Star some exercises for Biceps to build your pool" });
    expect(link).toHaveAttribute("href", "/exercises?m=Biceps");
    expect(shownNames()).toEqual([]);
    expect(screen.getByRole("button", { name: "Start workout" })).toBeDisabled();
  });

  it("suggests from the pool, longest ago first, never the last one done, with last-done text", async () => {
    await seedBiceps();
    await openCard();
    await screen.findByText("Incline Dumbbell Curl");
    // Default 2 per muscle: incline (10 days) and zottman (7 days); hammer was done last.
    expect(shownNames()).toEqual(["Incline Dumbbell Curl", "Zottman Curl"]);
    expect(screen.getByText("last done 10 days ago")).toBeInTheDocument();
    expect(screen.getByText("last done 7 days ago")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Biceps" })).toBeInTheDocument();
  });

  it("shows 'not done yet' for a never-done pick", async () => {
    await saveSplit(ARMS);
    await star(["hammer"]);
    await openCard();
    await screen.findByText("Hammer Curl");
    expect(screen.getByText("not done yet")).toBeInTheDocument();
  });

  it("how many per muscle: 1 to 3, remembered on the device", async () => {
    await seedBiceps();
    await openCard();
    await screen.findByText("Incline Dumbbell Curl");
    fireEvent.click(screen.getByRole("button", { name: "1 per muscle" }));
    await waitFor(() => expect(shownNames()).toEqual(["Incline Dumbbell Curl"]));
    expect(screen.getByRole("button", { name: "1 per muscle" })).toHaveAttribute("aria-pressed", "true");
    expect((await db.meta.get(PER_MUSCLE_KEY))?.value).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "3 per muscle" }));
    await waitFor(() => expect(shownNames()).toHaveLength(3));
    expect((await db.meta.get(PER_MUSCLE_KEY))?.value).toBe(3);
  });

  it("reads the saved per-muscle count", async () => {
    await seedBiceps();
    await db.meta.put({ key: PER_MUSCLE_KEY, value: 1 });
    await openCard();
    await waitFor(() => expect(shownNames()).toEqual(["Incline Dumbbell Curl"]));
  });

  it("swap: only other exercises from the same muscle's pool, and it replaces the pick", async () => {
    await seedBiceps();
    await db.meta.put({ key: PER_MUSCLE_KEY, value: 1 });
    await openCard();
    await waitFor(() => expect(shownNames()).toEqual(["Incline Dumbbell Curl"]));
    fireEvent.click(screen.getByRole("button", { name: "Swap Incline Dumbbell Curl" }));
    const list = screen.getByRole("list", { name: "Other Biceps exercises" });
    const options = within(list).getAllByRole("button").map((b) => b.firstChild?.textContent);
    expect(options).toEqual(["Zottman Curl", "Hammer Curl"]);
    expect(within(list).queryByText("Barbell Row")).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: /Hammer Curl/ }));
    expect(shownNames()).toEqual(["Hammer Curl"]);
    expect(screen.getByText("last done 3 days ago")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Other Biceps exercises" })).toBeNull();
  });

  it("swap is disabled when the pool has nothing else", async () => {
    await saveSplit(ARMS);
    await star(["hammer"]);
    await openCard();
    await screen.findByText("Hammer Curl");
    expect(screen.getByRole("button", { name: "Swap Hammer Curl" })).toBeDisabled();
  });

  it("the split day picker changes the day", async () => {
    await saveSplit(PP);
    await star(["hammer", "bench", "pushdown"]);
    await openCard();
    await screen.findByText("Hammer Curl");
    expect(screen.getByText("Next in your split.")).toBeInTheDocument();
    const picker = screen.getByRole("combobox", { name: "Split day" });
    expect(picker).toHaveValue("0");
    fireEvent.change(picker, { target: { value: "1" } });
    await screen.findByText("Bench Press");
    expect(shownNames()).toEqual(["Bench Press", "Triceps Pushdown"]);
    expect(screen.queryByText("Next in your split.")).toBeNull();
  });

  it("follows nextSplitDay: after a Pull session it offers Push", async () => {
    await saveSplit(PP);
    await star(["hammer", "bench", "pushdown"]);
    await logWorkout(daysAgo(1), ["hammer"]);
    await openCard();
    await screen.findByText("Bench Press");
    expect(screen.getByRole("combobox", { name: "Split day" })).toHaveValue("1");
  });

  it("untick then start: starts a workout from the ticked picks only, saves no routine", async () => {
    await seedBiceps();
    await openCard();
    await screen.findByText("Incline Dumbbell Curl");
    fireEvent.click(screen.getByRole("checkbox", { name: "Zottman Curl" }));
    expect(screen.getByRole("checkbox", { name: "Zottman Curl" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Start workout" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workout"));
    const active = await db.active.get("active");
    expect(active?.name).toBe("Arms day");
    expect(active?.exercises.map((e) => e.exercise_id)).toEqual(["incline"]);
    expect(await db.routines.count()).toBe(0);
  });

  it("start is disabled when every pick is unticked", async () => {
    await saveSplit(ARMS);
    await star(["hammer"]);
    await openCard();
    await screen.findByText("Hammer Curl");
    fireEvent.click(screen.getByRole("checkbox", { name: "Hammer Curl" }));
    expect(screen.getByRole("button", { name: "Start workout" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save as routine" })).toBeDisabled();
  });

  it("a running workout: asks first, and keeps it when the user says no", async () => {
    await seedBiceps();
    const running = await startWorkout({ name: "Running", exercises: [{ exercise_id: "row" }] });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openCard();
    await screen.findByText("Incline Dumbbell Curl");
    fireEvent.click(screen.getByRole("button", { name: "Start workout" }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toMatch(/already have a workout in progress/);
    expect(push).not.toHaveBeenCalled();
    expect((await db.active.get("active"))?.id).toBe(running.id);
  });

  it("a running workout: replaces it when the user agrees", async () => {
    await seedBiceps();
    const running = await startWorkout({ name: "Running", exercises: [{ exercise_id: "row" }] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await openCard();
    await screen.findByText("Incline Dumbbell Curl");
    fireEvent.click(screen.getByRole("button", { name: "Start workout" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workout"));
    const active = await db.active.get("active");
    expect(active?.id).not.toBe(running.id);
    expect(active?.exercises.map((e) => e.exercise_id)).toEqual(["incline", "zottman"]);
  });

  it("Save as routine uses createRoutine with the ticked picks", async () => {
    await seedBiceps();
    await openCard();
    await screen.findByText("Incline Dumbbell Curl");
    fireEvent.click(screen.getByRole("button", { name: "Save as routine" }));
    expect(await screen.findByText('Saved as routine "Arms day".')).toBeInTheDocument();
    const routines = await db.routines.toArray();
    expect(routines.map((r) => r.name)).toEqual(["Arms day"]);
    const rows = (await db.routine_exercises.toArray()).sort((a, b) => a.position - b.position);
    expect(rows.map((r) => r.exercise_id)).toEqual(["incline", "zottman"]);
    expect(push).not.toHaveBeenCalled();
  });

  it("honours the saved equipment", async () => {
    await saveSplit(PP);
    await db.meta.put({ key: "equipment", value: ["Dumbbell"] });
    await star(["bench", "fly", "pushdown"]);
    await openCard();
    fireEvent.change(await screen.findByRole("combobox", { name: "Split day" }), { target: { value: "1" } });
    await screen.findByText("Dumbbell Fly");
    expect(screen.queryByText("Bench Press")).toBeNull();
    expect(screen.getByRole("link", { name: "Star some exercises for Triceps to build your pool" })).toBeInTheDocument();
  });
});

// ---------- LINK-03: Use my routine for a day with linked routines ----------

import { createRoutine } from "@/lib/routines";

async function armsDayId() {
  await saveSplit(ARMS);
  return ((await db.meta.get("split"))!.value as Split).days[0].id!;
}

/** A finished workout done from a routine. */
async function doneFromRoutine(when: Date, routineId: string) {
  await db.workouts.put({ id: uuid(), started_at: when.toISOString(), ended_at: when.toISOString(), notes: null, routine_id: routineId });
}

describe("TodayPicks LINK-03 linked routines", () => {
  it("no linked routine: no Use my routine offer", async () => {
    await armsDayId();
    await star(["hammer"]);
    await createRoutine({ name: "Loose", exercises: [{ exercise_id: "row" }] });
    await openCard();
    await screen.findByText("Hammer Curl");
    expect(screen.queryByRole("button", { name: /^Use my routine/ })).toBeNull();
  });

  it("offers the linked routine as an alternative; the pool picks stay the default", async () => {
    const day = await armsDayId();
    await star(["hammer"]);
    await createRoutine({ name: "Arm blast", exercises: [{ exercise_id: "zottman", target_sets: 4, target_reps: "10" }], split_day_id: day });
    await openCard();
    expect(await screen.findByRole("button", { name: "Use my routine: Arm blast" })).toBeInTheDocument();
    // Pool picks still shown and still what Start workout uses.
    expect(shownNames()).toEqual(["Hammer Curl"]);
    fireEvent.click(screen.getByRole("button", { name: "Start workout" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workout"));
    const active = await db.active.get("active");
    expect(active?.exercises.map((e) => e.exercise_id)).toEqual(["hammer"]);
    expect(active?.routine_id ?? null).toBeNull();
  });

  it("Use my routine starts that routine with its targets", async () => {
    const day = await armsDayId();
    await star(["hammer"]);
    const id = await createRoutine({ name: "Arm blast", exercises: [{ exercise_id: "zottman", target_sets: 4, target_reps: "10" }], split_day_id: day });
    await openCard();
    fireEvent.click(await screen.findByRole("button", { name: "Use my routine: Arm blast" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workout"));
    const active = await db.active.get("active");
    expect(active?.name).toBe("Arm blast");
    expect(active?.routine_id).toBe(id);
    // Target sets become set rows; the rep target is kept.
    expect(active?.exercises.map((e) => [e.exercise_id, e.sets.length, e.target_reps])).toEqual([["zottman", 4, "10"]]);
  });

  it("with several linked routines offers the one done longest ago, never a mini", async () => {
    const day = await armsDayId();
    await star(["hammer"]);
    const a = await createRoutine({ name: "Arms A", exercises: [{ exercise_id: "zottman" }], split_day_id: day });
    const b = await createRoutine({ name: "Arms B", exercises: [{ exercise_id: "incline" }], split_day_id: day });
    await createRoutine({ name: "Arms mini", kind: "mini", exercises: [{ exercise_id: "hammer" }], split_day_id: day });
    await doneFromRoutine(daysAgo(2), a);
    await doneFromRoutine(daysAgo(9), b);
    await openCard();
    expect(await screen.findByRole("button", { name: "Use my routine: Arms B" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use my routine: Arms A" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use my routine: Arms mini" })).toBeNull();
  });

  it("follows the picked split day", async () => {
    await saveSplit(PP);
    const [pull, pushDay] = ((await db.meta.get("split"))!.value as Split).days.map((d) => d.id!);
    await star(["hammer", "bench"]);
    await createRoutine({ name: "Pull routine", exercises: [{ exercise_id: "row" }], split_day_id: pull });
    await createRoutine({ name: "Push routine", exercises: [{ exercise_id: "bench" }], split_day_id: pushDay });
    await openCard();
    expect(await screen.findByRole("button", { name: "Use my routine: Pull routine" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Split day" }), { target: { value: "1" } });
    expect(await screen.findByRole("button", { name: "Use my routine: Push routine" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use my routine: Pull routine" })).toBeNull();
  });

  it("asks before replacing a running workout and keeps it on no", async () => {
    const day = await armsDayId();
    await createRoutine({ name: "Arm blast", exercises: [{ exercise_id: "zottman" }], split_day_id: day });
    const running = await startWorkout({ name: "Running", exercises: [{ exercise_id: "row" }] });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openCard();
    fireEvent.click(await screen.findByRole("button", { name: "Use my routine: Arm blast" }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(push).not.toHaveBeenCalled();
    expect((await db.active.get("active"))?.id).toBe(running.id);
  });
});
