// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { DEFAULT_GOALS, type Goals } from "@/lib/goals";
import { listRoutines } from "@/lib/routines";
import { saveSplit, type Split } from "@/lib/splits";
import type { Exercise } from "@/lib/exercises";
import type { DayPlan } from "@/lib/coachBuild";
import { resetSwapAi } from "@/components/workout/SwapSheet";
import { ROUTE as PLAN_ROUTE } from "@/components/routines/GeneratePlan";
import {
  CoachSetup,
  MSG_ROUTINES_AI,
  MSG_ROUTINES_RULES,
  SPLIT_ROUTE,
  mergeAiPlan,
  parseSplitAnswer,
  rotationName,
} from "@/components/goals/CoachSetup";

// CO-05: the Build flow on the Coach tab asks only for missing inputs, keeps the
// split a rotation and drafts routines through generate-routines with the rule
// drafts as the fallback.

const CATALOGUE = JSON.parse(readFileSync(join(__dirname, "../../../data/exercises.json"), "utf8")) as Exercise[];
const BY_ID = new Map(CATALOGUE.map((e) => [e.id, e]));
const get = (id: string) => BY_ID.get(id);

const PPL: Split = {
  name: "PPL",
  days: [
    { name: "Push", muscles: ["Chest", "Shoulders", "Triceps"] },
    { name: "Pull", muscles: ["Lats", "Biceps"] },
    { name: "Legs", muscles: ["Quads", "Hamstrings", "Glutes", "Calves"] },
  ],
};

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Handler = (body: unknown) => Response;
function mockFetch(routes: { plan?: Handler; split?: Handler } = {}) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/exercises.json")) return jsonRes(200, CATALOGUE);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (u === PLAN_ROUTE && routes.plan) return routes.plan(body);
    if (u === SPLIT_ROUTE && routes.split) return routes.split(body);
    return jsonRes(503, { unavailable: true });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const sent = (fn: ReturnType<typeof mockFetch>, route: string) =>
  fn.mock.calls.filter((c) => String(c[0]) === route).map((c) => JSON.parse(String(c[1]?.body)));

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  resetSwapAi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const goals = (p: Partial<Goals> = {}): Goals => ({ ...DEFAULT_GOALS, ...p });
const storedSplit = async () => (await db.meta.get("split"))?.value as Split | undefined;
const nav = (panel: HTMLElement) => within(panel).getByRole("group", { name: "Step navigation" });
const next = (panel: HTMLElement) => fireEvent.click(within(nav(panel)).getByRole("button", { name: "Next" }));
const heading = (panel: HTMLElement) => within(panel).getByRole("heading").textContent;

function open(g: Goals, split: Split = { name: "", days: [] }) {
  render(<CoachSetup goals={g} split={split} />);
  fireEvent.click(screen.getByRole("button", { name: "Set up with coach" }));
  return screen.getByRole("region", { name: "Coach setup" });
}

async function toReview(g: Goals = goals(), favourites?: number) {
  await saveSplit(PPL);
  const panel = open(g, (await storedSplit())!);
  if (favourites) {
    // The favourites load a moment after the panel opens; wait so the request carries them.
    next(panel);
    await within(panel).findByText(`Your ${favourites} favourites are used first.`, {}, { timeout: 5000 });
  }
  while (heading(panel) !== "Review") next(panel);
  return panel;
}

const dayList = (panel: HTMLElement, day: string) => within(within(panel).getByRole("region", { name: "Your routines" })).getByRole("list", { name: `${day} exercises` });
const namesIn = (list: HTMLElement) => within(list).getAllByRole("listitem").map((li) => li.querySelector(".font-semibold")?.textContent);

// ---------- pure ----------

describe("rotationName and parseSplitAnswer", () => {
  it("keeps real day names and turns blank or weekday names into Day N", () => {
    expect(rotationName("Push", 0)).toBe("Push");
    expect(rotationName("", 2)).toBe("Day 3");
    expect(rotationName("Monday", 0)).toBe("Day 1");
    expect(rotationName("Upper (Wed)", 1)).toBe("Day 2");
    expect(rotationName("Sunday legs", 4)).toBe("Day 5");
    // Words that only contain a weekday's letters are left alone.
    expect(rotationName("Monster arms", 0)).toBe("Monster arms");
  });

  it("an AI split is a rotation, never weekdays", () => {
    const s = parseSplitAnswer({
      split: { name: "AI", days: [{ name: "Monday", muscles: ["Chest"] }, { name: "Pull", muscles: ["Lats"] }, { name: "fri", muscles: ["Quads"] }] },
    });
    expect(s?.days.map((d) => d.name)).toEqual(["Day 1", "Pull", "Day 3"]);
  });
});

