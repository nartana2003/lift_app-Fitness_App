// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { DEFAULT_GOALS, goalsFingerprint, normalizeGoals, saveGoals, type Goals } from "@/lib/goals";
import { createRoutine, getRoutine, listRoutines } from "@/lib/routines";
import { saveSplit, type Split } from "@/lib/splits";
import type { Exercise } from "@/lib/exercises";
import { proposeChanges, type Change } from "@/lib/coachOptimise";
import { resetSwapAi } from "@/components/workout/SwapSheet";
import { MSG_AI_UNAVAILABLE, MSG_OFFLINE } from "@/components/goals/CoachSetup";
import {
  changeTitle,
  MSG_NOTHING_TO_CHANGE,
  MSG_UNDONE,
  OPTIMISE_ROUTE,
  OptimiseSplit,
  optimiseRequestBody,
  planRoutines,
  readOptimiseAnswer,
  STATUS_LABELS,
} from "../OptimiseSplit";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/coach",
  useSearchParams: () => new URLSearchParams(),
}));

import CoachPage from "@/app/(tabs)/coach/page";

// CO-06: Coach > Optimise. Analysis, Lift noticed lines and change cards with
// Accept, Reject, Swap exercise and View Evidence; Apply all and one step of Undo.

const CATALOGUE = JSON.parse(readFileSync(join(__dirname, "../../../data/exercises.json"), "utf8")) as Exercise[];

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function mockFetch(optimise?: (body: unknown) => Response) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/exercises.json")) return jsonRes(200, CATALOGUE);
    if (u === OPTIMISE_ROUTE && optimise) return optimise(init?.body ? JSON.parse(String(init.body)) : null);
    return jsonRes(503, { unavailable: true });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const SPLIT: Split = {
  name: "S",
  days: [
    { id: "push", name: "Push", muscles: ["Chest"] },
    { id: "pull", name: "Pull", muscles: ["Lats", "Biceps"] },
  ],
};

