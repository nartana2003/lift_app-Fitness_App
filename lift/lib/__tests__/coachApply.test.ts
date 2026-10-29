import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import { createRoutine, getRoutine, listRoutines } from "../routines";
import { saveSplit, type Split } from "../splits";
import { applyChanges, hasOptimiseUndo, undoOptimise, UNDO_KEY } from "../coachApply";
import type { Change } from "../coachOptimise";

const splitMeta = async () => (await db.meta.get("split"))?.value as Split | undefined;
const shape = async (id: string) => (await getRoutine(id))!.exercises.map((e) => [e.exercise_id, e.target_sets, e.target_reps, e.position]);

const base = { routineId: null, exerciseId: null, replaceExerciseId: null, sets: null, reps: null, why: "why", evidenceIds: [] } as const;
const change = (c: Partial<Change> & Pick<Change, "id" | "kind">): Change => ({ muscle: "Biceps", dayId: "pull", ...base, ...c }) as Change;

let pull: string;
let push: string;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await saveSplit({
    name: "S",
    days: [
      { id: "push", name: "Push", muscles: ["Chest"] },
      { id: "pull", name: "Pull", muscles: ["Lats"] },
    ],
  });
  pull = await createRoutine({ name: "Pull", split_day_id: "pull", exercises: [{ exercise_id: "Close-Grip_Front_Lat_Pulldown", target_sets: 3, target_reps: "8-12" }, { exercise_id: "Barbell_Curl", target_sets: 3, target_reps: "10" }] });
  push = await createRoutine({ name: "Push", split_day_id: "push", exercises: [{ exercise_id: "Barbell_Bench_Press_-_Medium_Grip", target_sets: 3, target_reps: "8-12" }] });
});

describe("applyChanges", () => {
  it("adds an exercise to the end of its routine with the given sets and reps", async () => {
    const r = await applyChanges([change({ id: "a", kind: "add_exercise", routineId: pull, exerciseId: "Incline_Dumbbell_Curl", sets: 3, reps: "8-12" })]);
    expect(r).toEqual({ applied: ["a"], skipped: [] });
    expect(await shape(pull)).toEqual([
      ["Close-Grip_Front_Lat_Pulldown", 3, "8-12", 0],
      ["Barbell_Curl", 3, "10", 1],
      ["Incline_Dumbbell_Curl", 3, "8-12", 2],
    ]);
  });

  it("swaps an exercise in place and keeps its sets and reps", async () => {
    await applyChanges([change({ id: "s", kind: "swap_exercise", routineId: pull, replaceExerciseId: "Barbell_Curl", exerciseId: "Cable_Preacher_Curl" })]);
    expect(await shape(pull)).toEqual([
      ["Close-Grip_Front_Lat_Pulldown", 3, "8-12", 0],
      ["Cable_Preacher_Curl", 3, "10", 1],
    ]);
  });

  it("raises the sets of an exercise", async () => {
    await applyChanges([change({ id: "m", kind: "more_sets", routineId: pull, exerciseId: "Barbell_Curl", sets: 4 })]);
    expect((await shape(pull))[1]).toEqual(["Barbell_Curl", 4, "10", 1]);
  });

  it("adds a muscle to a split day, keeping every day id and routine link", async () => {
    await applyChanges([change({ id: "d", kind: "add_muscle", dayId: "pull", muscle: "Biceps" })]);
    const s = (await splitMeta())!;
    expect(s.days.map((d) => d.id)).toEqual(["push", "pull"]);
    expect(s.days[1].muscles).toEqual(["Lats", "Biceps"]);
    const linked = (await listRoutines()).map((r) => [r.name, r.split_day_id]).sort();
    expect(linked).toEqual([["Pull", "pull"], ["Push", "push"]]);
  });

  it("only touches the routines named in the changes", async () => {
    const before = await shape(push);
    await applyChanges([change({ id: "a", kind: "add_exercise", routineId: pull, exerciseId: "Hammer_Curls", sets: 3, reps: "8-12" })]);
    expect(await shape(push)).toEqual(before);
  });

  it("skips a change that no longer fits and applies the rest", async () => {
    const r = await applyChanges([
      change({ id: "gone", kind: "add_exercise", routineId: "missing", exerciseId: "Hammer_Curls", sets: 3, reps: "8-12" }),
      change({ id: "dup", kind: "add_exercise", routineId: pull, exerciseId: "Barbell_Curl", sets: 3, reps: "8-12" }),
      change({ id: "nodonor", kind: "swap_exercise", routineId: pull, replaceExerciseId: "Not_There", exerciseId: "Hammer_Curls" }),
      change({ id: "lower", kind: "more_sets", routineId: pull, exerciseId: "Barbell_Curl", sets: 2 }),
      change({ id: "noday", kind: "add_muscle", dayId: "nope", muscle: "Biceps" }),
      change({ id: "ok", kind: "add_exercise", routineId: pull, exerciseId: "Hammer_Curls", sets: 3, reps: "8-12" }),
    ]);
    expect(r.applied).toEqual(["ok"]);
    expect(r.skipped.sort()).toEqual(["dup", "gone", "lower", "noday", "nodonor"]);
  });

  it("changes nothing and leaves no undo when nothing applies", async () => {
    const r = await applyChanges([change({ id: "gone", kind: "add_exercise", routineId: "missing", exerciseId: "Hammer_Curls", sets: 3, reps: "8-12" })], { builtFor: "fp" });
    expect(r.applied).toEqual([]);
    expect(await hasOptimiseUndo()).toBe(false);
    expect((await splitMeta())?.builtFor).toBeUndefined();
  });

  it("stamps builtFor on the split only when something was applied", async () => {
    await applyChanges([change({ id: "a", kind: "add_exercise", routineId: pull, exerciseId: "Hammer_Curls", sets: 3, reps: "8-12" })], { builtFor: "fp-1" });
    expect((await splitMeta())?.builtFor).toBe("fp-1");
  });

  it("never touches past workouts", async () => {
    await db.workouts.put({ id: "w1", started_at: "2026-10-01T10:00:00.000Z", ended_at: "2026-10-01T11:00:00.000Z", notes: null, routine_id: pull });
    await db.workout_exercises.put({ id: "we1", workout_id: "w1", exercise_id: "Barbell_Curl", position: 0 });
    await db.sets.put({ id: "s1", workout_exercise_id: "we1", set_no: 1, reps: 10, weight: 30, is_warmup: false, rir: null, completed_at: "2026-10-01T10:10:00.000Z" });
    const snap = async () => JSON.stringify([await db.workouts.toArray(), await db.workout_exercises.toArray(), await db.sets.toArray()]);
    const before = await snap();
    await applyChanges([
      change({ id: "s", kind: "swap_exercise", routineId: pull, replaceExerciseId: "Barbell_Curl", exerciseId: "Cable_Preacher_Curl" }),
      change({ id: "m", kind: "add_muscle", dayId: "pull", muscle: "Biceps" }),
    ]);
    expect(await snap()).toBe(before);
  });

  it("queues the routine edit for sync", async () => {
    const queued = await db.outbox.count();
    await applyChanges([change({ id: "a", kind: "add_exercise", routineId: pull, exerciseId: "Hammer_Curls", sets: 3, reps: "8-12" })]);
    expect(await db.outbox.count()).toBeGreaterThan(queued);
  });
});

