import { describe, expect, it } from "vitest";
import type { Exercise } from "../exercises";
import type { Equipment, MuscleGroup } from "../muscles";
import type { PlannedDayRow } from "../offline/db";
import { preferredIds } from "../favorites";
import {
  CATCH_UP_NAME,
  MAX_PER_DAY,
  MAX_SETS,
  historyCounts,
  isCatchUpRoutine,
  pickTrainingDays,
  planCatchUp,
  sessionsThisWeek,
  splitSets,
  type CatchUpInput,
} from "../catchUp";

const ex = (id: string, muscle: MuscleGroup, equipment: Equipment = "Barbell"): Exercise => ({
  id,
  name: id,
  muscle_groups: [muscle],
  secondary_groups: [],
  equipment,
  category: "strength",
  mechanic: "compound",
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
});

const CATALOGUE = [
  ex("bench", "Chest"),
  ex("db-fly", "Chest", "Dumbbell"),
  ex("push-up", "Chest", "Bodyweight"),
  ex("row", "Back"),
  ex("squat", "Quads"),
  ex("leg-press", "Quads", "Machine/Cable"),
  ex("hip-thrust", "Glutes"),
  ex("curl", "Biceps", "Dumbbell"),
];

// Week of Mon 12 Oct 2026; "today" is Wednesday.
const WED = "2026-10-14";
const THU = "2026-10-15";
const FRI = "2026-10-16";
const SAT = "2026-10-17";
const SUN = "2026-10-18";
const DAYS = [WED, THU, FRI, SAT, SUN];

const row = (date: string, routine_id: string | null, status: PlannedDayRow["status"] = "planned"): PlannedDayRow => ({
  id: `row-${date}`,
  date,
  routine_id,
  status,
  workout_id: null,
  skip_reason: null,
  skip_note: null,
  moved_to: null,
  moved_from: null,
  created_at: "2026-10-12T00:00:00.000Z",
});

const routine = (name: string, ids: string[], sets = 3) => ({ name, exercises: ids.map((exercise_id) => ({ exercise_id, target_sets: sets })) });

const input = (over: Partial<CatchUpInput> = {}): CatchUpInput => ({
  behind: [{ muscle: "Chest", remaining: 6 }],
  days: DAYS,
  planned: [],
  sessionsPerWeek: 3,
  sessionsDone: 0,
  routines: new Map(),
  catalogue: CATALOGUE,
  history: new Map(),
  favorites: [],
  ...over,
});

describe("splitSets", () => {
  it("splits into near-equal pieces of at most 3", () => {
    expect(splitSets(7)).toEqual([3, 2, 2]);
    expect(splitSets(3)).toEqual([3]);
    expect(splitSets(1)).toEqual([1]);
    expect(splitSets(10)).toEqual([3, 3, 2, 2]);
  });
  it("returns nothing for zero, negative or invalid", () => {
    expect(splitSets(0)).toEqual([]);
    expect(splitSets(-2)).toEqual([]);
    expect(splitSets(NaN)).toEqual([]);
  });
});

describe("pickTrainingDays", () => {
  it("uses every planned day left, even beyond the sessions wanted", () => {
    const planned = [row(WED, "a"), row(THU, "b"), row(FRI, "c"), row(SAT, "d")];
    expect(pickTrainingDays(DAYS, planned, 3)).toEqual([WED, THU, FRI, SAT]);
  });

  it("counts a marked gym day with no routine as a training day", () => {
    expect(pickTrainingDays(DAYS, [row(THU, null)], 1)).toEqual([THU]);
  });

  it("tops up with free days spread across the week until the sessions left are reached", () => {
    expect(pickTrainingDays(DAYS, [], 3)).toEqual([WED, FRI, SUN]);
    expect(pickTrainingDays(DAYS, [row(FRI, "a")], 3)).toEqual([WED, FRI, SUN]);
    expect(pickTrainingDays(DAYS, [row(WED, "a")], 2)).toEqual([WED, SUN]);
  });

  it("never uses a done, skipped or moved day", () => {
    const planned = [row(WED, "a", "done"), row(THU, "b", "skipped"), row(FRI, "c", "moved")];
    expect(pickTrainingDays(DAYS, planned, 3)).toEqual([SAT, SUN]);
  });

  it("returns nothing when no sessions are left and nothing is planned", () => {
    expect(pickTrainingDays(DAYS, [], 0)).toEqual([]);
  });

  it("does not add more days than are left", () => {
    expect(pickTrainingDays([SAT, SUN], [], 3)).toEqual([SAT, SUN]);
  });
});

