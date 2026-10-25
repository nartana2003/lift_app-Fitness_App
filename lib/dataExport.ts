"use client";

// Export every piece of local data to one JSON file, and restore from it.
// Import is additive: it validates the whole file first, then only adds rows
// this device does not already have. It never deletes or overwrites local data.
import {
  db,
  type CustomExerciseRow,
  type MeasurementRow,
  type PlannedDayRow,
  type RoutineExerciseRow,
  type RoutineRow,
  type SetRow,
  type SyncTable,
  type WorkoutExerciseRow,
  type WorkoutRow,
} from "./offline/db";
import { enqueue } from "./offline/sync";

export const BACKUP_FORMAT = "lift-backup";
export const BACKUP_VERSION = 1;

/**
 * meta keys never written to (or restored from) a backup: the Lyfta API key is a
 * secret, and lastPull is per-device sync state.
 */
export const EXCLUDED_META_KEYS: readonly string[] = ["lyfta_key", "lastPull"];

/** A photo with its image inlined as a base64 data URL, so it fits in JSON. */
export type ExportedPhoto = { id: string; taken_at: string; pose: "front" | "side" | "back" | null; image: string };
export type MetaEntry = { key: string; value: unknown };

export type BackupTables = {
  workouts: WorkoutRow[];
  workout_exercises: WorkoutExerciseRow[];
  sets: SetRow[];
  measurements: MeasurementRow[];
  photos: ExportedPhoto[];
  custom_exercises: CustomExerciseRow[];
  routines: RoutineRow[];
  routine_exercises: RoutineExerciseRow[];
  planned_days: PlannedDayRow[];
  meta: MetaEntry[];
};
export type BackupTable = keyof BackupTables;

export type Backup = { format: typeof BACKUP_FORMAT; version: number; exported_at: string; tables: BackupTables };

/** Parents come before children. */
export const BACKUP_TABLES: BackupTable[] = [
  "workouts",
  "workout_exercises",
  "sets",
  "measurements",
  "photos",
  "custom_exercises",
  "routines",
  "routine_exercises",
  "planned_days",
  "meta",
];

export const TABLE_LABELS: Record<BackupTable, string> = {
  workouts: "Workouts",
  workout_exercises: "Workout exercises",
  sets: "Sets",
  measurements: "Measurements",
  photos: "Progress photos",
  custom_exercises: "Custom exercises",
  routines: "Routines",
  routine_exercises: "Routine exercises",
  planned_days: "Planned days",
  meta: "Settings and goals",
};

// ---------- Export ----------

const DATA_URL = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/;

/** Base64 data URL for a Blob. Works in the browser and in Node (no FileReader needed). */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || "image/jpeg"};base64,${btoa(bin)}`;
}

export function dataUrlToBlob(url: string): Blob {
  const m = DATA_URL.exec(url);
  if (!m) throw new Error("Not an image data URL");
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

/** Snapshot of all local data. Leaves out the sync outbox, the in-progress workout and secrets. */
export async function exportBackup(now: Date = new Date()): Promise<Backup> {
  const photos = await db.photos.toArray();
  const meta = (await db.meta.toArray()).filter((m) => !EXCLUDED_META_KEYS.includes(m.key));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: now.toISOString(),
    tables: {
      workouts: await db.workouts.toArray(),
      workout_exercises: await db.workout_exercises.toArray(),
      sets: await db.sets.toArray(),
      measurements: await db.measurements.toArray(),
      photos: await Promise.all(
        photos.map(async (p) => ({ id: p.id, taken_at: p.taken_at, pose: p.pose ?? null, image: await blobToDataUrl(p.blob) })),
      ),
      custom_exercises: await db.custom_exercises.toArray(),
      routines: await db.routines.toArray(),
      routine_exercises: await db.routine_exercises.toArray(),
      planned_days: await db.planned_days.toArray(),
      meta,
    },
  };
}

export const backupFilename = (now: Date = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `lift-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
};

export const serializeBackup = (b: Backup) => JSON.stringify(b);

// ---------- Validation ----------

/**
 * Field kinds. A trailing "?" means nullable: null or a missing field (older rows)
 * is accepted and stored as null. "optstring" and "optboolean" may be left out
 * entirely (then the field is omitted, not stored as null).
 */
