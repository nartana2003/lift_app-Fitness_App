import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import { deleteWorkout } from "../offline/sync";
import { addExercises, finishWorkout, getActive, startWorkout, toggleSetDone, updateSet } from "../workout";
import { lastSession } from "../history";

const SQUAT = "Barbell_Squat";

async function logSets(sets: [number, number][], tickAll = true) {
  await startWorkout();
  await addExercises([SQUAT]);
  let w = (await getActive())!;
  const ex = w.exercises[0];
  // make the row match the requested number of sets
  while (ex.sets.length > sets.length) ex.sets.pop();
  await db.active.put(w);
  const prs: string[][] = [];
  for (let i = 0; i < sets.length; i++) {
    w = (await getActive())!;
    const s = w.exercises[0].sets[i] ?? null;
    if (!s) break;
    await updateSet(ex.id, s.id, { weight: sets[i][0], reps: sets[i][1] });
    if (tickAll || i === 0) prs.push(await toggleSetDone(ex.id, s.id));
  }
  const id = await finishWorkout();
  return { id, prs };
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("workout flow (offline)", () => {
  it("saves ticked sets locally and queues them for sync", async () => {
    const { id, prs } = await logSets([[60, 10], [60, 10], [60, 9]]);
    expect(prs.flat()).toEqual([]); // first time logging: no PR fanfare
    expect(await db.workouts.get(id!)).toBeTruthy();
    expect(await db.active.get("active")).toBeUndefined();

    const outbox = await db.outbox.orderBy("seq").toArray();
    expect(outbox.map((o) => o.table)).toEqual(["workouts", "workout_exercises", "sets", "sets", "sets"]);

    const last = await lastSession(SQUAT);
    expect(last?.sets.map((s) => [s.weight, s.reps])).toEqual([[60, 10], [60, 10], [60, 9]]);
  });

  it("pre-fills next session from last time and detects PRs once", async () => {
    await logSets([[60, 10], [60, 10]]);

    await startWorkout();
    await addExercises([SQUAT]);
    const w = (await getActive())!;
    const ex = w.exercises[0];
    expect(ex.sets.map((s) => [s.weight, s.reps])).toEqual([[60, 10], [60, 10]]);

    await updateSet(ex.id, ex.sets[0].id, { weight: 62.5 });
    expect(await toggleSetDone(ex.id, ex.sets[0].id)).toEqual(["weight", "e1rm"]);
    await updateSet(ex.id, ex.sets[1].id, { weight: 62.5 });
    // Same as the set just done → not a new PR, but session volume beats last time.
    expect(await toggleSetDone(ex.id, ex.sets[1].id)).toEqual(["volume"]);
  });

  it("drops unticked sets and saves nothing for an empty workout", async () => {
    const { id } = await logSets([[50, 8], [50, 8], [50, 8]], false);
    const last = await lastSession(SQUAT);
    expect(last?.workout.id).toBe(id);
    expect(last?.sets).toHaveLength(1);

    await startWorkout();
    expect(await finishWorkout()).toBeNull();
  });

  it("deleting an unsynced workout removes its queued uploads", async () => {
    const { id } = await logSets([[60, 10]]);
    await deleteWorkout(id!);
    const outbox = await db.outbox.toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ table: "workouts", op: "delete", row: { id } });
    expect(await db.workouts.count()).toBe(0);
    expect(await db.sets.count()).toBe(0);
  });
});
