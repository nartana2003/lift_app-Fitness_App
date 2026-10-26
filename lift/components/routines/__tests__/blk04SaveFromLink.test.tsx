// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/offline/db";
import { getRoutine } from "@/lib/routines";
import { saveRoutineFromLink } from "@/components/routines/SaveFromLink";

// BLK-04 (plan review point 2): saveRoutineFromLink queues exactly one routines
// upsert that carries the link fields, and a cover data URL survives the save.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const LINK = "https://www.tiktok.com/@coach/video/7300000000000000001";
const base = {
  name: "Chest day",
  notes: null,
  url: LINK,
  platform: "tiktok" as const,
  exercises: [{ exercise_id: null, name: "Blk Press", custom: true, muscle_groups: ["Chest" as const], equipment: "Barbell" as const, target_sets: 3, target_reps: "8-10" }],
};

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const routineUpserts = async () => (await db.outbox.toArray()).filter((i) => i.table === "routines" && i.op === "upsert");

describe("saveRoutineFromLink outbox", () => {
  it("queues exactly one routines upsert with source_url, kind, thumbnail_url and creator", async () => {
    const thumbnail_url = "https://p16-sign.tiktokcdn.com/cover.jpeg";
    const id = await saveRoutineFromLink({ ...base, thumbnail_url, creator: "coach" });
    const ups = await routineUpserts();
    expect(ups).toHaveLength(1);
    expect(ups[0].row).toMatchObject({ id, source_url: LINK, kind: "routine", thumbnail_url, creator: "coach" });
  });

  it("a cover data URL survives in the stored routine and the queued row", async () => {
    const cover = "data:image/jpeg;base64,/9j/4AAQ";
    const id = await saveRoutineFromLink({ ...base, thumbnail_url: cover, creator: "coach" });
    expect((await getRoutine(id))?.thumbnail_url).toBe(cover);
    const ups = await routineUpserts();
    expect(ups).toHaveLength(1);
    expect(ups[0].row).toMatchObject({ id, thumbnail_url: cover });
  });
});