type Kind =
  | "string"
  | "string?"
  | "number"
  | "number?"
  | "boolean"
  | "string[]"
  | "true"
  | "optstring"
  | "optboolean"
  | { oneOf: readonly string[]; nullable?: boolean };

type Schema = Record<string, Kind>;

type RowTable = Exclude<BackupTable, "meta" | "photos">;

const SCHEMAS: Record<RowTable, Schema> = {
  workouts: { id: "string", started_at: "string", ended_at: "string?", notes: "string?", routine_id: "string?" },
  workout_exercises: { id: "string", workout_id: "string", exercise_id: "string", position: "number" },
  sets: {
    id: "string",
    workout_exercise_id: "string",
    set_no: "number",
    reps: "number",
    weight: "number",
    is_warmup: "boolean",
    rir: "number?",
    completed_at: "string",
  },
  measurements: { id: "string", type: "string", value: "number", date: "string" },
  custom_exercises: {
    id: "string",
    name: "string",
    muscle_groups: "string[]",
    secondary_groups: "string[]",
    equipment: "string",
    category: "string",
    mechanic: "string?",
    force: "string?",
    level: "string",
    instructions: "string[]",
    image_urls: "string[]",
    tiktok_url: "string",
    video_url: "optstring",
    custom: "true",
  },
  routines: {
    id: "string",
    name: "string",
    day_label: "string?",
    source: { oneOf: ["manual", "ai", "social"] },
    kind: { oneOf: ["routine", "mini"] },
    source_url: "string?",
    platform: { oneOf: ["tiktok", "instagram", "youtube"], nullable: true },
    thumbnail_url: "string?",
    creator: "string?",
    notes: "string?",
    created_at: "string",
  },
  routine_exercises: {
    id: "string",
    routine_id: "string",
    exercise_id: "string",
    position: "number",
    target_sets: "number",
    target_reps: "string",
  },
  planned_days: {
    id: "string",
    date: "string",
    routine_id: "string?",
    status: { oneOf: ["planned", "done", "skipped", "moved"] },
    workout_id: "string?",
    skip_reason: { oneOf: ["busy", "tired", "sore", "sick", "injury", "travel", "rest", "other"], nullable: true },
    skip_note: "string?",
    moved_to: "string?",
    moved_from: "string?",
    created_at: "string",
    was_marked: "optboolean",
  },
};

const PHOTO_SCHEMA: Schema = {
  id: "string",
  taken_at: "string",
  pose: { oneOf: ["front", "side", "back"], nullable: true },
  image: "string",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type Check = { ok: true; value: unknown } | { ok: false; why: string };

/** Check one field; returns the normalised value or why it is wrong. */
function checkField(v: unknown, kind: Kind): Check {
  const ok = (value: unknown): Check => ({ ok: true, value });
  const bad = (why: string): Check => ({ ok: false, why });
  if (typeof kind === "object") {
    if ((v === null || v === undefined) && kind.nullable) return ok(null);
    return typeof v === "string" && kind.oneOf.includes(v) ? ok(v) : bad(`must be one of ${kind.oneOf.join(", ")}`);
  }
  switch (kind) {
    case "string":
      return typeof v === "string" && v.length > 0 ? ok(v) : bad("must be non-empty text");
    case "string?":
      if (v === null || v === undefined) return ok(null);
      return typeof v === "string" ? ok(v) : bad("must be text or null");
    case "optstring":
      if (v === undefined) return ok(undefined);
      return typeof v === "string" ? ok(v) : bad("must be text");
    case "optboolean":
      if (v === undefined) return ok(undefined);
      return typeof v === "boolean" ? ok(v) : bad("must be true or false");
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? ok(v) : bad("must be a number");
    case "number?":
      if (v === null || v === undefined) return ok(null);
      return typeof v === "number" && Number.isFinite(v) ? ok(v) : bad("must be a number or null");
    case "boolean":
      return typeof v === "boolean" ? ok(v) : bad("must be true or false");
    case "true":
      return v === true ? ok(true) : bad("must be true");
    case "string[]":
      return Array.isArray(v) && v.every((x) => typeof x === "string") ? ok([...v]) : bad("must be a list of text");
  }
}

/** Validate rows against a schema, keeping only known fields. Throws on the first bad row. */
function checkRows(table: string, raw: unknown, schema: Schema): Record<string, unknown>[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`"${table}" must be a list`);
  const rows = raw.map((r, i) => {
    if (!isObj(r)) throw new Error(`${table} row ${i + 1} is not an object`);
    const out: Record<string, unknown> = {};
    for (const [field, kind] of Object.entries(schema)) {
      const res = checkField(r[field], kind);
      if (!res.ok) throw new Error(`${table} row ${i + 1}: "${field}" ${res.why}`);
      if (res.value !== undefined) out[field] = res.value;
    }
    return out;
  });
  uniqueBy(table, rows, (r) => r.id as string, "id");
  return rows;
}