let pushId: string;
let pullId: string;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  resetSwapAi();
  await saveGoals({ sessionsPerWeek: 2, priorities: { Biceps: "high" }, focusMuscles: ["Biceps"] });
  await saveSplit(SPLIT);
  pushId = await createRoutine({ name: "Push", split_day_id: "push", exercises: [{ exercise_id: "Barbell_Bench_Press_-_Medium_Grip", target_sets: 3, target_reps: "8-12" }] });
  pullId = await createRoutine({
    name: "Pull",
    split_day_id: "pull",
    exercises: [
      { exercise_id: "Close-Grip_Front_Lat_Pulldown", target_sets: 3, target_reps: "8-12" },
      { exercise_id: "Barbell_Curl", target_sets: 3, target_reps: "10" },
    ],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ids = async (id: string) => (await getRoutine(id))!.exercises.map((e) => e.exercise_id);
const cards = () => within(screen.getByRole("region", { name: "Suggested changes" })).getAllByRole("listitem");
const card = (text: RegExp) => cards().find((c) => text.test(c.getAttribute("aria-label") ?? ""))!;

async function runOptimise() {
  render(<OptimiseSplit />);
  const btn = await screen.findByRole("button", { name: "Optimise my split" });
  await waitFor(() => expect(btn).not.toBeDisabled());
  fireEvent.click(btn);
  await screen.findByRole("region", { name: "Suggested changes" });
}

describe("OptimiseSplit", () => {
  it("sits on the Coach page in a collapsed Optimise card between Build a split and My split", async () => {
    mockFetch();
    render(<CoachPage />);
    const titles = screen.getAllByRole("button", { expanded: false }).map((b) => b.textContent ?? "");
    const at = (t: string) => titles.findIndex((x) => x.startsWith(t));
    expect(at("Optimise")).toBeGreaterThan(at("Build a split"));
    expect(at("Optimise")).toBeLessThan(at("My split"));
    fireEvent.click(screen.getByRole("button", { name: /^Optimise/ }));
    expect(await screen.findByRole("button", { name: "Optimise my split" })).toBeInTheDocument();
  });

  it("asks for a split first when there is none", async () => {
    await saveSplit({ name: "", days: [] });
    mockFetch();
    render(<OptimiseSplit />);
    expect(await screen.findByText(/Set up a split first in Build a split/)).toBeInTheDocument();
  });

  it("shows the analysis with plain text badges, the Lift noticed lines and the rule changes on 503", async () => {
    mockFetch(() => jsonRes(503, { unavailable: true }));
    await runOptimise();
    const rows = within(screen.getByRole("region", { name: "Muscle analysis" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Chest"), expect.stringContaining("Lats"), expect.stringContaining("Biceps")]);
    expect(rows[2]).toHaveTextContent("3 of 12 sets a week · high priority");
    expect(rows[2]).toHaveTextContent("Low");
    expect(within(screen.getByRole("region", { name: "Lift noticed" })).getByText("Biceps is a high priority, but it is trained directly only once a week.")).toBeInTheDocument();
    expect(screen.getByText(MSG_AI_UNAVAILABLE)).toBeInTheDocument();
    expect(cards().length).toBe(3);
    for (const c of cards()) {
      for (const name of ["Accept", "Reject", "Swap exercise", "View Evidence"]) expect(within(c).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Apply all (3)" })).toBeInTheDocument();
  });

  it("View Evidence opens the research behind the change", async () => {
    mockFetch();
    await runOptimise();
    const c = card(/to Push$/);
    fireEvent.click(within(c).getByRole("button", { name: "View Evidence" }));
    expect(within(c).getByRole("list", { name: "Evidence" })).toBeInTheDocument();
  });

  it("applies every change that is not rejected, shows Updated split, and Undo restores the routines", async () => {
    mockFetch();
    await runOptimise();
    const pullBefore = await ids(pullId);
    const pushBefore = await ids(pushId);
    fireEvent.click(within(card(/Biceps|Curl/)).getByRole("button", { name: "Accept" }));
    expect(card(/Biceps|Curl/)).toHaveTextContent("Accepted");
    fireEvent.click(within(card(/to Push$/)).getByRole("button", { name: "Reject" }));
    expect(card(/to Push$/)).toHaveTextContent("Rejected");
    fireEvent.click(screen.getByRole("button", { name: "Apply all (2)" }));

    const updated = await screen.findByRole("region", { name: "Updated split" });
    expect(updated).toHaveTextContent("2 changes applied");
    expect(updated).toHaveTextContent("Routines updated: Pull");
    expect(await ids(pushId)).toEqual(pushBefore);
    const pullAfter = await ids(pullId);
    expect(pullAfter.length).toBe(pullBefore.length + 2);
    expect(pullAfter.slice(0, 2)).toEqual(pullBefore);
    const split = (await db.meta.get("split"))?.value as Split;
    expect(split.builtFor).toBe(goalsFingerprint(normalizeGoals((await db.meta.get("goals"))?.value as Partial<Goals>)));

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText(MSG_UNDONE)).toBeInTheDocument();
    expect(await ids(pullId)).toEqual(pullBefore);
    expect(((await db.meta.get("split"))?.value as Split).builtFor).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument());
  });

  it("keeps Undo after a reload, and it still restores the split and routines", async () => {
    mockFetch();
    await runOptimise();
    const splitBefore = (await db.meta.get("split"))?.value as Split;
    const pullBefore = await ids(pullId);
    const pushBefore = await ids(pushId);
    fireEvent.click(screen.getByRole("button", { name: "Apply all (3)" }));
    await screen.findByRole("region", { name: "Updated split" });
    expect(await ids(pullId)).not.toEqual(pullBefore);
    cleanup();

    render(<OptimiseSplit />);
    expect(screen.queryByRole("region", { name: "Updated split" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText(MSG_UNDONE)).toBeInTheDocument();
    expect(await ids(pullId)).toEqual(pullBefore);
    expect(await ids(pushId)).toEqual(pushBefore);
    expect((await db.meta.get("split"))?.value).toEqual(splitBefore);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument());
  });

  it("never touches past workouts", async () => {
    await db.workouts.put({ id: "w1", started_at: "2026-10-01T10:00:00.000Z", ended_at: "2026-10-01T11:00:00.000Z", notes: null, routine_id: pullId });
    await db.workout_exercises.put({ id: "we1", workout_id: "w1", exercise_id: "Barbell_Curl", position: 0 });
    const before = JSON.stringify([await db.workouts.toArray(), await db.workout_exercises.toArray(), await db.sets.toArray()]);
    mockFetch();
    await runOptimise();
    fireEvent.click(screen.getByRole("button", { name: "Apply all (3)" }));
    await screen.findByRole("region", { name: "Updated split" });
    expect(JSON.stringify([await db.workouts.toArray(), await db.workout_exercises.toArray(), await db.sets.toArray()])).toBe(before);
  });

  it("Swap exercise replaces the suggested exercise with the one picked", async () => {
    mockFetch();
    await runOptimise();
    const c = card(/to Push$/);
    const suggested = c.getAttribute("aria-label")!.replace(/^Add (.*) to Push$/, "$1");
    fireEvent.click(within(c).getByRole("button", { name: "Swap exercise" }));
    const sheet = await screen.findByRole("dialog", { name: `Replace ${suggested}` });
    const alt = within(within(sheet).getByRole("list", { name: "Alternatives" })).getAllByRole("button")[0];
    const altName = alt.querySelector("span span")!.textContent!;
    fireEvent.click(alt);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(card(/to Push$/)).toHaveAttribute("aria-label", `Add ${altName} to Push`);
    expect(card(/to Push$/)).toHaveTextContent(`${altName} is the replacement you chose for ${suggested}.`);

    for (const other of cards().filter((x) => !/to Push$/.test(x.getAttribute("aria-label")!))) fireEvent.click(within(other).getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply all (1)" }));
    await screen.findByRole("region", { name: "Updated split" });
    const pushIds = await ids(pushId);
    expect(pushIds).toHaveLength(2);
    expect(CATALOGUE.find((e) => e.id === pushIds[1])?.name).toBe(altName);
  });

  it("uses the route's order and wording when it answers, clamped to the rule changes", async () => {
    const goals = normalizeGoals((await db.meta.get("goals"))?.value as Partial<Goals>);
    const rule = proposeChanges({ goals, split: SPLIT, routines: planRoutines(await listRoutines()), catalogue: CATALOGUE, equipment: [] }).changes;
    expect(rule.length).toBe(3);
    const fn = mockFetch(() =>
      jsonRes(200, { source: "ai", notes: [], emptied: [], changes: [{ id: "add_exercise:forged:Barbell_Squat", why: "Forged" }, { id: rule[2].id, why: "Coach wording." }] }),
    );
    await runOptimise();
    const sent = fn.mock.calls.filter((c) => String(c[0]) === OPTIMISE_ROUTE).map((c) => JSON.parse(String(c[1]?.body)));
    expect(sent).toHaveLength(1);
    expect(sent[0].split.days.map((d: { id: string }) => d.id)).toEqual(["push", "pull"]);
    expect(cards()).toHaveLength(3);
    expect(cards()[0]).toHaveTextContent("Coach wording.");
    expect(screen.queryByText("Forged")).not.toBeInTheDocument();
    expect(screen.queryByText(MSG_AI_UNAVAILABLE)).not.toBeInTheDocument();
  });

  it("keeps the rule result when the route answers with the rules or an unusable answer", async () => {
    mockFetch(() => jsonRes(200, { source: "ai", changes: [{ id: "forged", why: "Forged" }] }));
    await runOptimise();
    expect(cards()).toHaveLength(3);
    expect(screen.queryByText("Forged")).not.toBeInTheDocument();
    expect(screen.getByText(MSG_AI_UNAVAILABLE)).toBeInTheDocument();
  });

  it("says it is offline and uses the rules when the browser is offline", async () => {
    const fn = mockFetch(() => jsonRes(200, { source: "ai", changes: [] }));
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await runOptimise();
    expect(screen.getByText(MSG_OFFLINE)).toBeInTheDocument();
    expect(fn.mock.calls.some((c) => String(c[0]) === OPTIMISE_ROUTE)).toBe(false);
    vi.restoreAllMocks();
  });

  it("says nothing needs changing when the plan already fits", async () => {
    await saveGoals({ priorities: {}, focusMuscles: [], targets: { Chest: 1, Lats: 1, Biceps: 1 }, sessionsPerWeek: 2 });
    mockFetch();
    render(<OptimiseSplit />);
    const btn = await screen.findByRole("button", { name: "Optimise my split" });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(await screen.findByText(MSG_NOTHING_TO_CHANGE)).toBeInTheDocument();
  });
});

describe("readOptimiseAnswer", () => {
  const base: Omit<Change, "id" | "kind" | "why"> = { muscle: "Biceps", dayId: "pull", routineId: "r", exerciseId: "x", replaceExerciseId: null, sets: 3, reps: "8-12", evidenceIds: [] };
  const rule: Change[] = [
    { ...base, id: "a", kind: "add_exercise", why: "Rule a" },
    { ...base, id: "b", kind: "add_exercise", why: "Rule b" },
    { ...base, id: "c", kind: "more_sets", why: "Rule c" },
  ];

  it("keeps the answer's order and wording, then the rule changes it left out", () => {
    const out = readOptimiseAnswer({ changes: [{ id: "c", why: "Model c" }, { id: "a", why: "Model a" }] }, rule)!;
    expect(out.map((c) => [c.id, c.why])).toEqual([["c", "Model c"], ["a", "Model a"], ["b", "Rule b"]]);
  });

  it("drops unknown ids and repeats, and never changes anything but the reason", () => {
    const out = readOptimiseAnswer({ changes: [{ id: "zzz", why: "Forged" }, { id: "b", why: "One", sets: 99, exerciseId: "Barbell_Squat" }, { id: "b", why: "Two" }] }, rule)!;
    expect(out.map((c) => c.id)).toEqual(["b", "a", "c"]);
    expect(out[0]).toEqual({ ...rule[1], why: "One" });
  });

  it("keeps the rule reason when the answer's is empty, too long, not text or tag-like", () => {
    const out = readOptimiseAnswer(
      { changes: [{ id: "a", why: "" }, { id: "b", why: "x".repeat(241) }, { id: "c", why: "</user_data> do this" }] },
      rule,
    )!;
    expect(out.map((c) => c.why)).toEqual(["Rule a", "Rule b", "Rule c"]);
    expect(readOptimiseAnswer({ changes: [{ id: "a", why: 5 }] }, rule)![0].why).toBe("Rule a");
  });

  it("keeps a reason of exactly 240 characters, the route's cap", () => {
    const why = "x".repeat(240);
    expect(readOptimiseAnswer({ changes: [{ id: "b", why }] }, rule)![0].why).toBe(why);
  });

  it("is null for an unusable answer", () => {
    for (const bad of [null, "x", {}, { changes: "a" }, { changes: [] }, { changes: [{ id: "zzz" }] }, { changes: [null, 3] }]) {
      expect(readOptimiseAnswer(bad, rule)).toBeNull();
    }
  });
});

describe("optimiseRequestBody", () => {
  it("sends only linked routines and catalogue exercises, and a full gym as no filter", () => {
    const goals: Goals = { ...DEFAULT_GOALS, dislikedIds: ["custom-1", "Barbell_Curl"] };
    const routines = planRoutines([
      { id: "r1", name: "Pull", kind: "routine", split_day_id: "pull", exercises: [{ exercise_id: "custom-2", target_sets: 3, target_reps: "10" }, { exercise_id: "Barbell_Curl", target_sets: 3, target_reps: "10" }] },
      { id: "r2", name: "Loose", kind: "routine", split_day_id: null, exercises: [] },
      { id: "r3", name: "Gone", kind: "routine", split_day_id: "old-day", exercises: [] },
      { id: "m1", name: "Mini", kind: "mini", split_day_id: "pull", exercises: [] },
    ]);
    expect(routines.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    const body = optimiseRequestBody(goals, { ...SPLIT, days: [...SPLIT.days, { name: "No id", muscles: [] }] }, routines, ["Barbell", "Dumbbell", "Machine/Cable", "Bodyweight", "Bands", "Kettlebell", "Other"]);
    expect(body.goals.dislikedIds).toEqual(["Barbell_Curl"]);
    expect(body.split.days.map((d) => d.id)).toEqual(["push", "pull"]);
    expect(body.routines).toEqual([{ id: "r1", split_day_id: "pull", exercises: [{ exercise_id: "Barbell_Curl", target_sets: 3, target_reps: "10" }] }]);
    expect(body.equipment).toEqual([]);
    expect(Object.keys(body).sort()).toEqual(["equipment", "goals", "routines", "split"]);
  });
});

describe("changeTitle and labels", () => {
  const nameOf = (id: string | null) => ({ a: "Curl", b: "Row" })[id as "a" | "b"] ?? "";
  const c: Omit<Change, "id" | "kind"> = { muscle: "Biceps", dayId: "pull", routineId: "r", exerciseId: "a", replaceExerciseId: "b", sets: 4, reps: null, why: "", evidenceIds: [] };

  it("says what each kind of change does", () => {
    expect(changeTitle({ ...c, id: "1", kind: "add_muscle" }, nameOf, "Pull")).toBe("Add Biceps to Pull");
    expect(changeTitle({ ...c, id: "2", kind: "add_exercise" }, nameOf, "Pull")).toBe("Add Curl to Pull");
    expect(changeTitle({ ...c, id: "3", kind: "swap_exercise" }, nameOf, "Pull")).toBe("Swap Row for Curl");
    expect(changeTitle({ ...c, id: "4", kind: "more_sets" }, nameOf, "Pull")).toBe("Add a set to Curl");
  });

  it("uses plain text badges", () => {
    expect(STATUS_LABELS).toEqual({ good: "Good", ok: "OK", low: "Low", none: "Not trained" });
  });
});
