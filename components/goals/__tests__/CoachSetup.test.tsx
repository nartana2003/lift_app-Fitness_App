// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { DEFAULT_GOALS, type Goals } from "@/lib/goals";
import { saveSplit, type Split } from "@/lib/splits";
import type { Exercise } from "@/lib/exercises";
import type { MuscleGroup } from "@/lib/muscles";
import {
  CoachSetup,
  MAX_ADDITIONS,
  MAX_NOTE,
  MSG_AI_UNAVAILABLE,
  MSG_ALL_GOOD,
  MSG_OFFLINE,
  REVIEW_ROUTE,
  SPLIT_ROUTE,
  catalogueIds,
  parseReviewAnswer,
  parseSplitAnswer,
  poolIdsFor,
  reviewRequestBody,
  ruleReview,
  ruleSplit,
  splitRequestBody,
  type Draft,
} from "@/components/goals/CoachSetup";
import { GoalsSection } from "@/components/goals/GoalsSection";

// ---------- fixtures ----------

const ex = (id: string, name: string, muscle: MuscleGroup, over: Partial<Exercise> = {}): Exercise => ({
  id,
  name,
  muscle_groups: [muscle],
  secondary_groups: [],
  equipment: "Barbell",
  category: "strength",
  mechanic: "compound",
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
  ...over,
});

const CATALOGUE: Exercise[] = [
  ex("bench", "Bench Press", "Chest"),
  ex("incline-db", "Incline Dumbbell Press", "Chest", { equipment: "Dumbbell" }),
  ex("cable-fly", "Cable Fly", "Chest", { equipment: "Machine/Cable", mechanic: "isolation" }),
  ex("row", "Barbell Row", "Back"),
  ex("db-row", "One-Arm Dumbbell Row", "Back", { equipment: "Dumbbell" }),
  ex("pulldown", "Lat Pulldown", "Lats", { equipment: "Machine/Cable" }),
  ex("squat", "Barbell Squat", "Quads"),
  ex("leg-press", "Leg Press", "Quads", { equipment: "Machine/Cable" }),
  ex("lunge", "Dumbbell Lunge", "Quads", { equipment: "Dumbbell" }),
  ex("curl", "Barbell Curl", "Biceps", { mechanic: "isolation" }),
  ex("hammer", "Hammer Curl", "Biceps", { equipment: "Dumbbell", mechanic: "isolation" }),
  ex("ohp", "Overhead Press", "Shoulders"),
  ex("lateral", "Lateral Raise", "Shoulders", { equipment: "Dumbbell", mechanic: "isolation" }),
  ex("rdl", "Romanian Deadlift", "Hamstrings"),
  ex("hip-thrust", "Barbell Hip Thrust", "Glutes"),
  ex("pushdown", "Triceps Pushdown", "Triceps", { equipment: "Machine/Cable", mechanic: "isolation" }),
  ex("crunch", "Crunch", "Abs/Core", { equipment: "Bodyweight", mechanic: "isolation" }),
];
const byId = new Map(CATALOGUE.map((e) => [e.id, e]));

const PPL: Split = {
  name: "Push Pull Legs",
  days: [
    { name: "Push", muscles: ["Chest", "Shoulders", "Triceps"] },
    { name: "Pull", muscles: ["Back", "Lats", "Biceps"] },
    { name: "Legs", muscles: ["Quads", "Hamstrings", "Glutes"] },
  ],
};

const draft = (over: Partial<Draft> = {}): Draft => ({
  goalType: "build_muscle",
  experience: "intermediate",
  note: "",
  focusMuscles: [],
  sessionsPerWeek: 3,
  ...over,
});

const goals = (over: Partial<Goals> = {}): Goals => ({ ...DEFAULT_GOALS, ...over });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (init?: RequestInit) => Response | Promise<Response>;
const unavailable: Handler = () => json({ unavailable: true }, 503);

/** fetch mock: the catalogue always loads; each AI route answers with its handler. */
function mockFetch(routes: { split?: Handler; review?: Handler } = {}) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/exercises.json")) return json(CATALOGUE);
    if (u === SPLIT_ROUTE) return (routes.split ?? unavailable)(init);
    if (u === REVIEW_ROUTE) return (routes.review ?? unavailable)(init);
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const calls = (fn: ReturnType<typeof mockFetch>, route: string) =>
  fn.mock.calls.filter((c) => String(c[0]) === route).map((c) => JSON.parse(String(c[1]?.body)));