function uniqueBy<T>(table: string, rows: T[], key: (r: T) => string, what: string) {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) throw new Error(`${table} has two entries with the same ${what} (${k})`);
    seen.add(k);
  }
}

export type ParseResult = { ok: true; backup: Backup } | { ok: false; error: string };

/**
 * Parse and fully validate a backup file. Nothing is written here: a file is
 * either entirely valid or rejected with a readable reason.
 */
export function parseBackup(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file is not valid JSON." };
  }
  try {
    if (!isObj(data) || data.format !== BACKUP_FORMAT) throw new Error("This is not a Lift backup file.");
    if (typeof data.version !== "number" || !Number.isInteger(data.version) || data.version < 1)
      throw new Error("The backup has no valid version number.");
    if (data.version > BACKUP_VERSION) throw new Error("This backup was made by a newer version of Lift. Update the app first.");
    if (typeof data.exported_at !== "string") throw new Error("The backup has no export date.");
    const t = data.tables;
    if (!isObj(t)) throw new Error("The backup has no data tables.");

    const rowTables = {} as Record<RowTable, Record<string, unknown>[]>;
    for (const name of Object.keys(SCHEMAS) as RowTable[]) rowTables[name] = checkRows(name, t[name], SCHEMAS[name]);

    const photos = checkRows("photos", t.photos, PHOTO_SCHEMA) as ExportedPhoto[];
    photos.forEach((p, i) => {
      if (!DATA_URL.test(p.image)) throw new Error(`photos row ${i + 1}: "image" is not an embedded image`);
    });

    if (t.meta !== undefined && !Array.isArray(t.meta)) throw new Error(`"meta" must be a list`);
    const meta: MetaEntry[] = ((t.meta as unknown[] | undefined) ?? []).map((m, i) => {
      if (!isObj(m) || typeof m.key !== "string" || m.key.length === 0) throw new Error(`meta row ${i + 1} has no key`);
      if (m.value === undefined) throw new Error(`meta row ${i + 1} ("${m.key}") has no value`);
      return { key: m.key, value: m.value };
    });
    uniqueBy("meta", meta, (m) => m.key, "key");

    const tables = { ...rowTables, photos, meta } as unknown as BackupTables;
    // Mirrors the local store's own rules: one measurement per type per day, one plan per day.
    uniqueBy("measurements", tables.measurements, (m) => `${m.type} ${m.date}`, "type and date");
    uniqueBy("planned_days", tables.planned_days, (d) => d.date, "date");

    return { ok: true, backup: { format: BACKUP_FORMAT, version: data.version, exported_at: data.exported_at, tables } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The backup file is not valid." };
  }
}

export const backupCounts = (b: Backup) =>
  Object.fromEntries(BACKUP_TABLES.map((t) => [t, b.tables[t].length])) as Record<BackupTable, number>;

// ---------- Import ----------

export type ImportSummary = { added: Record<BackupTable, number>; skipped: Record<BackupTable, number> };

const zero = () => Object.fromEntries(BACKUP_TABLES.map((t) => [t, 0])) as Record<BackupTable, number>;

/** Rows whose id is not already stored in `table`. */
async function missing<T extends { id: string }>(table: { bulkGet(keys: string[]): Promise<unknown[]> }, rows: T[]) {
  const found = await table.bulkGet(rows.map((r) => r.id));
  return rows.filter((_, i) => found[i] === undefined);
}