describe("undoOptimise", () => {
  const all = (): Change[] => [
    change({ id: "a", kind: "add_exercise", routineId: pull, exerciseId: "Hammer_Curls", sets: 3, reps: "8-12" }),
    change({ id: "s", kind: "swap_exercise", routineId: pull, replaceExerciseId: "Barbell_Curl", exerciseId: "Cable_Preacher_Curl" }),
    change({ id: "d", kind: "add_muscle", dayId: "pull", muscle: "Biceps" }),
  ];

  it("restores the split and routines exactly as before the apply", async () => {
    const splitBefore = await splitMeta();
    const pullBefore = await shape(pull);
    const pushBefore = await shape(push);
    await applyChanges(all(), { builtFor: "fp" });
    expect(await hasOptimiseUndo()).toBe(true);
    expect(await shape(pull)).not.toEqual(pullBefore);

    expect(await undoOptimise()).toBe(true);
    expect(await splitMeta()).toEqual(splitBefore);
    expect(await shape(pull)).toEqual(pullBefore);
    expect(await shape(push)).toEqual(pushBefore);
    expect(await hasOptimiseUndo()).toBe(false);
    expect((await listRoutines()).map((r) => r.split_day_id).sort()).toEqual(["pull", "push"]);
  });

  it("has nothing to undo twice, or before any apply", async () => {
    expect(await undoOptimise()).toBe(false);
    await applyChanges(all());
    expect(await undoOptimise()).toBe(true);
    expect(await undoOptimise()).toBe(false);
  });

  it("is one step: a second apply replaces the snapshot", async () => {
    await applyChanges([change({ id: "a", kind: "add_exercise", routineId: pull, exerciseId: "Hammer_Curls", sets: 3, reps: "8-12" })]);
    const afterFirst = await shape(pull);
    await applyChanges([change({ id: "b", kind: "more_sets", routineId: pull, exerciseId: "Barbell_Curl", sets: 5 })]);
    await undoOptimise();
    expect(await shape(pull)).toEqual(afterFirst);
  });

  it("skips a routine deleted since, and still restores the rest", async () => {
    const splitBefore = await splitMeta();
    await applyChanges([...all(), change({ id: "p", kind: "add_exercise", routineId: push, exerciseId: "Incline_Cable_Flye", sets: 3, reps: "8-12" })]);
    await db.routines.delete(push);
    expect(await undoOptimise()).toBe(true);
    expect(await splitMeta()).toEqual(splitBefore);
    expect((await shape(pull)).map((r) => r[0])).toEqual(["Close-Grip_Front_Lat_Pulldown", "Barbell_Curl"]);
  });

  it("keeps the undo snapshot out of the way of other meta keys", async () => {
    await applyChanges(all());
    expect((await db.meta.get(UNDO_KEY))?.key).toBe("split_undo");
    await undoOptimise();
    expect(await db.meta.get(UNDO_KEY)).toBeUndefined();
    expect(await splitMeta()).toBeDefined();
  });
});
