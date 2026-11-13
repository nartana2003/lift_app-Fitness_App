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

const routine = (name: string, ids: string[], sets = 1) => ({ name, exercises: ids.map((exercise_id) => ({ exercise_id, target_sets: sets })) });

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
    // The routine already has 1 chest set planned, so 2 of the 3 missing sets are added.
    expect(plan.additions[0]).toMatchObject({ exercise_id: "bench", date: FRI, sets: 2, muscle: "Chest" });
    expect(plan.additions[0].in_routine).toBe(true);
    expect(plan.additions[0].reason).toBe("Brings Chest to target");
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

describe("planCatchUp: sets already planned", () => {
  const push = (sets: number) => new Map([["push", routine("Push", ["bench"], sets)]]);

  it("subtracts the sets planned on training days from what is still needed", () => {
    const plan = planCatchUp(input({ routines: push(4), planned: [row(FRI, "push")], sessionsPerWeek: 1, behind: [{ muscle: "Chest", remaining: 10 }] }));
    expect(plan.covered).toEqual([{ muscle: "Chest", sets: 4 }]);
    expect(plan.additions.reduce((n, a) => n + a.sets, 0) + plan.unmet.reduce((n, u) => n + u.sets, 0)).toBe(6);
  });

  it("adds nothing for a muscle the planned routines already cover, and caps covered at what was needed", () => {
    const plan = planCatchUp(input({ routines: push(8), planned: [row(FRI, "push")], sessionsPerWeek: 1, behind: [{ muscle: "Chest", remaining: 3 }] }));
    expect(plan.additions).toEqual([]);
    expect(plan.unmet).toEqual([]);
    expect(plan.covered).toEqual([{ muscle: "Chest", sets: 3 }]);
    expect(plan.noSessionsLeft).toBe(false);
  });

  it("still plans the other muscles when one is covered", () => {
    const plan = planCatchUp(
      input({ routines: push(8), planned: [row(FRI, "push")], sessionsPerWeek: 1, behind: [{ muscle: "Chest", remaining: 3 }, { muscle: "Back", remaining: 3 }] }),
    );
    expect(plan.additions.map((a) => a.muscle)).toEqual(["Back"]);
  });

  it("counts every primary muscle of a planned exercise", () => {
    const both = { ...ex("pull-up", "Back"), muscle_groups: ["Back", "Biceps"] as MuscleGroup[] };
    const routines = new Map([["pull", routine("Pull", ["pull-up"], 4)]]);
    const plan = planCatchUp(input({ catalogue: [both], routines, planned: [row(FRI, "pull")], sessionsPerWeek: 1, behind: [{ muscle: "Back", remaining: 6 }, { muscle: "Biceps", remaining: 2 }] }));
    expect(plan.covered).toEqual([{ muscle: "Back", sets: 4 }, { muscle: "Biceps", sets: 2 }]);
  });

  it("ignores routines on days that are done, skipped or not planned", () => {
    const routines = new Map([["push", routine("Push", ["bench"], 8)], ["old", routine("Old", ["bench"], 8)]]);
    const plan = planCatchUp(input({ routines, planned: [row(WED, "push", "done"), row(THU, "old", "skipped")], sessionsPerWeek: 1, behind: [{ muscle: "Chest", remaining: 3 }] }));
    expect(plan.covered).toEqual([]);
    expect(plan.additions.length).toBeGreaterThan(0);
  });

  it("reports nothing covered when no planned routine trains a behind muscle", () => {
    const plan = planCatchUp(input({ routines: push(4), planned: [row(FRI, "push")], sessionsPerWeek: 1, behind: [{ muscle: "Back", remaining: 3 }] }));
    expect(plan.covered).toEqual([]);
  });

  it("counts an earlier catch-up copy planned on the day, so a second look does not add the same sets again", () => {
    const routines = new Map([["copy", routine("Push + catch up", ["bench"], 6)]]);
    const plan = planCatchUp(input({ routines, planned: [row(FRI, "copy")], sessionsPerWeek: 1, behind: [{ muscle: "Chest", remaining: 6 }] }));
    expect(plan.additions).toEqual([]);
    expect(plan.covered).toEqual([{ muscle: "Chest", sets: 6 }]);
  });
});

describe("planCatchUp: variety", () => {
  // "bar-extension" sorts before "pushdown", so it is the first pick unless variety changes it.
  const catalogue = [ex("bar-extension", "Triceps"), ex("pushdown", "Triceps", "Machine/Cable"), ex("bench", "Chest")];

  it("prefers equipment the day does not use yet among the top picks", () => {
    const routines = new Map([["push", routine("Push", ["bench"])]]);
    const plan = planCatchUp(input({ catalogue, routines, planned: [row(FRI, "push")], sessionsPerWeek: 1, behind: [{ muscle: "Triceps", remaining: 3 }] }));
    expect(plan.additions[0].exercise_id).toBe("pushdown");
  });

  it("falls back to the first pick when every option uses equipment the day already has", () => {
    const same = [ex("bar-extension", "Triceps"), ex("close-grip", "Triceps"), ex("bench", "Chest")];
    const routines = new Map([["push", routine("Push", ["bench"])]]);
    const plan = planCatchUp(input({ catalogue: same, routines, planned: [row(FRI, "push")], sessionsPerWeek: 1, behind: [{ muscle: "Triceps", remaining: 3 }] }));
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0].exercise_id).toBe("bar-extension");
  });

  it("does not change the pick on a day with nothing planned", () => {
    const plan = planCatchUp(input({ catalogue, planned: [row(WED, null)], sessionsPerWeek: 1, behind: [{ muscle: "Triceps", remaining: 3 }] }));
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0].exercise_id).toBe("bar-extension");
  });
});

