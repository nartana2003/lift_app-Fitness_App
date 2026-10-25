import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  db,
  type CustomExerciseRow,
  type MeasurementRow,
  type PlannedDayRow,
  type RoutineExerciseRow,
  type RoutineRow,
  type SetRow,
  type WorkoutExerciseRow,
  type WorkoutRow,
} from "../offline/db";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupCounts,
  backupFilename,
  blobToDataUrl,
  dataUrlToBlob,
  exportBackup,
  importBackup,
  parseBackup,
  serializeBackup,
  type Backup,
} from "../dataExport";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const workout = (id: string, o: Partial<WorkoutRow> = {}): WorkoutRow => ({
  id,
  started_at: "2026-10-01T10:00:00.000Z",
  ended_at: "2026-10-01T11:00:00.000Z",
  notes: null,
  routine_id: null,
  ...o,
});
const we = (id: string, workout_id: string, o: Partial<WorkoutExerciseRow> = {}): WorkoutExerciseRow => ({
  id,
  workout_id,
  exercise_id: "barbell-bench-press",
  position: 0,
  ...o,
});
const set = (id: string, workout_exercise_id: string, o: Partial<SetRow> = {}): SetRow => ({
  id,
  workout_exercise_id,
  set_no: 1,
  reps: 8,
  weight: 80,
  is_warmup: false,
  rir: 2,
  completed_at: "2026-10-01T10:10:00.000Z",
  ...o,
});
const measurement = (id: string, o: Partial<MeasurementRow> = {}): MeasurementRow => ({
  id,
  type: "body_weight",
  value: 80.5,
  date: "2026-10-01",
  ...o,
});
const routine = (id: string, o: Partial<RoutineRow> = {}): RoutineRow => ({
  id,
  name: "Push",
  day_label: "Mon",
  source: "manual",
  kind: "routine",
  source_url: null,
  platform: null,
  thumbnail_url: null,
  creator: null,
  notes: null,
  created_at: "2026-09-01T00:00:00.000Z",
  ...o,
});
const routineEx = (id: string, routine_id: string): RoutineExerciseRow => ({
  id,
  routine_id,
  exercise_id: "barbell-bench-press",
  position: 0,
  target_sets: 3,
  target_reps: "8-12",
});
const day = (id: string, date: string, o: Partial<PlannedDayRow> = {}): PlannedDayRow => ({
  id,
  date,
  routine_id: null,
  status: "planned",
  workout_id: null,
  skip_reason: null,
  skip_note: null,
  moved_to: null,
  moved_from: null,
  created_at: "2026-09-30T00:00:00.000Z",
  ...o,
});
const custom = (id: string, name: string): CustomExerciseRow => ({
  id,
  name,
  muscle_groups: ["chest"],
  secondary_groups: [],
  equipment: "Other",
  category: "strength",
  mechanic: null,
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "https://www.tiktok.com/search?q=x",
  custom: true,
});

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 255]);

async function seed() {
  await db.workouts.bulkPut([workout("w1"), workout("w2", { notes: "Heavy day", routine_id: "r1" })]);
  await db.workout_exercises.bulkPut([we("we1", "w1"), we("we2", "w2", { position: 1 })]);
  await db.sets.bulkPut([set("s1", "we1"), set("s2", "we1", { set_no: 2, is_warmup: true, rir: null }), set("s3", "we2")]);
  await db.measurements.bulkPut([measurement("m1"), measurement("m2", { type: "waist", value: 82, date: "2026-10-02" })]);
  await db.photos.put({ id: "p1", taken_at: "2026-10-01T09:00:00.000Z", pose: "front", blob: new Blob([PNG], { type: "image/png" }) });
  await db.custom_exercises.put(custom("custom-1", "Cable Fly Variant"));
  await db.routines.put(routine("r1"));
  await db.routine_exercises.put(routineEx("re1", "r1"));
  await db.planned_days.put(day("d1", "2026-10-03", { routine_id: "r1" }));
  await db.meta.bulkPut([
    { key: "settings", value: { unit: "lb", weekStart: 0 } },
    { key: "favorites", value: ["barbell-bench-press"] },
    { key: "lyfta_key", value: "secret-key" },
    { key: "lastPull", value: "2026-10-01T00:00:00.000Z" },
  ]);
  await db.active.put({ key: "active", id: "a1", started_at: "2026-10-05T10:00:00.000Z", routine_id: null, name: null, exercises: [] });
  await db.outbox.add({ table: "workouts", op: "upsert", row: { id: "w1" }, created_at: "2026-10-01T00:00:00.000Z" });
}

const clearAll = () => Promise.all(db.tables.map((t) => t.clear()));

