// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { dislikeExercise, saveGoals, type Goals } from "@/lib/goals";
import { saveEquipment } from "@/lib/equipment";
import type { Exercise } from "@/lib/exercises";
import type { Equipment, MuscleGroup } from "@/lib/muscles";
import { resetSwapAi } from "@/components/workout/SwapSheet";
import { ReplaceSheet } from "@/components/coach/ReplaceSheet";
import { EvidenceList } from "@/components/coach/EvidenceList";

const ex = (id: string, name: string, equipment: Equipment, over: Partial<Exercise> = {}): Exercise => ({
  id,
  name,
  muscle_groups: ["Chest"] as MuscleGroup[],
  secondary_groups: [],
  equipment,
  category: "strength",
  mechanic: "compound",
  force: "push",
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
  ...over,
});

const bench = ex("bench", "Bench Press", "Barbell");
const bench2 = ex("bench2", "Incline Barbell Press", "Barbell");
const dbPress = ex("db_press", "Dumbbell Press", "Dumbbell");
const pushUp = ex("push_up", "Push-Up", "Bodyweight");
const chestDip = ex("dip", "Chest Dip", "Bodyweight");
const cableFly = ex("cable_fly", "Cable Fly", "Machine/Cable", { mechanic: "isolation" });
const thrust = ex("Barbell_Hip_Thrust", "Barbell Hip Thrust", "Barbell", { muscle_groups: ["Glutes"] });
const bridge = ex("bridge", "Glute Bridge", "Bodyweight", { muscle_groups: ["Glutes"] });
const CATALOGUE = [bench, bench2, dbPress, pushUp, chestDip, cableFly, thrust, bridge];

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
function mockFetch(ai: () => Promise<Response> = () => Promise.resolve(jsonRes(503, { unavailable: true }))) {
  fetchMock.mockImplementation((url: string) => (url === "/exercises.json" ? Promise.resolve(jsonRes(200, CATALOGUE)) : ai()));
}

const storedGoals = async () => (await db.meta.get("goals"))?.value as Goals | undefined;
const names = () => within(screen.getByRole("list", { name: "Alternatives" })).queryAllByRole("button").map((b) => b.querySelector(".font-medium")?.textContent);