describe("planCatchUp: training days", () => {
  it("plans only on the sessions left (3 a week, 1 done leaves 2 days)", () => {
    const plan = planCatchUp(input({ sessionsDone: 1 }));
    expect(plan.trainingDays).toEqual([WED, SUN]);
    expect(plan.additions.every((a) => plan.trainingDays.includes(a.date))).toBe(true);
  });

  it("reports no sessions left when the week is done and nothing is planned", () => {
    const plan = planCatchUp(input({ sessionsDone: 3 }));
    expect(plan).toMatchObject({ trainingDays: [], additions: [], noSessionsLeft: true });
  });

  it("still plans on a day the user planned after reaching their sessions", () => {
    const plan = planCatchUp(input({ sessionsDone: 3, planned: [row(FRI, null)] }));
    expect(plan.noSessionsLeft).toBe(false);
    expect(plan.trainingDays).toEqual([FRI]);
    expect(plan.additions.length).toBeGreaterThan(0);
  });

  it("never plans on a finished day", () => {
    const plan = planCatchUp(input({ planned: [row(WED, "x", "done")], sessionsPerWeek: 7 }));
    expect(plan.trainingDays).not.toContain(WED);
  });
});

describe("planCatchUp: using the user's routines", () => {
  it("puts chest work on the day whose routine trains chest and adds sets to the exercise already there", () => {
    const routines = new Map([
      ["push", routine("Push", ["bench"])],
      ["legs", routine("Legs", ["squat"])],
    ]);
    const plan = planCatchUp(input({ planned: [row(WED, "legs"), row(FRI, "push")], routines, behind: [{ muscle: "Chest", remaining: 3 }] }));
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0]).toMatchObject({ exercise_id: "bench", date: FRI, sets: 3, muscle: "Chest" });
    expect(plan.additions[0].reason).toContain("more on bench");
    expect(plan.additions[0].reason).toContain("Push");
  });

  it("prefers a free day over a routine that does not train the muscle", () => {
    const routines = new Map([["legs", routine("Legs", ["squat"])]]);
    const plan = planCatchUp(input({ planned: [row(WED, "legs"), row(FRI, null)], routines, behind: [{ muscle: "Chest", remaining: 3 }] }));
    expect(plan.additions[0].date).toBe(FRI);
  });

  it("offers an exercise from the user's routines before the generic ranking", () => {
    // push-up is a poor generic pick; it is in a routine on another day, so it is the user's own.
    const routines = new Map([["other", routine("Other", ["push-up"])]]);
    const plan = planCatchUp(input({ routines, planned: [row(WED, null)], behind: [{ muscle: "Chest", remaining: 3 }] }));
    expect(plan.additions[0].exercise_id).toBe("push-up");
  });

  it("then prefers what the user logs most, then favourites, then the catalogue ranking", () => {
    const base = { planned: [row(WED, null)], behind: [{ muscle: "Chest" as MuscleGroup, remaining: 3 }] };
    const logged = planCatchUp(input({ ...base, history: new Map([["db-fly", 9], ["push-up", 2]]) }));
    expect(logged.additions[0].exercise_id).toBe("db-fly");
    const faved = planCatchUp(input({ ...base, favorites: ["push-up"] }));
    expect(faved.additions[0].exercise_id).toBe("push-up");
    const generic = planCatchUp(input(base));
    expect(generic.additions[0].exercise_id).toBe("bench");
  });

  it("does not learn from earlier catch-up routines", () => {
    const routines = new Map([["old", routine(`Push${" + catch up"}`, ["push-up"])]]);
    const plan = planCatchUp(input({ routines, planned: [row(WED, null)], behind: [{ muscle: "Chest", remaining: 3 }] }));
    expect(plan.additions[0].exercise_id).toBe("bench");
  });

  it("still sees a catch-up copy as the routine planned on that day", () => {
    const routines = new Map([["copy", routine("Push + catch up", ["bench"])]]);
    const plan = planCatchUp(input({ routines, planned: [row(FRI, "copy")], behind: [{ muscle: "Chest", remaining: 3 }] }));
    expect(plan.additions[0]).toMatchObject({ exercise_id: "bench", date: FRI });
  });
});

