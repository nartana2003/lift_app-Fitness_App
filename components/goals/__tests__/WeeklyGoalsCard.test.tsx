// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { createRoutine, getRoutine, listRoutines } from "@/lib/routines";
import { getDay, planDay } from "@/lib/planner";
import { getActive, startWorkout } from "@/lib/workout";
import { DEFAULT_GOALS } from "@/lib/goals";
import type { Exercise } from "@/lib/exercises";
import type { MuscleGroup } from "@/lib/muscles";
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
const WED = "2026-10-14";
const THU = "2026-10-15";
const FRI = "2026-10-16";
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

async function renderCard() {
  render(<WeeklyGoalsCard workouts={[]} />);
  return screen.findByRole("button", { name: "Plan the week with AI" });
}

const plan = () => screen.getByRole("list", { name: "AI catch-up plan" });

describe("WeeklyGoalsCard AI catch-up", () => {
  it("keeps the existing card and rule-based suggestions", async () => {
    await renderCard();
    expect(screen.getByRole("heading", { name: "Weekly goals" })).toBeInTheDocument();
    expect(screen.getByText("Catch up")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Bench Press" })[0]).toHaveAttribute("href", "/exercises/bench");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("success: posts a body the route accepts and shows the plan by day", async () => {
    fetchMock.mockResolvedValue(json(200, { additions: ADDITIONS, unmet: [], adjusted: 0 }));
    fireEvent.click(await renderCard());

    await waitFor(() => expect(plan()).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ai/goal-gaps");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(validateInput(body).ok).toBe(true);
    expect(body.days_left).toEqual(daysLeftKeys(1, NOW));

    const items = within(plan()).getAllByRole("listitem");
    expect(within(plan()).getByText("Hip Thrust · 3 sets")).toBeInTheDocument();
    expect(within(plan()).getByText("Glute Bridge · 2 sets")).toBeInTheDocument();
    expect(within(plan()).getByText("Glutes are furthest behind.")).toBeInTheDocument();
    expect(items.length).toBeGreaterThan(0);
    expect(within(plan()).getByRole("button", { name: "Add to next workout" })).toBeInTheDocument();
    expect(within(plan()).getByRole("button", { name: `Add to ${short(FRI)}` })).toBeInTheDocument();
    // Rule-based chips are still there.
    expect(screen.getByText("Catch up")).toBeInTheDocument();
  });

  it("one tap adds to the next workout (new catch-up day) and to a planned routine as a copy", async () => {
    const pushId = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench", target_sets: 4 }] });
    await planDay(FRI, pushId);
    fetchMock.mockResolvedValue(json(200, { additions: ADDITIONS }));
    fireEvent.click(await renderCard());
    await waitFor(() => expect(plan()).toBeInTheDocument());

    fireEvent.click(within(plan()).getByRole("button", { name: "Add to next workout" }));
    expect(await screen.findByText(`Planned a catch-up workout on ${short(WED)}.`)).toBeInTheDocument();
    const wed = await getDay(WED);
    expect(wed?.status).toBe("planned");
    const catchUp = await getRoutine(wed!.routine_id!);
    expect(catchUp).toMatchObject({ name: "Catch up", source: "ai" });
    expect(catchUp!.exercises.map((e) => [e.exercise_id, e.target_sets])).toEqual([["hip-thrust", 3]]);

    fireEvent.click(within(plan()).getByRole("button", { name: `Add to ${short(FRI)}` }));
    expect(await screen.findByText(`Added to Push on ${short(FRI)}.`)).toBeInTheDocument();
    const fri = await getDay(FRI);
    expect(fri?.routine_id).not.toBe(pushId);
    const copy = await getRoutine(fri!.routine_id!);
    expect(copy?.name).toBe("Push + catch up");
    expect(copy!.exercises.map((e) => [e.exercise_id, e.target_sets])).toEqual([
      ["bench", 4],
      ["glute-bridge", 2],
    ]);
    // The user's saved routine is untouched.
    expect((await getRoutine(pushId))!.exercises.map((e) => e.exercise_id)).toEqual(["bench"]);
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

  it("503: shows a short plain message and keeps the rule-based suggestions", async () => {
    fetchMock.mockResolvedValue(json(503, { unavailable: true }));
    const btn = await renderCard();
    const linksBefore = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    fireEvent.click(btn);
    expect(await screen.findByText(AI_MESSAGES.unavailable)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "AI catch-up plan" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(linksBefore);
    expect(await db.planned_days.count()).toBe(0);
  });

  it("failure: error status, network error and malformed body each show the failure message", async () => {
    fetchMock.mockResolvedValueOnce(json(502, { error: "error" }));
    const btn = await renderCard();
    fireEvent.click(btn);
    expect(await screen.findByText(AI_MESSAGES.failed)).toBeInTheDocument();

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Plan the week with AI" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(AI_MESSAGES.failed)).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(json(200, { nope: true }));
    fireEvent.click(screen.getByRole("button", { name: "Plan the week with AI" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(AI_MESSAGES.failed)).toBeInTheDocument();
    expect(screen.getByText("Catch up")).toBeInTheDocument();
  });

  it("offline: does not call the route", async () => {
    const spy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fireEvent.click(await renderCard());
    expect(await screen.findByText(AI_MESSAGES.offline)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("no usable picks: says so", async () => {
    fetchMock.mockResolvedValue(json(200, { additions: [{ exercise_id: "made-up", muscle: "Glutes", date: WED, sets: 2, reason: "x" }] }));
    fireEvent.click(await renderCard());
    expect(await screen.findByText(AI_MESSAGES.empty)).toBeInTheDocument();
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