function open(current = bench, extra: Partial<Parameters<typeof ReplaceSheet>[0]> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(<ReplaceSheet current={current} onPick={onPick} onClose={onClose} {...extra} />);
  return { onPick, onClose };
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  resetSwapAi();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReplaceSheet", () => {
  it("offers the four reasons, marks the first alternative as the top pick and picks one", async () => {
    const { onPick } = open();
    for (const label of ["Replace", "Equipment unavailable", "Too difficult", "Causes discomfort"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Replace" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    expect(names()).not.toContain("Bench Press");
    expect(within(screen.getByRole("list", { name: "Alternatives" })).getAllByText("Top pick")).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("list", { name: "Alternatives" })).getAllByRole("button")[0]);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].muscle_groups).toContain("Chest");
  });

  it("only offers exercises for the same muscle and leaves out those already in the plan", async () => {
    open(bench, { exclude: ["db_press"] });
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    expect(names()).not.toContain("Dumbbell Press");
    expect(names()).not.toContain("Glute Bridge");
  });

  it("Equipment unavailable drops other exercises that need the same equipment", async () => {
    open();
    await waitFor(() => expect(names()).toContain("Incline Barbell Press"));
    fireEvent.click(screen.getByRole("button", { name: "Equipment unavailable" }));
    expect(screen.getByRole("button", { name: "Equipment unavailable" })).toHaveAttribute("aria-pressed", "true");
    expect(names()).not.toContain("Incline Barbell Press");
    expect(names()).toContain("Push-Up");
  });

  it("keeps to the equipment the user has", async () => {
    await saveEquipment(["Dumbbell"]);
    open();
    await waitFor(() => expect(names()).toEqual(["Dumbbell Press"]));
  });

  it("hides exercises that load a chosen limit and says so, and hides the never-suggest list", async () => {
    await saveGoals({ limitations: ["Shoulder"] });
    open();
    // The saved goals load a moment after the sheet opens.
    await waitFor(() => expect(screen.getByText(/not medical advice/i)).toBeInTheDocument());
    expect(names().length).toBeGreaterThan(0);
    expect(names()).not.toContain("Chest Dip");
  });

  it("I don't like this saves the exercise to the never-suggest list and says so", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "I don't like this" }));
    await waitFor(async () => expect((await storedGoals())?.dislikedIds).toEqual(["bench"]));
    expect(await screen.findByText(/Bench Press will not be suggested again/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I don't like this" })).toBeDisabled();
  });

  it("never offers an exercise on the never-suggest list", async () => {
    await dislikeExercise("db_press");
    open();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    await waitFor(() => expect(names()).not.toContain("Dumbbell Press"));
    expect(names()).toContain("Push-Up");
  });

  it("says why nothing is offered when the limits remove every alternative", async () => {
    await saveGoals({ limitations: ["Shoulder"] });
    // Only Chest Dip is left to offer for the bench, and the shoulder limit removes it.
    open(bench, { exclude: ["push_up", "bench2", "db_press", "cable_fly"] });
    expect(await screen.findByText(/leave no alternative/)).toBeInTheDocument();
    expect(names()).toEqual([]);
  });

  it("Why is this exercise here shows the reason and the research for that exercise", async () => {
    open(thrust, { why: "Hip thrusts add direct glute work to Day 2." });
    expect(screen.queryByRole("region", { name: "Why this exercise" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Why is this exercise here?" }));
    const why = screen.getByRole("region", { name: "Why this exercise" });
    expect(within(why).getByText("Hip thrusts add direct glute work to Day 2.")).toBeInTheDocument();
    const list = within(why).getByRole("list", { name: "Evidence" });
    expect(within(list).getByText(/hip thrusts and back squats grew the glutes/)).toBeInTheDocument();
    expect(within(list).getByText("Single trial, 34 people")).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: "View paper" })).toHaveAttribute("href", "https://pubmed.ncbi.nlm.nih.gov/37877099/");
  });

  it("Why falls back to a plain line and an honest note when there is no research", async () => {
    open(bench);
    fireEvent.click(screen.getByRole("button", { name: "Why is this exercise here?" }));
    const why = screen.getByRole("region", { name: "Why this exercise" });
    expect(within(why).getByText("Bench Press trains chest.")).toBeInTheDocument();
    expect(within(why).getByText(/No research in the Lift Evidence Library/)).toBeInTheDocument();
  });

  it("adds Coach picks when the route answers, minus anything disliked or loading a limit", async () => {
    await dislikeExercise("db_press");
    await saveGoals({ limitations: ["Shoulder"] });
    mockFetch(() =>
      Promise.resolve(
        jsonRes(200, {
          exercise_id: "bench",
          alternatives: [
            { exercise_id: "db_press", reason: "Disliked one.", source: "ai" },
            { exercise_id: "dip", reason: "Loads the shoulder.", source: "ai" },
            { exercise_id: "cable_fly", reason: "Smooth cable path.", source: "ai" },
          ],
          adjusted: 0,
        }),
      ),
    );
    open();
    const section = await screen.findByRole("region", { name: "Coach picks" });
    expect(within(section).getByText("Smooth cable path.")).toBeInTheDocument();
    // The saved goals load a moment after the sheet opens; then the two picks drop out.
    await waitFor(() => expect(within(section).queryByText("Disliked one.")).not.toBeInTheDocument());
    expect(within(section).queryByText("Loads the shoulder.")).not.toBeInTheDocument();
  });

  it("works with no AI: the rule alternatives show and no Coach picks appear", async () => {
    open();
    await waitFor(() => expect(names().length).toBeGreaterThan(0));
    expect(screen.queryByRole("region", { name: "Coach picks" })).not.toBeInTheDocument();
  });

  it("Cancel and a tap outside both close it", async () => {
    const { onClose } = open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("EvidenceList", () => {
  it("shows each paper once with its strength and link, skips unknown ids, and has the disclaimer", () => {
    render(<EvidenceList ids={["volume-hypertrophy", "volume-hypertrophy", "made-up", "rest-review"]} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.getByText("Pooled analysis of several studies")).toBeInTheDocument();
    expect(screen.getByText("Review of studies")).toBeInTheDocument();
    for (const a of screen.getAllByRole("link", { name: "View paper" })) {
      expect(a.getAttribute("href")).toMatch(/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/);
      expect(a).toHaveAttribute("rel", "noreferrer");
    }
    expect(screen.getByText("General fitness information, not medical advice.")).toBeInTheDocument();
  });

  it("says plainly when nothing in the library applies", () => {
    render(<EvidenceList ids={["made-up"]} />);
    expect(screen.getByText(/No research in the Lift Evidence Library/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
