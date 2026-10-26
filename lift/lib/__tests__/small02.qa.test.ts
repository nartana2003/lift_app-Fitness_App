import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import { exportBackup, importBackup, parseBackup, serializeBackup, BACKUP_FORMAT } from "../dataExport";
import { parseLink } from "../social/oembed";
import { createRoutine, getRoutine } from "../routines";
import { planDay, getDay, routineUsedOnOtherDay, markGymDay } from "../planner";
import { addMiniToToday, isTodayCopy, safeThumbnailUrl } from "@/components/routines/MiniWorkoutCard";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const IMAGE = "data:image/png;base64,iVBORw==";
const backupText = (photos: unknown[]) =>
  JSON.stringify({ format: BACKUP_FORMAT, version: 1, exported_at: "2026-10-02T00:00:00.000Z", tables: { photos } });
const ph = (extra: Record<string, unknown>) => ({ id: "p", taken_at: "2026-09-01T00:00:00.000Z", pose: null, image: IMAGE, ...extra });
const blob = () => new Blob([new Uint8Array([1])]);

describe("QA photo workout_id", () => {
  it.each([[5], [true], [{}], [["w"]], [0]])("rejects non-text workout_id %j", (v) => {
    expect(parseBackup(backupText([ph({ workout_id: v })])).ok).toBe(false);
  });

  it("orphan workout id (no such workout) imports and round-trips", async () => {
    const p = parseBackup(backupText([ph({ workout_id: "ghost" })]));
    if (!p.ok) throw new Error(p.error);
    await importBackup(p.backup);
    expect(((await db.photos.get("p")) as { workout_id?: string }).workout_id).toBe("ghost");
    const again = parseBackup(serializeBackup(await exportBackup()));
    expect(again.ok && again.backup.tables.photos[0].workout_id).toBe("ghost");
  });

  it("empty-string workout_id never writes a link", async () => {
    const p = parseBackup(backupText([ph({ workout_id: "" })]));
    if (!p.ok) return;
    await importBackup(p.backup);
    expect("workout_id" in ((await db.photos.get("p")) as object)).toBe(false);
  });

  it("export omits non-string / empty link on a dirty local row", async () => {
    await db.photos.bulkPut([
      { id: "a", taken_at: "t", pose: null, blob: blob(), workout_id: 7 },
      { id: "b", taken_at: "t", pose: null, blob: blob(), workout_id: "" },
      { id: "c", taken_at: "t", pose: null, blob: blob(), workout_id: null },
    ] as never);
    const b = await exportBackup();
    for (const p of b.tables.photos) expect("workout_id" in p).toBe(false);
  });

  it("unknown extra photo key does not leak into stored row", async () => {
    const p = parseBackup(backupText([ph({ workout_id: "w", evil: "x" })]));
    if (!p.ok) return;
    await importBackup(p.backup);
    expect("evil" in ((await db.photos.get("p")) as object)).toBe(false);
  });
});

describe("QA vt.tiktok.com host checks", () => {
  it("accepts uppercase host, canonicalised lowercase", () => {
    expect(parseLink("https://VT.TikTok.COM/ZS1/")).toEqual({ url: "https://vt.tiktok.com/ZS1/", platform: "tiktok" });
  });
  it.each([
    "https://vt.tiktok.com./x",
    "https://VT.TIKTOK.COM.:443/x",
    "https://u:p@vt.tiktok.com/x",
    "https://vt.tiktok.com@evil.com/x",
    "https://evil.com#@vt.tiktok.com/",
    "https://evil.com\\@vt.tiktok.com/",
    "https://vt.tiktok.com.evil.com/x",
    "https://xn--vt.tiktok.com/x",
    "https://vt.xn--tiktok-9ya.com/x",
    "https://vт.tiktok.com/x",
    "https://a.vt.tiktok.com/x",
    "https://vt.tiktok.co/x",
    "http://vt.tiktok.com/x",
    "//vt.tiktok.com/x",
    "https:vt.tiktok.com/x",
    "javascript://vt.tiktok.com/%0aalert(1)",
  ])("rejects %s", (u) => {
    expect(parseLink(u)).toBeNull();
  });
  it("rejects non-strings and huge input", () => {
    for (const v of [null, undefined, 5, {}, []]) expect(parseLink(v)).toBeNull();
    expect(parseLink("https://vt.tiktok.com/" + "a".repeat(3000))).toBeNull();
  });
});

describe("QA createRoutine link fields", () => {
  it("existing-style caller: same row shape as before", async () => {
    const id = await createRoutine({ name: "  ", exercises: [{ exercise_id: "e1", target_sets: 0 }] });
    const r = (await getRoutine(id))!;
    expect(r.name).toBe("My routine");
    expect(r.source_url).toBeNull();
    expect(r.exercises[0].target_sets).toBe(1);
    expect("split_day_id" in r).toBe(false);
    expect((await db.outbox.toArray()).filter((o) => o.table === "routines")).toHaveLength(1);
  });
  it("split_day_id null / empty writes null", async () => {
    const a = (await getRoutine(await createRoutine({ name: "a", exercises: [], split_day_id: null })))!;
    const b = (await getRoutine(await createRoutine({ name: "b", exercises: [], split_day_id: "" })))!;
    expect(a.split_day_id).toBeNull();
    expect(b.split_day_id).toBeNull();
  });
  it("non-https thumbnail does not throw; rendering guard rejects it", async () => {
    const id = await createRoutine({ name: "t", exercises: [], thumbnail_url: "http://x.test/a.jpg" });
    const r = (await getRoutine(id))!;
    expect(safeThumbnailUrl(r.thumbnail_url)).toBeNull();
    expect(safeThumbnailUrl("javascript:alert(1)")).toBeNull();
  });
  it("several link saves give one routines upsert each", async () => {
    for (let i = 0; i < 5; i++)
      await createRoutine({ name: "n" + i, exercises: [{ exercise_id: "e" }], source: "social", source_url: "https://www.tiktok.com/@a/video/" + i, platform: "tiktok" });
    const ups = (await db.outbox.toArray()).filter((o) => o.table === "routines");
    expect(ups).toHaveLength(5);
    expect(new Set(ups.map((o) => (o.row as { id: string }).id)).size).toBe(5);
  });
});

