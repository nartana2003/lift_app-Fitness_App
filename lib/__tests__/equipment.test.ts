import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../offline/db";
import { EQUIPMENT, type Equipment } from "../muscles";
import {
  EQUIPMENT_KEY,
  equipmentForAi,
  equipmentSummary,
  getEquipment,
  missingEquipment,
  normalizeEquipment,
  saveEquipment,
  toggleEquipment,
  toggleEquipmentIn,
} from "../equipment";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const stored = async () => (await db.meta.get(EQUIPMENT_KEY))?.value;
const ALL = [...EQUIPMENT];

describe("normalizeEquipment", () => {
  it("treats missing or malformed values as a full gym", () => {
    expect(normalizeEquipment(undefined)).toEqual(ALL);
    expect(normalizeEquipment(null)).toEqual(ALL);
    expect(normalizeEquipment("Dumbbell")).toEqual(ALL);
    expect(normalizeEquipment({ Dumbbell: true })).toEqual(ALL);
    expect(normalizeEquipment([])).toEqual(ALL);
    expect(normalizeEquipment(["Treadmill", 4])).toEqual(ALL);
  });

  it("drops unknown values and duplicates and keeps catalogue order", () => {
    expect(normalizeEquipment(["Bodyweight", "Dumbbell", "Rowing machine", "Dumbbell", "dumbbell"])).toEqual(["Dumbbell", "Bodyweight"]);
  });
});

describe("toggleEquipmentIn", () => {
  it("unticks a bucket the user has", () => {
    expect(toggleEquipmentIn(ALL, "Barbell")).toEqual(ALL.filter((e) => e !== "Barbell"));
  });

  it("ticks a bucket back in catalogue order", () => {
    expect(toggleEquipmentIn(["Bodyweight", "Dumbbell"], "Barbell")).toEqual(["Dumbbell", "Barbell", "Bodyweight"]);
  });

  it("refuses to untick the last bucket", () => {
    expect(toggleEquipmentIn(["Bands"], "Bands")).toEqual(["Bands"]);
  });

  it("does not mutate its input", () => {
    const list: Equipment[] = ["Dumbbell", "Bodyweight"];
    toggleEquipmentIn(list, "Dumbbell");
    expect(list).toEqual(["Dumbbell", "Bodyweight"]);
  });
});

describe("AI and summary helpers", () => {
  it("sends a full gym to the AI routes as an empty list (no restriction)", () => {
    expect(equipmentForAi(ALL)).toEqual([]);
  });

  it("sends a partial gym as the ticked list", () => {
    expect(equipmentForAi(["Bodyweight", "Dumbbell"])).toEqual(["Dumbbell", "Bodyweight"]);
  });

  it("lists what is missing", () => {
    expect(missingEquipment(ALL)).toEqual([]);
    expect(missingEquipment(["Dumbbell", "Bodyweight"])).toEqual(["Machine/Cable", "Barbell", "Bands", "Kettlebell", "Other"]);
  });

  it("summarises a full gym and a partial one", () => {
    expect(equipmentSummary(ALL)).toBe("Full gym");
    expect(equipmentSummary(["Bodyweight", "Dumbbell"])).toBe("Dumbbell, Bodyweight");
  });
});

describe("equipment storage", () => {
  it("returns every bucket before anything is saved", async () => {
    expect(await getEquipment()).toEqual(ALL);
    expect(await stored()).toBeUndefined();
  });

  it("saves a cleaned list and reads it back", async () => {
    expect(await saveEquipment(["Bodyweight", "Dumbbell", "Bodyweight"])).toEqual(["Dumbbell", "Bodyweight"]);
    expect(await stored()).toEqual(["Dumbbell", "Bodyweight"]);
    expect(await getEquipment()).toEqual(["Dumbbell", "Bodyweight"]);
  });

  it("toggles one bucket and persists the result", async () => {
    expect(await toggleEquipment("Barbell")).toEqual(ALL.filter((e) => e !== "Barbell"));
    expect(await getEquipment()).toEqual(ALL.filter((e) => e !== "Barbell"));
    expect(await toggleEquipment("Barbell")).toEqual(ALL);
  });

  it("keeps the last bucket ticked", async () => {
    await saveEquipment(["Kettlebell"]);
    expect(await toggleEquipment("Kettlebell")).toEqual(["Kettlebell"]);
    expect(await stored()).toEqual(["Kettlebell"]);
  });

  it("recovers from a corrupted stored value", async () => {
    await db.meta.put({ key: EQUIPMENT_KEY, value: "garbage" });
    expect(await getEquipment()).toEqual(ALL);
  });
});
