import { describe, expect, it } from "vitest";
import {
  customExerciseFromRemote,
  dedupePlannedDays,
  isOwnPhotoPath,
  measurementFromRemote,
  photoPath,
  photoSignature,
  plannedDayFromRemote,
  remotePhotoFromRow,
  routineExerciseFromRemote,
  routineFromRemote,
  toRemoteRow,
  splitPlannedDays,
} from "../remote";
import type { PlannedDayRow } from "../db";

const UID = "11111111-1111-4111-8111-111111111111";

const day = (o: Partial<PlannedDayRow> = {}): PlannedDayRow => ({
  id: "d1",
  date: "2026-10-26",
  routine_id: null,
  status: "planned",
  workout_id: null,
  skip_reason: null,
  skip_note: null,
  moved_to: null,
  moved_from: null,
  created_at: "2026-10-20T10:00:00.000Z",
  ...o,
});

describe("toRemoteRow", () => {
  it("owns custom exercises and drops the local marker", () => {
    const out = toRemoteRow("exercises", { id: "custom-1", name: "X", custom: true, owner_id: "someone-else" }, UID);
    expect(out).toEqual({ id: "custom-1", name: "X", owner_id: UID });
  });

  it("planned_days uses the app's moved_to/moved_from dates and an explicit was_marked", () => {
    const row = { ...day({ status: "moved", moved_to: "2026-10-28" }) };
    const out = toRemoteRow("planned_days", row, UID);
    expect(out.moved_to).toBe("2026-10-28");
    expect(out.was_marked).toBe(false);
    expect(out).not.toHaveProperty("moved_to_id");
    expect(toRemoteRow("planned_days", { ...row, was_marked: true }, UID).was_marked).toBe(true);
  });

  it("routines always send split_day_id", () => {
    expect(toRemoteRow("routines", { id: "r" }, UID).split_day_id).toBeNull();
    expect(toRemoteRow("routines", { id: "r", split_day_id: "" }, UID).split_day_id).toBeNull();
    expect(toRemoteRow("routines", { id: "r", split_day_id: "day-1" }, UID).split_day_id).toBe("day-1");
  });

  it("leaves other tables untouched", () => {
    const row = { id: "w", started_at: "x" };
    expect(toRemoteRow("workouts", row, UID)).toBe(row);
  });
});

describe("from remote", () => {
  it("planned day keeps local fields only and validates", () => {
    const out = plannedDayFromRemote({
      ...day({ moved_from: "2026-10-25" }),
      user_id: UID,
      moved_to_id: "x",
      was_marked: true,
      status: "planned",
      skip_reason: "bogus",
      date: "2026-10-26",
    });
    expect(out).toEqual({ ...day({ moved_from: "2026-10-25" }), was_marked: true });
    expect(plannedDayFromRemote({ id: "x", date: "nope" })).toBeNull();
    expect(plannedDayFromRemote({ id: "x", date: "2026-10-01", status: "weird" })?.status).toBe("planned");
    expect(plannedDayFromRemote({ ...day(), was_marked: false })).not.toHaveProperty("was_marked");
  });

  it("dedupes planned days by date, newest wins", () => {
    const a = day({ id: "a", created_at: "2026-10-01T00:00:00Z" });
    const b = day({ id: "b", created_at: "2026-10-02T00:00:00Z" });
    const c = day({ id: "c", date: "2026-10-27" });
    expect(dedupePlannedDays([a, b, c]).map((d) => d.id).sort()).toEqual(["b", "c"]);
    expect(dedupePlannedDays([b, a]).map((d) => d.id)).toEqual(["b"]);
  });

  it("routine maps split_day_id and enums", () => {
    const r = routineFromRemote({ id: "r", name: "Push", source: "evil", kind: "mini", platform: "myspace", split_day_id: "d", user_id: UID });
    expect(r).toMatchObject({ id: "r", name: "Push", source: "manual", kind: "mini", platform: null, split_day_id: "d" });
    expect(r).not.toHaveProperty("user_id");
    expect(routineFromRemote({ id: "r", name: "Push" })).not.toHaveProperty("split_day_id");
    expect(routineFromRemote({ id: "r" })).toBeNull();
  });

  it("routine exercise, measurement and custom exercise", () => {
    expect(routineExerciseFromRemote({ id: "e", routine_id: "r", exercise_id: "Bench", position: 2, target_sets: 4, target_reps: "6-8", rest_sec: 90 })).toEqual({
      id: "e",
      routine_id: "r",
      exercise_id: "Bench",
      position: 2,
      target_sets: 4,
      target_reps: "6-8",
    });
    expect(measurementFromRemote({ id: "m", type: "weight", value: "80.5", date: "2026-10-01" })).toEqual({ id: "m", type: "weight", value: 80.5, date: "2026-10-01" });
    expect(measurementFromRemote({ id: "m", type: "weight", value: "x", date: "2026-10-01" })).toBeNull();
    const c = customExerciseFromRemote({ id: "custom-1", name: "Hip thrust", muscle_groups: ["Glutes", 3], video_url: "https://youtu.be/x", owner_id: UID });
    expect(c).toMatchObject({ id: "custom-1", muscle_groups: ["Glutes"], custom: true, video_url: "https://youtu.be/x" });
    expect(customExerciseFromRemote({ id: "Bench_Press", name: "Bench" })).toBeNull();
  });
});