describe("mergeAiPlan", () => {
  const split: Split = {
    name: "S",
    days: [
      { name: "Push", muscles: ["Chest", "Shoulders"] },
      { name: "Rest", muscles: [] },
      { name: "Legs", muscles: ["Quads"] },
    ],
  };
  const rule = (dayIndex: number, name: string, id: string): DayPlan => ({
    dayIndex,
    name,
    items: [{ exercise_id: id, muscle: get(id)!.muscle_groups[0], target_sets: 3, target_reps: "8-12", why: "rule", evidenceIds: [] }],
  });
  const base = [rule(0, "Push", "Barbell_Bench_Press_-_Medium_Grip"), rule(2, "Legs", "Barbell_Squat")];
  const opts = { get, equipment: [], limitations: [], dislikedIds: [] };
  const day = (ids: string[]) => ({ name: "x", muscles: [], notes: null, exercises: ids.map((exercise_id) => ({ exercise_id, target_sets: 4, target_reps: "6-10" })) });

  it("puts plan day i on training day i (rest days skipped) with the coach's sets and a Why", () => {
    const out = mergeAiPlan(base, split, { days: [day(["Side_Lateral_Raise"]), day(["Leg_Press"])], indices: [0, 1] }, opts)!;
    expect(out.map((d) => d.dayIndex)).toEqual([0, 2]);
    expect(out[0].items).toEqual([
      expect.objectContaining({ exercise_id: "Side_Lateral_Raise", muscle: "Shoulders", target_sets: 4, target_reps: "6-10", why: "The coach picked Side Lateral Raise for shoulders on Push." }),
    ]);
    expect(out[1].items[0].exercise_id).toBe("Leg_Press");
  });

  it("drops exercises off the day's muscles, unknown, custom, disliked, limited or for missing equipment", () => {
    const ids = ["Barbell_Curl", "made_up", "custom-1", "Side_Lateral_Raise", "Barbell_Shoulder_Press", "Triceps_Pushdown", "Barbell_Bench_Press_-_Medium_Grip"];
    const out = mergeAiPlan(base, split, { days: [day(ids)], indices: [0] }, {
      get,
      equipment: ["Barbell"],
      limitations: ["Shoulder"],
      dislikedIds: ["Side_Lateral_Raise"],
    })!;
    expect(out[0].items.map((i) => i.exercise_id)).toEqual(["Barbell_Bench_Press_-_Medium_Grip"]);
    expect(out[1]).toBe(base[1]);
  });

  it("keeps the rule draft for a day the answer left empty, ignores repeats and returns null when nothing changed", () => {
    expect(mergeAiPlan(base, split, { days: [day(["Barbell_Curl"])], indices: [0] }, opts)).toBeNull();
    // Plan day 2 repeats training day 0 (two training days): ignored.
    expect(mergeAiPlan(base, split, { days: [day(["Side_Lateral_Raise"])], indices: [2] }, opts)).toBeNull();
    const lunges = mergeAiPlan(base, split, { days: [day(["Dumbbell_Lunges"])], indices: [1] }, { ...opts, limitations: ["Knee"] });
    expect(lunges).toBeNull();
  });
});

// ---------- component ----------

