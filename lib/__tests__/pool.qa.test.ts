// Independent QA for lib/pool.ts. Written without reading the builder's tests.
import { describe, expect, it } from "vitest";
import type { Exercise } from "../exercises";
import type { Equipment, MuscleGroup } from "../muscles";
import { MUSCLE_GROUPS } from "../muscles";
import type { Split } from "../splits";
import { nextSplitDay, poolByMuscle, suggestToday, type PoolWorkout } from "../pool";

function ex(
  id: string,
  muscles: MuscleGroup[],
  o: Partial<Exercise> = {},
): Exercise {
  return {
    id,
    name: o.name ?? id,
    muscle_groups: muscles,
    secondary_groups: [],
    equipment: "Dumbbell" as Equipment,
    category: "strength",
    mechanic: "isolation",
    force: null,
    level: "beginner",
    instructions: [],
    image_urls: [],
    tiktok_url: "",
    ...o,
  };
}

const CAT: Exercise[] = [
  ex("zottman", ["Biceps"]),
  ex("incline-curl", ["Biceps"]),
  ex("hammer", ["Biceps"]),
  ex("pushdown", ["Triceps"], { equipment: "Machine/Cable" }),
  ex("skull", ["Triceps"], { equipment: "Barbell" }),
  ex("ohp", ["Shoulders"], { mechanic: "compound", equipment: "Barbell" }),
  ex("lateral", ["Shoulders"]),
  ex("row", ["Back"], { mechanic: "compound", equipment: "Barbell" }),
  ex("row2", ["Back"], { equipment: "Machine/Cable" }),
  ex("bench", ["Chest"], { mechanic: "compound", equipment: "Barbell" }),
  ex("fly", ["Chest"]),
  ex("squat", ["Quads"], { mechanic: "compound", equipment: "Barbell" }),
  ex("legpress", ["Quads"], { mechanic: "compound", equipment: "Machine/Cable" }),
  ex("rdl", ["Hamstrings"], { mechanic: "compound", equipment: "Barbell" }),
  ex("legcurl", ["Hamstrings"], { equipment: "Machine/Cable" }),
  ex("thrust", ["Glutes"], { mechanic: "compound", equipment: "Barbell" }),
  ex("kickback", ["Glutes"], { equipment: "Machine/Cable" }),
  ex("plank", ["Abs/Core"], { equipment: "Bodyweight" }),
  ex("crunch", ["Abs/Core"], { equipment: "Bodyweight" }),
];
const FAVS = CAT.map((e) => e.id);

const SPLIT: Split = {
  name: "3 day",
  days: [
    { name: "Legs", muscles: ["Quads", "Hamstrings", "Glutes", "Abs/Core"] },
    { name: "Upper", muscles: ["Biceps", "Triceps", "Shoulders", "Back", "Abs/Core"] },
    {
      name: "Full body",
      muscles: ["Chest", "Back", "Shoulders", "Biceps", "Triceps", "Quads", "Hamstrings", "Glutes", "Abs/Core"],
    },
  ],
};

