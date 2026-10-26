import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, type ActiveWorkout } from "../offline/db";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  listRoutines,
  repRangeFrom,
  routineExercisesFromActive,
  updateRoutine,
} from "../routines";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const set = (reps: number | "", weight: number | "", is_warmup = false) => ({
  id: Math.random().toString(36).slice(2),
  reps,
  weight,
  is_warmup,
  rir: null,
  done: true,
});

describe("repRangeFrom", () => {
  it("summarises reps as a range, a single number, or the default", () => {
    expect(repRangeFrom([10, 8, 9])).toBe("8-10");
    expect(repRangeFrom([10, 10])).toBe("10");
    expect(repRangeFrom([])).toBe("8-12");
    expect(repRangeFrom([0, 0])).toBe("8-12");
  });
});

describe("routineExercisesFromActive", () => {
  it("ignores warm-ups, counts working sets and merges a repeated exercise", () => {
    const w = {
      exercises: [
        { id: "1", exercise_id: "bench", sets: [set(15, 20, true), set(10, 60), set(8, 60)] },
        { id: "2", exercise_id: "squat", sets: [set(5, 100)] },
        { id: "3", exercise_id: "bench", sets: [set(6, 70)] },
      ],
    } as unknown as ActiveWorkout;
    expect(routineExercisesFromActive(w)).toEqual([
      { exercise_id: "bench", target_sets: 2, target_reps: "8-10" },
      { exercise_id: "squat", target_sets: 1, target_reps: "5" },
    ]);
  });

  it("falls back to the default rep range when nothing was logged", () => {
    const w = { exercises: [{ id: "1", exercise_id: "bench", sets: [set("", "")] }] } as unknown as ActiveWorkout;
    expect(routineExercisesFromActive(w)).toEqual([{ exercise_id: "bench", target_sets: 1, target_reps: "8-12" }]);
  });
});

describe("saving routines", () => {
  it("stores the routine with ordered exercises and queues it for sync", async () => {
    const id = await createRoutine({
      name: "  Push day  ",
      exercises: [
        { exercise_id: "bench", target_sets: 4, target_reps: "6-8" },
        { exercise_id: "fly" },
      ],
    });

    const r = await getRoutine(id);
    expect(r).toMatchObject({ name: "Push day", kind: "routine", source: "manual" });
    expect(r!.exercises.map((e) => [e.exercise_id, e.position, e.target_sets, e.target_reps])).toEqual([
      ["bench", 0, 4, "6-8"],
      ["fly", 1, 3, "8-12"],
    ]);

    const outbox = await db.outbox.orderBy("seq").toArray();
    expect(outbox.map((o) => o.table)).toEqual(["routines", "routine_exercises", "routine_exercises"]);
  });

  it("renames and replaces the exercise list", async () => {
    const id = await createRoutine({ name: "Day A", exercises: [{ exercise_id: "bench" }, { exercise_id: "fly" }] });
    await db.outbox.clear();

    await updateRoutine(id, { name: "Day B", exercises: [{ exercise_id: "squat", target_sets: 5, target_reps: "5" }] });

    const r = await getRoutine(id);
    expect(r!.name).toBe("Day B");
    expect(r!.exercises.map((e) => e.exercise_id)).toEqual(["squat"]);
    expect(await db.routine_exercises.count()).toBe(1);

    const ops = (await db.outbox.orderBy("seq").toArray()).map((o) => `${o.table}:${o.op}`);
    expect(ops).toEqual(["routines:upsert", "routine_exercises:delete", "routine_exercises:delete", "routine_exercises:upsert"]);
  });

  it("deletes a routine and its exercises", async () => {
    const id = await createRoutine({ name: "Gone", exercises: [{ exercise_id: "bench" }] });
    await deleteRoutine(id);
    expect(await getRoutine(id)).toBeUndefined();
    expect(await db.routine_exercises.count()).toBe(0);
    expect((await db.outbox.orderBy("seq").last())).toMatchObject({ table: "routines", op: "delete", row: { id } });
  });

  it("lists routines newest first", async () => {
    const a = await createRoutine({ name: "A", exercises: [{ exercise_id: "x" }] });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createRoutine({ name: "B", exercises: [{ exercise_id: "y" }] });
    expect((await listRoutines()).map((r) => r.id)).toEqual([b, a]);
  });
});
