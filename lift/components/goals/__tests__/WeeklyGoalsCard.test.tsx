// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { createRoutine, getRoutine, listRoutines } from "@/lib/routines";
import { getDay, planDay } from "@/lib/planner";
import { getActive, startWorkout } from "@/lib/workout";
import { DEFAULT_GOALS, saveGoals } from "@/lib/goals";
import { saveEquipment } from "@/lib/equipment";
import type { WorkoutLite } from "@/lib/progress";
import type { Exercise } from "@/lib/exercises";
import { EQUIPMENT, MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import { MAX_SETS_PER_ADD, validateInput } from "@/lib/ai/goal-gaps";
import { MAX_TARGET, MAX_USER_TARGET } from "@/lib/ai/goal-targets";

const { CATALOGUE } = vi.hoisted(() => {
  const ex = (id: string, name: string, muscle: string) => ({
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
  });
  return {
    CATALOGUE: [
      ex("bench", "Bench Press", "Chest"),
      ex("hip-thrust", "Hip Thrust", "Glutes"),
      ex("glute-bridge", "Glute Bridge", "Glutes"),
      ex("row", "Barbell Row", "Back"),
    ] as unknown as Exercise[],
  };
});

vi.mock("@/lib/catalogue", () => {
  const byId = new Map(CATALOGUE.map((e) => [e.id, e]));
  return { useCatalogue: () => ({ loading: false, exercises: CATALOGUE, get: (id: string) => byId.get(id) }) };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import {
  AI_MESSAGES,
  GAP_MAX_REMAINING,
  GAP_MAX_SETS,
  GAP_MAX_TARGET,
  WeeklyGoalsCard,
  addToDay,
  buildGapsRequest,
  daysLeftKeys,
  parseGapsResponse,
  type GapAddition,
} from "@/components/goals/WeeklyGoalsCard";

// "Today" is Wednesday 14 Oct 2026 (local); the week starts Monday.
const NOW = new Date(2026, 9, 14, 12, 0, 0);
const MON = "2026-10-12";
const TUE = "2026-10-13";
const WED = "2026-10-14";
const THU = "2026-10-15";
const FRI = "2026-10-16";
const SUN = "2026-10-18";
const DAYS = [WED, THU, FRI, "2026-10-17", "2026-10-18"];
const short = (key: string) => new Date(key + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ADDITIONS = [
  { exercise_id: "hip-thrust", muscle: "Glutes", date: WED, sets: 3, reason: "Glutes are furthest behind.", source: "ai" },
  { exercise_id: "glute-bridge", muscle: "Glutes", date: FRI, sets: 2, reason: "Spread over the week.", source: "ai" },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await Promise.all(db.tables.map((t) => t.clear()));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderCard(workouts: WorkoutLite[] = []) {
  render(<WeeklyGoalsCard workouts={workouts} />);
  return screen.findByRole("button", { name: "Refine with AI" });
}

const plan = () => screen.getByRole("list", { name: "Catch-up plan" });
const day = (key: string) => within(plan()).getAllByRole("listitem").find((li) => within(li).queryByText(short(key), { selector: "p" }))!;
const workoutOn = (date: string): WorkoutLite => ({
  id: date,
  started_at: new Date(date + "T09:00:00").toISOString(),
  ended_at: null,
  notes: null,
  volume: 0,
  setCount: 0,
  exercises: [],
});

describe("WeeklyGoalsCard catch-up plan", () => {
  it("shows the plan on your training days with no AI call, and keeps the card", async () => {
    await renderCard();
    expect(screen.getByRole("heading", { name: "Weekly goals" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Catch up" })).toBeInTheDocument();
    // 3 sessions a week, none done, none planned: three spread days (Wed, Fri, Sun).
    expect(screen.getByText(/on your 3 remaining training days/)).toBeInTheDocument();
    const days = within(plan()).getAllByRole("listitem").filter((li) => li.querySelector(":scope > p"));
    expect(days.map((li) => li.querySelector(":scope > p")!.textContent)).toEqual([short(WED), short(FRI), short(SUN)].filter((d, i, all) => all.indexOf(d) === i).slice(0, days.length));
    expect(screen.getAllByRole("link", { name: "Bench Press" })[0]).toHaveAttribute("href", "/exercises/bench");
    expect(within(plan()).getByRole("button", { name: "Add to next workout" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("plans chest sets on the planned routine that trains chest, as more sets", async () => {
    const push = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench", target_sets: 4 }] });
    const pull = await createRoutine({ name: "Pull", exercises: [{ exercise_id: "row", target_sets: 4 }] });
    await planDay(THU, pull);
    await planDay(FRI, push);
    await renderCard();
    await waitFor(() => expect(within(day(FRI)).getByRole("link", { name: "Bench Press" })).toBeInTheDocument());
    expect(within(day(FRI)).getByText(/more on Bench Press, already in Push/)).toBeInTheDocument();
    // Back work goes to the pull day, on the exercise already in it.
    expect(within(day(THU)).getByText(/more on Barbell Row, already in Pull/)).toBeInTheDocument();
  });

  it("counts sets already planned in a routine: says so, and does not ask the AI for them again", async () => {
    // Chest defaults to 11 sets a week; this routine plans all 11, so chest is already covered.
    const push = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench", target_sets: 11 }] });
    await planDay(FRI, push);
    fetchMock.mockResolvedValue(json(200, { additions: ADDITIONS }));
    fireEvent.click(await renderCard());
    expect(screen.getByText(/Already covered by your planned routines: Chest \(11 sets\)/)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.gaps.map((g: { muscle: string }) => g.muscle)).not.toContain("Chest");
    expect(validateInput(body).ok).toBe(true);
    // No chest sets are suggested on any day.
    expect(within(plan()).queryByRole("link", { name: "Bench Press" })).not.toBeInTheDocument();
  });

  it("says the plan is already covered when every behind muscle is planned", async () => {
    await saveGoals({ targets: { ...Object.fromEntries(MUSCLE_GROUPS.map((m) => [m, 0])), Chest: 4 } });
    const push = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench", target_sets: 4 }] });
    await planDay(FRI, push);
    render(<WeeklyGoalsCard workouts={[]} />);
    expect(await screen.findByText("Your planned routines already cover your remaining sets.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Catch-up plan" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refine with AI" })).toBeDisabled();
  });

  it("says nothing is added when the week's sessions are already done", async () => {
    // Mon, Tue and Wed (today): three sessions with a goal of three.
    await renderCard([workoutOn(MON), workoutOn(TUE), workoutOn(WED)]).catch(() => undefined);
    expect(await screen.findByText("You have done your 3 sessions this week, so no more are added.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Catch-up plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refine with AI" })).not.toBeInTheDocument();
  });

  it("says all targets are met when no muscle is behind", async () => {
    await saveGoals({ targets: Object.fromEntries(MUSCLE_GROUPS.map((m) => [m, 0])) });
    render(<WeeklyGoalsCard workouts={[]} />);
    expect(await screen.findByText("All weekly targets are met.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Catch up" })).not.toBeInTheDocument();
  });

  it("refine: posts only the training days and a body the route accepts, then shows the AI plan", async () => {
    fetchMock.mockResolvedValue(json(200, { additions: ADDITIONS, unmet: [], adjusted: 0 }));
    fireEvent.click(await renderCard());

    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh AI plan" })).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ai/goal-gaps");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(validateInput(body).ok).toBe(true);
    expect(body.days_left).toEqual([WED, FRI, SUN]);
    expect(body.equipment).toBeUndefined();

    expect(within(plan()).getByText(/Hip Thrust/)).toBeInTheDocument();
    expect(within(plan()).getByText("Glutes are furthest behind.")).toBeInTheDocument();
    expect(within(plan()).getByRole("button", { name: "Add to next workout" })).toBeInTheDocument();
    expect(within(plan()).getByRole("button", { name: `Add to ${short(FRI)}` })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Basic plan" }));
    expect(screen.getByRole("button", { name: "Refine with AI" })).toBeInTheDocument();
    expect(within(plan()).queryByText("Glutes are furthest behind.")).not.toBeInTheDocument();
  });

  it("refine: sends your own exercises as favourites and your equipment", async () => {
    const id = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench" }] });
    await planDay(FRI, id);
    await saveEquipment(["Barbell", "Dumbbell"]);
    fetchMock.mockResolvedValue(json(200, { additions: ADDITIONS }));
    fireEvent.click(await renderCard());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.favorites).toContain("bench");
    expect(body.equipment).toEqual(["Dumbbell", "Barbell"]);
    expect(validateInput(body).ok).toBe(true);
    expect(body.days_left).toContain(FRI);
  });

  it("one tap adds to a free day as a new Catch up routine and to a planned routine as a copy with more sets", async () => {
    const pushId = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench", target_sets: 4 }] });
    await planDay(FRI, pushId);
    await renderCard();
    await waitFor(() => expect(within(day(FRI)).getByRole("link", { name: "Bench Press" })).toBeInTheDocument());
    const benchSets = Number(within(day(FRI)).getByRole("link", { name: "Bench Press" }).parentElement!.textContent!.match(/· (\d+) set/)![1]);

    fireEvent.click(within(plan()).getByRole("button", { name: "Add to next workout" }));
    expect(await screen.findByText(`Planned a catch-up workout on ${short(WED)}.`)).toBeInTheDocument();
    const wed = await getDay(WED);
    expect(wed?.status).toBe("planned");
    expect(await getRoutine(wed!.routine_id!)).toMatchObject({ name: "Catch up", source: "ai" });

    fireEvent.click(within(plan()).getByRole("button", { name: `Add to ${short(FRI)}` }));
    expect(await screen.findByText(`Added to Push on ${short(FRI)}.`)).toBeInTheDocument();
    const fri = await getDay(FRI);
    expect(fri?.routine_id).not.toBe(pushId);
    const copy = await getRoutine(fri!.routine_id!);
    expect(copy?.name).toBe("Push + catch up");
    expect(copy!.exercises.find((e) => e.exercise_id === "bench")!.target_sets).toBe(4 + benchSets);
    // The user's saved routine is untouched.
    expect((await getRoutine(pushId))!.exercises.map((e) => [e.exercise_id, e.target_sets])).toEqual([["bench", 4]]);
  });

  it("does not reshuffle the other days after one is added", async () => {
    await renderCard();
    const before = within(plan()).getAllByRole("listitem").map((li) => li.textContent);
    fireEvent.click(within(plan()).getByRole("button", { name: "Add to next workout" }));
    await screen.findByText(`Planned a catch-up workout on ${short(WED)}.`);
    await waitFor(() => expect(within(plan()).getAllByRole("listitem").map((li) => li.textContent!.replace(`Planned a catch-up workout on ${short(WED)}.`, "").replace("Add to next workout", ""))).toEqual(before.map((t) => t!.replace("Add to next workout", ""))));
    expect(within(plan()).getByRole("button", { name: `Add to ${short(FRI)}` })).toBeInTheDocument();
  });

  it("adding does not star the exercises or let catch-up routines feed favourites", async () => {
    await renderCard();
    fireEvent.click(within(plan()).getByRole("button", { name: "Add to next workout" }));
    await screen.findByText(`Planned a catch-up workout on ${short(WED)}.`);
    expect((await db.meta.get("favorites"))?.value ?? []).toEqual([]);
  });

  it("adds today's picks to a workout in progress", async () => {
    await startWorkout({ name: "Now", exercises: [{ exercise_id: "hip-thrust" }] });
    const msg = await addToDay(WED, [
      { exercise_id: "hip-thrust", muscle: "Glutes", date: WED, sets: 3, reason: "" },
      { exercise_id: "glute-bridge", muscle: "Glutes", date: WED, sets: 2, reason: "" },
    ], NOW);
    expect(msg).toBe("Added to your current workout.");
    expect((await getActive())!.exercises.map((e) => e.exercise_id)).toEqual(["hip-thrust", "glute-bridge"]);
    expect(await getDay(WED)).toBeUndefined();
  });

  it("addToDay adds sets to an exercise already in the day's routine and keeps a catch-up name from stacking", async () => {
    const id = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench", target_sets: 4, target_reps: "6-8" }] });
    await planDay(FRI, id);
    await addToDay(FRI, [{ exercise_id: "bench", muscle: "Chest", date: FRI, sets: 2, reason: "" }], NOW);
    const first = await getRoutine((await getDay(FRI))!.routine_id!);
    expect(first!.name).toBe("Push + catch up");
    expect(first!.exercises.map((e) => [e.exercise_id, e.target_sets, e.target_reps])).toEqual([["bench", 6, "6-8"]]);

    await addToDay(FRI, [{ exercise_id: "row", muscle: "Back", date: FRI, sets: 3, reason: "" }], NOW);
    const second = await getRoutine((await getDay(FRI))!.routine_id!);
    expect(second!.name).toBe("Push + catch up");
    expect(second!.exercises.map((e) => [e.exercise_id, e.target_sets])).toEqual([["bench", 6], ["row", 3]]);
  });

  it("leaves a done or skipped day alone", async () => {
    const id = await createRoutine({ name: "Legs", exercises: [{ exercise_id: "row" }] });
    await planDay(THU, id);
    await db.planned_days.update((await getDay(THU))!.id, { status: "done" });
    const before = await listRoutines();
    const msg = await addToDay(THU, [{ exercise_id: "hip-thrust", muscle: "Glutes", date: THU, sets: 2, reason: "" }], NOW);
    expect(msg).toBe(`${short(THU)} already has a finished or skipped workout.`);
    expect((await getDay(THU))?.routine_id).toBe(id);
    expect(await listRoutines()).toHaveLength(before.length);
  });

  it("503: shows a short plain message and keeps the plan", async () => {
    fetchMock.mockResolvedValue(json(503, { unavailable: true }));
    const btn = await renderCard();
    const before = within(plan()).getAllByRole("listitem").map((li) => li.textContent);
    fireEvent.click(btn);
    expect(await screen.findByText(AI_MESSAGES.unavailable)).toBeInTheDocument();
    expect(within(plan()).getAllByRole("listitem").map((li) => li.textContent)).toEqual(before);
    expect(await db.planned_days.count()).toBe(0);
  });

  it("failure: error status, network error and malformed body each show the failure message", async () => {
    fetchMock.mockResolvedValueOnce(json(502, { error: "error" }));
    const btn = await renderCard();
    fireEvent.click(btn);
    expect(await screen.findByText(AI_MESSAGES.failed)).toBeInTheDocument();

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Refine with AI" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(AI_MESSAGES.failed)).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(json(200, { nope: true }));
    fireEvent.click(screen.getByRole("button", { name: "Refine with AI" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(AI_MESSAGES.failed)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Catch up" })).toBeInTheDocument();
    expect(plan()).toBeInTheDocument();
  });

  it("offline: does not call the route", async () => {
    const spy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fireEvent.click(await renderCard());
    expect(await screen.findByText(AI_MESSAGES.offline)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("no usable picks: says so and keeps the plan", async () => {
    fetchMock.mockResolvedValue(json(200, { additions: [{ exercise_id: "made-up", muscle: "Glutes", date: WED, sets: 2, reason: "x" }] }));
    fireEvent.click(await renderCard());
    expect(await screen.findByText(AI_MESSAGES.empty)).toBeInTheDocument();
    expect(plan()).toBeInTheDocument();
  });
});

describe("goal-gaps helpers", () => {
  const known = (id: string) => CATALOGUE.some((e) => e.id === id);

  it("limits match the route", () => {
    expect(GAP_MAX_REMAINING).toBe(MAX_TARGET);
    expect(GAP_MAX_TARGET).toBe(MAX_USER_TARGET);
    expect(GAP_MAX_SETS).toBe(MAX_SETS_PER_ADD);
  });

  it("daysLeftKeys runs from today to the end of the week", () => {
    expect(daysLeftKeys(1, NOW)).toEqual(DAYS);
    expect(daysLeftKeys(0, NOW)).toEqual([WED, THU, FRI, "2026-10-17"]);
  });

  it("buildGapsRequest clamps to what the route accepts", () => {
    const goals = { ...DEFAULT_GOALS, sessionsPerWeek: 12, targets: { Chest: 99, Back: 10 }, focusMuscles: ["Glutes" as MuscleGroup] };
    const body = buildGapsRequest(
      [
        { muscle: "Chest", done: 0, target: 30, remaining: 30, status: "none" },
        { muscle: "Glutes", done: 2, target: 14, remaining: 12, status: "partial" },
        { muscle: "Wings", done: 0, target: 5, remaining: 5, status: "none" },
        { muscle: "Back", done: 10, target: 10, remaining: 0, status: "met" },
      ],
      goals,
      DAYS,
    );
    expect(body!.gaps).toEqual([
      { muscle: "Chest", sets_remaining: 24, target: 30 },
      { muscle: "Glutes", sets_remaining: 12, target: 14 },
    ]);
    expect(body!.goals.sessionsPerWeek).toBe(7);
    expect(body!.goals.targets).toEqual({ Back: 10 });
    expect(validateInput(body).ok).toBe(true);
    expect(buildGapsRequest([], goals, DAYS)).toBeNull();
  });

  it("buildGapsRequest sends equipment only when it is a restriction", () => {
    const behind = [{ muscle: "Chest", done: 0, target: 10, remaining: 10, status: "none" as const }];
    expect(buildGapsRequest(behind, DEFAULT_GOALS, DAYS, [], ["Dumbbell", "Barbell"])!.equipment).toEqual(["Dumbbell", "Barbell"]);
    expect(buildGapsRequest(behind, DEFAULT_GOALS, DAYS, [])!.equipment).toBeUndefined();
    expect(buildGapsRequest(behind, DEFAULT_GOALS, DAYS, [], [...EQUIPMENT])!.equipment).toBeUndefined();
    expect(validateInput(buildGapsRequest(behind, DEFAULT_GOALS, DAYS, [], ["Dumbbell"])).ok).toBe(true);
  });

  it("parseGapsResponse keeps only known exercises on offered days", () => {
    const out = parseGapsResponse(
      {
        additions: [
          { exercise_id: "hip-thrust", muscle: "Glutes", date: WED, sets: 3, reason: "ok" },
          { exercise_id: "hip-thrust", muscle: "Glutes", date: WED, sets: 2, reason: "dup" },
          { exercise_id: "unknown", muscle: "Glutes", date: WED, sets: 3, reason: "" },
          { exercise_id: "row", muscle: "Back", date: "2026-10-01", sets: 3, reason: "" },
          { exercise_id: "row", muscle: "Back", date: THU, sets: 9, reason: "" },
          { exercise_id: "row", muscle: "Wings", date: THU, sets: 2, reason: "" },
          null,
          { exercise_id: "row", muscle: "Back", date: THU, sets: 2 },
        ],
      },
      DAYS,
      known,
    );
    expect(out).toEqual<GapAddition[]>([
      { exercise_id: "hip-thrust", muscle: "Glutes", date: WED, sets: 3, reason: "ok" },
      { exercise_id: "row", muscle: "Back", date: THU, sets: 2, reason: "" },
    ]);
    expect(parseGapsResponse(null, DAYS, known)).toBeNull();
    expect(parseGapsResponse({ additions: "x" }, DAYS, known)).toBeNull();
  });
});
