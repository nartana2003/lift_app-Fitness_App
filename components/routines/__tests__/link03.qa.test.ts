// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/offline/db";
import { getRoutine, createRoutine, listRoutines } from "@/lib/routines";
import type { Split } from "@/lib/splits";
import { planDays } from "@/lib/ai/generate-routines";
import { parsePlanIndexed, planDayLinks, savePlanDays } from "@/components/routines/GeneratePlan";
import { saveRoutineFromLink } from "@/components/routines/SaveFromLink";
import { planChoices } from "@/components/planner/WeekStrip";
import { nextRoutineForDay, routinesForDay, lastDoneByRoutine } from "@/lib/splitRoutines";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const day = (id: string, name = id, muscles: Split["days"][number]["muscles"] = ["Chest"]) => ({ id, name, muscles });
const split = (n: number): Split => ({ name: "s", days: Array.from({ length: n }, (_, i) => day(`d${i}`, `Day${i}`)) });

describe("planDayLinks vs planDays (sweep)", () => {
  it("plan day i links to split day i mod n for every split size and plan length", () => {
    for (let n = 1; n <= 7; n++) {
      for (let count = 2; count <= 6; count++) {
        const s = split(n);
        const idx = Array.from({ length: count }, (_, i) => i);
        const links = planDayLinks(s, idx);
        const tpl = planDays(s, count);
        expect(links).toHaveLength(count);
        links.forEach((id, i) => {
          expect(id).toBe(`d${i % n}`);
          expect(tpl[i].name.startsWith(`Day${i % n}`)).toBe(true);
        });
      }
    }
  });

  it("skips split days without muscles, like the route does", () => {
    const s: Split = { name: "s", days: [day("rest", "Rest", []), day("a"), day("b")] };
    expect(planDayLinks(s, [0, 1, 2])).toEqual(["a", "b", "a"]);
    expect(planDays(s, 3).map((t) => t.name.charAt(0))).toEqual(["a", "b", "a"]);
  });

  it("uses the dropped-day original index, not the kept position", () => {
    expect(planDayLinks(split(3), [0, 2])).toEqual(["d0", "d2"]);
  });

  it("returns null for ids missing, empty, or negative / non-integer indices", () => {
    const s: Split = { name: "s", days: [{ name: "x", muscles: ["Chest"] }, { id: "", name: "y", muscles: ["Back"] }, day("c")] };
    expect(planDayLinks(s, [0, 1, 2])).toEqual([null, null, "c"]);
    expect(planDayLinks(split(2), [-1, 1.5, NaN])).toEqual([null, null, null]);
  });

  it("returns nulls for an empty or muscle-less split and an empty list for no indices", () => {
    expect(planDayLinks({ name: "", days: [] }, [0, 1])).toEqual([null, null]);
    expect(planDayLinks({ name: "", days: [day("a", "a", [])] }, [0])).toEqual([null]);
    expect(planDayLinks(split(3), [])).toEqual([]);
  });

  it("only the first 7 training days count", () => {
    expect(planDayLinks(split(9), [0, 1, 2])).toEqual(["d0", "d1", "d2"]);
  });

  it("does not mutate the split", () => {
    const s = split(3);
    const copy = JSON.stringify(s);
    planDayLinks(s, [0, 1, 2, 3]);
    expect(JSON.stringify(s)).toBe(copy);
  });
});

