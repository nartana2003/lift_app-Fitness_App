import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, type PhotoRow, type PlannedDayRow } from "../offline/db";
import { exportBackup, importBackup, parseBackup, serializeBackup, BACKUP_FORMAT } from "../dataExport";
import { ALLOWED_HOSTS, oembedUrl, parseLink } from "../social/oembed";
import { createRoutine, getRoutine } from "../routines";
import { planDay, routineUsedOnOtherDay } from "../planner";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const PNG = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
const photo = (id: string, o: Partial<PhotoRow> & { workout_id?: string } = {}) => ({
  id,
  taken_at: "2026-10-01T10:00:00.000Z",
  pose: "front" as const,
  blob: PNG,
  ...o,
});
const IMAGE = "data:image/png;base64,iVBORw==";
const backupText = (photos: unknown[]) =>
  JSON.stringify({ format: BACKUP_FORMAT, version: 1, exported_at: "2026-10-02T00:00:00.000Z", tables: { photos } });

// ---------- dataExport: a progress photo's workout link ----------

describe("backup keeps a progress photo's workout link", () => {
  it("exports workout_id for a linked photo and leaves it out for an unlinked one", async () => {
    await db.photos.bulkPut([photo("p1", { workout_id: "w1" }), photo("p2")]);
    const b = await exportBackup(new Date("2026-10-02T00:00:00.000Z"));
    const byId = Object.fromEntries(b.tables.photos.map((p) => [p.id, p]));
    expect(byId.p1.workout_id).toBe("w1");
    expect("workout_id" in byId.p2).toBe(false);
  });

  it("round-trips the link through export, parse and import", async () => {
    await db.photos.put(photo("p1", { workout_id: "w1" }));
    const text = serializeBackup(await exportBackup());
    await db.photos.clear();
    const parsed = parseBackup(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.tables.photos[0].workout_id).toBe("w1");
    const s = await importBackup(parsed.backup);
    expect(s.added.photos).toBe(1);
    const row = (await db.photos.get("p1")) as PhotoRow & { workout_id?: string };
    expect(row.workout_id).toBe("w1");
    expect(row.pose).toBe("front");
  });

  it("still imports an old backup whose photos have no workout_id, writing no link", async () => {
    const parsed = parseBackup(backupText([{ id: "old", taken_at: "2026-09-01T00:00:00.000Z", pose: null, image: IMAGE }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect("workout_id" in parsed.backup.tables.photos[0]).toBe(false);
    await importBackup(parsed.backup);
    const row = (await db.photos.get("old")) as PhotoRow & { workout_id?: string };
    expect(row).toBeDefined();
    expect("workout_id" in row).toBe(false);
  });

  it("treats a null workout_id as no link", async () => {
    const parsed = parseBackup(backupText([{ id: "n", taken_at: "2026-09-01T00:00:00.000Z", pose: null, image: IMAGE, workout_id: null }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await importBackup(parsed.backup);
    expect("workout_id" in ((await db.photos.get("n")) as object)).toBe(false);
  });

  it("rejects a workout_id that is not text", () => {
    const parsed = parseBackup(backupText([{ id: "x", taken_at: "2026-09-01T00:00:00.000Z", pose: null, image: IMAGE, workout_id: 5 }]));
    expect(parsed).toEqual({ ok: false, error: 'photos row 1: "workout_id" must be text or null' });
  });

  it("never overwrites a local photo's link on import", async () => {
    await db.photos.put(photo("p1", { workout_id: "local" }));
    const parsed = parseBackup(backupText([{ id: "p1", taken_at: "2026-09-01T00:00:00.000Z", pose: null, image: IMAGE, workout_id: "other" }]));
    if (!parsed.ok) throw new Error(parsed.error);
    const s = await importBackup(parsed.backup);
    expect(s.skipped.photos).toBe(1);
    expect(((await db.photos.get("p1")) as { workout_id?: string }).workout_id).toBe("local");
  });
});

// ---------- oEmbed: vt.tiktok.com ----------

describe("vt.tiktok.com share links", () => {
  it("is on the allow list as TikTok", () => {
    expect(ALLOWED_HOSTS["vt.tiktok.com"]).toBe("tiktok");
    expect(parseLink(" https://vt.tiktok.com/ZSabc123/ ")).toEqual({ url: "https://vt.tiktok.com/ZSabc123/", platform: "tiktok" });
  });

  it("is only ever a query parameter to the fixed TikTok endpoint", () => {
    const url = oembedUrl(parseLink("https://vt.tiktok.com/ZSabc123/")!)!;
    expect(url.startsWith("https://www.tiktok.com/oembed?")).toBe(true);
    expect(new URL(url).searchParams.get("url")).toBe("https://vt.tiktok.com/ZSabc123/");
  });

  it("still rejects lookalikes and tricks around the new host", () => {
    for (const bad of [
      "http://vt.tiktok.com/x",
      "https://vt.tiktok.com.evil.io/x",
      "https://evilvt.tiktok.com/x",
      "https://vt.tiktok.com./x",
      "https://vt.tiktok.com:8443/x",
      "https://user@vt.tiktok.com/x",
    ]) {
      expect(parseLink(bad), bad).toBeNull();
    }
  });
});

// ---------- createRoutine: optional link fields ----------

describe("createRoutine link fields", () => {
  it("writes the link fields in one step (one routines upsert)", async () => {
    const id = await createRoutine({
      name: "Ab finisher",
      exercises: [{ exercise_id: "crunch" }],
      source: "social",
      split_day_id: "day-1",
      source_url: "https://www.tiktok.com/@c/video/1",
      platform: "tiktok",
      thumbnail_url: "https://p16.example.com/t.jpg",
      creator: "@coach",
    });
    expect(await getRoutine(id)).toMatchObject({
      source_url: "https://www.tiktok.com/@c/video/1",
      platform: "tiktok",
      thumbnail_url: "https://p16.example.com/t.jpg",
      creator: "@coach",
      split_day_id: "day-1",
    });
    const routineRows = (await db.outbox.toArray()).filter((o) => o.table === "routines");
    expect(routineRows).toHaveLength(1);
    expect(routineRows[0].row).toMatchObject({ source_url: "https://www.tiktok.com/@c/video/1", platform: "tiktok", creator: "@coach" });
  });

  it("leaves existing callers unchanged: link fields null and no split_day_id field", async () => {
    const id = await createRoutine({ name: "Push", exercises: [{ exercise_id: "pushup" }] });
    const r = (await getRoutine(id))!;
    expect(r).toMatchObject({ source_url: null, platform: null, thumbnail_url: null, creator: null, source: "manual", kind: "routine" });
    expect("split_day_id" in r).toBe(false);
  });

  it("stores empty link text as null", async () => {
    const id = await createRoutine({ name: "X", exercises: [], source_url: "", thumbnail_url: "", creator: "", platform: null });
    expect(await getRoutine(id)).toMatchObject({ source_url: null, platform: null, thumbnail_url: null, creator: null });
  });
});

// ---------- planner: is a routine planned on another day ----------

describe("routineUsedOnOtherDay", () => {
  it("is false when only the given day uses the routine, or nobody does", async () => {
    expect(await routineUsedOnOtherDay("r1", "2026-10-12")).toBe(false);
    await planDay("2026-10-12", "r1");
    expect(await routineUsedOnOtherDay("r1", "2026-10-12")).toBe(false);
  });

  it("is true when another day plans the routine", async () => {
    await planDay("2026-10-12", "r1");
    await planDay("2026-10-15", "r1");
    expect(await routineUsedOnOtherDay("r1", "2026-10-12")).toBe(true);
  });

  it("counts other days in any status (done, skipped, moved)", async () => {
    await planDay("2026-10-12", "r1");
    const base = (await db.planned_days.toArray())[0];
    const other: PlannedDayRow = { ...base, id: "d2", date: "2026-10-05", status: "done", workout_id: "w1" };
    await db.planned_days.put(other);
    expect(await routineUsedOnOtherDay("r1", "2026-10-12")).toBe(true);
  });

  it("ignores other routines on other days", async () => {
    await planDay("2026-10-12", "r1");
    await planDay("2026-10-15", "r2");
    expect(await routineUsedOnOtherDay("r1", "2026-10-12")).toBe(false);
  });
});