describe("Build flow: only missing inputs are asked", () => {
  it("starts at Focus and days when a goal is already typed, and Back still reaches the goal step", () => {
    mockFetch();
    const panel = open(goals({ rankedGoals: ["Bigger arms"], note: "Bigger arms" }));
    expect(heading(panel)).toBe("Focus and days");
    fireEvent.click(within(nav(panel)).getByRole("button", { name: "Back" }));
    expect(heading(panel)).toBe("What do you want");
    expect(within(panel).getByLabelText("Your goal in your own words")).toHaveValue("Bigger arms");
  });

  it("starts at the goal step when no goal is typed", () => {
    mockFetch();
    expect(heading(open(goals()))).toBe("What do you want");
  });

  it("uses the saved priorities and limits instead of asking for focus muscles, and says favourites are used", async () => {
    mockFetch();
    await db.meta.put({ key: "favorites", value: ["Barbell_Curl"] });
    const panel = open(goals({ rankedGoals: ["Arms"], note: "Arms", priorities: { Biceps: "high", Calves: "low" }, focusMuscles: ["Biceps"], limitations: ["Knee"] }));
    const from = within(panel).getByRole("group", { name: "From Priorities and limits" });
    expect(from).toHaveTextContent("Muscle priorities: Biceps high, Calves low");
    expect(from).toHaveTextContent("Working around: Knee");
    expect(within(panel).queryByText("Focus muscles: these get more sets")).not.toBeInTheDocument();
    expect(await within(panel).findByText("Your 1 favourite is used first.", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("still shows the focus chips when no priorities are set", () => {
    mockFetch();
    const panel = open(goals({ rankedGoals: ["Arms"], note: "Arms" }));
    expect(within(panel).getByText("Focus muscles: these get more sets")).toBeInTheDocument();
    expect(within(panel).queryByRole("group", { name: "From Priorities and limits" })).not.toBeInTheDocument();
  });

  it("shows the proposed split as a rotation, Day 1, Day 2 ...", async () => {
    mockFetch({ split: () => jsonRes(200, { split: { name: "AI", days: [{ name: "Tuesday", muscles: ["Chest"] }, { name: "Pull", muscles: ["Lats"] }] } }) });
    const panel = open(goals());
    next(panel);
    next(panel);
    fireEvent.click(within(panel).getByRole("button", { name: "Build split" }));
    const list = await within(panel).findByRole("list", { name: "Proposed split" }, { timeout: 5000 });
    const rows = within(list).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows[0]).toMatch(/^Day 1 · Chest/);
    expect(rows[1]).toMatch(/^Day 2 · Pull · Lats/);
    expect(within(panel).getByText(/A rotation, not weekdays/)).toBeInTheDocument();
  });
});

describe("Build flow: routines through generate-routines", () => {
  const answer = {
    plan: {
      days: [
        { name: "Push", muscles: ["Chest"], exercises: [{ exercise_id: "Barbell_Bench_Press_-_Medium_Grip", target_sets: 4, target_reps: "6-8" }, { exercise_id: "Triceps_Pushdown", target_sets: 3, target_reps: "10-12" }] },
        { name: "Pull", muscles: ["Lats"], exercises: [{ exercise_id: "Pullups", target_sets: 3, target_reps: "6-10" }, { exercise_id: "made_up", target_sets: 3, target_reps: "8" }] },
        { name: "Legs", muscles: ["Quads"], exercises: [{ exercise_id: "Dumbbell_Lunges", target_sets: 3, target_reps: "10" }] },
      ],
    },
  };

  it("sends the split, plan days and favourites, shows the coach's picks with a Why, and saves them linked to the days", async () => {
    await db.meta.put({ key: "favorites", value: ["Barbell_Curl", "custom-x"] });
    const fn = mockFetch({ plan: () => jsonRes(200, answer) });
    const panel = await toReview(goals({ limitations: ["Knee"] }), 2);
    expect(await within(panel).findByText(MSG_ROUTINES_AI, {}, { timeout: 5000 })).toBeInTheDocument();
    const body = sent(fn, PLAN_ROUTE)[0];
    expect(body.split.days.map((d: { name: string }) => d.name)).toEqual(["Push", "Pull", "Legs"]);
    expect(body.plan_days).toBeUndefined(); // three days is the route default
    expect(body.favorites).toEqual(["Barbell_Curl"]);

    expect(namesIn(dayList(panel, "Push"))).toEqual(["Barbell Bench Press - Medium Grip", "Triceps Pushdown"]);
    expect(namesIn(dayList(panel, "Pull"))).toEqual(["Pullups"]);
    // Lunges load the knee: the rule draft stays for Legs.
    expect(namesIn(dayList(panel, "Legs"))).not.toContain("Dumbbell Lunges");
    expect(within(dayList(panel, "Push")).getAllByRole("listitem")[0]).toHaveTextContent("Chest · 4 x 6-8");
    fireEvent.click(within(panel).getByRole("button", { name: "Why Pullups in Pull" }));
    expect(within(panel).getByText("The coach picked Pullups for lats on Pull.")).toBeInTheDocument();
    expect(within(panel).getByText(/Day 2 ·/)).toBeInTheDocument();

    fireEvent.click(within(nav(panel)).getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await listRoutines()).toHaveLength(3), { timeout: 5000 });
    const split = (await storedSplit())!;
    const rs = await listRoutines();
    const push = rs.find((r) => r.split_day_id === split.days[0].id)!;
    expect(push.exercises.map((e) => [e.exercise_id, e.target_sets, e.target_reps])).toEqual([
      ["Barbell_Bench_Press_-_Medium_Grip", 4, "6-8"],
      ["Triceps_Pushdown", 3, "10-12"],
    ]);
    expect(split.builtFor).toBeTruthy();
    expect(await screen.findByText("Coach setup saved.", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("keeps the rule drafts with a plain note when the route is unavailable", async () => {
    mockFetch();
    const panel = await toReview();
    expect(await within(panel).findByText(MSG_ROUTINES_RULES, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(within(panel).queryByText(MSG_ROUTINES_AI)).not.toBeInTheDocument();
    expect(namesIn(dayList(panel, "Push")).length).toBeGreaterThan(0);
  });

  it("keeps the rule drafts when the answer is unusable", async () => {
    mockFetch({ plan: () => jsonRes(200, { plan: { days: [{ exercises: [{ exercise_id: "<script>" }] }] } }) });
    const panel = await toReview();
    expect(await within(panel).findByText(MSG_ROUTINES_RULES, {}, { timeout: 5000 })).toBeInTheDocument();
  });
});
