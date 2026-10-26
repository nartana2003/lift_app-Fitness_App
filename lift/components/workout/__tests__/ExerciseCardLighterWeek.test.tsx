// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type ActiveSet, type SetRow } from "@/lib/offline/db";
import type { Exercise } from "@/lib/exercises";
import { restTimer } from "@/lib/restTimer";
import { PLATEAU_APPLIED_KEY } from "@/lib/lighterWeek";
import { ExerciseCard, resetOverloadAi } from "@/components/workout/ExerciseCard";

const EX_ID = "bench";

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

const set = (id: string): ActiveSet => ({ id, reps: "", weight: "", is_warmup: false, rir: null, done: false });

async function seed() {
  await db.active.put({
    key: "active",
    id: "w-live",
    started_at: new Date().toISOString(),
    routine_id: null,
    name: null,
    exercises: [{ id: "card-1", exercise_id: EX_ID, sets: [set("a"), set("b"), set("c")], target_reps: "8-12" }],
  });
  await db.workouts.put({ id: "w-old", started_at: "2026-10-10T09:00:00.000Z", ended_at: "2026-10-10T10:00:00.000Z", notes: null, routine_id: null });
  await db.workout_exercises.put({ id: "we-old", workout_id: "w-old", exercise_id: EX_ID, position: 0 });
  const row = (n: number): SetRow => ({
    id: `s-old-${n}`,
    workout_exercise_id: "we-old",
    set_no: n,
    reps: 12,
    weight: 100,
    is_warmup: false,
    rir: null,
    completed_at: "2026-10-10T10:00:00.000Z",
  });
  await db.sets.bulkPut([row(1), row(2), row(3)]);
}

const lighter = (over: Record<string, unknown> = {}) => ({
  kind: "deload",
  headline: "Take a lighter week",
  applied_at: new Date(Date.now() - 864e5).toISOString(),
  until: new Date(Date.now() + 6 * 864e5).toISOString(),
  deload_percent: 60,
  deload_weight: 60,
  ...over,
});

function Harness() {
  const w = useLiveQuery(() => db.active.get("active"), []);
  const ex = w?.exercises[0];
  return ex ? <ExerciseCard ex={ex} info={bench} onPr={() => {}} /> : null;
}

const liveSets = async () => (await db.active.get("active"))!.exercises[0].sets;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  restTimer.stop();
  resetOverloadAi();
  vi.unstubAllGlobals();
  // The AI refinement is not part of this test; fail its request quietly.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
});

describe("ExerciseCard: plateau lighter week", () => {
  it("without a lighter week, Today's suggestion is the normal one", async () => {
    await seed();
    render(<Harness />);
    expect(await screen.findByText(/Today: 3×8 @ 102\.5kg/)).toBeInTheDocument();
    expect(screen.queryByText(/Lighter week/)).toBeNull();
  });

  it("a running lighter week makes Today's suggestion lighter, applied on tap", async () => {
    await seed();
    await db.meta.put({ key: PLATEAU_APPLIED_KEY, value: { [EX_ID]: lighter() } });
    render(<Harness />);
    expect(await screen.findByText(/Today: 3×8 @ 60kg/)).toBeInTheDocument();
    expect(screen.getByText("Lighter week: about 60% of your usual weight. Keep every set easy.")).toBeInTheDocument();
    // Opt-in: nothing changes until the user taps it.
    expect((await liveSets()).every((s) => s.weight === "")).toBe(true);
    fireEvent.click(screen.getByText(/Today: 3×8 @ 60kg/));
    await waitFor(async () => expect((await liveSets()).every((s) => s.weight === 60 && s.reps === 8)).toBe(true));
    // No AI refinement is asked for during a lighter week.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an ended lighter week, or one for another lift, changes nothing", async () => {
    await seed();
    await db.meta.put({
      key: PLATEAU_APPLIED_KEY,
      value: { [EX_ID]: lighter({ until: new Date(Date.now() - 864e5).toISOString() }), squat: lighter() },
    });
    render(<Harness />);
    expect(await screen.findByText(/Today: 3×8 @ 102\.5kg/)).toBeInTheDocument();
  });

  it("other plateau fixes do not make the suggestion lighter", async () => {
    await seed();
    await db.meta.put({ key: PLATEAU_APPLIED_KEY, value: { [EX_ID]: lighter({ kind: "extra_set" }) } });
    render(<Harness />);
    expect(await screen.findByText(/Today: 3×8 @ 102\.5kg/)).toBeInTheDocument();
  });
});
