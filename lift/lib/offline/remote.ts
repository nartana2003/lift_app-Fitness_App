/**
 * Pure row mapping between the local Dexie store (lib/offline/db.ts) and the
 * Supabase tables (supabase/migrations/0001_init.sql + 0002_app_drift.sql).
 * No Dexie, no network: shared by sync.ts and photoSync.ts and unit tested.
 */
import type {
  CustomExerciseRow,
  MeasurementRow,
  PlannedDayRow,
  RoutineExerciseRow,
  RoutineRow,
  SkipReason,
  SyncTable,
} from "./db";

type Row = Record<string, unknown>;

/**
 * The row the outbox sends for `table`. Fills columns the server would
 * otherwise keep stale on an upsert (PostgREST only updates the columns sent):
 * - exercises: owned by the user, local-only `custom` marker dropped;
 * - planned_days: `was_marked` always explicit (the app deletes the field to clear it);
 * - routines: `split_day_id` always explicit (absent = unassigned).
 */
export function toRemoteRow(table: SyncTable, row: Row, uid: string): Row {
  if (table === "exercises") {
    const rest: Row = { ...row };
    delete rest.custom;
    return { ...rest, owner_id: uid };
  }
  if (table === "planned_days") return { ...row, was_marked: row.was_marked === true };
  if (table === "routines") return { ...row, split_day_id: typeof row.split_day_id === "string" && row.split_day_id ? row.split_day_id : null };
  return row;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v: unknown): string | null => (typeof v === "string" && DATE_RE.test(v.slice(0, 10)) ? v.slice(0, 10) : null);

const PLAN_STATUS = ["planned", "done", "skipped", "moved"] as const;
const SKIPS: readonly SkipReason[] = ["busy", "tired", "sore", "sick", "injury", "travel", "rest", "other"];

/** Server planned_days row to the local shape, or null when unusable. */
export function plannedDayFromRemote(r: Row): PlannedDayRow | null {
  const id = str(r.id);
  const d = date(r.date);
  if (!id || !d) return null;
  const status = (PLAN_STATUS as readonly unknown[]).includes(r.status) ? (r.status as PlannedDayRow["status"]) : "planned";
  const out: PlannedDayRow = {
    id,
    date: d,
    routine_id: str(r.routine_id),
    status,
    workout_id: str(r.workout_id),
    skip_reason: (SKIPS as readonly unknown[]).includes(r.skip_reason) ? (r.skip_reason as SkipReason) : null,
    skip_note: str(r.skip_note),
    moved_to: date(r.moved_to),
    moved_from: date(r.moved_from),
    created_at: str(r.created_at) ?? new Date(0).toISOString(),
  };
  if (r.was_marked === true) out.was_marked = true;
  return out;
}

/**
 * The local planned_days store has a unique `date`. Two devices can each mark
 * the same date before syncing, leaving two server rows: keep the newest.
 */
export function dedupePlannedDays(rows: readonly PlannedDayRow[]): PlannedDayRow[] {
  const byDate = new Map<string, PlannedDayRow>();
  for (const r of rows) {
    const cur = byDate.get(r.date);
    if (!cur || r.created_at > cur.created_at || (r.created_at === cur.created_at && r.id > cur.id)) byDate.set(r.date, r);
  }
  return [...byDate.values()];
}

export function routineFromRemote(r: Row): RoutineRow | null {
  const id = str(r.id);
  const name = str(r.name);
  if (!id || !name) return null;
  const out: RoutineRow = {
    id,
    name,
    day_label: str(r.day_label),
    source: r.source === "ai" || r.source === "social" ? r.source : "manual",
    kind: r.kind === "mini" ? "mini" : "routine",
    source_url: str(r.source_url),
    platform: r.platform === "tiktok" || r.platform === "instagram" || r.platform === "youtube" ? r.platform : null,
    thumbnail_url: str(r.thumbnail_url),
    creator: str(r.creator),
    notes: str(r.notes),
    created_at: str(r.created_at) ?? new Date(0).toISOString(),
  };
  if (typeof r.split_day_id === "string" && r.split_day_id) out.split_day_id = r.split_day_id;
  return out;
}

export function routineExerciseFromRemote(r: Row): RoutineExerciseRow | null {
  const id = str(r.id);
  const routine_id = str(r.routine_id);
  const exercise_id = str(r.exercise_id);
  if (!id || !routine_id || !exercise_id) return null;
  return {
    id,
    routine_id,
    exercise_id,
    position: num(r.position),
    target_sets: num(r.target_sets, 3),
    target_reps: str(r.target_reps) ?? "8-12",
  };
}

export function measurementFromRemote(r: Row): MeasurementRow | null {
  const id = str(r.id);
  const type = str(r.type);
  const d = date(r.date);
  const value = num(r.value, NaN);
  if (!id || !type || !d || !Number.isFinite(value)) return null;
  return { id, type, value, date: d };
}

export function customExerciseFromRemote(r: Row): CustomExerciseRow | null {
  const id = str(r.id);
  const name = str(r.name);
  if (!id || !name || !id.startsWith("custom-")) return null;
  const out: CustomExerciseRow = {
    id,
    name,
    muscle_groups: strArr(r.muscle_groups),
    secondary_groups: strArr(r.secondary_groups),
    equipment: str(r.equipment) ?? "Other",
    category: str(r.category) ?? "strength",
    mechanic: str(r.mechanic),
    force: str(r.force),
    level: str(r.level) ?? "beginner",
    instructions: strArr(r.instructions),
    image_urls: strArr(r.image_urls),
    tiktok_url: str(r.tiktok_url) ?? "",
    custom: true,
  };
  const video = str(r.video_url);
  if (video) out.video_url = video;
  return out;
}

// ---------- Progress photos ----------

export const PHOTO_BUCKET = "progress-photos";

/** Storage object path. The first folder must be the user id (storage RLS in 0001). */
export function photoPath(uid: string, photoId: string): string {
  return `${uid}/${photoId}.jpg`;
}

/** True when `path` is inside the user's own folder and has no traversal. */
export function isOwnPhotoPath(uid: string, path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.startsWith(`${uid}/`) &&
    !path.includes("..") &&
    !path.includes("\\") &&
    path.length <= 300 &&
    path.indexOf("/", uid.length + 1) === -1
  );
}

/**
 * Change signature for a local photo: a replaced Finish-screen photo keeps its
 * id, so the signature (not the id) decides whether it must be uploaded again.
 */
export function photoSignature(p: { taken_at: string; pose: string | null; blob: { size: number; type?: string }; workout_id?: string | null }): string {
  return [p.taken_at, p.pose ?? "", p.blob.size, p.blob.type ?? "", p.workout_id ?? ""].join("|");
}

export type RemotePhotoRow = {
  id: string;
  taken_at: string;
  pose: "front" | "side" | "back" | null;
  storage_path: string;
  workout_id: string | null;
};

const POSES = ["front", "side", "back"] as const;

/** Server progress_photos row, validated, or null. */
export function remotePhotoFromRow(uid: string, r: Row): RemotePhotoRow | null {
  const id = str(r.id);
  const taken_at = str(r.taken_at);
  if (!id || !taken_at || Number.isNaN(Date.parse(taken_at))) return null;
  if (!isOwnPhotoPath(uid, r.storage_path)) return null;
  return {
    id,
    taken_at,
    pose: (POSES as readonly unknown[]).includes(r.pose) ? (r.pose as RemotePhotoRow["pose"]) : null,
    storage_path: r.storage_path,
    workout_id: str(r.workout_id),
  };
}
