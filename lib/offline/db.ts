// Local-first store (IndexedDB via Dexie). All workout writes land here first,
// then the outbox pushes them to Supabase when online (see sync.ts).
import Dexie, { type Table } from "dexie";

export type WorkoutRow = {
  id: string;
  started_at: string;
  ended_at: string | null;
  notes: string | null;
  routine_id: string | null;
};

export type WorkoutExerciseRow = {
  id: string;
  workout_id: string;
  exercise_id: string;
  position: number;
};

export type SetRow = {
  id: string;
  workout_exercise_id: string;
  set_no: number;
  reps: number;
  weight: number;
  is_warmup: boolean;
  rir: number | null;
  completed_at: string;
};

export type SyncTable =
  | "workouts"
  | "workout_exercises"
  | "sets"
  | "personal_records"
  | "measurements"
  | "exercises"
  | "routines"
  | "routine_exercises"
  | "planned_days";

export type SkipReason = "busy" | "tired" | "sore" | "sick" | "injury" | "travel" | "rest" | "other";

export type PlannedDayRow = {
  id: string;
  /** Local date, YYYY-MM-DD */
  date: string;
  routine_id: string | null;
  status: "planned" | "done" | "skipped" | "moved";
  workout_id: string | null;
  skip_reason: SkipReason | null;
  skip_note: string | null;
  /** The day this one was moved to / came from. */
  moved_to: string | null;
  moved_from: string | null;
  created_at: string;
};

export type RoutineRow = {
  id: string;
  name: string;
  day_label: string | null;
  source: "manual" | "ai" | "social";
  kind: "routine" | "mini";
  source_url: string | null;
  platform: "tiktok" | "instagram" | "youtube" | null;
  thumbnail_url: string | null;
  creator: string | null;
  notes: string | null;
  created_at: string;
};

export type RoutineExerciseRow = {
  id: string;
  routine_id: string;
  exercise_id: string;
  position: number;
  target_sets: number;
  /** "8-12", "10", or "45s" for timed work */
  target_reps: string;
};

export type OutboxItem = {
  seq?: number;
  table: SyncTable;
  op: "upsert" | "delete";
  row: Record<string, unknown>;
  created_at: string;
};

export type MeasurementRow = { id: string; type: string; value: number; date: string };

/** Progress photo kept on-device (uploaded to private storage in a later phase). */
export type PhotoRow = { id: string; taken_at: string; pose: "front" | "side" | "back" | null; blob: Blob };

/** A user-made exercise (e.g. from an import or a saved video). Same shape as a catalogue exercise. */
export type CustomExerciseRow = {
  id: string;
  name: string;
  muscle_groups: string[];
  secondary_groups: string[];
  equipment: string;
  category: string;
  mechanic: string | null;
  force: string | null;
  level: string;
  instructions: string[];
  image_urls: string[];
  tiktok_url: string;
  video_url?: string;
  custom: true;
};

/** In-progress workout, persisted so a crash / app close doesn't lose it. */
export type ActiveSet = {
  id: string;
  reps: number | "";
  weight: number | "";
  is_warmup: boolean;
  rir: number | null;
  done: boolean;
  pr?: string[];
};
export type ActiveExercise = { id: string; exercise_id: string; sets: ActiveSet[]; rest_sec?: number; target_reps?: string };
export type ActiveWorkout = {
  key: "active";
  id: string;
  started_at: string;
  routine_id: string | null;
  name: string | null;
  exercises: ActiveExercise[];
};

class LiftDB extends Dexie {
  workouts!: Table<WorkoutRow, string>;
  workout_exercises!: Table<WorkoutExerciseRow, string>;
  sets!: Table<SetRow, string>;
  outbox!: Table<OutboxItem, number>;
  active!: Table<ActiveWorkout, string>;
  meta!: Table<{ key: string; value: unknown }, string>;
  measurements!: Table<MeasurementRow, string>;
  photos!: Table<PhotoRow, string>;
  custom_exercises!: Table<CustomExerciseRow, string>;
  routines!: Table<RoutineRow, string>;
  routine_exercises!: Table<RoutineExerciseRow, string>;
  planned_days!: Table<PlannedDayRow, string>;

  constructor() {
    super("lift");
    this.version(1).stores({
      workouts: "id, started_at",
      workout_exercises: "id, workout_id, exercise_id",
      sets: "id, workout_exercise_id",
      outbox: "++seq",
      active: "key",
      meta: "key",
    });
    this.version(2).stores({
      measurements: "id, type, date, [type+date]",
      photos: "id, taken_at",
    });
    this.version(3).stores({
      custom_exercises: "id, name",
    });
    this.version(4).stores({
      routines: "id, created_at",
      routine_exercises: "id, routine_id",
    });
    this.version(5).stores({
      planned_days: "id, &date",
    });
  }
}

export const db = new LiftDB();

/** crypto.randomUUID only exists on https/localhost; fall back for testing over LAN http. */
export const uuid = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16),
      );
