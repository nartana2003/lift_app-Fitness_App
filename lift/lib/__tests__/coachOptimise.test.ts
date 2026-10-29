import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyseSplit,
  MAX_CHANGES,
  MAX_SETS_PER_EXERCISE,
  proposeChanges,
  type Change,
  type OptimiseGoals,
  type OptimiseInput,
  type PlanRoutine,
} from "../coachOptimise";
import { reviewDefaultTarget } from "../coachReview";
import { defaultTarget, DEFAULT_GOALS, normalizeGoals } from "../goals";
import { knownEvidenceIds } from "../evidence/library";
import { MUSCLE_GROUPS } from "../muscles";
import type { Exercise } from "../exercises";
import type { Split } from "../splits";

const catalogue = JSON.parse(readFileSync(join(__dirname, "../../data/exercises.json"), "utf8")) as Exercise[];
const byId = new Map(catalogue.map((e) => [e.id, e]));
const x = (exercise_id: string, target_sets = 3) => ({ exercise_id, target_sets, target_reps: "8-12" });

const split: Split = {
  name: "Split",
  days: [
    { id: "push", name: "Push", muscles: ["Chest", "Triceps", "Shoulders"] },
    { id: "pull", name: "Pull", muscles: ["Lats", "Biceps"] },
    { id: "legs", name: "Legs", muscles: ["Quads"] },
  ],
};

const routines = (over: Partial<Record<string, PlanRoutine["exercises"]>> = {}): PlanRoutine[] => [
  { id: "r-push", name: "Push", split_day_id: "push", exercises: over.push ?? [x("Barbell_Bench_Press_-_Medium_Grip", 9), x("Triceps_Pushdown", 3)] },
  { id: "r-pull", name: "Pull", split_day_id: "pull", exercises: over.pull ?? [x("Close-Grip_Front_Lat_Pulldown", 3), x("Barbell_Curl", 3)] },
  { id: "r-legs", name: "Legs", split_day_id: "legs", exercises: over.legs ?? [x("Barbell_Squat", 6), x("Leg_Press", 6)] },
];

const goals = (p: Partial<OptimiseGoals> = {}): OptimiseGoals => ({
  goalType: "build_muscle",
  experience: "intermediate",
  sessionsPerWeek: 3,
  focusMuscles: ["Biceps"],
  priorities: { Biceps: "high", "Abs/Core": "medium", Calves: "low" },
  targets: {},
  ...p,
});

const input = (p: Partial<OptimiseInput> = {}): OptimiseInput => ({
  goals: goals(),
  split,
  routines: routines(),
  catalogue,
  equipment: [],
  ...p,
});

const row = (a: ReturnType<typeof analyseSplit>, m: string) => a.rows.find((r) => r.muscle === m)!;
const ofKind = (cs: Change[], kind: Change["kind"], muscle?: string) => cs.filter((c) => c.kind === kind && (!muscle || c.muscle === muscle));

