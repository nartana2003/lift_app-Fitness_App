import { beforeEach, describe, expect, it, vi } from "vitest";
import { bestsFromHistory, emptyBests, prsForNewSets, type SetLike } from "../prs";
import { db, type ActiveSet, type ActiveWorkout, type SetRow } from "../offline/db";
import { finishWorkout } from "../workout";
import { logToWorkout, markQuickLogPrs, rowPrs, toActiveExercises } from "../../components/workout/QuickLog";

const s = (reps: number, weight: number, is_warmup = false): SetLike => ({ reps, weight, is_warmup });
/** History: one session of 3x10 @ 60. */
const HIST = () => bestsFromHistory([[s(10, 60), s(10, 60), s(10, 60)]]);

describe("prsForNewSets", () => {
  it("gives one entry per set and nothing for a set that beats nothing", () => {
    expect(prsForNewSets([s(8, 50), s(10, 60)], HIST(), true)).toEqual([[], []]);
  });

  it("flags weight, e1rm and reps PRs like a hand tick", () => {
    expect(prsForNewSets([s(5, 70)], HIST(), true)).toEqual([["weight", "e1rm"]]);
    expect(prsForNewSets([s(12, 60)], HIST(), true)).toEqual([["reps", "e1rm"]]);
  });

  it("checks each set against the sets before it", () => {
    // The second 70 is not a new weight PR once the first counted.
    expect(prsForNewSets([s(5, 70), s(5, 70), s(6, 70)], HIST(), true)).toEqual([["weight", "e1rm"], [], ["reps", "e1rm"]]);
  });

  it("gives the volume PR once, to the set that crosses the best session", () => {
    const out = prsForNewSets([s(10, 60), s(10, 60), s(10, 60), s(10, 60)], HIST(), true);
    expect(out).toEqual([[], [], [], ["volume"]]);
    expect(prsForNewSets([...Array(6)].map(() => s(10, 60)), HIST(), true).flat().filter((p) => p === "volume")).toHaveLength(1);
  });

  it("no celebration the first time an exercise is logged", () => {
    expect(prsForNewSets([s(5, 100), s(5, 120)], emptyBests(), false)).toEqual([[], []]);
  });

  it("skips warm-ups, zero reps and bodyweight sets", () => {
    expect(prsForNewSets([s(10, 100, true), s(0, 100), s(20, 0)], HIST(), true)).toEqual([[], [], []]);
  });

  it("does not mutate the bests passed in", () => {
    const b = HIST();
    const copy = JSON.parse(JSON.stringify(b));
    prsForNewSets([s(5, 80)], b, true);
    expect(b).toEqual(copy);
  });
});

// ---------- quick log against the local store ----------

const active = (exercises: ActiveWorkout["exercises"] = []): ActiveWorkout => ({
  key: "active",
  id: "w-live",
  started_at: new Date().toISOString(),
  routine_id: null,
  name: null,
  exercises,
});

const doneSet = (id: string, reps: number, weight: number): ActiveSet => ({ id, reps, weight, is_warmup: false, rir: null, done: true });