function setOnline(v: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v });
}

const storedGoals = async () => (await db.meta.get("goals"))?.value as Goals | undefined;
const storedSplit = async () => (await db.meta.get("split"))?.value as Split | undefined;
const storedFavs = async () => ((await db.meta.get("favorites"))?.value as string[] | undefined) ?? [];

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  setOnline(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- UI helpers ----------

function open(props: { goals?: Goals; split?: Split } = {}) {
  render(<CoachSetup goals={props.goals ?? goals()} split={props.split ?? { name: "", days: [] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Set up with coach" }));
  return screen.getByRole("region", { name: "Coach setup" });
}
const NAV = new Set(["Back", "Next", "Skip", "Save"]);
/** Clicks a button in the panel; the step buttons are looked up in the step navigation (a muscle is also called Back). */
const click = (panel: HTMLElement, name: string | RegExp) => {
  const scope = typeof name === "string" && NAV.has(name) ? within(panel).getByRole("group", { name: "Step navigation" }) : panel;
  fireEvent.click(within(scope).getByRole("button", { name }));
};
const heading = (panel: HTMLElement) => within(panel).getByRole("heading").textContent;

// ---------- pure helpers ----------

describe("catalogueIds", () => {
  it("drops custom exercises and duplicates and caps the list", () => {
    expect(catalogueIds(["bench", "custom-1", "bench", "row", "squat"], 2)).toEqual(["bench", "row"]);
  });
});

describe("splitRequestBody", () => {
  it("sends goal, focus, days (2 to 6) and the note, never custom ids", () => {
    const body = splitRequestBody(draft({ note: "  more arms  ", focusMuscles: ["Biceps"], sessionsPerWeek: 7 }), ["custom-x", "curl"], ["Dumbbell"]);
    expect(body).toEqual({
      favorites: ["curl"],
      request: "more arms",
      days_per_week: 6,
      equipment: ["Dumbbell"],
      goal_type: "build_muscle",
      experience: "intermediate",
      focus_muscles: ["Biceps"],
    });
    expect(splitRequestBody(draft({ sessionsPerWeek: 1 }), [], []).days_per_week).toBe(2);
    expect("request" in splitRequestBody(draft({ note: "   " }), [], [])).toBe(false);
  });
});

describe("ruleSplit", () => {
  it("builds a split in the browser with the focus muscles on two days", () => {
    const s = ruleSplit(draft({ focusMuscles: ["Glutes"], sessionsPerWeek: 3 }), [], byId, []);
    expect(s.days).toHaveLength(3);
    expect(s.days.filter((d) => d.muscles.includes("Glutes")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("parseSplitAnswer", () => {
  it("keeps known muscles, drops empty days and rejects unusable answers", () => {
    const s = parseSplitAnswer({ split: { name: "AI", days: [{ name: "A", muscles: ["Chest", "Wings"] }, { name: "B", muscles: ["Nope"] }] } });
    expect(s).toEqual({ name: "AI", days: [{ name: "A", muscles: ["Chest"] }] });
    expect(parseSplitAnswer({ split: { days: [] } })).toBeNull();
    expect(parseSplitAnswer(null)).toBeNull();
    expect(parseSplitAnswer({ unavailable: true })).toBeNull();
  });
});

describe("reviewRequestBody", () => {
  it("leaves custom exercises out of the pool, clamps targets and omits an empty split", () => {
    const body = reviewRequestBody(draft({ note: "x" }), { Chest: 99, Back: 10 }, null, { Chest: ["bench", "custom-a"], Back: ["custom-b"] }, []);
    expect(body.pool).toEqual({ Chest: ["bench"] });
    expect(body.goals.targets).toEqual({ Chest: 40, Back: 10 });
    expect(body.goals.note).toBe("x");
    expect(body.split).toBeNull();
    expect(reviewRequestBody(draft(), {}, PPL, {}, []).split?.days).toHaveLength(3);
    expect("note" in reviewRequestBody(draft(), {}, PPL, {}, []).goals).toBe(false);
  });
});

describe("ruleReview", () => {
  it("says there is no split and suggests exercises for focus muscles", () => {
    const r = ruleReview(draft({ focusMuscles: ["Chest"] }), {}, null, {}, CATALOGUE, []);
    expect(r.source).toBe("rules");
    expect(r.lines.join(" ")).toMatch(/no split/i);
    expect(r.picks.some((p) => p.muscle === "Chest")).toBe(true);
  });

  it("never suggests a pool exercise", () => {
    const pool = poolIdsFor(["bench", "incline-db"], CATALOGUE, []);
    const r = ruleReview(draft({ focusMuscles: ["Chest"] }), {}, PPL, pool, CATALOGUE, []);
    expect(r.picks.map((p) => p.exercise.id)).not.toContain("bench");
    expect(r.picks.map((p) => p.exercise.id)).not.toContain("incline-db");
  });

  it("says all good when nothing needs fixing", () => {
    const split: Split = { name: "One", days: [{ name: "A", muscles: ["Chest"] }] };
    const r = ruleReview(draft({ sessionsPerWeek: 1 }), { Chest: 4 }, split, { Chest: ["bench", "incline-db"] }, CATALOGUE, []);
    expect(r.lines).toEqual([MSG_ALL_GOOD]);
  });
});

describe("parseReviewAnswer", () => {
  const get = (id: string) => byId.get(id);
  it("clamps additions to catalogue exercises not in the pool", () => {
    const additions = [
      { exercise_id: "row", muscle: "Back", reason: "Heavy pull." },
      { exercise_id: "row", muscle: "Back", reason: "Again." },
      { exercise_id: "made-up", muscle: "Back", reason: "x" },
      { exercise_id: "custom-1", muscle: "Back", reason: "x" },
      { exercise_id: "bench", muscle: "Chest", reason: "In pool." },
      { exercise_id: "squat", muscle: "Wings", reason: "x" },
      { exercise_id: "squat", muscle: "Quads" },
    ];
    const r = parseReviewAnswer({ summary: ["Line one", 3, ""], additions }, get, new Set(["bench"]));
    expect(r?.source).toBe("ai");
    expect(r?.lines).toEqual(["Line one"]);
    expect(r?.picks.map((p) => p.exercise.id)).toEqual(["row", "squat"]);
    expect(r?.picks[1].reason).toMatch(/Quads/);
  });

  it("caps additions and rejects answers with no summary", () => {
    const many = CATALOGUE.map((e) => ({ exercise_id: e.id, muscle: e.muscle_groups[0], reason: "r" }));
    expect(parseReviewAnswer({ summary: ["ok"], additions: many }, get, new Set())?.picks).toHaveLength(MAX_ADDITIONS);
    expect(parseReviewAnswer({ summary: [] }, get, new Set())).toBeNull();
    expect(parseReviewAnswer({ unavailable: true }, get, new Set())).toBeNull();
  });
});

// ---------- component ----------

describe("CoachSetup panel", () => {
  it("walks every step on the 503 path and saves the goal, note and day count only on Save", async () => {
    await db.meta.put({ key: "favorites", value: ["bench"] });
    const fetchFn = mockFetch();
    const panel = open({ split: PPL });
    expect(heading(panel)).toBe("What do you want");

    click(panel, "Get stronger");
    click(panel, "Advanced");
    fireEvent.change(within(panel).getByLabelText("Your goal in your own words"), { target: { value: "Bigger shoulders" } });
    click(panel, "Next");
    expect(heading(panel)).toBe("Focus and days");

    click(panel, "Shoulders");
    fireEvent.change(within(panel).getByLabelText("Days a week"), { target: { value: "5" } });
    expect(within(panel).getByTestId("coach-days").textContent).toBe("5");
    click(panel, "Next");
    expect(heading(panel)).toBe("Your split");
    expect(within(panel).getByRole("button", { name: "Use my current split" })).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).getByRole("list", { name: "Your current split" })).toBeInTheDocument();

    click(panel, "Next");
    expect(heading(panel)).toBe("Your exercises");
    expect(await within(panel).findByText("Bench Press")).toBeInTheDocument();

    click(panel, "Next");
    expect(heading(panel)).toBe("Review");
    expect(await within(panel).findByText(MSG_AI_UNAVAILABLE)).toBeInTheDocument();
    // The rule review still appears.
    expect(within(panel).getByRole("list", { name: "Review" }).textContent).toMatch(/Shoulders/);
    const sent = calls(fetchFn, REVIEW_ROUTE)[0];
    expect(sent.goals).toMatchObject({ goalType: "strength", experience: "advanced", sessionsPerWeek: 5, focusMuscles: ["Shoulders"], note: "Bigger shoulders" });
    expect(sent.pool).toEqual({ Chest: ["bench"] });

    // Nothing saved yet.
    expect(await storedGoals()).toBeUndefined();
    click(panel, "Save");
    await waitFor(async () => expect((await storedGoals())?.sessionsPerWeek).toBe(5));
    expect(await storedGoals()).toMatchObject({ goalType: "strength", experience: "advanced", note: "Bigger shoulders", focusMuscles: ["Shoulders"] });
    expect(await storedSplit()).toBeUndefined();
    expect(await screen.findByText("Coach setup saved.")).toBeInTheDocument();
  });

  it("caps the typed goal at 300 characters", () => {
    mockFetch();
    const panel = open();
    const box = within(panel).getByLabelText("Your goal in your own words") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "a".repeat(400) } });
    expect(box.value).toHaveLength(MAX_NOTE);
  });

  it("Back keeps changes, Skip undoes the step's changes, Cancel discards everything", async () => {
    mockFetch();
    const panel = open();
    click(panel, "Lose fat");
    click(panel, "Next");
    click(panel, "Back");
    expect(heading(panel)).toBe("What do you want");
    expect(within(panel).getByRole("button", { name: "Lose fat" })).toHaveAttribute("aria-pressed", "true");

    click(panel, "General fitness");
    click(panel, "Skip");
    expect(heading(panel)).toBe("Focus and days");
    click(panel, "Back");
    // Skip undid the change made on step 1; the change kept by Next/Back stays.
    expect(within(panel).getByRole("button", { name: "Lose fat" })).toHaveAttribute("aria-pressed", "true");

    click(panel, "Next");
    fireEvent.change(within(panel).getByLabelText("Days a week"), { target: { value: "6" } });
    click(panel, "Skip");
    click(panel, "Back");
    click(panel, "Back");
    click(panel, "Next");
    expect(within(panel).getByTestId("coach-days").textContent).toBe("3");

    click(panel, "Cancel");
    expect(screen.queryByRole("region", { name: "Coach setup" })).toBeNull();
    expect(await storedGoals()).toBeUndefined();
  });

  it("with no split, Build is the default and the rule split is built on 503", async () => {
    const fetchFn = mockFetch();
    const panel = open({ goals: goals({ focusMuscles: ["Glutes"] }) });
    click(panel, "Next");
    click(panel, "Next");
    expect(within(panel).queryByRole("button", { name: "Use my current split" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Build one for me" })).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).getByText(/You have no split yet/)).toBeInTheDocument();

    click(panel, "Build split");
    expect(await within(panel).findByText(MSG_AI_UNAVAILABLE)).toBeInTheDocument();
    const proposed = within(panel).getByRole("list", { name: "Proposed split" });
    expect(within(proposed).getAllByRole("listitem")).toHaveLength(3);
    expect(calls(fetchFn, SPLIT_ROUTE)[0]).toMatchObject({ days_per_week: 3, focus_muscles: ["Glutes"], goal_type: "build_muscle" });

    click(panel, "Use this split");
    expect(within(panel).getByText("This split will be saved when you tap Save.")).toBeInTheDocument();
    expect(await storedSplit()).toBeUndefined();
    click(panel, "Next");
    click(panel, "Next");
    await within(panel).findByText(MSG_AI_UNAVAILABLE);
    click(panel, "Save");
    await waitFor(async () => expect((await storedSplit())?.days).toHaveLength(3));
  });

  it("replacing an existing split needs a confirm and keeps the old split until Save", async () => {
    await saveSplit(PPL);
    mockFetch({
      split: () => json({ split: { name: "Upper Lower", days: [{ name: "Upper", muscles: ["Chest", "Back"] }, { name: "Lower", muscles: ["Quads"] }] }, notes: null, source: "ai" }),
    });
    const panel = open({ split: PPL });
    click(panel, "Next");
    click(panel, "Next");
    click(panel, "Build one for me");
    click(panel, "Build split");
    const proposed = await within(panel).findByRole("list", { name: "Proposed split" });
    expect(proposed.textContent).toMatch(/Upper/);
    expect(within(panel).queryByText(MSG_AI_UNAVAILABLE)).toBeNull();

    click(panel, "Use this split");
    expect(within(panel).getByText(/This replaces your current split \(Push Pull Legs\)/)).toBeInTheDocument();
    click(panel, "Keep current");
    expect(within(panel).getByRole("button", { name: "Use this split" })).toBeInTheDocument();
    click(panel, "Use this split");
    click(panel, "Replace split");
    expect((await storedSplit())?.name).toBe("Push Pull Legs");

    click(panel, "Next");
    click(panel, "Next");
    await within(panel).findByText(MSG_AI_UNAVAILABLE);
    expect((await storedSplit())?.name).toBe("Push Pull Legs");
    click(panel, "Save");
    await waitFor(async () => expect((await storedSplit())?.name).toBe("Upper Lower"));
  });

  it("Use my current split after a replace keeps the old split", async () => {
    await saveSplit(PPL);
    mockFetch({ split: () => json({ split: { name: "U", days: [{ name: "Upper", muscles: ["Chest"] }] } }) });
    const panel = open({ split: PPL });
    click(panel, "Next");
    click(panel, "Next");
    click(panel, "Build one for me");
    click(panel, "Build split");
    await within(panel).findByRole("list", { name: "Proposed split" });
    click(panel, "Use this split");
    click(panel, "Replace split");
    click(panel, "Use my current split");
    click(panel, "Next");
    click(panel, "Next");
    await within(panel).findByText(MSG_AI_UNAVAILABLE);
    click(panel, "Save");
    await screen.findByText("Coach setup saved.");
    expect((await storedSplit())?.name).toBe("Push Pull Legs");
  });

  /** suggest-split answers split A first, then split B. */
  function twoBuilds() {
    let n = 0;
    return mockFetch({
      split: () =>
        json(
          n++ === 0
            ? { split: { name: "Split A", days: [{ name: "A1", muscles: ["Chest"] }, { name: "A2", muscles: ["Quads"] }] }, notes: null, source: "ai" }
            : { split: { name: "Split B", days: [{ name: "B1", muscles: ["Back"] }, { name: "B2", muscles: ["Glutes"] }] }, notes: null, source: "ai" },
        ),
    });
  }

  it("Build again without accepting the new split does not save the earlier one", async () => {
    twoBuilds();
    const panel = open();
    click(panel, "Next");
    click(panel, "Next");
    click(panel, "Build split");
    expect((await within(panel).findByRole("list", { name: "Proposed split" })).textContent).toMatch(/A1/);
    click(panel, "Use this split");
    expect(within(panel).getByText("This split will be saved when you tap Save.")).toBeInTheDocument();

    click(panel, "Build again");
    await waitFor(() => expect(within(panel).getByRole("list", { name: "Proposed split" }).textContent).toMatch(/B1/));
    expect(within(panel).getByRole("button", { name: "Use this split" })).toBeInTheDocument();
    expect(within(panel).queryByText("This split will be saved when you tap Save.")).toBeNull();

    click(panel, "Next");
    click(panel, "Next");
    await within(panel).findByText(MSG_AI_UNAVAILABLE);
    expect(within(panel).queryByText("Your new split is saved when you tap Save.")).toBeNull();
    click(panel, "Save");
    await screen.findByText("Coach setup saved.");
    expect(await storedSplit()).toBeUndefined();
  });

  it("Build again with an existing split asks to confirm again and saves only the accepted new split", async () => {
    await saveSplit(PPL);
    twoBuilds();
    const panel = open({ split: PPL });
    click(panel, "Next");
    click(panel, "Next");
    click(panel, "Build one for me");
    click(panel, "Build split");
    await within(panel).findByRole("list", { name: "Proposed split" });
    click(panel, "Use this split");
    click(panel, "Replace split");

    click(panel, "Build again");
    await waitFor(() => expect(within(panel).getByRole("list", { name: "Proposed split" }).textContent).toMatch(/B1/));
    click(panel, "Use this split");
    expect(within(panel).getByText(/This replaces your current split/)).toBeInTheDocument();
    click(panel, "Replace split");

    click(panel, "Next");
    click(panel, "Next");
    await within(panel).findByText(MSG_AI_UNAVAILABLE);
    expect((await storedSplit())?.name).toBe("Push Pull Legs");
    click(panel, "Save");
    await waitFor(async () => expect((await storedSplit())?.name).toBe("Split B"));
  });

  it("adds exercises from the search and stars them only on Save", async () => {
    await db.meta.put({ key: "favorites", value: ["custom-mine"] });
    const fetchFn = mockFetch();
    const panel = open({ split: PPL });
    click(panel, "Next");
    click(panel, "Next");
    click(panel, "Next");
    await within(panel).findByRole("button", { name: "Add exercises for Biceps" });
    click(panel, "Add exercises for Biceps");
    fireEvent.change(await within(panel).findByLabelText("Search exercises for Biceps"), { target: { value: "hammer" } });
    click(panel, "Add Hammer Curl");
    expect(within(panel).getByRole("button", { name: "Remove Hammer Curl" })).toBeInTheDocument();
    expect(await storedFavs()).toEqual(["custom-mine"]);

    click(panel, "Next");
    await within(panel).findByText(MSG_AI_UNAVAILABLE);
    const sent = calls(fetchFn, REVIEW_ROUTE)[0];
    expect(sent.pool).toEqual({ Biceps: ["hammer"] });
    expect(JSON.stringify(sent)).not.toContain("custom-");
    click(panel, "Save");
    await waitFor(async () => expect(await storedFavs()).toContain("hammer"));
    expect(await storedFavs()).toContain("custom-mine");
  });

  it("shows the AI review and adds a suggested exercise with a tap", async () => {
    mockFetch({
      review: () =>
        json({
          summary: ["Your back needs a second exercise."],
          additions: [
            { exercise_id: "row", muscle: "Back", reason: "A heavy row for thickness." },
            { exercise_id: "not-real", muscle: "Back", reason: "x" },
          ],
          source: "ai",
        }),
    });
    const panel = open({ split: PPL });
    for (let i = 0; i < 4; i++) click(panel, "Next");
    expect(await within(panel).findByText("Your back needs a second exercise.")).toBeInTheDocument();
    expect(within(panel).getByText("A heavy row for thickness.")).toBeInTheDocument();
    expect(within(panel).queryByText(MSG_AI_UNAVAILABLE)).toBeNull();
    click(panel, "Add Barbell Row");
    expect(within(panel).getByRole("button", { name: "Barbell Row added" })).toBeInTheDocument();
    click(panel, "Save");
    await waitFor(async () => expect(await storedFavs()).toEqual(["row"]));
  });

  it("adds a rule suggestion on the 503 path", async () => {
    mockFetch();
    const panel = open({ split: PPL, goals: goals({ focusMuscles: ["Chest"] }) });
    for (let i = 0; i < 4; i++) click(panel, "Next");
    await within(panel).findByText(MSG_AI_UNAVAILABLE);
    const add = within(panel).getAllByRole("button", { name: /^Add / })[0];
    const name = add.getAttribute("aria-label")!.replace(/^Add /, "");
    fireEvent.click(add);
    click(panel, "Save");
    const id = CATALOGUE.find((e) => e.name === name)!.id;
    await waitFor(async () => expect(await storedFavs()).toEqual([id]));
  });

  it("falls back to the rules on a failed or malformed answer and when offline", async () => {
    mockFetch({ split: () => json({ nope: 1 }), review: () => json({ error: "x" }, 500) });
    const panel = open();
    click(panel, "Next");
    click(panel, "Next");
    click(panel, "Build split");
    expect(await within(panel).findByText(MSG_AI_UNAVAILABLE)).toBeInTheDocument();
    click(panel, "Next");
    click(panel, "Next");
    expect(await within(panel).findByText(MSG_AI_UNAVAILABLE)).toBeInTheDocument();

    setOnline(false);
    click(panel, "Back");
    click(panel, "Next");
    expect(await within(panel).findByText(MSG_OFFLINE)).toBeInTheDocument();
    expect(within(panel).getByRole("list", { name: "Review" })).toBeInTheDocument();
  });

  it("uses no emojis", async () => {
    mockFetch();
    const panel = open({ split: PPL });
    for (let i = 0; i < 4; i++) click(panel, "Next");
    await within(panel).findByText(MSG_AI_UNAVAILABLE);
    expect(panel.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("GoalsSection with CoachSetup", () => {
  it("keeps the existing controls and adds the Set up with coach button", async () => {
    mockFetch();
    render(<GoalsSection />);
    expect(screen.getByText("What are you training for?")).toBeInTheDocument();
    expect(screen.getByText("Weekly set targets")).toBeInTheDocument();
    expect(screen.getByText("Suggest weekly targets")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up with coach" }));
    expect(screen.getByRole("region", { name: "Coach setup" })).toBeInTheDocument();
  });
});
