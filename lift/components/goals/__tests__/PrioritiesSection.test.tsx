// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { dislikeExercise, saveGoals, type Goals } from "@/lib/goals";
import { PrioritiesSection } from "@/components/goals/PrioritiesSection";

const CATALOGUE = [{ id: "Barbell_Curl", name: "Barbell Curl", muscle_groups: ["Biceps"], secondary_groups: [], equipment: "Barbell", category: "strength", mechanic: "isolation", force: "pull", level: "beginner", instructions: [], image_urls: [], tiktok_url: "" }];
const stored = async () => (await db.meta.get("goals"))?.value as Goals | undefined;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(CATALOGUE), { status: 200 }))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PrioritiesSection", () => {
  it("shows three goal boxes, a priority for every muscle, the limit chips and the never-suggest list", () => {
    render(<PrioritiesSection />);
    for (const n of [1, 2, 3]) expect(screen.getByLabelText(`Goal ${n}`)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Muscle priorities" })).getAllByRole("combobox")).toHaveLength(16);
    for (const l of ["Shoulder", "Knee", "Lower back", "Wrist", "Elbow", "Hip"]) expect(screen.getByRole("button", { name: l })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });

  it("saves the goals in order when a box loses focus, and goal 1 stays the older single goal", async () => {
    render(<PrioritiesSection />);
    fireEvent.change(screen.getByLabelText("Goal 1"), { target: { value: "  Bigger arms " } });
    fireEvent.blur(screen.getByLabelText("Goal 1"));
    fireEvent.change(screen.getByLabelText("Goal 2"), { target: { value: "Defined abs" } });
    fireEvent.blur(screen.getByLabelText("Goal 2"));
    await waitFor(async () => expect((await stored())?.rankedGoals).toEqual(["Bigger arms", "Defined abs"]));
    expect((await stored())?.note).toBe("Bigger arms");
  });

  it("does not overwrite a box that is being typed in when another box saves", async () => {
    render(<PrioritiesSection />);
    fireEvent.change(screen.getByLabelText("Goal 1"), { target: { value: "One" } });
    fireEvent.blur(screen.getByLabelText("Goal 1"));
    fireEvent.change(screen.getByLabelText("Goal 2"), { target: { value: "Two being typed" } });
    await waitFor(async () => expect((await stored())?.rankedGoals).toEqual(["One"]));
    expect(screen.getByLabelText("Goal 2")).toHaveValue("Two being typed");
  });

  it("loads the saved goals once", async () => {
    await saveGoals({ rankedGoals: ["A", "B", "C"] });
    render(<PrioritiesSection />);
    await waitFor(() => expect(screen.getByLabelText("Goal 3")).toHaveValue("C"));
    expect(screen.getByLabelText("Goal 1")).toHaveValue("A");
  });

  it("caps the typed goal at 300 characters", () => {
    render(<PrioritiesSection />);
    fireEvent.change(screen.getByLabelText("Goal 1"), { target: { value: "x".repeat(400) } });
    expect((screen.getByLabelText("Goal 1") as HTMLInputElement).value).toHaveLength(300);
  });

  it("sets a muscle priority, keeps focus muscles equal to the high ones, and clears it again", async () => {
    render(<PrioritiesSection />);
    fireEvent.change(screen.getByLabelText("Biceps"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Chest"), { target: { value: "low" } });
    await waitFor(async () => expect((await stored())?.priorities).toEqual({ Biceps: "high", Chest: "low" }));
    expect((await stored())?.focusMuscles).toEqual(["Biceps"]);
    fireEvent.change(screen.getByLabelText("Biceps"), { target: { value: "" } });
    await waitFor(async () => expect((await stored())?.priorities).toEqual({ Chest: "low" }));
    expect((await stored())?.focusMuscles).toEqual([]);
  });

  it("shows the priority of a muscle that was set as a focus muscle before priorities existed", async () => {
    await db.meta.put({ key: "goals", value: { focusMuscles: ["Triceps"], note: "Arms" } });
    render(<PrioritiesSection />);
    await waitFor(() => expect(screen.getByLabelText("Triceps")).toHaveValue("high"));
    await waitFor(() => expect(screen.getByLabelText("Goal 1")).toHaveValue("Arms"));
  });

  it("toggles limits and shows the not-medical-advice line", async () => {
    render(<PrioritiesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Knee" }));
    fireEvent.click(screen.getByRole("button", { name: "Wrist" }));
    await waitFor(async () => expect((await stored())?.limitations).toEqual(["Knee", "Wrist"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Knee" })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Knee" }));
    await waitFor(async () => expect((await stored())?.limitations).toEqual(["Wrist"]));
    expect(screen.getByText(/not medical advice/i)).toBeInTheDocument();
  });

  it("lists the never-suggest exercises by name and lets you allow one again", async () => {
    await dislikeExercise("Barbell_Curl");
    await dislikeExercise("Gone_From_Catalogue");
    render(<PrioritiesSection />);
    expect(await screen.findByText("Barbell Curl")).toBeInTheDocument();
    expect(screen.getByText("Gone_From_Catalogue")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow Barbell Curl again" }));
    await waitFor(async () => expect((await stored())?.dislikedIds).toEqual(["Gone_From_Catalogue"]));
  });
});