async function seedHistory(exerciseId = "bench") {
  await db.workouts.put({ id: "w-old", started_at: "2026-10-10T09:00:00.000Z", ended_at: "2026-10-10T10:00:00.000Z", notes: null, routine_id: null });
  await db.workout_exercises.put({ id: "we-old", workout_id: "w-old", exercise_id: exerciseId, position: 0 });
  const row = (n: number): SetRow => ({
    id: `s-old-${n}`,
    workout_exercise_id: "we-old",
    set_no: n,
    reps: 10,
    weight: 60,
    is_warmup: false,
    rir: null,
    completed_at: "2026-10-10T10:00:00.000Z",
  });
  await db.sets.bulkPut([row(1), row(2), row(3)]);
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("markQuickLogPrs", () => {
  it("marks PR sets and leaves the others without a pr key", async () => {
    await seedHistory();
    const rows = toActiveExercises([{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 70 }, { reps: 8, weight_kg: 50 }] }]);
    const out = await markQuickLogPrs(rows, active());
    expect(out[0].sets[0].pr).toEqual(["weight", "e1rm"]);
    expect(out[0].sets[1]).not.toHaveProperty("pr");
    expect(rows[0].sets[0]).not.toHaveProperty("pr"); // input untouched
  });

  it("counts done sets of the same lift already in this workout", async () => {
    await seedHistory();
    const w = active([{ id: "card", exercise_id: "bench", sets: [doneSet("x", 5, 70), { ...doneSet("y", 5, 90), done: false }] }]);
    const out = await markQuickLogPrs(toActiveExercises([{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 70 }] }]), w);
    expect(out[0].sets[0]).not.toHaveProperty("pr");
  });

  it("counts an earlier item for the same lift in the same quick log", async () => {
    await seedHistory();
    const rows = toActiveExercises([
      { exercise_id: "bench", sets: [{ reps: 5, weight_kg: 70 }] },
      { exercise_id: "bench", sets: [{ reps: 5, weight_kg: 70 }] },
    ]);
    const out = await markQuickLogPrs(rows, active());
    expect(out[0].sets[0].pr).toEqual(["weight", "e1rm"]);
    expect(out[1].sets[0]).not.toHaveProperty("pr");
  });

  it("no PRs for a lift with no history", async () => {
    const out = await markQuickLogPrs(toActiveExercises([{ exercise_id: "squat", sets: [{ reps: 5, weight_kg: 140 }] }]), active());
    expect(out[0].sets[0]).not.toHaveProperty("pr");
  });

  it("uses the injected bests and excludes the running workout", async () => {
    const bestsOf = vi.fn(async () => HIST());
    await markQuickLogPrs(toActiveExercises([{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 70 }] }]), active(), bestsOf);
    expect(bestsOf).toHaveBeenCalledWith("bench", "w-live");
  });
});

describe("rowPrs", () => {
  it("lists each PR type once, in label order", () => {
    const [row] = toActiveExercises([{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 70 }, { reps: 5, weight_kg: 70 }] }]);
    row.sets[0].pr = ["e1rm", "weight"];
    row.sets[1].pr = ["volume", "e1rm"];
    expect(rowPrs(row)).toEqual(["weight", "e1rm", "volume"]);
    expect(rowPrs({ ...row, sets: [] })).toEqual([]);
  });
});

describe("logToWorkout PRs", () => {
  it("saves the PR marks, calls onPr per lift, and finishWorkout records them", async () => {
    await seedHistory();
    await db.active.put(active());
    const onPr = vi.fn();
    const ok = await logToWorkout(
      [
        { exercise_id: "bench", sets: [{ reps: 5, weight_kg: 70 }] },
        { exercise_id: "curl", sets: [{ reps: 12, weight_kg: 12 }] },
      ],
      onPr,
    );
    expect(ok).toBe(true);
    const w = (await db.active.get("active"))!;
    expect(w.exercises[0].sets[0]).toMatchObject({ done: true, pr: ["weight", "e1rm"] });
    expect(onPr).toHaveBeenCalledTimes(1);
    expect(onPr).toHaveBeenCalledWith("bench", ["weight", "e1rm"]);

    await finishWorkout();
    const queued = (await db.outbox.toArray()).filter((o) => o.table === "personal_records").map((o) => o.row as { type: string; exercise_id: string });
    expect(queued.map((r) => [r.exercise_id, r.type]).sort()).toEqual([["bench", "e1rm"], ["bench", "weight"]]);
  });

  it("still returns false with no workout running and calls no onPr", async () => {
    const onPr = vi.fn();
    expect(await logToWorkout([{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 70 }] }], onPr)).toBe(false);
    expect(onPr).not.toHaveBeenCalled();
  });

  it("works without onPr (existing callers)", async () => {
    await seedHistory();
    await db.active.put(active());
    expect(await logToWorkout([{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 70 }] }])).toBe(true);
    expect((await db.active.get("active"))!.exercises[0].sets[0].pr).toEqual(["weight", "e1rm"]);
  });
});