describe("QA addMiniToToday reuse rules", () => {
  const NOW = new Date(2026, 9, 20, 12, 0, 0);
  const TODAY = "2026-10-20";
  const mk = (name: string, ids: string[]) => createRoutine({ name, exercises: ids.map((exercise_id) => ({ exercise_id })) });
  const ids = async (rid: string) => (await getRoutine(rid))!.exercises.map((e) => e.exercise_id);

  it("same mini twice on a day: one copy, second says already", async () => {
    const base = await mk("Base", ["a"]);
    const mini = await mk("Mini", ["b"]);
    await planDay(TODAY, base);
    await addMiniToToday(mini, NOW);
    const first = (await getDay(TODAY))!.routine_id!;
    expect(await addMiniToToday(mini, NOW)).toBe("Already planned for today.");
    expect((await getDay(TODAY))!.routine_id).toBe(first);
    expect(isTodayCopy((await getRoutine(first))!)).toBe(true);
    expect((await db.routines.toArray()).length).toBe(3);
  });

  it("two different minis reuse the same copy", async () => {
    const base = await mk("Base", ["a"]);
    const m1 = await mk("M1", ["b"]);
    const m2 = await mk("M2", ["c"]);
    await planDay(TODAY, base);
    await addMiniToToday(m1, NOW);
    const copy = (await getDay(TODAY))!.routine_id!;
    await addMiniToToday(m2, NOW);
    expect((await getDay(TODAY))!.routine_id).toBe(copy);
    expect(await ids(copy)).toEqual(["a", "b", "c"]);
    expect((await db.routines.toArray()).length).toBe(4);
  });

  it("copy shared with another day is not changed; fresh copy for today", async () => {
    const base = await mk("Base", ["a"]);
    const m1 = await mk("M1", ["b"]);
    const m2 = await mk("M2", ["c"]);
    await planDay(TODAY, base);
    await addMiniToToday(m1, NOW);
    const shared = (await getDay(TODAY))!.routine_id!;
    await planDay("2026-10-22", shared);
    await addMiniToToday(m2, NOW);
    const now = (await getDay(TODAY))!.routine_id!;
    expect(now).not.toBe(shared);
    expect(await ids(shared)).toEqual(["a", "b"]);
    expect(await ids(now)).toEqual(["a", "b", "c"]);
    expect(await routineUsedOnOtherDay(shared, TODAY)).toBe(true);
  });

  it("copy used by a done day elsewhere is also protected", async () => {
    const base = await mk("Base", ["a"]);
    const m1 = await mk("M1", ["b"]);
    const m2 = await mk("M2", ["c"]);
    await planDay(TODAY, base);
    await addMiniToToday(m1, NOW);
    const shared = (await getDay(TODAY))!.routine_id!;
    await planDay("2026-10-10", shared);
    const old = (await getDay("2026-10-10"))!;
    await db.planned_days.put({ ...old, status: "done", workout_id: "w" });
    await addMiniToToday(m2, NOW);
    expect(await ids(shared)).toHaveLength(2);
    expect((await getDay(TODAY))!.routine_id).not.toBe(shared);
  });

  it.each(["done", "skipped", "moved"] as const)("a %s today is left alone", async (status) => {
    const base = await mk("Base", ["a"]);
    const mini = await mk("Mini", ["b"]);
    await planDay(TODAY, base);
    const d = (await getDay(TODAY))!;
    await db.planned_days.put({ ...d, status });
    expect(await addMiniToToday(mini, NOW)).toMatch(/already done, skipped or moved/);
    expect((await getDay(TODAY))!.routine_id).toBe(base);
  });

  it("planned row with null routine plans the mini itself", async () => {
    const mini = await mk("Mini", ["b"]);
    await markGymDay(TODAY);
    expect(await addMiniToToday(mini, NOW)).toBe("Planned for today.");
    expect((await getDay(TODAY))!.routine_id).toBe(mini);
  });

  it("empty or missing mini changes nothing", async () => {
    const empty = await mk("E", []);
    await addMiniToToday(empty, NOW);
    await addMiniToToday("nope", NOW);
    expect(await getDay(TODAY)).toBeUndefined();
  });

  it("user routine with other notes is never edited in place", async () => {
    const base = await createRoutine({ name: "Base", exercises: [{ exercise_id: "a" }], notes: "Mine" });
    const mini = await mk("Mini", ["b"]);
    await planDay(TODAY, base);
    await addMiniToToday(mini, NOW);
    expect(await ids(base)).toHaveLength(1);
    expect((await getDay(TODAY))!.routine_id).not.toBe(base);
  });
});

describe("QA vt.tiktok.com URL normalisation", () => {
  it.each(["https://vt.tiktok.com:443/x", "https://vt.tiktok.com:/x", "https://:@vt.tiktok.com/x", "https:///vt.tiktok.com/x"])(
    "%s, if accepted, is the canonical vt host with no port or credentials",
    (u) => {
      const r = parseLink(u);
      if (r) expect(r).toEqual({ url: "https://vt.tiktok.com/x", platform: "tiktok" });
    },
  );
});