/**
 * Restore a validated backup. Additive and idempotent:
 * - rows whose id already exists here are kept as they are (never overwritten);
 * - children (workout exercises, sets, routine exercises) are only added under a
 *   workout or routine this import adds, so a local workout never gains extra sets;
 * - a measurement for a type and day already logged here, or a plan for a day
 *   already planned here, is skipped;
 * - settings, goals and other preferences are only added if not set here.
 * Everything is written in one transaction. Importing the same file twice adds
 * nothing the second time.
 */
export async function importBackup(backup: Backup): Promise<ImportSummary> {
  const t = backup.tables;
  const added = zero();
  const skipped = zero();
  const queue: Parameters<typeof enqueue>[0] = [];
  const up = (table: SyncTable, rows: object[]) =>
    rows.forEach((row) => queue.push({ table, op: "upsert", row: { ...(row as Record<string, unknown>) } }));

  await db.transaction(
    "rw",
    [
      db.workouts,
      db.workout_exercises,
      db.sets,
      db.measurements,
      db.photos,
      db.custom_exercises,
      db.routines,
      db.routine_exercises,
      db.planned_days,
      db.meta,
    ],
    async () => {
      const workouts = await missing(db.workouts, t.workouts);
      const newWorkouts = new Set(workouts.map((w) => w.id));
      const wes = (await missing(db.workout_exercises, t.workout_exercises)).filter((e) => newWorkouts.has(e.workout_id));
      const newWes = new Set(wes.map((e) => e.id));
      const sets = (await missing(db.sets, t.sets)).filter((s) => newWes.has(s.workout_exercise_id));

      const routines = await missing(db.routines, t.routines);
      const newRoutines = new Set(routines.map((r) => r.id));
      const res = (await missing(db.routine_exercises, t.routine_exercises)).filter((e) => newRoutines.has(e.routine_id));

      const measurements: MeasurementRow[] = [];
      for (const m of await missing(db.measurements, t.measurements)) {
        if (!(await db.measurements.where("[type+date]").equals([m.type, m.date]).first())) measurements.push(m);
      }
      const days: PlannedDayRow[] = [];
      for (const d of await missing(db.planned_days, t.planned_days)) {
        if (!(await db.planned_days.where("date").equals(d.date).first())) days.push(d);
      }

      const customs = await missing(db.custom_exercises, t.custom_exercises);
      const photos = await missing(db.photos, t.photos);

      const meta: MetaEntry[] = [];
      for (const m of t.meta) {
        if (EXCLUDED_META_KEYS.includes(m.key)) continue;
        if ((await db.meta.get(m.key)) === undefined) meta.push(m);
      }

      await db.workouts.bulkAdd(workouts);
      await db.workout_exercises.bulkAdd(wes);
      await db.sets.bulkAdd(sets);
      await db.routines.bulkAdd(routines);
      await db.routine_exercises.bulkAdd(res);
      await db.measurements.bulkAdd(measurements);
      await db.planned_days.bulkAdd(days);
      await db.custom_exercises.bulkAdd(customs);
      await db.photos.bulkAdd(photos.map((p) => ({ id: p.id, taken_at: p.taken_at, pose: p.pose, blob: dataUrlToBlob(p.image) })));
      await db.meta.bulkAdd(meta);

      const written: Record<BackupTable, unknown[]> = {
        workouts,
        workout_exercises: wes,
        sets,
        measurements,
        photos,
        custom_exercises: customs,
        routines,
        routine_exercises: res,
        planned_days: days,
        meta,
      };
      for (const name of BACKUP_TABLES) {
        added[name] = written[name].length;
        skipped[name] = t[name].length - written[name].length;
      }

      up("workouts", workouts);
      up("workout_exercises", wes);
      up("sets", sets);
      up("measurements", measurements);
      up("routines", routines);
      up("routine_exercises", res);
      up("planned_days", days);
      // A user's own exercises live in the shared `exercises` table; `custom` is a local-only marker.
      for (const c of customs) {
        const row: Record<string, unknown> = { ...c };
        delete row.custom;
        queue.push({ table: "exercises", op: "upsert", row });
      }
    },
  );

  // Queue the new rows for sync, so a later pull from the server does not drop them.
  if (queue.length) await enqueue(queue);
  return { added, skipped };
}
