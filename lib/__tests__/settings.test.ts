import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import { DEFAULT_SETTINGS, saveSettings, type Settings } from "../settings";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const stored = async () => (await db.meta.get("settings"))?.value as Partial<Settings> | undefined;

describe("settings", () => {
  it("defaults to kg and a Monday week start", () => {
    expect(DEFAULT_SETTINGS).toEqual({ unit: "kg", weekStart: 1 });
  });

  it("stores only what was changed", async () => {
    expect(await stored()).toBeUndefined();
    await saveSettings({ unit: "lb" });
    expect(await stored()).toEqual({ unit: "lb" });
  });

  it("merges later patches into the stored copy", async () => {
    await saveSettings({ unit: "lb" });
    await saveSettings({ weekStart: 0 });
    expect(await stored()).toEqual({ unit: "lb", weekStart: 0 });
    await saveSettings({ unit: "kg" });
    expect(await stored()).toEqual({ unit: "kg", weekStart: 0 });
  });

  it("does not lose a patch when two saves run at once", async () => {
    await Promise.all([saveSettings({ unit: "lb" }), saveSettings({ weekStart: 0 })]);
    expect(await stored()).toEqual({ unit: "lb", weekStart: 0 });
  });

  it("leaves the defaults object untouched", async () => {
    await saveSettings({ unit: "lb", weekStart: 0 });
    expect(DEFAULT_SETTINGS).toEqual({ unit: "kg", weekStart: 1 });
  });
});
