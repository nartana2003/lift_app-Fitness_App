// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { createRoutine, getRoutine, listRoutines } from "@/lib/routines";
import { getDay, planDay } from "@/lib/planner";
import { getActive, startWorkout } from "@/lib/workout";
import { saveGoals } from "@/lib/goals";
import type { WorkoutLite } from "@/lib/progress";
import type { Exercise } from "@/lib/exercises";
import { MUSCLE_GROUPS } from "@/lib/muscles";

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

import { WeeklyGoalsCard, addToDay, daysLeftKeys } from "@/components/goals/WeeklyGoalsCard";

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
  return screen.findByRole("list", { name: "Catch-up plan" });
}

const plan = () => screen.getByRole("list", { name: "Catch-up plan" });
const day = (key: string) => within(plan()).getByRole("listitem", { name: short(key) });
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
    const days = [WED, FRI, SUN].filter((k) => within(plan()).queryByRole("listitem", { name: short(k) }));
    expect(days.length).toBeGreaterThan(0);
    expect(within(plan()).getAllByRole("listitem", { name: /^\w{3}$/ })).toHaveLength(days.length);
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
    expect(within(day(FRI)).getByText(/^\+\d+ sets?$/)).toBeInTheDocument();
    expect(within(day(FRI)).getByText("Brings Chest to target")).toBeInTheDocument();
    // Back work goes to the pull day, on the exercise already in it.
    expect(within(day(THU)).getByRole("link", { name: "Barbell Row" })).toBeInTheDocument();
    expect(within(day(THU)).getByText("Brings Back to target")).toBeInTheDocument();
  });

  it("counts sets already planned in a routine: says so, and suggests no more for that muscle", async () => {
    // Chest defaults to 11 sets a week; this routine plans all 11, so chest is already covered.
    const push = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench", target_sets: 11 }] });
    await planDay(FRI, push);
    await renderCard();
    expect(screen.getByText((_, el) => el?.tagName === "P" && /Covered by your routines:.*Chest \(11 sets\)/.test(el.textContent ?? ""))).toBeInTheDocument();
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
  });

  it("says nothing is added when the week's sessions are already done", async () => {
    // Mon, Tue and Wed (today): three sessions with a goal of three.
    await renderCard([workoutOn(MON), workoutOn(TUE), workoutOn(WED)]).catch(() => undefined);
    expect(await screen.findByText("You have done your 3 sessions this week, so no more are added.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Catch-up plan" })).not.toBeInTheDocument();
  });

  it("says all targets are met when no muscle is behind", async () => {
    await saveGoals({ targets: Object.fromEntries(MUSCLE_GROUPS.map((m) => [m, 0])) });
    render(<WeeklyGoalsCard workouts={[]} />);
    expect(await screen.findByText("All weekly targets are met.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Catch up" })).not.toBeInTheDocument();
  });

  it("one tap adds to a free day as a new Catch up routine and to a planned routine as a copy with more sets", async () => {
    const pushId = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench", target_sets: 4 }] });
    await planDay(FRI, pushId);
    await renderCard();
    await waitFor(() => expect(within(day(FRI)).getByRole("link", { name: "Bench Press" })).toBeInTheDocument());
    const benchSets = Number(within(day(FRI)).getByText(/^\+\d+ sets?$/).textContent!.match(/\d+/)![0]);

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
    const picks = () => within(plan()).getAllByRole("link").map((l) => l.textContent);
    const before = picks();
    fireEvent.click(within(plan()).getByRole("button", { name: "Add to next workout" }));
    await screen.findByText(`Planned a catch-up workout on ${short(WED)}.`);
    expect(picks()).toEqual(before);
    expect(within(plan()).getByRole("button", { name: `Add to ${short(FRI)}` })).toBeInTheDocument();
    expect(within(day(WED)).getByText("Added")).toBeInTheDocument();
  });

  it("Add all to my week plans every day in one tap and then hides itself", async () => {
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Add all to my week" }));
    expect(await screen.findByText(`Planned a catch-up workout on ${short(WED)}.`)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add all to my week" })).not.toBeInTheDocument());
    expect(within(plan()).getAllByText("Added").length).toBeGreaterThan(1);
    expect((await getDay(WED))?.status).toBe("planned");
    expect((await getDay(FRI))?.status).toBe("planned");
  });

  it("lists only the muscles that are behind until you ask for all of them", async () => {
    await saveGoals({ targets: { ...Object.fromEntries(MUSCLE_GROUPS.map((m) => [m, 0])), Chest: 11, Glutes: 1 } });
    // One glute set done this week, so Glutes is met and Chest is behind.
    const done: WorkoutLite = { ...workoutOn(WED), exercises: [{ exercise_id: "hip-thrust", sets: [{ is_warmup: false }] as never }] };
    await renderCard([done]);
    expect(screen.getByText("Chest")).toBeInTheDocument();
    expect(screen.queryByText("Glutes")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show all muscles" });
    fireEvent.click(toggle);
    expect(screen.getByText("Glutes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide other muscles" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Hide other muscles" }));
    expect(screen.queryByText("Glutes")).not.toBeInTheDocument();
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

  it("has no AI step: no button, and the plan never calls the network", async () => {
    await renderCard();
    expect(screen.queryByRole("button", { name: /AI/ })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("daysLeftKeys", () => {
  it("runs from today to the end of the week", () => {
    expect(daysLeftKeys(1, NOW)).toEqual(DAYS);
    expect(daysLeftKeys(0, NOW)).toEqual([WED, THU, FRI, "2026-10-17"]);
  });
});
