// @vitest-environment jsdom
// QA for LINK-02: grouping, remove-day question, ?day= parsing.
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { groupRoutinesBySplit } from "@/components/routines/RoutineList";
import { dayFromSearch } from "@/components/routines/RoutineEditor";
import { clearSplitQuestion, removeDayQuestion } from "@/components/goals/SplitEditor";

type R = { id: string; created_at: string; kind?: "mini" | "routine"; split_day_id?: string | null };
const r = (id: string, day?: string | null, extra: Partial<R> = {}): R => ({
  id,
  created_at: `2026-01-01T00:00:${id.padStart(2, "0").slice(-2)}Z`,
  split_day_id: day,
  ...extra,
});
const split = (...ids: (string | undefined)[]) => ({
  days: ids.map((id, i) => ({ name: `Day ${i + 1}`, muscles: [], ...(id ? { id } : {}) })),
}) as never;

describe("groupRoutinesBySplit (QA)", () => {
  it("returns null for an empty routine list and for an empty split", () => {
    expect(groupRoutinesBySplit([], split("a"))).toBeNull();
    expect(groupRoutinesBySplit([r("1", "a")], split())).toBeNull();
  });
  it("returns null when every link points to a removed day (stale ids)", () => {
    expect(groupRoutinesBySplit([r("1", "gone"), r("2", null), r("3")], split("a", "b"))).toBeNull();
  });
  it("puts routines linked to a removed day under Unassigned, last", () => {
    const g = groupRoutinesBySplit([r("1", "gone"), r("2", "a"), r("3", "")], split("a", "b"))!;
    expect(g.map((x) => x.title)).toEqual(["Day 1", "Unassigned"]);
    expect(g[1].routines.map((x) => x.id)).toEqual(["1", "3"]);
    expect(g[1].dayId).toBeNull();
  });
  it("skips days with no routines and keeps split order, not routine order", () => {
    const g = groupRoutinesBySplit([r("1", "c"), r("2", "a")], split("a", "b", "c"))!;
    expect(g.map((x) => x.dayId)).toEqual(["a", "c"]);
  });
  it("includes mini routines in their day group", () => {
    const g = groupRoutinesBySplit([r("1", "a", { kind: "mini" }), r("2", "a")], split("a"))!;
    expect(g[0].routines.map((x) => x.id)).toEqual(["1", "2"]);
  });
  it("keeps input order inside a group even when created_at disagrees", () => {
    const rows = [r("9", "a", { created_at: "2026-05-01T00:00:00Z" }), r("1", "a", { created_at: "2026-01-01T00:00:00Z" })];
    const g = groupRoutinesBySplit(rows, split("a"))!;
    expect(g[0].routines.map((x) => x.id)).toEqual(["9", "1"]);
  });
  it("a duplicate day id yields one group, not two", () => {
    const g = groupRoutinesBySplit([r("1", "a")], split("a", "a"))!;
    expect(g).toHaveLength(1);
  });
  it("days without an id never group anything, even for routines with a falsy link", () => {
    expect(groupRoutinesBySplit([r("1", undefined), r("2", null)], split(undefined, undefined))).toBeNull();
  });
  it("falls back to 'Split day' for a blank day name", () => {
    const s = { days: [{ name: "", muscles: [], id: "a" }] } as never;
    expect(groupRoutinesBySplit([r("1", "a")], s)![0].title).toBe("Split day");
  });
  it("does not mutate the input and loses nothing on a large fuzzed list", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const days = Array.from({ length: 20 }, (_, i) => `d${i}`);
    const rows = Array.from({ length: 3000 }, (_, i) => {
      const x = rnd();
      return r(String(i), x < 0.3 ? null : x < 0.4 ? "stale" : days[Math.floor(rnd() * 20)], { kind: rnd() < 0.2 ? "mini" : "routine" });
    });
    const copy = JSON.stringify(rows);
    const g = groupRoutinesBySplit(rows, split(...days))!;
    expect(JSON.stringify(rows)).toBe(copy);
    const out = g.flatMap((x) => x.routines.map((y) => y.id));
    expect(out).toHaveLength(rows.length);
    expect(new Set(out).size).toBe(rows.length);
    expect(g.at(-1)!.title).toBe("Unassigned");
    for (const grp of g) {
      const idx = grp.routines.map((y) => Number(y.id));
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
  });
});

describe("removeDayQuestion / clearSplitQuestion (QA)", () => {
  it("asks nothing when no routine is linked", () => {
    expect(removeDayQuestion("Push", 0)).toBeNull();
  });
  it("uses singular for 1 and plural for many, and states nothing is deleted", () => {
    expect(removeDayQuestion("Push", 1)).toContain("1 routine will");
    expect(removeDayQuestion("Push", 1)).not.toContain("1 routines");
    expect(removeDayQuestion("Push", 12)).toContain("12 routines will become unassigned");
    expect(removeDayQuestion("Push", 2)).toContain("Nothing is deleted");
  });
  it("falls back for a blank or whitespace name and trims a padded one", () => {
    expect(removeDayQuestion("   ", 2)).toContain("Remove this day?");
    expect(removeDayQuestion("  Pull  ", 2)).toContain("Remove Pull?");
  });
  it("clear split question matches counts", () => {
    expect(clearSplitQuestion(0)).toBe("Clear this split?");
    expect(clearSplitQuestion(1)).toContain("1 routine will become unassigned");
    expect(clearSplitQuestion(3)).toContain("3 routines will become unassigned");
  });
});

describe("dayFromSearch (QA)", () => {
  it("handles empty, missing and blank values", () => {
    expect(dayFromSearch("")).toBeNull();
    expect(dayFromSearch("?other=1")).toBeNull();
    expect(dayFromSearch("?day=")).toBeNull();
    expect(dayFromSearch("?day=%20%20")).toBeNull();
  });
  it("reads the value with or without the leading ?, trimmed", () => {
    expect(dayFromSearch("?day=abc")).toBe("abc");
    expect(dayFromSearch("day=abc")).toBe("abc");
    expect(dayFromSearch("?day=%20abc%20")).toBe("abc");
  });
  it("takes the first of repeated params and decodes encoded values", () => {
    expect(dayFromSearch("?day=a&day=b")).toBe("a");
    expect(dayFromSearch("?day=a%2Fb%3Cx")).toBe("a/b<x");
  });
  it("returns unknown ids as-is (caller must tolerate them) and survives huge input", () => {
    expect(dayFromSearch("?day=does-not-exist")).toBe("does-not-exist");
    const big = "x".repeat(100000);
    expect(dayFromSearch(`?day=${big}`)).toBe(big);
  });
});