/** Export, then go through JSON text exactly as the file would. */
async function exportedText() {
  return serializeBackup(await exportBackup(new Date("2026-10-16T12:00:00.000Z")));
}

function parsed(text: string): Backup {
  const r = parseBackup(text);
  if (!r.ok) throw new Error(r.error);
  return r.backup;
}

describe("photo encoding", () => {
  it("round-trips bytes and type through a data URL", async () => {
    const url = await blobToDataUrl(new Blob([PNG], { type: "image/png" }));
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const back = dataUrlToBlob(url);
    expect(back.type).toBe("image/png");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(PNG);
  });

  it("refuses anything that is not an image data URL", () => {
    expect(() => dataUrlToBlob("data:text/html;base64,PGI+")).toThrow();
    expect(() => dataUrlToBlob("https://example.com/a.png")).toThrow();
  });
});

describe("export", () => {
  it("names the file by local date", () => {
    expect(backupFilename(new Date(2026, 0, 5, 23, 30))).toBe("lift-backup-2026-01-05.json");
  });

  it("includes every data table, and leaves out the outbox, the active workout and secrets", async () => {
    await seed();
    const b = await exportBackup(new Date("2026-10-16T12:00:00.000Z"));
    expect(b.format).toBe(BACKUP_FORMAT);
    expect(b.version).toBe(BACKUP_VERSION);
    expect(b.exported_at).toBe("2026-10-16T12:00:00.000Z");
    expect(backupCounts(b)).toEqual({
      workouts: 2,
      workout_exercises: 2,
      sets: 3,
      measurements: 2,
      photos: 1,
      custom_exercises: 1,
      routines: 1,
      routine_exercises: 1,
      planned_days: 1,
      meta: 2,
    });
    expect(b.tables.meta.map((m) => m.key).sort()).toEqual(["favorites", "settings"]);
    expect(Object.keys(b.tables)).not.toContain("outbox");
    expect(Object.keys(b.tables)).not.toContain("active");
    expect(serializeBackup(b)).not.toContain("secret-key");
  });
});

describe("round trip", () => {
  it("restores every row exactly after wiping the device", async () => {
    await seed();
    const before = {
      workouts: await db.workouts.toArray(),
      workout_exercises: await db.workout_exercises.toArray(),
      sets: await db.sets.toArray(),
      measurements: await db.measurements.toArray(),
      custom_exercises: await db.custom_exercises.toArray(),
      routines: await db.routines.toArray(),
      routine_exercises: await db.routine_exercises.toArray(),
      planned_days: await db.planned_days.toArray(),
    };
    const text = await exportedText();
    await clearAll();

    const summary = await importBackup(parsed(text));
    expect(summary.added.workouts).toBe(2);
    expect(summary.added.sets).toBe(3);
    expect(summary.added.photos).toBe(1);
    expect(summary.added.meta).toBe(2);
    expect(Object.values(summary.skipped).every((n) => n === 0)).toBe(true);

    expect(await db.workouts.toArray()).toEqual(before.workouts);
    expect(await db.workout_exercises.toArray()).toEqual(before.workout_exercises);
    expect(await db.sets.toArray()).toEqual(before.sets);
    expect(await db.measurements.toArray()).toEqual(before.measurements);
    expect(await db.custom_exercises.toArray()).toEqual(before.custom_exercises);
    expect(await db.routines.toArray()).toEqual(before.routines);
    expect(await db.routine_exercises.toArray()).toEqual(before.routine_exercises);
    expect(await db.planned_days.toArray()).toEqual(before.planned_days);
    expect((await db.meta.get("settings"))?.value).toEqual({ unit: "lb", weekStart: 0 });
    expect(await db.meta.get("lyfta_key")).toBeUndefined();

    const photo = (await db.photos.get("p1"))!;
    expect(photo.pose).toBe("front");
    expect(photo.blob.type).toBe("image/png");
    expect(new Uint8Array(await photo.blob.arrayBuffer())).toEqual(PNG);
  });

  it("queues restored rows for sync (custom exercises without the local marker)", async () => {
    await seed();
    const text = await exportedText();
    await clearAll();
    await importBackup(parsed(text));
    const out = await db.outbox.toArray();
    const ids = (table: string) => out.filter((o) => o.table === table).map((o) => o.row.id).sort();
    expect(out.every((o) => o.op === "upsert")).toBe(true);
    expect(ids("workouts")).toEqual(["w1", "w2"]);
    expect(ids("sets")).toEqual(["s1", "s2", "s3"]);
    expect(ids("measurements")).toEqual(["m1", "m2"]);
    expect(ids("planned_days")).toEqual(["d1"]);
    const ex = out.find((o) => o.table === "exercises")!;
    expect(ex.row.id).toBe("custom-1");
    expect("custom" in ex.row).toBe(false);
  });

  it("is idempotent: importing the same file again adds nothing and queues nothing", async () => {
    await seed();
    const text = await exportedText();
    await clearAll();
    await importBackup(parsed(text));
    const counts = { w: await db.workouts.count(), s: await db.sets.count(), p: await db.photos.count(), o: await db.outbox.count() };

    const again = await importBackup(parsed(text));
    expect(Object.values(again.added).every((n) => n === 0)).toBe(true);
    expect(again.skipped.workouts).toBe(2);
    expect(again.skipped.sets).toBe(3);
    expect({ w: await db.workouts.count(), s: await db.sets.count(), p: await db.photos.count(), o: await db.outbox.count() }).toEqual(counts);
  });
});