describe("photos", () => {
  it("paths live in the user's folder", () => {
    expect(photoPath(UID, "p1")).toBe(`${UID}/p1.jpg`);
    expect(isOwnPhotoPath(UID, `${UID}/p1.jpg`)).toBe(true);
    expect(isOwnPhotoPath(UID, `other/p1.jpg`)).toBe(false);
    expect(isOwnPhotoPath(UID, `${UID}/../other/p1.jpg`)).toBe(false);
    expect(isOwnPhotoPath(UID, `${UID}/a/b.jpg`)).toBe(false);
    expect(isOwnPhotoPath(UID, 5)).toBe(false);
  });

  it("signature changes when the image is replaced", () => {
    const base = { taken_at: "t", pose: "front", blob: { size: 10, type: "image/jpeg" }, workout_id: "w" };
    expect(photoSignature(base)).toBe(photoSignature({ ...base }));
    expect(photoSignature(base)).not.toBe(photoSignature({ ...base, blob: { size: 11, type: "image/jpeg" } }));
    expect(photoSignature(base)).not.toBe(photoSignature({ ...base, pose: null }));
  });

  it("validates server photo rows", () => {
    const ok = { id: "p", taken_at: "2026-10-01T09:00:00Z", pose: "side", storage_path: `${UID}/p.jpg`, workout_id: null };
    expect(remotePhotoFromRow(UID, ok)).toEqual(ok);
    expect(remotePhotoFromRow(UID, { ...ok, pose: "upside" })?.pose).toBeNull();
    expect(remotePhotoFromRow(UID, { ...ok, storage_path: "other/p.jpg" })).toBeNull();
    expect(remotePhotoFromRow(UID, { ...ok, taken_at: "never" })).toBeNull();
  });
});

describe("splitPlannedDays keeps workout links", () => {
  it("a winner without a workout takes the loser's link and is reported for upload", () => {
    const loser = day({ id: "l", status: "planned", workout_id: "w1", created_at: "2026-10-01T00:00:00Z" });
    const winner = day({ id: "w", status: "planned", workout_id: null, created_at: "2026-10-05T00:00:00Z" });
    const r = splitPlannedDays([loser, winner]);
    expect(r.keep).toEqual([{ ...winner, workout_id: "w1" }]);
    expect(r.losers.map((x) => x.id)).toEqual(["l"]);
    expect(r.relinked).toEqual([{ ...winner, workout_id: "w1" }]);
  });

  it("a done winner keeps its own link", () => {
    const done = day({ id: "d", status: "done", workout_id: "wd" });
    const other = day({ id: "o", workout_id: "wo", created_at: "2026-10-30T00:00:00Z" });
    const r = splitPlannedDays([other, done]);
    expect(r.keep).toEqual([done]);
    expect(r.relinked).toEqual([]);
  });
});