describe("analyseSplit", () => {
  it("adds up the sets in each day's routine, once per round of the split", () => {
    const a = analyseSplit(input());
    expect(row(a, "Biceps")).toMatchObject({ weeklySets: 3, directPerWeek: 1, target: 15, status: "low", priority: "high", onSplit: true, estimated: false });
    expect(row(a, "Quads").weeklySets).toBe(12);
  });

  it("grades each muscle against its target: good, ok, low, none", () => {
    const a = analyseSplit(input());
    expect(row(a, "Quads").status).toBe("good");
    expect(row(a, "Chest").status).toBe("ok");
    expect(row(a, "Triceps").status).toBe("low");
    expect(row(a, "Abs/Core")).toMatchObject({ status: "none", onSplit: false, weeklySets: 0 });
  });

  it("scales with how often the split comes round (4 days, 2 sessions a week)", () => {
    const four: Split = { name: "4", days: [...split.days, { id: "calves", name: "Calves", muscles: ["Calves"] }] };
    const a = analyseSplit(input({ split: four, goals: goals({ sessionsPerWeek: 2 }) }));
    expect(row(a, "Quads").weeklySets).toBe(6);
    expect(row(a, "Biceps").directPerWeek).toBe(0.5);
  });

  it("estimates a day with no routine and says so", () => {
    const a = analyseSplit(input({ routines: routines().filter((r) => r.split_day_id !== "legs") }));
    expect(row(a, "Quads")).toMatchObject({ weeklySets: 6, estimated: true });
    expect(row(a, "Chest").estimated).toBe(false);
  });

  it("ignores split days that have no id (they cannot be linked)", () => {
    const noIds: Split = { name: "x", days: [{ name: "Push", muscles: ["Chest"] }] };
    expect(analyseSplit(input({ split: noIds })).rows.find((r) => r.muscle === "Chest")).toBeUndefined();
  });

  it("writes Lift noticed lines for priorities the plan does not reflect", () => {
    const a = analyseSplit(input());
    expect(a.notes).toContain("Biceps is a high priority, but it is trained directly only once a week.");
    expect(a.notes).toContain("Abs/Core is a medium priority, but no day of your split trains it.");
    expect(a.notes.length).toBeLessThanOrEqual(6);
  });

  it("says when a split muscle has no exercise in the routines", () => {
    const a = analyseSplit(input({ routines: routines({ pull: [x("Close-Grip_Front_Lat_Pulldown")] }) }));
    expect(a.notes).toContain("Biceps is a high priority, but your routines have no exercise for it.");
  });

  it("calls out a low priority muscle that gets far more than it needs", () => {
    const a = analyseSplit(input({ goals: goals({ priorities: { Quads: "low" }, focusMuscles: [] }), routines: routines({ legs: [x("Barbell_Squat", 9), x("Leg_Press", 9)] }) }));
    expect(a.notes).toContain("Quads is a low priority but gets about 18 sets a week, more than you need.");
  });

  it("passes the setup review findings through", () => {
    const a = analyseSplit(input());
    expect(a.findings.some((f) => f.code === "focus_few_exercises" && f.muscle === "Biceps")).toBe(true);
  });

  it("is quiet with no priorities and a covered split", () => {
    const a = analyseSplit(input({ goals: goals({ priorities: {}, focusMuscles: [] }) }));
    expect(a.notes).toEqual([]);
  });
});