describe("import never overwrites or deletes local data", () => {
  it("keeps a locally edited row and does not add backup sets under a local workout", async () => {
    await seed();
    const text = await exportedText();
    // After the export, the user edits w1's notes and deletes one of its sets.
    await db.workouts.update("w1", { notes: "edited locally" });
    await db.sets.delete("s2");

    const summary = await importBackup(parsed(text));
    expect((await db.workouts.get("w1"))!.notes).toBe("edited locally");
    expect(await db.sets.get("s2")).toBeUndefined();
    expect(summary.added.sets).toBe(0);
    expect(summary.skipped.sets).toBe(3);
  });

  it("keeps rows that are not in the file", async () => {
    await db.workouts.put(workout("local-only"));
    const text = serializeBackup({
      format: BACKUP_FORMAT,
      version: 1,
      exported_at: "2026-10-16T12:00:00.000Z",
      tables: { workouts: [workout("w9")] } as Backup["tables"],
    });
    await importBackup(parsed(text));
    expect((await db.workouts.toArray()).map((w) => w.id).sort()).toEqual(["local-only", "w9"]);
  });

  it("keeps a local measurement for the same type and day, and a local plan for the same date", async () => {
    await db.measurements.put(measurement("local-m", { value: 79 }));
    await db.planned_days.put(day("local-d", "2026-10-03", { status: "skipped", skip_reason: "sick" }));
    const text = serializeBackup({
      format: BACKUP_FORMAT,
      version: 1,
      exported_at: "2026-10-16T12:00:00.000Z",
      tables: {
        measurements: [measurement("file-m", { value: 81 }), measurement("file-m2", { date: "2026-10-04" })],
        planned_days: [day("file-d", "2026-10-03"), day("file-d2", "2026-10-05")],
      } as Backup["tables"],
    });
    const summary = await importBackup(parsed(text));
    expect((await db.measurements.get("local-m"))!.value).toBe(79);
    expect(await db.measurements.get("file-m")).toBeUndefined();
    expect(await db.measurements.get("file-m2")).toBeDefined();
    expect((await db.planned_days.get("local-d"))!.status).toBe("skipped");
    expect(await db.planned_days.get("file-d")).toBeUndefined();
    expect(await db.planned_days.get("file-d2")).toBeDefined();
    expect(summary.skipped.measurements).toBe(1);
    expect(summary.skipped.planned_days).toBe(1);
  });

  it("keeps existing settings and only fills in missing ones; ignores secrets in a file", async () => {
    await db.meta.put({ key: "settings", value: { unit: "kg" } });
    const text = serializeBackup({
      format: BACKUP_FORMAT,
      version: 1,
      exported_at: "2026-10-16T12:00:00.000Z",
      tables: {
        meta: [
          { key: "settings", value: { unit: "lb" } },
          { key: "goals", value: { goalType: "hypertrophy" } },
          { key: "lyfta_key", value: "planted" },
        ],
      } as Backup["tables"],
    });
    await importBackup(parsed(text));
    expect((await db.meta.get("settings"))!.value).toEqual({ unit: "kg" });
    expect((await db.meta.get("goals"))!.value).toEqual({ goalType: "hypertrophy" });
    expect(await db.meta.get("lyfta_key")).toBeUndefined();
  });

  it("drops child rows whose parent is not being added", async () => {
    const text = serializeBackup({
      format: BACKUP_FORMAT,
      version: 1,
      exported_at: "2026-10-16T12:00:00.000Z",
      tables: { workout_exercises: [we("orphan", "missing")], sets: [set("orphan-s", "orphan")] } as Backup["tables"],
    });
    const summary = await importBackup(parsed(text));
    expect(await db.workout_exercises.count()).toBe(0);
    expect(await db.sets.count()).toBe(0);
    expect(summary.skipped.workout_exercises).toBe(1);
  });
});

