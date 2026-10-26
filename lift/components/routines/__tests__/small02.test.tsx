// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, type RoutineExerciseRow, type RoutineRow } from "@/lib/offline/db";
import { dayKey, getDay, planDay } from "@/lib/planner";
import { createRoutine, getRoutine } from "@/lib/routines";
import { addMiniToToday, isTodayCopy, TODAY_COPY_NOTE } from "@/components/routines/MiniWorkoutCard";
import { saveMiniWorkout, saveRoutineFromLink, type ImportItem } from "@/components/routines/SaveFromLink";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const LINK = "https://vt.tiktok.com/ZSabc123/";

const routine = (id: string, name: string, over: Partial<RoutineRow> = {}): RoutineRow => ({
  id,
  name,
  day_label: null,
  source: "manual",
  kind: "routine",
  source_url: null,
  platform: null,
  thumbnail_url: null,
  creator: null,
  notes: null,
  created_at: "2026-10-01T00:00:00.000Z",
  ...over,
});
const rex = (routineId: string, exerciseId: string, position = 0): RoutineExerciseRow => ({
  id: `${routineId}-${exerciseId}`,
  routine_id: routineId,
  exercise_id: exerciseId,
  position,
  target_sets: 3,
  target_reps: "8-12",
});
const item = (exercise_id: string): ImportItem => ({
  exercise_id,
  name: exercise_id,
  custom: false,
  muscle_groups: ["Abs/Core"],
  equipment: "Bodyweight",
  target_sets: 3,
  target_reps: "15",
});

describe("Save from link writes the link fields in one step", () => {
  it("saves a routine with link, platform, thumbnail, creator and split day, queued once", async () => {
    const id = await saveRoutineFromLink({
      name: "Core",
      notes: null,
      url: LINK,
      platform: "tiktok",
      exercises: [item("crunch")],
      thumbnail_url: "https://p16.example.com/t.jpg",
      creator: "@coach",
      split_day_id: "day-1",
    });
    expect(await getRoutine(id)).toMatchObject({
      kind: "routine",
      source: "social",
      source_url: LINK,
      platform: "tiktok",
      thumbnail_url: "https://p16.example.com/t.jpg",
      creator: "@coach",
      split_day_id: "day-1",
    });
    const routines = (await db.outbox.toArray()).filter((o) => o.table === "routines");
    expect(routines).toHaveLength(1);
    expect(routines[0].row).toMatchObject({ source_url: LINK, platform: "tiktok", split_day_id: "day-1" });
  });

  it("a mini with no thumbnail or creator stores null for both and no split day", async () => {
    const id = await saveMiniWorkout({ name: "Abs", notes: null, url: LINK, platform: "tiktok", exercises: [item("crunch")] });
    const r = (await getRoutine(id))!;
    expect(r).toMatchObject({ kind: "mini", source_url: LINK, thumbnail_url: null, creator: null });
    expect("split_day_id" in r).toBe(false);
  });

  it("drops a non-https thumbnail", async () => {
    const id = await saveRoutineFromLink({
      name: "X",
      notes: null,
      url: LINK,
      platform: "tiktok",
      exercises: [item("crunch")],
      thumbnail_url: "javascript:alert(1)",
    });
    expect((await getRoutine(id))!.thumbnail_url).toBeNull();
  });
});

describe("Adding a mini reuses a marked copy only if no other day uses it", () => {
  const today = () => dayKey(new Date());
  const tomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return dayKey(d);
  };

  async function seed() {
    await db.routines.bulkPut([
      routine("m1", "Abs", { kind: "mini", source: "social" }),
      routine("copy", "Push + Core", { notes: `${TODAY_COPY_NOTE} Push + Core` }),
    ]);
    await db.routine_exercises.bulkPut([rex("m1", "squat"), rex("copy", "pushup"), rex("copy", "crunch", 1)]);
  }

  it("makes a fresh copy when another day also plans the marked copy, leaving that day's routine unchanged", async () => {
    await seed();
    await planDay(today(), "copy");
    await planDay(tomorrow(), "copy");
    const before = await getRoutine("copy");

    expect(await addMiniToToday("m1")).toBe("Added to Push + Core today.");
    const todayId = (await getDay(today()))!.routine_id!;
    expect(todayId).not.toBe("copy");
    const fresh = (await getRoutine(todayId))!;
    expect(isTodayCopy(fresh)).toBe(true);
    expect(fresh.exercises.map((e) => e.exercise_id)).toEqual(["pushup", "crunch", "squat"]);
    expect(await getRoutine("copy")).toEqual(before);
    expect((await getDay(tomorrow()))!.routine_id).toBe("copy");
  });

  it("still reuses the marked copy in place when only today uses it", async () => {
    await seed();
    await planDay(today(), "copy");
    const count = await db.routines.count();
    expect(await addMiniToToday("m1")).toBe("Added to Push + Core today.");
    expect((await getDay(today()))!.routine_id).toBe("copy");
    expect(await db.routines.count()).toBe(count);
    expect((await getRoutine("copy"))!.exercises.map((e) => e.exercise_id)).toEqual(["pushup", "crunch", "squat"]);
  });

  it("an unmarked routine is never changed, whether or not other days use it", async () => {
    await seed();
    const base = await createRoutine({ name: "Push", exercises: [{ exercise_id: "pushup" }] });
    await planDay(today(), base);
    const before = await getRoutine(base);
    await addMiniToToday("m1");
    expect(await getRoutine(base)).toEqual(before);
    expect((await getDay(today()))!.routine_id).not.toBe(base);
  });
});