describe("parsePlanIndexed", () => {
  const ex = (id: string) => ({ exercise_id: id, target_sets: 3, target_reps: "8-10" });
  const known = (id: string) => id.startsWith("k");

  it("keeps original indices when empty / invalid days are dropped", () => {
    const json = {
      plan: {
        days: [
          { name: "A", muscles: ["Chest"], exercises: [ex("k1")] },
          { name: "B", muscles: ["Back"], exercises: [ex("unknown")] },
          "junk",
          { name: "D", muscles: ["Legs"], exercises: [ex("k2")] },
          { name: "E", exercises: [] },
        ],
      },
    };
    const r = parsePlanIndexed(json, known, 6)!;
    expect(r.days.map((d) => d.name)).toEqual(["A", "D"]);
    expect(r.indices).toEqual([0, 3]);
    expect(r.days).toHaveLength(r.indices.length);
  });

  it("names unnamed days after their original position", () => {
    const r = parsePlanIndexed({ plan: { days: [{ exercises: [ex("k1")] }, { name: "  ", exercises: [ex("k2")] }] } }, known, 3)!;
    expect(r.days.map((d) => d.name)).toEqual(["Day 1", "Day 2"]);
  });

  it("respects maxDays when slicing", () => {
    const days = Array.from({ length: 6 }, (_, i) => ({ name: `D${i}`, exercises: [ex(`k${i}`)] }));
    expect(parsePlanIndexed({ plan: { days } }, known, 2)!.indices).toEqual([0, 1]);
    expect(parsePlanIndexed({ plan: { days } }, known, 99)!.indices).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("returns null for junk and when nothing is usable", () => {
    for (const j of [null, undefined, 5, "x", [], {}, { plan: null }, { plan: {} }, { plan: { days: "x" } }, { plan: { days: [] } }, { plan: { days: [{ exercises: [ex("zz")] }] } }]) {
      expect(parsePlanIndexed(j, known)).toBeNull();
    }
  });
});

describe("savePlanDays links", () => {
  const d = (name: string) => ({ name, muscles: [], notes: null, exercises: [{ exercise_id: "k1", target_sets: 3, target_reps: "8-10" }] });

  it("links by position; null, undefined, empty and missing entries write no field", async () => {
    const ids = await savePlanDays([d("A"), d("B"), d("C"), d("D")], ["x", null, undefined, ""]);
    const rows = await Promise.all(ids.map((i) => getRoutine(i)));
    expect(rows.map((r) => r?.split_day_id)).toEqual(["x", undefined, undefined, undefined]);
    expect(rows.every((r) => r?.source === "ai")).toBe(true);
  });

  it("repeated day ids link several routines to the same day", async () => {
    const ids = await savePlanDays([d("A"), d("B")], ["x", "x"]);
    const all = await listRoutines();
    expect(routinesForDay(all, "x").map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it("works with no links argument, extra links and no days", async () => {
    const ids = await savePlanDays([d("A")]);
    expect((await getRoutine(ids[0]))?.split_day_id).toBeUndefined();
    const ids2 = await savePlanDays([d("A")], ["a", "b", "c"]);
    expect((await getRoutine(ids2[0]))?.split_day_id).toBe("a");
    expect(await savePlanDays([], ["a"])).toEqual([]);
  });
});

describe("saveRoutineFromLink links", () => {
  const base = {
    name: "Chest day",
    notes: null,
    url: "https://www.tiktok.com/@a/video/1",
    platform: "tiktok" as const,
    exercises: [
      { exercise_id: null, name: "Qa Press", custom: true, muscle_groups: ["Chest" as const], equipment: "Barbell" as const, target_sets: 3, target_reps: "8-10" },
    ],
  };

  it("stores split_day_id and keeps the social fields", async () => {
    const id = await saveRoutineFromLink({ ...base, split_day_id: "day-1", creator: "me" });
    const r = await getRoutine(id);
    expect(r?.split_day_id).toBe("day-1");
    expect(r?.source).toBe("social");
    expect(r?.kind).toBe("routine");
    expect(r?.source_url).toBe(base.url);
    expect(r?.creator).toBe("me");
  });

  it("None (undefined, null, empty) writes no link", async () => {
    for (const v of [undefined, null, ""]) {
      const id = await saveRoutineFromLink({ ...base, split_day_id: v });
      expect((await getRoutine(id))?.split_day_id).toBeUndefined();
    }
  });
});

describe("longest-ago choice and minis", () => {
  const r = (id: string, created: number, extra: Record<string, unknown> = {}) => ({
    id,
    created_at: new Date(2026, 0, created).toISOString(),
    split_day_id: "push",
    ...extra,
  });

  it("never-done wins, then oldest done", () => {
    const list = [r("a", 1), r("b", 2), r("c", 3)];
    const ld = new Map([
      ["a", "2026-10-20T00:00:00Z"],
      ["b", "2026-10-10T00:00:00Z"],
    ]);
    expect(nextRoutineForDay(list, "push", ld)!.id).toBe("c");
    ld.set("c", "2026-10-25T00:00:00Z");
    expect(nextRoutineForDay(list, "push", ld)!.id).toBe("b");
  });

  it("a mini is never chosen, even when never done", () => {
    const list = [r("m", 1, { kind: "mini" }), r("a", 2)];
    expect(nextRoutineForDay(list, "push")!.id).toBe("a");
    expect(nextRoutineForDay([list[0]], "push")).toBeNull();
  });

  it("lastDoneByRoutine ignores null routine ids and keeps the latest", () => {
    const m = lastDoneByRoutine([
      { routine_id: null, started_at: "2026-10-01" },
      { routine_id: "a", started_at: "2026-10-02" },
      { routine_id: "a", started_at: "2026-10-05" },
      { routine_id: "a", started_at: "2026-10-03" },
    ]);
    expect([...m.entries()]).toEqual([["a", "2026-10-05"]]);
  });
});

describe("planChoices (WeekStrip groupings)", () => {
  const r = (id: string, created: number, dayId?: string | null, kind?: "routine" | "mini") => ({
    id,
    created_at: new Date(2026, 0, created).toISOString(),
    ...(dayId !== undefined ? { split_day_id: dayId } : {}),
    ...(kind ? { kind } : {}),
  });
  const sp: Pick<Split, "days"> = { days: [day("push", "Push"), day("pull", "Pull"), day("Legs", "Legs")] };

  it("no links: no groups and others is the input order", () => {
    const c = planChoices(sp, [r("z", 3), r("y", 1), r("x", 2)]);
    expect(c.groups).toEqual([]);
    expect(c.others.map((x) => x.id)).toEqual(["z", "y", "x"]);
  });

  it("empty routines and empty split", () => {
    expect(planChoices(sp, [])).toEqual({ groups: [], others: [] });
    expect(planChoices({ days: [] }, [r("a", 1, "push")]).others.map((x) => x.id)).toEqual(["a"]);
  });

  it("groups follow split order, next-due first, minis listed but not first", () => {
    const list = [r("p1", 1, "push"), r("pm", 2, "push", "mini"), r("p2", 3, "push"), r("l1", 4, "Legs"), r("free", 5)];
    const c = planChoices(sp, list, new Map([["p1", "2026-10-20T00:00:00Z"]]));
    expect(c.groups.map((g) => g.name)).toEqual(["Push", "Legs"]);
    expect(c.groups[0].routines.map((x) => x.id)).toEqual(["p2", "p1", "pm"]);
    expect(c.others.map((x) => x.id)).toEqual(["free"]);
  });

  it("a mini-only day still lists the mini and does not crash", () => {
    const c = planChoices(sp, [r("pm", 1, "push", "mini")]);
    expect(c.groups[0].routines.map((x) => x.id)).toEqual(["pm"]);
    expect(c.others).toEqual([]);
  });

  it("stale / removed split-day ids fall into others, never lost or duplicated", () => {
    const c = planChoices(sp, [r("a", 1, "gone"), r("b", 2, "push"), r("c", 3, null)]);
    const all = [...c.groups.flatMap((g) => g.routines), ...c.others].map((x) => x.id).sort();
    expect(all).toEqual(["a", "b", "c"]);
    expect(c.others.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("days with no id, a repeated id or a blank name are handled", () => {
    const odd: Pick<Split, "days"> = { days: [{ name: "NoId", muscles: ["Chest"] }, day("push", "  "), day("push", "Dup")] };
    const c = planChoices(odd, [r("a", 1, "push")]);
    expect(c.groups).toHaveLength(1);
    expect(c.groups[0].name).toBe("Day 2");
    expect(c.groups[0].routines.map((x) => x.id)).toEqual(["a"]);
  });

  it("does not mutate the routines list", () => {
    const list = [r("b", 2, "push"), r("a", 1, "push")];
    planChoices(sp, list);
    expect(list.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("routines saved with a link are grouped end to end", async () => {
    const id = await createRoutine({ name: "R", exercises: [], split_day_id: "pull" });
    await createRoutine({ name: "Loose", exercises: [] });
    const c = planChoices(sp, await listRoutines());
    expect(c.groups.map((g) => [g.name, g.routines.map((x) => x.id)])).toEqual([["Pull", [id]]]);
    expect(c.others).toHaveLength(1);
  });
});