describe("planCatchUp: exercises that hit two muscles", () => {
  const pullUp = { ...ex("weighted-pull-up", "Back"), muscle_groups: ["Back", "Biceps"] as MuscleGroup[] };

  it("credits every primary muscle of a placed exercise and says so in the reason", () => {
    const plan = planCatchUp(input({ catalogue: [pullUp], planned: [row(WED, null)], sessionsPerWeek: 1, behind: [{ muscle: "Back", remaining: 3 }, { muscle: "Biceps", remaining: 3 }] }));
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0]).toMatchObject({ exercise_id: "weighted-pull-up", muscle: "Back", sets: 3 });
    expect(plan.additions[0].reason).toBe("Brings Back to target, also Biceps");
    expect(plan.unmet).toEqual([]);
  });

  it("only credits the sets the other muscle still needs", () => {
    const plan = planCatchUp(input({ catalogue: [pullUp, ex("curl", "Biceps", "Dumbbell")], planned: [row(WED, null), row(FRI, null)], sessionsPerWeek: 2, behind: [{ muscle: "Back", remaining: 6 }, { muscle: "Biceps", remaining: 4 }] }));
    const biceps = plan.additions.filter((a) => a.muscle === "Biceps").reduce((n, a) => n + a.sets, 0);
    const back = plan.additions.filter((a) => a.muscle === "Back").reduce((n, a) => n + a.sets, 0);
    expect(back).toBe(6);
    // The pull-up sets cover biceps too, so at most the remaining 4 biceps sets are covered in total.
    expect(biceps + Math.min(back, 4)).toBeGreaterThanOrEqual(4);
    expect(plan.unmet).toEqual([]);
  });

  it("when slots are short, prefers the exercise that covers two behind muscles so more muscles fit", () => {
    const catalogue = [
      ex("row", "Back"), pullUp, ex("curl", "Biceps", "Dumbbell"), ex("squat", "Quads"), ex("hip-thrust", "Glutes"),
      ex("bench", "Chest"), ex("press", "Shoulders"), ex("dip", "Triceps"),
    ];
    const behind: CatchUpInput["behind"] = (["Back", "Biceps", "Quads", "Glutes", "Chest", "Shoulders", "Triceps"] as MuscleGroup[]).map((muscle) => ({ muscle, remaining: 3 }));
    // One training day: 6 slots for 7 muscles, so the pull-up (Back and Biceps) has to carry two.
    const plan = planCatchUp(input({ catalogue, behind, planned: [row(WED, null)], sessionsPerWeek: 1 }));
    expect(plan.additions).toHaveLength(MAX_PER_DAY);
    expect(plan.additions.map((a) => a.exercise_id).sort()).toEqual(["bench", "dip", "hip-thrust", "press", "squat", "weighted-pull-up"]);
    expect(plan.unmet).toEqual([]);
  });

  it("fits six behind muscles into one day: six exercises of three sets each", () => {
    const catalogue = [ex("row", "Back"), ex("curl", "Biceps", "Dumbbell"), ex("dip", "Triceps"), ex("squat", "Quads"), ex("hip-thrust", "Glutes"), ex("bench", "Chest")];
    const behind: CatchUpInput["behind"] = (["Back", "Biceps", "Triceps", "Quads", "Glutes", "Chest"] as MuscleGroup[]).map((muscle) => ({ muscle, remaining: 3 }));
    const plan = planCatchUp(input({ catalogue, behind, planned: [row(WED, null)], sessionsPerWeek: 1 }));
    expect(plan.additions).toHaveLength(6);
    expect(plan.additions.every((a) => a.sets === 3)).toBe(true);
    expect(plan.unmet).toEqual([]);
  });

  it("counts the day's routine toward the six: 4 planned exercises leave room for 2 new ones, but extra sets on the 4 are fine", () => {
    const catalogue = [
      ex("bench", "Chest"), ex("row", "Back"), ex("squat", "Quads"), ex("curl", "Biceps", "Dumbbell"),
      ex("hip-thrust", "Glutes"), ex("dip", "Triceps"), ex("press", "Shoulders"), ex("crunch", "Abs/Core" as MuscleGroup, "Bodyweight"),
    ];
    const routines = new Map([["full", routine("Full", ["bench", "row", "squat", "curl"])]]);
    const behind: CatchUpInput["behind"] = (["Chest", "Back", "Quads", "Biceps", "Glutes", "Triceps", "Shoulders", "Abs/Core"] as MuscleGroup[]).map((muscle) => ({ muscle, remaining: 4 }));
    const plan = planCatchUp(input({ catalogue, routines, behind, planned: [row(WED, "full")], sessionsPerWeek: 1 }));
    const fresh = plan.additions.filter((a) => !a.in_routine);
    const extra = plan.additions.filter((a) => a.in_routine);
    expect(fresh.length).toBeLessThanOrEqual(2);
    expect(4 + fresh.length).toBeLessThanOrEqual(MAX_PER_DAY);
    // More sets on the exercises already in the routine are still suggested.
    expect(extra.map((a) => a.exercise_id).sort()).toEqual(["bench", "curl", "row", "squat"]);
    // What does not fit is reported, not squeezed in.
    expect(plan.unmet.length).toBeGreaterThan(0);
  });

  it("with plenty of slots, keeps the user's own order of exercises", () => {
    const catalogue = [ex("row", "Back"), pullUp];
    const routines = new Map([["other", routine("Other", ["row"])]]);
    const plan = planCatchUp(input({ catalogue, routines, behind: [{ muscle: "Back", remaining: 3 }], planned: [row(WED, null)], sessionsPerWeek: 1 }));
    expect(plan.additions[0].exercise_id).toBe("row");
  });

  it("marks sets added to an exercise already in the day's routine", () => {
    const routines = new Map([["push", routine("Push", ["bench"])]]);
    const plan = planCatchUp(input({ routines, planned: [row(FRI, "push"), row(WED, null)], sessionsPerWeek: 2, behind: [{ muscle: "Chest", remaining: 3 }, { muscle: "Quads", remaining: 3 }] }));
    expect(plan.additions.find((a) => a.muscle === "Chest")!.in_routine).toBe(true);
    expect(plan.additions.find((a) => a.muscle === "Quads")!.in_routine).toBe(false);
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
      { muscle: "Chest", remaining: 30 },
      { muscle: "Back", remaining: 30 },
      { muscle: "Quads", remaining: 30 },
      { muscle: "Glutes", remaining: 30 },
      { muscle: "Biceps", remaining: 30 },
    ];
    const plan = planCatchUp(input({ behind, planned: [row(WED, null), row(FRI, null)] }));
    for (const d of plan.trainingDays) expect(plan.additions.filter((a) => a.date === d).length).toBeLessThanOrEqual(MAX_PER_DAY);
    expect(plan.unmet.length).toBeGreaterThan(0);
  });

  it("never exceeds the per-day cap even when one muscle has several pieces and many exercises", () => {
    const many = [...CATALOGUE, ex("glute-a", "Glutes"), ex("glute-b", "Glutes"), ex("glute-c", "Glutes"), ex("glute-d", "Glutes")];
    const behind: CatchUpInput["behind"] = [
      { muscle: "Glutes", remaining: 60 },
      { muscle: "Chest", remaining: 60 },
    ];
    const plan = planCatchUp(input({ catalogue: many, behind, planned: [row(WED, null), row(FRI, null)], sessionsPerWeek: 2 }));
    for (const d of plan.trainingDays) expect(plan.additions.filter((a) => a.date === d).length).toBeLessThanOrEqual(MAX_PER_DAY);
    const placed = plan.additions.reduce((n, a) => n + a.sets, 0);
    expect(placed + plan.unmet.reduce((n, u) => n + u.sets, 0)).toBe(120);
    expect(plan.unmet.length).toBeGreaterThan(0);
  });

  it("counts only the sets it really adds when an exercise hits the per-exercise cap", () => {
    const routines = new Map([["push", routine("Push", ["bench"])]]);
    const plan = planCatchUp(input({ routines, catalogue: [ex("bench", "Chest")], planned: [row(FRI, "push")], sessionsPerWeek: 1, behind: [{ muscle: "Chest", remaining: 10 }] }));
    expect(plan.additions).toHaveLength(1);
    expect(plan.additions[0].sets).toBe(MAX_SETS);
    expect(plan.unmet).toEqual([{ muscle: "Chest", sets: 9 - MAX_SETS }]); // 1 of the 10 is already planned
  });

  it("caps sets per exercise and spreads the rest to another day", () => {
    const routines = new Map([["push", routine("Push", ["bench"])]]);
    const plan = planCatchUp(input({ routines, planned: [row(WED, "push"), row(FRI, null)], behind: [{ muscle: "Chest", remaining: 12 }] }));
    for (const a of plan.additions) expect(a.sets).toBeLessThanOrEqual(MAX_SETS);
    expect(new Set(plan.additions.map((a) => a.date)).size).toBeGreaterThan(1);
    // 1 of the 12 sets is already planned in the routine.
    expect(plan.additions.reduce((n, a) => n + a.sets, 0) + plan.unmet.reduce((n, u) => n + u.sets, 0)).toBe(11);
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