describe("validation happens before anything is written", () => {
  const base = (tables: Record<string, unknown>, o: Record<string, unknown> = {}) =>
    JSON.stringify({ format: BACKUP_FORMAT, version: 1, exported_at: "2026-10-16T12:00:00.000Z", tables, ...o });
  const error = (text: string) => {
    const r = parseBackup(text);
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.error;
  };

  it("rejects non-JSON, foreign files and newer versions", () => {
    expect(error("not json")).toMatch(/not valid JSON/);
    expect(error(JSON.stringify({ workouts: [] }))).toMatch(/not a Lift backup/);
    expect(error(base({}, { version: BACKUP_VERSION + 1 }))).toMatch(/newer version/);
    expect(error(base({}, { version: "1" }))).toMatch(/version/);
    expect(error(base({}, { tables: [] }))).toMatch(/no data tables/);
  });

  it("rejects a bad row anywhere in the file, naming the table, row and field", () => {
    const good = [workout("w1")];
    expect(error(base({ workouts: good, sets: [set("s1", "we1", { weight: "80" as unknown as number })] }))).toBe(
      'sets row 1: "weight" must be a number',
    );
    expect(error(base({ workouts: [workout("w1"), { ...workout("w2"), id: "" }] }))).toMatch(/workouts row 2: "id"/);
    expect(error(base({ routines: [routine("r1", { source: "spam" as RoutineRow["source"] })] }))).toMatch(/routines row 1: "source"/);
    expect(error(base({ sets: "nope" }))).toMatch(/"sets" must be a list/);
    expect(error(base({ workouts: [workout("w1"), workout("w1")] }))).toMatch(/same id/);
    expect(error(base({ planned_days: [day("a", "2026-10-03"), day("b", "2026-10-03")] }))).toMatch(/same date/);
    expect(error(base({ measurements: [measurement("a"), measurement("b")] }))).toMatch(/same type and date/);
    expect(error(base({ photos: [{ id: "p", taken_at: "x", pose: null, image: "data:text/html;base64,PGI+" }] }))).toMatch(/embedded image/);
    expect(error(base({ meta: [{ key: "settings" }] }))).toMatch(/no value/);
  });

  it("an invalid file leaves the database untouched", async () => {
    await seed();
    const before = await exportedText();
    const text = base({ workouts: [workout("new-1")], sets: [{ id: "bad" }] });
    expect(parseBackup(text).ok).toBe(false);
    expect(await db.workouts.get("new-1")).toBeUndefined();
    expect(await exportedText()).toBe(before);
  });

  it("accepts older rows with missing nullable fields, storing them as null, and strips unknown fields", () => {
    const legacy: Record<string, unknown> = { ...workout("w1"), extra: "x" };
    delete legacy.notes;
    delete legacy.routine_id;
    const b = parsed(base({ workouts: [legacy] }));
    expect(b.tables.workouts[0]).toEqual({ ...workout("w1"), notes: null, routine_id: null });
    expect(b.tables.sets).toEqual([]);
  });
});

describe("planned day was_marked (undo of a move keeps a marked date)", () => {
  const text = (planned_days: unknown[]) =>
    JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: "2026-10-16T12:00:00.000Z", tables: { planned_days } });

  it("round-trips was_marked through export, wipe and import", async () => {
    await db.planned_days.bulkPut([
      day("d1", "2026-10-03", { routine_id: "r1", moved_from: "2026-10-02", was_marked: true }),
      day("d2", "2026-10-04"),
    ]);
    const before = await db.planned_days.toArray();
    const t = await exportedText();
    expect(BACKUP_VERSION).toBe(parsed(t).version);
    await clearAll();
    await importBackup(parsed(t));
    expect(await db.planned_days.toArray()).toEqual(before);
    expect((await db.planned_days.get("d1"))!.was_marked).toBe(true);
    expect("was_marked" in (await db.planned_days.get("d2"))!).toBe(false);
  });

  it("imports older files without the field and leaves it out (not null)", () => {
    const b = parsed(text([day("d1", "2026-10-03")]));
    expect(b.tables.planned_days[0]).toEqual(day("d1", "2026-10-03"));
    expect("was_marked" in b.tables.planned_days[0]).toBe(false);
  });

  it("keeps false, and rejects a non-boolean was_marked", () => {
    expect(parsed(text([day("d1", "2026-10-03", { was_marked: false })])).tables.planned_days[0].was_marked).toBe(false);
    const r = parseBackup(text([{ ...day("d1", "2026-10-03"), was_marked: "yes" }]));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/was_marked/);
  });
});
