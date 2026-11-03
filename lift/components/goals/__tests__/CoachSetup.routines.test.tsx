// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { DEFAULT_GOALS, goalsFingerprint, normalizeGoals, type Goals } from "@/lib/goals";
import { createRoutine, listRoutines } from "@/lib/routines";
import { saveSplit, type Split } from "@/lib/splits";
import type { Exercise } from "@/lib/exercises";
import { resetSwapAi } from "@/components/workout/SwapSheet";
import { CoachSetup } from "@/components/goals/CoachSetup";

const CATALOGUE = JSON.parse(readFileSync(join(__dirname, "../../../data/exercises.json"), "utf8")) as Exercise[];
const BY_ID = new Map(CATALOGUE.map((e) => [e.id, e]));

const PPL: Split = {
  name: "PPL",
  days: [
    { name: "Push", muscles: ["Chest", "Shoulders", "Triceps"] },
    { name: "Pull", muscles: ["Lats", "Biceps"] },
    { name: "Legs", muscles: ["Quads", "Hamstrings", "Glutes", "Calves"] },
  ],
};

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  resetSwapAi();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => Promise.resolve(String(url).endsWith("/exercises.json") ? jsonRes(200, CATALOGUE) : jsonRes(503, { unavailable: true }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const goals = (p: Partial<Goals> = {}): Goals => ({ ...DEFAULT_GOALS, ...p });
const storedSplit = async () => (await db.meta.get("split"))?.value as Split | undefined;
const storedGoals = async () => (await db.meta.get("goals"))?.value as Goals | undefined;
const nav = (panel: HTMLElement) => within(panel).getByRole("group", { name: "Step navigation" });
const next = (panel: HTMLElement) => fireEvent.click(within(nav(panel)).getByRole("button", { name: "Next" }));

/** Saves PPL, opens the wizard on it and walks to Review. */
async function toReview(p: { goals?: Goals; saved?: boolean } = {}) {
  let split: Split = { name: "", days: [] };
  if (p.saved !== false) {
    await saveSplit(PPL);
    split = (await storedSplit())!;
  }
  render(<CoachSetup goals={p.goals ?? goals()} split={split} />);
  fireEvent.click(screen.getByRole("button", { name: "Set up with coach" }));
  const panel = screen.getByRole("region", { name: "Coach setup" });
  for (let i = 0; i < 4; i++) next(panel);
  expect(within(panel).getByRole("heading").textContent).toBe("Review");
  return panel;
}

const dayList = (panel: HTMLElement, day: string) => within(within(panel).getByRole("region", { name: "Your routines" })).getByRole("list", { name: `${day} exercises` });
const namesIn = (list: HTMLElement) => within(list).getAllByRole("listitem").map((li) => li.querySelector(".font-semibold")?.textContent);

describe("CoachSetup review: routines for the days", () => {
  it("drafts a routine for every split day, with sets, reps and the muscle", async () => {
    const panel = await toReview();
    const section = await within(panel).findByRole("region", { name: "Your routines" });
    for (const day of ["Push", "Pull", "Legs"]) {
      const items = within(within(section).getByRole("list", { name: `${day} exercises` })).getAllByRole("listitem");
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].textContent).toMatch(/3 x 8-12/);
    }
    expect(within(section).getByRole("checkbox", { name: "Create these routines when I save" })).toBeChecked();
  });

  it("takes favourites first and Why gives the reason and the research for that exercise", async () => {
    await db.meta.put({ key: "favorites", value: ["Barbell_Hip_Thrust"] });
    const panel = await toReview();
    await within(panel).findByRole("region", { name: "Your routines" });
    // Favourites load a moment after the review opens; the drafts follow them.
    await waitFor(() => expect(namesIn(dayList(panel, "Legs"))).toContain("Barbell Hip Thrust"));
    fireEvent.click(within(panel).getByRole("button", { name: "Why Barbell Hip Thrust in Legs" }));
    expect(within(panel).getByText("Barbell Hip Thrust is one of your favourites for glutes.")).toBeInTheDocument();
    const evidence = within(panel).getByRole("list", { name: "Evidence" });
    expect(within(evidence).getByText(/hip thrusts and back squats grew the glutes/)).toBeInTheDocument();
    expect(within(evidence).getByRole("link", { name: "View paper" })).toHaveAttribute("href", "https://pubmed.ncbi.nlm.nih.gov/37877099/");
    fireEvent.click(within(panel).getByRole("button", { name: "Why Barbell Hip Thrust in Legs" }));
    expect(within(panel).queryByRole("list", { name: "Evidence" })).not.toBeInTheDocument();
  });

  it("Replace swaps one exercise in the draft for another that trains the same muscle", async () => {
    await db.meta.put({ key: "favorites", value: ["Barbell_Hip_Thrust"] });
    const panel = await toReview();
    await within(panel).findByRole("region", { name: "Your routines" });
    const replaceBtn = await within(panel).findByRole("button", { name: "Replace Barbell Hip Thrust in Legs" });
    const before = namesIn(dayList(panel, "Legs"));
    fireEvent.click(replaceBtn);
    const sheet = await screen.findByRole("dialog", { name: "Replace Barbell Hip Thrust" });
    const alts = within(within(sheet).getByRole("list", { name: "Alternatives" })).getAllByRole("button");
    await waitFor(() => expect(alts.length).toBeGreaterThan(0));
    const picked = alts[0].querySelector(".font-medium")!.textContent!;
    expect(BY_ID.get(CATALOGUE.find((e) => e.name === picked)!.id)!.muscle_groups).toContain("Glutes");
    fireEvent.click(alts[0]);
    const after = namesIn(dayList(panel, "Legs"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(after).not.toContain("Barbell Hip Thrust");
    expect(after).toContain(picked);
    expect(after).toHaveLength(before.length);
    fireEvent.click(within(panel).getByRole("button", { name: `Why ${picked} in Legs` }));
    expect(within(panel).getByText(`${picked} is the replacement you chose for Barbell Hip Thrust.`)).toBeInTheDocument();
  });

  it("Save writes the routines linked to their split days and records the goals the split was built for", async () => {
    const panel = await toReview({ goals: goals({ sessionsPerWeek: 3 }) });
    await within(panel).findByRole("region", { name: "Your routines" });
    const planned = ["Push", "Pull", "Legs"].map((d) => namesIn(dayList(panel, d)).length);
    fireEvent.click(within(nav(panel)).getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await listRoutines()).toHaveLength(3), { timeout: 5000 });

    const split = (await storedSplit())!;
    const rs = await listRoutines();
    for (const [i, day] of split.days.entries()) {
      const r = rs.find((x) => x.split_day_id === day.id)!;
      expect(r.name).toBe(day.name);
      expect(r.exercises).toHaveLength(planned[i]);
      expect(r.exercises.every((e) => e.target_sets === 3 && e.target_reps === "8-12")).toBe(true);
    }
    const g = normalizeGoals(await storedGoals());
    expect(split.builtFor).toBe(goalsFingerprint(g));
    expect(await db.outbox.count()).toBeGreaterThan(0);
    expect(await screen.findByText("Coach setup saved.", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("with Create unticked it saves no routines but still records the goals", async () => {
    const panel = await toReview();
    fireEvent.click(await within(panel).findByRole("checkbox", { name: "Create these routines when I save" }));
    fireEvent.click(within(nav(panel)).getByRole("button", { name: "Save" }));
    await screen.findByText("Coach setup saved.", {}, { timeout: 5000 });
    expect(await listRoutines()).toHaveLength(0);
    expect((await storedSplit())?.builtFor).toBeTruthy();
  });

  it("leaves out days that already have a routine and never creates a second one", async () => {
    await saveSplit(PPL);
    const split = (await storedSplit())!;
    await createRoutine({ name: "My push", split_day_id: split.days[0].id, exercises: [{ exercise_id: "Barbell_Bench_Press_-_Medium_Grip" }] });
    render(<CoachSetup goals={goals()} split={split} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up with coach" }));
    const panel = screen.getByRole("region", { name: "Coach setup" });
    for (let i = 0; i < 4; i++) next(panel);
    const section = await within(panel).findByRole("region", { name: "Your routines" });
    // The saved routines load a moment after the review opens; Push drops out once they do.
    await waitFor(() => expect(within(section).queryByRole("list", { name: "Push exercises" })).not.toBeInTheDocument());
    expect(within(section).getByRole("list", { name: "Pull exercises" })).toBeInTheDocument();
    fireEvent.click(within(nav(panel)).getByRole("button", { name: "Save" }));
    await screen.findByText("Coach setup saved.", {}, { timeout: 5000 });
    const rs = await listRoutines();
    expect(rs).toHaveLength(3);
    expect(rs.filter((r) => r.split_day_id === split.days[0].id)).toHaveLength(1);
  });

  it("says nothing about routines when every day already has one, or when there is no split", async () => {
    const none = await toReview({ saved: false });
    expect(within(none).queryByRole("region", { name: "Your routines" })).not.toBeInTheDocument();
  });

  it("never drafts an exercise on the never-suggest list or one that loads a chosen limit", async () => {
    const baseline = await toReview();
    await within(baseline).findByRole("region", { name: "Your routines" });
    const first = namesIn(dayList(baseline, "Push"))[0]!;
    const id = CATALOGUE.find((e) => e.name === first)!.id;
    document.body.innerHTML = "";
    await Promise.all(db.tables.map((t) => t.clear()));
    const panel = await toReview({ goals: goals({ dislikedIds: [id], limitations: ["Shoulder"] }) });
    await within(panel).findByRole("region", { name: "Your routines" });
    const all = ["Push", "Pull", "Legs"].flatMap((d) => namesIn(dayList(panel, d)));
    expect(all).not.toContain(first);
    for (const n of all) expect(n).not.toMatch(/overhead|military|shoulder press|upright row|\bdips?\b|handstand/i);
  });

  it("Cancel discards the drafts and saves nothing", async () => {
    const panel = await toReview();
    await within(panel).findByRole("region", { name: "Your routines" });
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(await listRoutines()).toHaveLength(0);
    expect((await storedSplit())?.builtFor).toBeUndefined();
  });
});