describe("proposeChanges: growth", () => {
  it("adds a different exercise for a high priority muscle that is under target, with a why and evidence", () => {
    const { changes } = proposeChanges(input());
    const add = ofKind(changes, "add_exercise", "Biceps")[0];
    expect(add).toMatchObject({ routineId: "r-pull", dayId: "pull", sets: 3, reps: "8-12", replaceExerciseId: null });
    const ex = byId.get(add.exerciseId!)!;
    expect(ex.muscle_groups).toContain("Biceps");
    expect(add.exerciseId).not.toBe("Barbell_Curl");
    expect(add.why).toContain("Biceps is a high priority");
    expect(add.why).toContain("target of 15");
    expect(add.evidenceIds).toContain("volume-hypertrophy");
  });

  it("puts a muscle no day trains onto the lightest day and adds an exercise for it there", () => {
    const { changes } = proposeChanges(input());
    const m = ofKind(changes, "add_muscle", "Abs/Core")[0];
    expect(m).toMatchObject({ dayId: "pull", routineId: null, exerciseId: null });
    expect(m.why).toContain("no day of your split trains it");
    expect(m.why).toContain("Pull is your lightest day");
    const ex = ofKind(changes, "add_exercise", "Abs/Core")[0];
    expect(ex).toMatchObject({ dayId: "pull", routineId: "r-pull" });
  });

  it("trains a covered high priority muscle on a second day", () => {
    const covered = routines({ pull: [x("Close-Grip_Front_Lat_Pulldown"), x("Barbell_Curl", 8), x("Incline_Dumbbell_Curl", 8)] });
    const { changes } = proposeChanges(input({ routines: covered }));
    const m = ofKind(changes, "add_muscle", "Biceps")[0];
    expect(m.dayId).not.toBe("pull");
    expect(m.why).toContain("trained directly only once a week");
    expect(m.evidenceIds).toContain("frequency-twice-weekly");
  });

  it("adds a set when the muscle already has two exercises", () => {
    const two = routines({ pull: [x("Close-Grip_Front_Lat_Pulldown"), x("Barbell_Curl", 3), x("Incline_Dumbbell_Curl", 4)] });
    const more = ofKind(proposeChanges(input({ routines: two })).changes, "more_sets", "Biceps")[0];
    expect(more).toMatchObject({ exerciseId: "Barbell_Curl", sets: 4, routineId: "r-pull" });
  });

  it("never adds a set past the cap", () => {
    const maxed = routines({ pull: [x("Close-Grip_Front_Lat_Pulldown"), x("Barbell_Curl", MAX_SETS_PER_EXERCISE), x("Incline_Dumbbell_Curl", MAX_SETS_PER_EXERCISE)] });
    expect(ofKind(proposeChanges(input({ routines: maxed })).changes, "more_sets", "Biceps")).toEqual([]);
  });

  it("skips low priority muscles", () => {
    const { changes } = proposeChanges(input());
    expect(changes.some((c) => c.muscle === "Calves")).toBe(false);
  });

  it("never suggests an exercise already in a routine, or the same one twice", () => {
    const { changes } = proposeChanges(input());
    const inPlan = new Set(routines().flatMap((r) => r.exercises.map((e) => e.exercise_id)));
    const added = changes.filter((c) => c.kind === "add_exercise" || c.kind === "swap_exercise").map((c) => c.exerciseId!);
    for (const id of added) expect(inPlan.has(id)).toBe(false);
    expect(new Set(added).size).toBe(added.length);
  });

  it("respects the user's equipment", () => {
    const { changes } = proposeChanges(input({ equipment: ["Dumbbell"] }));
    for (const c of changes.filter((c) => c.kind === "add_exercise")) expect(byId.get(c.exerciseId!)!.equipment).toBe("Dumbbell");
  });

  it("proposes nothing without a split", () => {
    const empty = input({ split: { name: "", days: [] }, routines: [] });
    expect(proposeChanges(empty).changes).toEqual([]);
    expect(analyseSplit(empty).findings.some((f) => f.code === "no_split")).toBe(true);
  });

  it("keeps to the cap with unique ids, known evidence and plain text", () => {
    const heavy = goals({ priorities: Object.fromEntries(MUSCLE_GROUPS.map((m) => [m, "high" as const])) });
    const { changes } = proposeChanges(input({ goals: heavy, routines: routines({ push: [x("Triceps_Pushdown")], pull: [x("Barbell_Curl")], legs: [x("Leg_Press")] }) }));
    expect(changes.length).toBeLessThanOrEqual(MAX_CHANGES);
    expect(new Set(changes.map((c) => c.id)).size).toBe(changes.length);
    for (const c of changes) {
      expect(knownEvidenceIds(c.evidenceIds)).toEqual(c.evidenceIds);
      expect(c.evidenceIds.length).toBeLessThanOrEqual(3);
      expect(c.why.length).toBeGreaterThan(10);
      expect(c.why).not.toMatch(/\p{Extended_Pictographic}|[<>]/u);
    }
  });

  it("is deterministic and does not change its input", () => {
    const i = input();
    const before = JSON.stringify(i);
    const a = proposeChanges(i);
    expect(JSON.stringify(i)).toBe(before);
    expect(proposeChanges(input())).toEqual(a);
  });
});