const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h, 0, 0);
const iso = (d: Date) => d.toISOString();
function wk(ids: string[], start: Date, finished = true): PoolWorkout {
  return {
    started_at: iso(start),
    ended_at: finished ? iso(new Date(start.getTime() + 3600e3)) : null,
    exercises: ids.map((exercise_id) => ({ exercise_id })),
  };
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

const biceps = (id: string) => CAT.find((e) => e.id === id)!;
const bicepsDay = { name: "Arms", muscles: ["Biceps"] as MuscleGroup[] };

describe("poolByMuscle", () => {
  it("has a key for every muscle and groups starred exercises", () => {
    const p = poolByMuscle(FAVS, CAT, []);
    expect(Object.keys(p).sort()).toEqual([...MUSCLE_GROUPS].sort());
    expect(p.Biceps.map((e) => e.id)).toEqual(["zottman", "incline-curl", "hammer"]);
    expect(p.Neck).toEqual([]);
  });
  it("empty favourites gives all-empty pools", () => {
    const p = poolByMuscle([], CAT, []);
    for (const m of MUSCLE_GROUPS) expect(p[m]).toEqual([]);
  });
  it("same exercise under two muscles appears in both pools", () => {
    const dual = ex("dual", ["Quads", "Glutes"]);
    const p = poolByMuscle(["dual"], [dual], []);
    expect(p.Quads).toEqual([dual]);
    expect(p.Glutes).toEqual([dual]);
  });
  it("a muscle listed twice on one exercise is not duplicated", () => {
    const e = ex("dup", ["Biceps", "Biceps"]);
    expect(poolByMuscle(["dup"], [e], []).Biceps).toHaveLength(1);
  });
  it("unknown ids, duplicate ids and custom exercises without muscles are dropped", () => {
    const custom = ex("custom-1", []);
    const customOk = ex("custom-2", ["Calves"]);
    const p = poolByMuscle(["nope", "zottman", "zottman", "custom-1", "custom-2"], [...CAT, custom, customOk], []);
    expect(p.Biceps.map((e) => e.id)).toEqual(["zottman"]);
    expect(p.Calves.map((e) => e.id)).toEqual(["custom-2"]);
    const total = Object.values(p).flat().length;
    expect(total).toBe(2);
  });
  it("equipment filter limits; empty list means full gym", () => {
    const p = poolByMuscle(FAVS, CAT, ["Bodyweight"]);
    expect(p["Abs/Core"]).toHaveLength(2);
    expect(p.Biceps).toEqual([]);
    expect(poolByMuscle(FAVS, CAT, ["Barbell", "Machine/Cable"]).Biceps).toEqual([]);
    expect(poolByMuscle(FAVS, CAT, ["Dumbbell"]).Biceps).toHaveLength(3);
  });
  it("keeps the favourites' order", () => {
    const p = poolByMuscle(["hammer", "zottman", "incline-curl"], CAT, []);
    expect(p.Biceps.map((e) => e.id)).toEqual(["hammer", "zottman", "incline-curl"]);
  });
  it("200 favourites are quick", () => {
    const cat = Array.from({ length: 400 }, (_, i) => ex(`e${i}`, [MUSCLE_GROUPS[i % MUSCLE_GROUPS.length]]));
    const t = Date.now();
    const p = poolByMuscle(cat.slice(0, 200).map((e) => e.id), cat, []);
    expect(Date.now() - t).toBeLessThan(500);
    expect(Object.values(p).flat()).toHaveLength(200);
  });
});

describe("suggestToday basics (the user's Zottman example)", () => {
  const pool = poolByMuscle(FAVS, CAT, []);
  const now = at(2026, 10, 25);
  it("Zottman a week ago, hammer 3 weeks, incline never: never-done wins, not Zottman", () => {
    const history = [wk(["zottman"], at(2026, 10, 18)), wk(["hammer"], at(2026, 10, 4))];
    const r = suggestToday({ day: bicepsDay, pool, history, perMuscle: 1, now });
    expect(r.muscles[0].picks.map((p) => p.exercise.id)).toEqual(["incline-curl"]);
    expect(r.muscles[0].picks[0].lastDoneDaysAgo).toBeNull();
  });
  it("all done: the longest ago wins, last session's pick is avoided", () => {
    const history = [
      wk(["zottman"], at(2026, 10, 18)),
      wk(["incline-curl"], at(2026, 10, 11)),
      wk(["hammer"], at(2026, 10, 4)),
    ];
    const r = suggestToday({ day: bicepsDay, pool, history, perMuscle: 1, now });
    expect(r.muscles[0].picks[0].exercise.id).toBe("hammer");
    expect(r.muscles[0].picks[0].lastDoneDaysAgo).toBe(21);
  });
  it("perMuscle 2 picks the two longest ago", () => {
    const history = [
      wk(["zottman"], at(2026, 10, 18)),
      wk(["incline-curl"], at(2026, 10, 11)),
      wk(["hammer"], at(2026, 10, 4)),
    ];
    const r = suggestToday({ day: bicepsDay, pool, history, perMuscle: 2, now });
    expect(r.muscles[0].picks.map((p) => p.exercise.id).sort()).toEqual(["hammer", "incline-curl"]);
  });
  it("perMuscle 0, negative, fractional, bigger than pool", () => {
    const f = (n: number) => suggestToday({ day: bicepsDay, pool, history: [], perMuscle: n, now }).muscles[0].picks.length;
    expect(f(0)).toBe(0);
    expect(f(-3)).toBe(0);
    expect(f(1)).toBe(1);
    expect(f(2.9)).toBe(2);
    expect(f(3)).toBe(3);
    expect(f(10)).toBe(3);
    expect(f(Number.NaN)).toBeGreaterThanOrEqual(0);
    expect(f(Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(3);
  });
  it("pool of size 0 is listed as missing, size 1 repeats the only option, size 2 alternates", () => {
    const empty = suggestToday({ day: bicepsDay, pool: poolByMuscle([], CAT, []), history: [], perMuscle: 2, now });
    expect(empty.missing).toEqual(["Biceps"]);
    expect(empty.muscles[0].picks).toEqual([]);
    expect(empty.exercises).toEqual([]);

    const one = poolByMuscle(["zottman"], CAT, []);
    const hist = [wk(["zottman"], at(2026, 10, 20))];
    const r1 = suggestToday({ day: bicepsDay, pool: one, history: hist, perMuscle: 2, now });
    expect(r1.muscles[0].picks.map((p) => p.exercise.id)).toEqual(["zottman"]);
    expect(r1.missing).toEqual([]);

    const two = poolByMuscle(["zottman", "hammer"], CAT, []);
    const r2 = suggestToday({ day: bicepsDay, pool: two, history: hist, perMuscle: 1, now });
    expect(r2.muscles[0].picks[0].exercise.id).toBe("hammer");
  });
  it("tie-break is deterministic whatever the pool order", () => {
    const a = poolByMuscle(["hammer", "zottman", "incline-curl"], CAT, []);
    const b = poolByMuscle(["incline-curl", "hammer", "zottman"], CAT, []);
    const ra = suggestToday({ day: bicepsDay, pool: a, history: [], perMuscle: 2, now });
    const rb = suggestToday({ day: bicepsDay, pool: b, history: [], perMuscle: 2, now });
    expect(ra.muscles[0].picks.map((p) => p.exercise.id)).toEqual(rb.muscles[0].picks.map((p) => p.exercise.id));
  });
  it("a day with duplicate muscles lists each muscle once", () => {
    const r = suggestToday({
      day: { name: "x", muscles: ["Biceps", "Biceps"] },
      pool,
      history: [],
      perMuscle: 1,
      now,
    });
    expect(r.muscles).toHaveLength(1);
  });
  it("an exercise covering two muscles of the day is picked once", () => {
    const dual = ex("dual", ["Quads", "Glutes"], { mechanic: "compound" });
    const p = poolByMuscle(["dual", "thrust"], [dual, ...CAT], []);
    const r = suggestToday({
      day: { name: "L", muscles: ["Quads", "Glutes"] },
      pool: p,
      history: [],
      perMuscle: 1,
      now,
    });
    const ids = r.exercises.map((x) => x.exercise.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.exercises.find((x) => x.exercise.id === "dual")?.muscles.sort()).toEqual(["Glutes", "Quads"]);
  });
});

describe("history handling", () => {
  const pool = poolByMuscle(["zottman", "hammer"], CAT, []);
  const now = at(2026, 10, 25);
  const pick = (history: PoolWorkout[], n = now) =>
    suggestToday({ day: bicepsDay, pool, history, perMuscle: 1, now: n }).muscles[0].picks[0];

  it("unfinished workouts do not count", () => {
    const p = pick([wk(["zottman"], at(2026, 10, 24), false), wk(["hammer"], at(2026, 10, 1))]);
    expect(p.exercise.id).toBe("zottman");
    expect(p.lastDoneDaysAgo).toBeNull();
  });
  it("warm-up-only sets do not count as done; working sets do", () => {
    const warm: PoolWorkout = {
      ...wk([], at(2026, 10, 24)),
      exercises: [{ exercise_id: "zottman", sets: [{ is_warmup: true }, { is_warmup: true }] }],
    };
    const none: PoolWorkout = { ...wk([], at(2026, 10, 24)), exercises: [{ exercise_id: "zottman", sets: [] }] };
    const real: PoolWorkout = {
      ...wk([], at(2026, 10, 24)),
      exercises: [{ exercise_id: "zottman", sets: [{ is_warmup: true }, { is_warmup: false }] }],
    };
    expect(pick([warm, wk(["hammer"], at(2026, 10, 1))]).exercise.id).toBe("zottman");
    expect(pick([none, wk(["hammer"], at(2026, 10, 1))]).exercise.id).toBe("zottman");
    expect(pick([real, wk(["hammer"], at(2026, 10, 1))]).exercise.id).toBe("hammer");
  });
  it("order of the history array does not matter", () => {
    const h = [wk(["zottman"], at(2026, 10, 20)), wk(["hammer"], at(2026, 10, 10)), wk(["zottman"], at(2026, 10, 1))];
    expect(pick(h).exercise.id).toBe("hammer");
    expect(pick([...h].reverse()).exercise.id).toBe("hammer");
  });
  it("two workouts on the same day: the later one is the 'last session'", () => {
    const h = [wk(["zottman"], at(2026, 10, 24, 8)), wk(["hammer"], at(2026, 10, 24, 18))];
    expect(pick(h).exercise.id).toBe("zottman");
    expect(pick([...h].reverse()).exercise.id).toBe("zottman");
  });
  it("a future workout is ignored", () => {
    const p = pick([wk(["zottman"], at(2026, 11, 3)), wk(["hammer"], at(2026, 10, 24))]);
    expect(p.exercise.id).toBe("zottman");
    expect(p.lastDoneDaysAgo).toBeNull();
  });
  it("invalid dates and unknown exercise ids are tolerated", () => {
    const bad: PoolWorkout = { started_at: "garbage", ended_at: "garbage", exercises: [{ exercise_id: "zottman" }] };
    const unk = wk(["mystery"], at(2026, 10, 24));
    expect(() => pick([bad, unk])).not.toThrow();
    expect(pick([bad, unk]).lastDoneDaysAgo).toBeNull();
  });
  it("last session that trained the muscle is looked up via the catalogue for out-of-pool lifts", () => {
    const p2 = poolByMuscle(["zottman", "hammer"], CAT, []);
    // incline-curl is NOT in the pool, but trained biceps last session; hammer was older.
    const h = [wk(["incline-curl"], at(2026, 10, 24)), wk(["hammer"], at(2026, 10, 10))];
    const r = suggestToday({ day: bicepsDay, pool: p2, history: h, perMuscle: 1, now, catalogue: CAT });
    expect(r.muscles[0].picks[0].exercise.id).toBe("zottman");
  });
});

describe("calendar-day counting", () => {
  const pool = poolByMuscle(["zottman"], CAT, []);
  const days = (done: Date, now: Date) =>
    suggestToday({ day: bicepsDay, pool, history: [wk(["zottman"], done)], perMuscle: 1, now }).muscles[0].picks[0]
      .lastDoneDaysAgo;
  it("same day is 0, even hours apart", () => {
    expect(days(at(2026, 10, 25, 0), at(2026, 10, 25, 23))).toBe(0);
  });
  it("late night to early next morning is 1", () => {
    expect(days(at(2026, 10, 24, 23), at(2026, 10, 25, 1))).toBe(1);
  });
  it("across a month boundary", () => {
    expect(days(at(2026, 1, 31), at(2026, 3, 1))).toBe(29);
    expect(days(at(2026, 4, 30), at(2026, 5, 1))).toBe(1);
  });
  it("across a leap day", () => {
    expect(days(at(2028, 2, 28), at(2028, 3, 1))).toBe(2);
  });
  it("across a year boundary", () => {
    expect(days(at(2025, 12, 31, 23), at(2026, 1, 1, 0))).toBe(1);
    expect(days(at(2025, 1, 1), at(2026, 1, 1))).toBe(365);
  });
  it("across DST changes (US and EU dates) counts calendar days", () => {
    expect(days(at(2026, 3, 7, 22), at(2026, 3, 9, 1))).toBe(2);
    expect(days(at(2026, 3, 8, 0), at(2026, 3, 9, 0))).toBe(1);
    expect(days(at(2026, 3, 28, 23), at(2026, 3, 30, 0))).toBe(2);
    expect(days(at(2026, 10, 31, 23), at(2026, 11, 2, 0))).toBe(2);
    expect(days(at(2026, 11, 1, 0), at(2026, 11, 2, 23))).toBe(1);
    expect(days(at(2026, 10, 24, 12), at(2026, 10, 26, 12))).toBe(2);
  });
  it("now as a number equals now as a Date", () => {
    const d = at(2026, 10, 25);
    const a = suggestToday({ day: bicepsDay, pool, history: [wk(["zottman"], at(2026, 10, 20))], perMuscle: 1, now: d });
    const b = suggestToday({ day: bicepsDay, pool, history: [wk(["zottman"], at(2026, 10, 20))], perMuscle: 1, now: d.getTime() });
    expect(a).toEqual(b);
  });
});

describe("nextSplitDay", () => {
  const legs = wk(["squat", "rdl", "thrust", "plank"], at(2026, 10, 1));
  const upper = wk(["zottman", "pushdown", "ohp", "row", "crunch"], at(2026, 10, 3));
  const full = wk(["bench", "row", "ohp", "zottman", "pushdown", "squat", "rdl", "thrust", "plank"], at(2026, 10, 5));

  it("no history -> day 1, empty split -> null", () => {
    const r = nextSplitDay(SPLIT, [], CAT)!;
    expect(r.index).toBe(0);
    expect(r.lastIndex).toBeNull();
    expect(r.overridden).toBe(false);
    expect(nextSplitDay({ name: "x", days: [] }, [legs], CAT)).toBeNull();
    expect(nextSplitDay({ name: "x", days: [] }, [], CAT, 0)).toBeNull();
  });
  it("cycles legs -> upper -> full -> legs", () => {
    expect(nextSplitDay(SPLIT, [legs], CAT)!.index).toBe(1);
    expect(nextSplitDay(SPLIT, [legs, upper], CAT)!.index).toBe(2);
    expect(nextSplitDay(SPLIT, [legs, upper, full], CAT)!.index).toBe(0);
  });
  it("one-day split always returns day 0", () => {
    const one: Split = { name: "one", days: [SPLIT.days[0]] };
    expect(nextSplitDay(one, [legs], CAT)!.index).toBe(0);
    expect(nextSplitDay(one, [], CAT)!.index).toBe(0);
  });
  it("a split with an empty day: that day never matches but is returned when it follows", () => {
    const s: Split = { name: "s", days: [SPLIT.days[0], { name: "Rest", muscles: [] }, SPLIT.days[1]] };
    expect(nextSplitDay(s, [legs], CAT)!.index).toBe(1);
    expect(nextSplitDay(s, [legs], CAT)!.day.name).toBe("Rest");
    expect(nextSplitDay(s, [upper], CAT)!.index).toBe(0);
  });
  it("a workout matching no day is skipped in favour of the one before it", () => {
    const odd = wk(["mystery"], at(2026, 10, 9));
    const neck = wk(["neck-x"], at(2026, 10, 10));
    const cat = [...CAT, ex("neck-x", ["Neck"])];
    expect(nextSplitDay(SPLIT, [legs, odd, neck], cat)!.index).toBe(1);
    expect(nextSplitDay(SPLIT, [odd], cat)!.index).toBe(0);
  });
  it("unfinished newest workout is ignored", () => {
    const running = wk(["zottman"], at(2026, 10, 20), false);
    expect(nextSplitDay(SPLIT, [legs, running], CAT)!.index).toBe(1);
  });
  it("two days equally matched: earliest wins, deterministically", () => {
    const twin: Split = {
      name: "t",
      days: [
        { name: "A", muscles: ["Biceps", "Triceps"] },
        { name: "B", muscles: ["Biceps", "Triceps"] },
        { name: "C", muscles: ["Chest"] },
      ],
    };
    const w = wk(["zottman", "pushdown"], at(2026, 10, 1));
    const r = nextSplitDay(twin, [w], CAT)!;
    expect(r.lastIndex).toBe(0);
    expect(r.index).toBe(1);
  });
  it("duplicate day names do not confuse indexes", () => {
    const dup: Split = {
      name: "d",
      days: [
        { name: "Day", muscles: ["Quads"] },
        { name: "Day", muscles: ["Biceps"] },
      ],
    };
    expect(nextSplitDay(dup, [wk(["zottman"], at(2026, 10, 1))], CAT)!.index).toBe(0);
    expect(nextSplitDay(dup, [wk(["squat"], at(2026, 10, 1))], CAT)!.index).toBe(1);
  });
  it("override: valid index wins; out-of-range, negative, fractional, NaN fall back", () => {
    const h = [legs];
    expect(nextSplitDay(SPLIT, h, CAT, 2)).toMatchObject({ index: 2, overridden: true });
    expect(nextSplitDay(SPLIT, h, CAT, 0)).toMatchObject({ index: 0, overridden: true });
    for (const bad of [3, 99, -1, 1.5, Number.NaN, Infinity, null, undefined]) {
      const r = nextSplitDay(SPLIT, h, CAT, bad as number | null | undefined)!;
      expect(r.overridden).toBe(false);
      expect(r.index).toBe(1);
    }
  });
  it("same-day workouts: the later start decides", () => {
    const a = wk(["squat", "rdl", "thrust", "plank"], at(2026, 10, 5, 8));
    const b = wk(["zottman", "pushdown", "ohp", "row", "crunch"], at(2026, 10, 5, 18));
    expect(nextSplitDay(SPLIT, [a, b], CAT)!.index).toBe(2);
    expect(nextSplitDay(SPLIT, [b, a], CAT)!.index).toBe(2);
  });
  it("a legs-only session is not mistaken for full body", () => {
    const r = nextSplitDay(SPLIT, [wk(["squat", "rdl"], at(2026, 10, 1))], CAT)!;
    expect(r.lastIndex).toBe(0);
  });
});

describe("rotation simulated over 8 weeks of the user's 3-day split", () => {
  function simulate(perMuscle: number, favs = FAVS, cat = CAT, sessions = 24, split: Split = SPLIT) {
    const pool = poolByMuscle(favs, cat, []);
    const history: PoolWorkout[] = [];
    const log: { dayIndex: number; plan: ReturnType<typeof suggestToday>; when: Date }[] = [];
    for (let i = 0; i < sessions; i++) {
      // three sessions a week on irregular days: Mon, Wed, Sat
      const week = Math.floor(i / 3);
      const off = [0, 2, 5][i % 3];
      const when = at(2026, 1, 5 + week * 7 + off);
      const next = nextSplitDay(split, history, cat)!;
      const plan = suggestToday({ day: next.day, pool, history, perMuscle, now: when, catalogue: cat });
      log.push({ dayIndex: next.index, plan, when });
      history.push(wk(plan.exercises.map((p) => p.exercise.id), when));
    }
    return { pool, history, log };
  }

  it("the split cycles legs, upper, full body in order", () => {
    const { log } = simulate(1);
    log.forEach((l, i) => expect(l.dayIndex).toBe(i % 3));
  });
  it("no pool exercise starves (each chosen at least once in 8 weeks)", () => {
    for (const per of [1, 2]) {
      const { log } = simulate(per);
      const chosen = new Set(log.flatMap((l) => l.plan.exercises.map((p) => p.exercise.id)));
      const missing = FAVS.filter((id) => !chosen.has(id));
      expect(missing, `perMuscle ${per}`).toEqual([]);
    }
  });
  it("never the same exercise on consecutive sessions of a muscle when the pool has 2+ options", () => {
    for (const per of [1, 2]) {
      const { pool, log } = simulate(per);
      for (const m of MUSCLE_GROUPS) {
        if (pool[m].length < 2) continue;
        let prev: Set<string> | null = null;
        for (const l of log) {
          const row = l.plan.muscles.find((r) => r.muscle === m);
          if (!row) continue;
          const ids = new Set(row.picks.map((p) => p.exercise.id));
          if (prev && per === 1) {
            for (const id of ids) expect(prev.has(id), `${m} repeated ${id} (per ${per})`).toBe(false);
          }
          if (prev && per < pool[m].length) {
            // with spare options at least one pick must be new
            expect([...ids].some((id) => !prev!.has(id)), `${m} identical set (per ${per})`).toBe(true);
          }
          prev = ids;
        }
      }
    }
  });
  it("is deterministic for identical input", () => {
    const a = simulate(2);
    const b = simulate(2);
    expect(JSON.stringify(a.log.map((l) => l.plan.exercises.map((p) => p.exercise.id)))).toBe(
      JSON.stringify(b.log.map((l) => l.plan.exercises.map((p) => p.exercise.id))),
    );
  });
  it("starvation holds with a muscle covered by two lifts (Back + Lats) and a dual quad/glute lift", () => {
    const cat = [
      ...CAT,
      ex("pulldown", ["Lats"], { equipment: "Machine/Cable" }),
      ex("pullup", ["Back", "Lats"], { mechanic: "compound", equipment: "Bodyweight" }),
      ex("lunge", ["Quads", "Glutes"], { mechanic: "compound" }),
    ];
    const favs = [...FAVS, "pulldown", "pullup", "lunge"];
    const lats: Split = { name: "l", days: SPLIT.days.map((d) => ({ ...d, muscles: d.muscles.includes("Back") ? [...d.muscles, "Lats" as MuscleGroup] : d.muscles })) };
    const { log } = simulate(1, favs, cat, 30, lats);
    const chosen = new Set(log.flatMap((l) => l.plan.exercises.map((p) => p.exercise.id)));
    expect(favs.filter((id) => !chosen.has(id))).toEqual([]);
  });
  it("lastDoneDaysAgo matches the real gap in the simulation", () => {
    const { log, history } = simulate(1);
    for (let i = 1; i < log.length; i++) {
      for (const p of log[i].plan.exercises) {
        const prev = history.slice(0, i).reverse().find((w) => w.exercises.some((x) => x.exercise_id === p.exercise.id));
        if (!prev) {
          expect(p.lastDoneDaysAgo).toBeNull();
        } else {
          const gap = Math.round((new Date(log[i].when.toDateString()).getTime() - new Date(new Date(prev.started_at).toDateString()).getTime()) / 864e5);
          expect(p.lastDoneDaysAgo).toBe(gap);
        }
      }
    }
  });
});

describe("immutability", () => {
  it("does not mutate (or choke on frozen) inputs", () => {
    const cat = deepFreeze(structuredClone(CAT));
    const favs = deepFreeze([...FAVS]);
    const eq = deepFreeze<Equipment[]>(["Dumbbell", "Barbell", "Machine/Cable", "Bodyweight"]);
    const split = deepFreeze(structuredClone(SPLIT));
    const hist = deepFreeze([wk(["squat"], at(2026, 10, 1)), wk(["zottman"], at(2026, 10, 3))]);
    const pool = poolByMuscle(favs, cat, eq);
    const snapshotPool = JSON.stringify(pool);
    deepFreeze(pool);
    expect(() => nextSplitDay(split, hist, cat, 1)).not.toThrow();
    expect(() => nextSplitDay(split, hist, cat)).not.toThrow();
    const r = suggestToday({ day: split.days[2], pool, history: hist, perMuscle: 2, now: at(2026, 10, 25), catalogue: cat });
    expect(JSON.stringify(pool)).toBe(snapshotPool);
    // returned picks must not alias frozen internals that callers will want to edit
    expect(() => r.exercises.forEach((p) => p.muscles.push("Neck"))).not.toThrow();
  });
});

describe("performance", () => {
  it("500 workouts and 200 favourites finish quickly", () => {
    const cat = Array.from({ length: 300 }, (_, i) => ex(`e${i}`, [MUSCLE_GROUPS[i % MUSCLE_GROUPS.length]]));
    const favs = cat.slice(0, 200).map((e) => e.id);
    const hist = Array.from({ length: 500 }, (_, i) =>
      wk([`e${(i * 7) % 300}`, `e${(i * 13) % 300}`], new Date(2026, 0, 1 + (i % 300), 9)),
    );
    const split: Split = {
      name: "big",
      days: [
        { name: "A", muscles: [...MUSCLE_GROUPS] },
        { name: "B", muscles: ["Chest", "Back"] },
      ],
    };
    const t = Date.now();
    const pool = poolByMuscle(favs, cat, []);
    const n = nextSplitDay(split, hist, cat)!;
    const r = suggestToday({ day: split.days[0], pool, history: hist, perMuscle: 3, now: at(2026, 12, 31), catalogue: cat });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(n.index).toBeGreaterThanOrEqual(0);
    expect(r.exercises.length).toBeGreaterThan(0);
  });
});

describe("fixed-seed property tests", () => {
  it("invariants hold over 300 random scenarios", () => {
    const rand = rng(20261025);
    const int = (n: number) => Math.floor(rand() * n);
    for (let iter = 0; iter < 300; iter++) {
      const favs = CAT.filter(() => rand() < 0.6).map((e) => e.id);
      if (rand() < 0.3 && favs.length) favs.push(favs[0], "ghost");
      const eq: Equipment[] = rand() < 0.5 ? [] : ["Dumbbell", "Bodyweight"];
      const pool = poolByMuscle(favs, CAT, eq);
      // pool invariants
      for (const m of MUSCLE_GROUPS) {
        const ids = pool[m].map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const e of pool[m]) {
          expect(favs).toContain(e.id);
          expect(e.muscle_groups).toContain(m);
          if (eq.length) expect(eq).toContain(e.equipment);
        }
      }
      const now = at(2026, 6, 15).getTime();
      const history: PoolWorkout[] = Array.from({ length: int(25) }, () => ({
        started_at: new Date(now + (int(120) - 100) * 864e5 + int(86400) * 1000).toISOString(),
        ended_at: rand() < 0.85 ? new Date(now).toISOString() : null,
        exercises: Array.from({ length: int(5) }, () => ({
          exercise_id: rand() < 0.1 ? "ghost" : CAT[int(CAT.length)].id,
          ...(rand() < 0.3 ? { sets: [{ is_warmup: rand() < 0.5 }] } : {}),
        })),
      }));
      const day = SPLIT.days[int(3)];
      const per = int(5);
      const r = suggestToday({ day, pool, history, perMuscle: per, now, catalogue: CAT });
      const seen = new Set<string>();
      for (const row of r.muscles) {
        expect(day.muscles).toContain(row.muscle);
        expect(row.picks.length).toBeLessThanOrEqual(per);
        expect(row.picks.length).toBeLessThanOrEqual(pool[row.muscle].length);
        if (pool[row.muscle].length === 0) expect(r.missing).toContain(row.muscle);
        else expect(row.picks.length, JSON.stringify({iter, per, m: row.muscle, pool: pool[row.muscle].map(e=>e.id), picks: row.picks.map(p=>p.exercise.id)})).toBe(Math.min(per, pool[row.muscle].length));
        const ids = row.picks.map((p) => p.exercise.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const p of row.picks) {
          expect(pool[row.muscle].map((e) => e.id)).toContain(p.exercise.id);
          expect(p.muscles).toContain(row.muscle);
          if (p.lastDoneDaysAgo !== null) {
            expect(Number.isInteger(p.lastDoneDaysAgo)).toBe(true);
            expect(p.lastDoneDaysAgo).toBeGreaterThanOrEqual(0);
          }
          seen.add(p.exercise.id);
        }
      }
      expect(r.exercises.map((p) => p.exercise.id).sort()).toEqual([...seen].sort());
      // determinism
      const again = suggestToday({ day, pool, history: [...history].reverse(), perMuscle: per, now, catalogue: CAT });
      expect(again.exercises.map((p) => p.exercise.id)).toEqual(r.exercises.map((p) => p.exercise.id));
      // nextSplitDay invariants
      const n = nextSplitDay(SPLIT, history, CAT);
      expect(n).not.toBeNull();
      expect(n!.index).toBeGreaterThanOrEqual(0);
      expect(n!.index).toBeLessThan(3);
      expect(n!.day).toBe(SPLIT.days[n!.index]);
    }
  });
});

// keep helper referenced for readability
void biceps;

describe("regression: asking for more than the fresh options", () => {
  it("perMuscle >= pool size still returns the whole pool when last session used one of them", () => {
    const pool = poolByMuscle(["zottman", "hammer"], CAT, []);
    const history = [wk(["zottman"], at(2026, 10, 24))];
    const r = suggestToday({ day: bicepsDay, pool, history, perMuscle: 2, now: at(2026, 10, 25) });
    expect(r.muscles[0].picks.map((p) => p.exercise.id).sort()).toEqual(["hammer", "zottman"]);
  });
  it("perMuscle 2 of a 3 pool returns 2 even when 2 of the 3 were done last session", () => {
    const pool = poolByMuscle(["zottman", "hammer", "incline-curl"], CAT, []);
    const history = [wk(["zottman", "hammer"], at(2026, 10, 24))];
    const r = suggestToday({ day: bicepsDay, pool, history, perMuscle: 2, now: at(2026, 10, 25) });
    expect(r.muscles[0].picks).toHaveLength(2);
    expect(r.muscles[0].picks[0].exercise.id).toBe("incline-curl");
  });
});
