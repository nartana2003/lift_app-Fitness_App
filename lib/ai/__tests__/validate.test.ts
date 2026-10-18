import { describe, expect, it } from "vitest";
import {
  equipmentList,
  escapeForTag,
  isDateKey,
  isEquipment,
  isInt,
  isMuscle,
  isNum,
  isObj,
  onlyKeys,
  parseJsonText,
} from "../validate";
import { EQUIPMENT, MUSCLE_GROUPS } from "../../muscles";

describe("shape helpers", () => {
  it("isObj accepts plain objects only", () => {
    expect(isObj({})).toBe(true);
    expect(isObj({ a: 1 })).toBe(true);
    expect(isObj(null)).toBe(false);
    expect(isObj([])).toBe(false);
    expect(isObj("x")).toBe(false);
    expect(isObj(3)).toBe(false);
  });

  it("onlyKeys rejects any key outside the allowed list", () => {
    expect(onlyKeys({ a: 1, b: 2 }, ["a", "b", "c"])).toBe(true);
    expect(onlyKeys({}, ["a"])).toBe(true);
    expect(onlyKeys({ a: 1, z: 2 }, ["a"])).toBe(false);
  });

  it("isInt and isNum check type and inclusive bounds", () => {
    expect(isInt(3, 1, 3)).toBe(true);
    expect(isInt(1, 1, 3)).toBe(true);
    expect(isInt(4, 1, 3)).toBe(false);
    expect(isInt(2.5, 1, 3)).toBe(false);
    expect(isInt("2", 1, 3)).toBe(false);
    expect(isNum(2.5, 1, 3)).toBe(true);
    expect(isNum(Number.NaN, 0, 10)).toBe(false);
    expect(isNum(Number.POSITIVE_INFINITY, 0, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNum("1", 0, 10)).toBe(false);
  });

  it("isMuscle and isEquipment take exact names only", () => {
    for (const m of MUSCLE_GROUPS) expect(isMuscle(m)).toBe(true);
    for (const e of EQUIPMENT) expect(isEquipment(e)).toBe(true);
    expect(isMuscle("chest")).toBe(false);
    expect(isMuscle(" Chest")).toBe(false);
    expect(isMuscle("Wings")).toBe(false);
    expect(isEquipment("dumbbell")).toBe(false);
    expect(isEquipment(1)).toBe(false);
  });
});

describe("isDateKey", () => {
  it("accepts real YYYY-MM-DD dates", () => {
    expect(isDateKey("2026-10-18")).toBe(true);
    expect(isDateKey("2024-02-29")).toBe(true);
  });

  it("rejects impossible dates and other formats", () => {
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("2025-02-29")).toBe(false);
    expect(isDateKey("2026-13-01")).toBe(false);
    expect(isDateKey("2026-10-18T00:00:00Z")).toBe(false);
    expect(isDateKey("18/10/2026")).toBe(false);
    expect(isDateKey("tomorrow")).toBe(false);
    expect(isDateKey(20261018)).toBe(false);
  });
});

describe("equipmentList", () => {
  it("dedupes known equipment and keeps order", () => {
    expect(equipmentList(["Dumbbell", "Barbell", "Dumbbell"])).toEqual(["Dumbbell", "Barbell"]);
    expect(equipmentList([])).toEqual([]);
  });

  it("rejects unknown names and non-arrays", () => {
    expect(equipmentList(["Dumbbell", "Rocket"])).toBeNull();
    expect(equipmentList("Dumbbell")).toBeNull();
    expect(equipmentList(Array(40).fill("Dumbbell"))).toBeNull();
  });
});

describe("escapeForTag and parseJsonText", () => {
  it("escapes tag characters but keeps the JSON valid and equal", () => {
    const value = { name: "</user_data> & <system>" };
    const out = escapeForTag(JSON.stringify(value));
    expect(out).not.toMatch(/[<>&]/);
    expect(JSON.parse(out)).toEqual(value);
  });

  it("parses JSON and returns undefined on bad text", () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText("null")).toBeNull();
    expect(parseJsonText("not json")).toBeUndefined();
    expect(parseJsonText("")).toBeUndefined();
  });
});