describe("proposeChanges: dislikes and limits", () => {
  it("swaps an exercise the user never wants, keeping the muscle", () => {
    const { changes } = proposeChanges(input({ goals: goals({ dislikedIds: ["Barbell_Curl"] }) }));
    const swap = ofKind(changes, "swap_exercise")[0];
    expect(swap).toMatchObject({ replaceExerciseId: "Barbell_Curl", routineId: "r-pull", muscle: "Biceps" });
    expect(byId.get(swap.exerciseId!)!.muscle_groups).toContain("Biceps");
    expect(swap.why).toContain("never suggest");
  });

  it("never adds a set to a disliked exercise", () => {
    const two = routines({ pull: [x("Close-Grip_Front_Lat_Pulldown"), x("Barbell_Curl", 3), x("Incline_Dumbbell_Curl", 4)] });
    const { changes } = proposeChanges(input({ routines: two, goals: goals({ dislikedIds: ["Barbell_Curl"] }) }));
    const more = ofKind(changes, "more_sets", "Biceps")[0];
    expect(more?.exerciseId).toBe("Incline_Dumbbell_Curl");
    expect(ofKind(changes, "swap_exercise")[0].replaceExerciseId).toBe("Barbell_Curl");
  });

  it("never suggests a disliked exercise", () => {
    const disliked = catalogue.filter((e) => e.muscle_groups.includes("Biceps")).map((e) => e.id);
    const { changes } = proposeChanges(input({ goals: goals({ dislikedIds: disliked.slice(0, 20) }) }));
    const never = disliked.slice(0, 20);
    for (const c of changes) {
      if (c.kind === "add_exercise" || c.kind === "swap_exercise") expect(never).not.toContain(c.exerciseId);
    }
  });

  it("swaps an exercise whose movement loads a chosen limit, naming the limit", () => {
    const withLunge = routines({ legs: [x("Barbell_Lunge", 6), x("Leg_Press", 6)] });
    const { changes } = proposeChanges(input({ goals: goals({ limitations: ["Knee"] }), routines: withLunge }));
    const swap = ofKind(changes, "swap_exercise")[0];
    expect(swap.replaceExerciseId).toBe("Barbell_Lunge");
    expect(swap.why).toContain("knee");
    expect(byId.get(swap.exerciseId!)!.name).not.toMatch(/lunge/i);
  });

  it("never proposes an exercise that loads a chosen limit", () => {
    const { changes } = proposeChanges(input({ goals: goals({ limitations: ["Elbow", "Wrist", "Shoulder"] }) }));
    for (const c of changes.filter((c) => c.kind === "add_exercise")) {
      expect(byId.get(c.exerciseId!)!.name).not.toMatch(/skull|french press|dip|preacher|close.?grip|wrist curl|push.?up|overhead|military/i);
    }
  });

  it("reports a muscle whose candidates were all removed, instead of showing nothing quietly", () => {
    const small = catalogue.filter((e) => !e.muscle_groups.includes("Biceps") || ["Barbell_Curl", "Incline_Dumbbell_Curl"].includes(e.id));
    const { changes, emptied } = proposeChanges(input({ catalogue: small, goals: goals({ dislikedIds: ["Incline_Dumbbell_Curl"] }) }));
    expect(emptied).toContain("Biceps");
    expect(ofKind(changes, "add_exercise", "Biceps")).toEqual([]);
  });

  it("does not report emptied when nothing was removed", () => {
    expect(proposeChanges(input()).emptied).toEqual([]);
  });
});

describe("target formula with priorities", () => {
  it("coachReview agrees with goals.defaultTarget for every muscle, priority and setting", () => {
    for (const m of MUSCLE_GROUPS)
      for (const priority of [undefined, "high", "medium", "low"] as const)
        for (const experience of ["beginner", "intermediate", "advanced"] as const)
          for (const goalType of ["build_muscle", "strength", "general", "fat_loss"] as const)
            for (const sessionsPerWeek of [2, 3, 5]) {
              const g = normalizeGoals({ ...DEFAULT_GOALS, experience, goalType, sessionsPerWeek, priorities: priority ? { [m]: priority } : {} });
              expect(reviewDefaultTarget(m, g)).toBe(defaultTarget(m, g));
            }
  });

  it("keeps the old focus-only behaviour when no priorities are given", () => {
    const g = { ...DEFAULT_GOALS, focusMuscles: ["Chest" as const] };
    expect(reviewDefaultTarget("Chest", g)).toBe(defaultTarget("Chest", g));
    expect(reviewDefaultTarget("Chest", g)).toBe(reviewDefaultTarget("Back", g) + 4);
  });
});
