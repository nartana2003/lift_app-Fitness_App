import { describe, expect, it } from "vitest";
import { exerciseCaption, exerciseThumb, recordsBySet, recordsByWorkout, type FeedWorkout } from "../homeFeed";
import type { SetLike } from "../prs";

const sets = (n: number, weight: number, reps = 8, is_warmup = false): SetLike[] =>
  Array.from({ length: n }, () => ({ reps, weight, is_warmup }));

const w = (id: string, day: number, exercises: FeedWorkout["exercises"]): FeedWorkout => ({
  id,
  started_at: `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`,
  exercises,
});

describe("records per workout", () => {
  it("gives no records the first time an exercise is logged", () => {
    const r = recordsByWorkout([w("a", 1, [{ exercise_id: "bench", sets: sets(3, 50) }])]);
    expect(r.get("a")).toBe(0);
  });

  it("counts each PR type a set earns, like the live workout", () => {
    // 60x8 beats 50x8: weight + e1RM on set 1, then the session volume PR on set 3.
    const r = recordsByWorkout([
      w("a", 1, [{ exercise_id: "bench", sets: sets(3, 50) }]),
      w("b", 8, [{ exercise_id: "bench", sets: sets(3, 60) }]),
    ]);
    expect(r.get("a")).toBe(0);
    expect(r.get("b")).toBe(3);
  });

  it("compares only against earlier workouts, whatever the input order", () => {
    const r = recordsByWorkout([
      w("b", 8, [{ exercise_id: "bench", sets: sets(3, 60) }]),
      w("a", 1, [{ exercise_id: "bench", sets: sets(3, 50) }]),
    ]);
    expect(r.get("a")).toBe(0);
    expect(r.get("b")).toBe(3);
  });

  it("gives 0 when a later workout does not beat the bests", () => {
    const r = recordsByWorkout([
      w("a", 1, [{ exercise_id: "bench", sets: sets(3, 60) }]),
      w("b", 8, [{ exercise_id: "bench", sets: sets(2, 50) }]),
    ]);
    expect(r.get("b")).toBe(0);
  });

  it("keeps exercises apart and ignores warm-ups", () => {
    const r = recordsByWorkout([
      w("a", 1, [
        { exercise_id: "bench", sets: sets(1, 50) },
        { exercise_id: "squat", sets: sets(1, 100) },
      ]),
      w("b", 8, [
        { exercise_id: "bench", sets: sets(1, 200, 8, true) },
        { exercise_id: "squat", sets: sets(1, 100, 10) },
      ]),
    ]);
    // Squat 100x10 vs 100x8: reps, e1RM and session volume. The heavy bench warm-up counts for nothing.
    expect(r.get("b")).toBe(3);
  });

  it("has an entry for every workout, including empty ones", () => {
    const r = recordsByWorkout([w("a", 1, [])]);
    expect(r.get("a")).toBe(0);
  });
});

describe("exercise caption", () => {
  it("is working sets x name", () => {
    expect(exerciseCaption(sets(3, 50), "Bench Press")).toBe("3 x Bench Press");
  });

  it("leaves warm-ups out of the count", () => {
    expect(exerciseCaption([...sets(1, 20, 10, true), ...sets(2, 50)], "Squat")).toBe("2 x Squat");
  });

  it("falls back to all sets when every set is a warm-up", () => {
    expect(exerciseCaption(sets(2, 20, 10, true), "Squat")).toBe("2 x Squat");
  });
});

describe("exercise thumbnail", () => {
  it("uses the first catalogue image", () => {
    expect(exerciseThumb(["https://x/0.jpg", "https://x/1.jpg"], "Bench")).toEqual({ kind: "image", src: "https://x/0.jpg" });
  });

  it("skips blank image urls", () => {
    expect(exerciseThumb(["  ", "https://x/1.jpg"], "Bench")).toEqual({ kind: "image", src: "https://x/1.jpg" });
  });

  it("falls back to the first letter, upper-cased", () => {
    expect(exerciseThumb([], "lever hip thrust")).toEqual({ kind: "letter", letter: "L" });
    expect(exerciseThumb(undefined, "  3/4 sit-up")).toEqual({ kind: "letter", letter: "3" });
  });

  it("uses a neutral mark when the name has no letter or digit", () => {
    expect(exerciseThumb([], " -- ")).toEqual({ kind: "letter", letter: "?" });
  });
});

describe("records per set", () => {
  const ex = (id: string, exercise_id: string, s: SetLike[]) => ({ id, exercise_id, sets: s });
  const wk = (id: string, day: number, exercises: ReturnType<typeof ex>[]) => ({ id, started_at: `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`, exercises });

  it("gives no records the first time an exercise is logged", () => {
    const r = recordsBySet([wk("a", 1, [ex("a1", "bench", sets(3, 50))])]);
    expect(r.get("a1")).toEqual([[], [], []]);
  });

  it("puts each record on the set that earned it, in set order", () => {
    const r = recordsBySet([
      wk("a", 1, [ex("a1", "bench", sets(3, 50))]),
      wk("b", 8, [ex("b1", "bench", sets(3, 60))]),
    ]);
    const per = r.get("b1")!;
    expect(per).toHaveLength(3);
    // 60x8 beats 50x8 on the first set (weight and est. 1RM); the session volume record lands on the first set that beats the old session.
    expect(per[0]).toEqual(expect.arrayContaining(["weight", "e1rm"]));
    expect(per[0].length + per[1].length + per[2].length).toBeGreaterThanOrEqual(3);
  });

  it("agrees with the per-workout count", () => {
    const all = [
      wk("a", 1, [ex("a1", "bench", sets(3, 50)), ex("a2", "row", sets(2, 40))]),
      wk("b", 8, [ex("b1", "bench", sets(3, 60)), ex("b2", "row", sets(2, 45, 10))]),
    ];
    const perSet = recordsBySet(all);
    const perWorkout = recordsByWorkout(all);
    for (const wo of all) {
      const n = wo.exercises.reduce((sum, e) => sum + perSet.get(e.id)!.reduce((a, p) => a + p.length, 0), 0);
      expect(n).toBe(perWorkout.get(wo.id));
    }
  });

  it("never gives a warm-up a record, and keeps exercises separate", () => {
    const r = recordsBySet([
      wk("a", 1, [ex("a1", "bench", sets(2, 50)), ex("a2", "row", sets(2, 30))]),
      wk("b", 8, [ex("b1", "bench", [...sets(1, 100, 5, true), ...sets(2, 55)]), ex("b2", "row", sets(2, 30))]),
    ]);
    expect(r.get("b1")![0]).toEqual([]);
    expect(r.get("b1")![1].length).toBeGreaterThan(0);
    // The row did not improve, so it earned nothing.
    expect(r.get("b2")).toEqual([[], []]);
  });

  it("is oldest first regardless of input order", () => {
    const a = wk("a", 1, [ex("a1", "bench", sets(1, 50))]);
    const b = wk("b", 8, [ex("b1", "bench", sets(1, 60))]);
    expect(recordsBySet([b, a]).get("b1")![0].length).toBeGreaterThan(0);
    expect(recordsBySet([b, a]).get("a1")).toEqual([[]]);
  });
});
