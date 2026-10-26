import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import { tiktokUrl } from "../muscles";
import { createCustomExercise, deleteCustomExercise, ensureCustomExercise, isCustomId } from "../customExercises";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("custom exercise ids", () => {
  it("recognises the custom- prefix only", () => {
    expect(isCustomId("custom-123")).toBe(true);
    expect(isCustomId("Barbell_Bench_Press")).toBe(false);
    expect(isCustomId("my-custom-lift")).toBe(false);
  });
});

describe("creating custom exercises", () => {
  it("fills defaults and trims the name", async () => {
    const row = await createCustomExercise({ name: "  Landmine press " });
    expect(isCustomId(row.id)).toBe(true);
    expect(row).toMatchObject({
      name: "Landmine press",
      muscle_groups: [],
      secondary_groups: [],
      equipment: "Other",
      category: "strength",
      mechanic: null,
      force: null,
      level: "beginner",
      instructions: [],
      image_urls: [],
      custom: true,
      tiktok_url: tiktokUrl("Landmine press"),
    });
    expect(await db.custom_exercises.get(row.id)).toEqual(row);
  });

  it("keeps the details the user gave", async () => {
    const row = await createCustomExercise({
      name: "Cable fly",
      muscle_groups: ["Chest"],
      equipment: "Machine/Cable",
      video_url: "https://example.com/v",
      instructions: ["Squeeze at the top"],
    });
    expect(row.muscle_groups).toEqual(["Chest"]);
    expect(row.equipment).toBe("Machine/Cable");
    expect(row.video_url).toBe("https://example.com/v");
    expect(row.instructions).toEqual(["Squeeze at the top"]);
  });

  it("gives every exercise its own id", async () => {
    const a = await createCustomExercise({ name: "A" });
    const b = await createCustomExercise({ name: "A" });
    expect(a.id).not.toBe(b.id);
  });

  it("queues an upsert to the shared exercises table without the local-only marker", async () => {
    const row = await createCustomExercise({ name: "Sissy squat" });
    const outbox = await db.outbox.orderBy("seq").toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ table: "exercises", op: "upsert", row: { id: row.id, name: "Sissy squat" } });
    expect(outbox[0].row).not.toHaveProperty("custom");
    expect((await db.custom_exercises.get(row.id))!.custom).toBe(true);
  });
});

describe("finding or creating", () => {
  it("reuses an existing exercise matched by name, ignoring case and outer spaces", async () => {
    const original = await createCustomExercise({ name: "Jefferson curl" });
    const found = await ensureCustomExercise("  jefferson CURL ");
    expect(found.id).toBe(original.id);
    expect(await db.custom_exercises.count()).toBe(1);
  });

  it("creates one with the extra details when none matches", async () => {
    const made = await ensureCustomExercise("Nordic curl", { muscle_groups: ["Hamstrings"] });
    expect(made.name).toBe("Nordic curl");
    expect(made.muscle_groups).toEqual(["Hamstrings"]);
    expect(await db.custom_exercises.count()).toBe(1);
  });
});

describe("deleting", () => {
  it("removes the exercise locally", async () => {
    const keep = await createCustomExercise({ name: "Keep" });
    const row = await createCustomExercise({ name: "Temp" });
    await deleteCustomExercise(row.id);
    expect(await db.custom_exercises.get(row.id)).toBeUndefined();
    expect(await db.custom_exercises.get(keep.id)).toEqual(keep);
  });

  it("queues a remote delete", async () => {
    const row = await createCustomExercise({ name: "Temp" });
    await deleteCustomExercise(row.id);
    const queued = await db.outbox.toArray();
    expect(queued.some((q) => q.table === "exercises" && q.op === "delete" && q.row.id === row.id)).toBe(true);
  });
});

describe("thumbnail", () => {
  it("becomes the exercise picture", async () => {
    const row = await createCustomExercise({ name: "Clip", thumbnail_url: "https://img.example.com/t.jpg" });
    expect(row.image_urls).toEqual(["https://img.example.com/t.jpg"]);
  });
});
