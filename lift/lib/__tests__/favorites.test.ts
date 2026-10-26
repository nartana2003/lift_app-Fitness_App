import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import { toggleFavorite } from "../favorites";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const stored = async () => (await db.meta.get("favorites"))?.value as string[] | undefined;

describe("favorite exercises", () => {
  it("adds an exercise when it is not a favorite yet", async () => {
    await toggleFavorite("bench-press");
    expect(await stored()).toEqual(["bench-press"]);
  });

  it("puts the newest favorite first", async () => {
    await toggleFavorite("bench-press");
    await toggleFavorite("squat");
    await toggleFavorite("deadlift");
    expect(await stored()).toEqual(["deadlift", "squat", "bench-press"]);
  });

  it("removes an exercise when toggled again, keeping the others in order", async () => {
    await toggleFavorite("bench-press");
    await toggleFavorite("squat");
    await toggleFavorite("deadlift");
    await toggleFavorite("squat");
    expect(await stored()).toEqual(["deadlift", "bench-press"]);
  });

  it("does not lose favorites when several are toggled at once", async () => {
    await Promise.all([toggleFavorite("a"), toggleFavorite("b"), toggleFavorite("c")]);
    expect([...(await stored())!].sort()).toEqual(["a", "b", "c"]);
  });
});
