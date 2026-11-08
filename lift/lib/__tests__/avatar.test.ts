import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import { formatWorkoutDate, getAvatar, setAvatar } from "../avatar";

describe("formatWorkoutDate", () => {
  it("formats afternoon times", () => {
    expect(formatWorkoutDate(new Date(2026, 10, 27, 17, 30))).toBe("27 November, 2026 at 5:30 pm");
  });
  it("formats morning, noon and midnight", () => {
    expect(formatWorkoutDate(new Date(2026, 0, 5, 9, 5))).toBe("5 January, 2026 at 9:05 am");
    expect(formatWorkoutDate(new Date(2026, 0, 5, 12, 0))).toBe("5 January, 2026 at 12:00 pm");
    expect(formatWorkoutDate(new Date(2026, 0, 5, 0, 10))).toBe("5 January, 2026 at 12:10 am");
  });
});

describe("avatar storage", () => {
  beforeEach(async () => {
    await db.meta.clear();
  });
  it("is null until set, then round-trips and clears", async () => {
    expect(await getAvatar()).toBeNull();
    await setAvatar("data:image/jpeg;base64,AAAA");
    expect(await getAvatar()).toBe("data:image/jpeg;base64,AAAA");
    await setAvatar(null);
    expect(await getAvatar()).toBeNull();
  });
});
