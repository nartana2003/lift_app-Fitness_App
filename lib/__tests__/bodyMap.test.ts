import { describe, expect, it } from "vitest";
import { MUSCLE_GROUPS } from "../muscles";
import { bodyMapData, GROUP_MAP, intensityLevel } from "../bodyMap";

describe("body map", () => {
  it("every muscle group is mapped", () => {
    for (const g of MUSCLE_GROUPS) expect(GROUP_MAP[g].muscles.length).toBeGreaterThan(0);
  });

  it("shade levels by sets", () => {
    expect([0, 1, 3, 4, 7, 8, 11, 12, 30].map(intensityLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("only returns muscles for the requested side, repeated by shade level", () => {
    const sets = { Chest: 9, Glutes: 5, Quads: 0 };
    const front = bodyMapData(sets, "anterior");
    expect(front).toHaveLength(3); // chest at level 3
    expect(front.every((d) => d.muscles.includes("chest"))).toBe(true);
    const back = bodyMapData(sets, "posterior");
    expect(back).toHaveLength(2); // glutes at level 2
    expect(back[0].muscles).toEqual(["gluteal"]);
  });
});