describe("planCatchUp: rules for picks", () => {
  it("skips disliked exercises", () => {
    const plan = planCatchUp(input({ planned: [row(WED, null)], dislikedIds: ["bench"], behind: [{ muscle: "Chest", remaining: 3 }] }));
    expect(plan.additions[0].exercise_id).not.toBe("bench");
  });

  it("only uses equipment the user has (bodyweight always allowed)", () => {
    const plan = planCatchUp(input({ planned: [row(WED, null)], equipment: ["Dumbbell"], behind: [{ muscle: "Chest", remaining: 3 }] }));
    expect(plan.additions.map((a) => a.exercise_id)).not.toContain("bench");
    expect(["db-fly", "push-up"]).toContain(plan.additions[0].exercise_id);
  });

  it("treats an empty equipment list as no restriction", () => {
    const plan = planCatchUp(input({ planned: [row(WED, null)], equipment: [], behind: [{ muscle: "Chest", remaining: 3 }] }));
    expect(plan.additions[0].exercise_id).toBe("bench");
  });

  it("never puts more than MAX_PER_DAY additions on a day", () => {
    const behind: CatchUpInput["behind"] = [
      { muscle: "Chest", remaining: 9 },
      { muscle: "Back", remaining: 9 },
      { muscle: "Quads", remaining: 9 },
      { muscle: "Glutes", remaining: 9 },
      { muscle: "Biceps", remaining: 9 },
    ];
    const plan = planCatchUp(input({ behind, planned: [row(WED, null), row(FRI, null)] }));
    for (const d of plan.trainingDays) expect(plan.additions.filter((a) => a.date === d).length).toBeLessThanOrEqual(MAX_PER_DAY);
    expect(plan.unmet.length).toBeGreaterThan(0);
  });

  it("never exceeds the per-day cap even when one muscle has several pieces and many exercises", () => {
    const many = [...CATALOGUE, ex("glute-a", "Glutes"), ex("glute-b", "Glutes"), ex("glute-c", "Glutes"), ex("glute-d", "Glutes")];
    const behind: CatchUpInput["behind"] = [
      { muscle: "Glutes", remaining: 24 },
      { muscle: "Chest", remaining: 12 },
    ];
    const plan = planCatchUp(input({ catalogue: many, behind, planned: [row(WED, null), row(FRI, null)], sessionsPerWeek: 2 }));
    for (const d of plan.trainingDays) expect(plan.additions.filter((a) => a.date === d).length).toBeLessThanOrEqual(MAX_PER_DAY);
    const placed = plan.additions.reduce((n, a) => n + a.sets, 0);
    expect(placed + plan.unmet.reduce((n, u) => n + u.sets, 0)).toBe(36);
    expect(plan.unmet.length).toBeGreaterThan(0);
  });

  it("counts only the sets it really adds when an exercise hits the per-exercise cap", () => {
    const routines = new Map([["push", routine("Push", ["bench"])]]);
    const plan = planCatchUp(input({ routines, catalogue: [ex("bench", "Chest")], planned: [row(FRI, "push")], sessionsPerWeek: 1, behind: [{ muscle: "Chest", remaining: 10 }] }));
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0].sets).toBe(MAX_SETS);
    expect(plan.unmet).toEqual([{ muscle: "Chest", sets: 10 - MAX_SETS }]);
  });

  it("caps sets per exercise and spreads the rest to another day", () => {
    const routines = new Map([["push", routine("Push", ["bench"])]]);
    const plan = planCatchUp(input({ routines, planned: [row(WED, "push"), row(FRI, null)], behind: [{ muscle: "Chest", remaining: 12 }] }));
    for (const a of plan.additions) expect(a.sets).toBeLessThanOrEqual(MAX_SETS);
    expect(new Set(plan.additions.map((a) => a.date)).size).toBeGreaterThan(1);
    expect(plan.additions.reduce((n, a) => n + a.sets, 0) + plan.unmet.reduce((n, u) => n + u.sets, 0)).toBe(12);
  });

  it("never lists the same exercise twice on one day", () => {
    const plan = planCatchUp(input({ planned: [row(WED, null)], behind: [{ muscle: "Chest", remaining: 12 }] }));
    const ids = plan.additions.map((a) => `${a.date}:${a.exercise_id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not add an exercise to a day whose routine has it unless as more sets", () => {
    const routines = new Map([["push", routine("Push", ["bench", "db-fly"])]]);
    const plan = planCatchUp(input({ routines, planned: [row(WED, "push")], behind: [{ muscle: "Chest", remaining: 3 }] }));
    expect(["bench", "db-fly"]).toContain(plan.additions[0].exercise_id);
  });

  it("reports sets it could not place when no exercise trains the muscle", () => {
    const plan = planCatchUp(input({ behind: [{ muscle: "Calves", remaining: 5 }], planned: [row(WED, null)] }));
    expect(plan.additions).toEqual([]);
    expect(plan.unmet).toEqual([{ muscle: "Calves", sets: 5 }]);
  });

  it("handles nothing behind, an empty catalogue and no history", () => {
    expect(planCatchUp(input({ behind: [] })).additions).toEqual([]);
    const plan = planCatchUp(input({ catalogue: [] }));
    expect(plan.additions).toEqual([]);
    expect(plan.unmet).toEqual([{ muscle: "Chest", sets: 6 }]);
  });

  it("plans the most important muscle first when room is short", () => {
    const behind: CatchUpInput["behind"] = [
      { muscle: "Glutes", remaining: 3 },
      { muscle: "Chest", remaining: 3 },
    ];
    const plan = planCatchUp(input({ behind, planned: [row(WED, null)] }));
    expect(plan.additions.map((a) => a.muscle)).toEqual(["Glutes", "Chest"]);
  });
});

describe("helpers", () => {
  it("sessionsThisWeek counts distinct days inside the week", () => {
    const now = new Date(2026, 9, 14, 12);
    const at = (d: number, h = 9) => ({ started_at: new Date(2026, 9, d, h).toISOString() });
    expect(sessionsThisWeek([], 1, now)).toBe(0);
    expect(sessionsThisWeek([at(12), at(12, 18), at(13)], 1, now)).toBe(2);
    expect(sessionsThisWeek([at(11), at(19), at(14)], 1, now)).toBe(1);
    expect(sessionsThisWeek([at(11), at(12)], 0, now)).toBe(2);
  });

  it("historyCounts counts workouts, not repeats inside one workout", () => {
    const m = historyCounts([
      { exercises: [{ exercise_id: "a" }, { exercise_id: "a" }, { exercise_id: "b" }] },
      { exercises: [{ exercise_id: "a" }] },
    ]);
    expect(m.get("a")).toBe(2);
    expect(m.get("b")).toBe(1);
    expect(historyCounts([]).size).toBe(0);
  });

  it("isCatchUpRoutine matches only the names the plan creates", () => {
    expect(isCatchUpRoutine(CATCH_UP_NAME)).toBe(true);
    expect(isCatchUpRoutine("Push + catch up")).toBe(true);
    expect(isCatchUpRoutine("Push")).toBe(false);
    expect(isCatchUpRoutine("Catch up on legs")).toBe(false);
  });

  it("preferredIds puts stars first and drops duplicates", () => {
    expect(preferredIds(["b", "a"], ["a", "c", "c"])).toEqual(["b", "a", "c"]);
    expect(preferredIds([], [])).toEqual([]);
  });
});
