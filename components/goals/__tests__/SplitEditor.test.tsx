// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { createRoutine, getRoutine, listRoutines } from "@/lib/routines";
import { saveSplit, type Split } from "@/lib/splits";
import { getActive } from "@/lib/workout";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push, back: vi.fn() }),
  usePathname: () => "/profile",
  useSearchParams: () => new URLSearchParams(),
}));

import { clearSplitQuestion, removeDayQuestion, SplitEditor } from "@/components/goals/SplitEditor";

const PPL: Split = {
  name: "PPL",
  days: [
    { id: "push", name: "Push", muscles: ["Chest", "Shoulders", "Triceps"] },
    { id: "pull", name: "Pull", muscles: ["Back", "Biceps"] },
    { id: "legs", name: "Legs", muscles: ["Quads"] },
  ],
};

beforeEach(async () => {
  push.mockReset();
  await Promise.all(db.tables.map((t) => t.clear()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const dayGroup = (name: string) => screen.getByRole("group", { name: `Routines for ${name}` });
const dayItem = (name: string) => screen.getByDisplayValue(name).closest("li") as HTMLElement;

async function seed() {
  await saveSplit(PPL);
  const pushA = await createRoutine({
    name: "Push A",
    exercises: [{ exercise_id: "bench" }, { exercise_id: "ohp" }],
    split_day_id: "push",
  });
  const loose = await createRoutine({ name: "Loose", exercises: [{ exercise_id: "curl" }] });
  return { pushA, loose };
}

describe("confirm questions", () => {
  it("asks nothing for a day with no routines, and states the count otherwise", () => {
    expect(removeDayQuestion("Push", 0)).toBeNull();
    expect(removeDayQuestion("Push", 1)).toBe("Remove Push? 1 routine will become unassigned. Nothing is deleted.");
    expect(removeDayQuestion(" ", 2)).toBe("Remove this day? 2 routines will become unassigned. Nothing is deleted.");
    expect(clearSplitQuestion(0)).toBe("Clear this split?");
    expect(clearSplitQuestion(3)).toBe("Clear this split? 3 routines will become unassigned. Nothing is deleted.");
  });
});

describe("SplitEditor: routines under each day", () => {
  it("still offers presets with no split, and saves one with day ids", async () => {
    render(<SplitEditor />);
    fireEvent.click(await screen.findByRole("button", { name: /Push \/ Pull \/ Legs/ }));
    await screen.findByDisplayValue("Push");
    const stored = (await db.meta.get("split"))!.value as Split;
    expect(stored.days.every((d) => typeof d.id === "string" && d.id.length > 0)).toBe(true);
  });

  it("shows linked routines with exercise count, Start and Edit, and a plain line for empty days", async () => {
    const { pushA } = await seed();
    render(<SplitEditor />);
    const g = await waitFor(() => dayGroup("Push"));
    await within(g).findByText("Push A");
    expect(within(g).getByText("2 exercises")).toBeInTheDocument();
    expect(within(g).getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(within(g).getByRole("link", { name: "Edit" })).toHaveAttribute("href", `/routines/${pushA}`);
    expect(within(dayGroup("Pull")).getByText("No routine: pick exercises from your pool on the day.")).toBeInTheDocument();
    expect(within(dayGroup("Pull")).queryByText("Push A")).not.toBeInTheDocument();
  });

  it("Start begins the routine as the live workout and opens it", async () => {
    const { pushA } = await seed();
    render(<SplitEditor />);
    const g = await waitFor(() => dayGroup("Push"));
    fireEvent.click(await within(g).findByRole("button", { name: "Start" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workout"));
    const active = await getActive();
    expect(active?.routine_id).toBe(pushA);
    expect(active?.exercises.map((e) => e.exercise_id)).toEqual(["bench", "ohp"]);
  });

  it("Remove from this day unlinks the routine and never deletes it", async () => {
    const { pushA } = await seed();
    render(<SplitEditor />);
    const g = await waitFor(() => dayGroup("Push"));
    fireEvent.click(await within(g).findByRole("button", { name: "Remove from this day" }));
    await waitFor(() => expect(within(dayGroup("Push")).queryByText("Push A")).not.toBeInTheDocument());
    const r = await getRoutine(pushA);
    expect(r).toBeDefined();
    expect(r!.split_day_id).toBeNull();
    expect(r!.exercises).toHaveLength(2);
  });

  it("Add routine offers a new routine for this day and attaching an unassigned one", async () => {
    const { loose } = await seed();
    render(<SplitEditor />);
    const g = await waitFor(() => dayGroup("Pull"));
    fireEvent.click(within(g).getByRole("button", { name: "+ Add routine" }));
    expect(within(g).getByRole("link", { name: "New routine for this day" })).toHaveAttribute("href", "/routines/new?day=pull");
    const select = within(g).getByRole("combobox", { name: "Attach a routine" });
    // Only unassigned routines are offered.
    expect(within(select).queryByRole("option", { name: "Push A" })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: loose } });
    await within(dayGroup("Pull")).findByText("Loose");
    expect((await getRoutine(loose))!.split_day_id).toBe("pull");
  });

  it("Add routine says so when there is nothing to attach, and Cancel closes it", async () => {
    await saveSplit(PPL);
    render(<SplitEditor />);
    const g = await waitFor(() => dayGroup("Legs"));
    fireEvent.click(within(g).getByRole("button", { name: "+ Add routine" }));
    expect(within(g).getByText("No unassigned routines to attach.")).toBeInTheDocument();
    fireEvent.click(within(g).getByRole("button", { name: "Cancel" }));
    expect(within(g).getByRole("button", { name: "+ Add routine" })).toBeInTheDocument();
  });

  it("removing a day with routines asks first, stating the count; cancelling keeps it", async () => {
    const { pushA } = await seed();
    const ask = vi.fn(() => false);
    vi.stubGlobal("confirm", ask);
    render(<SplitEditor />);
    await within(await waitFor(() => dayGroup("Push"))).findByText("Push A");
    fireEvent.click(within(dayItem("Push")).getByRole("button", { name: "Remove" }));
    expect(ask).toHaveBeenCalledWith("Remove Push? 1 routine will become unassigned. Nothing is deleted.");
    await new Promise((r) => setTimeout(r, 20));
    expect(((await db.meta.get("split"))!.value as Split).days).toHaveLength(3);
    expect((await getRoutine(pushA))!.split_day_id).toBe("push");
  });

  it("confirming removes the day and leaves its routines unassigned, not deleted", async () => {
    const { pushA } = await seed();
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<SplitEditor />);
    await within(await waitFor(() => dayGroup("Push"))).findByText("Push A");
    fireEvent.click(within(dayItem("Push")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByDisplayValue("Push")).not.toBeInTheDocument());
    await waitFor(async () => expect((await getRoutine(pushA))!.split_day_id).toBeNull());
    expect(await listRoutines()).toHaveLength(2);
  });

  it("removing a day with no routines does not ask", async () => {
    await seed();
    const ask = vi.fn(() => true);
    vi.stubGlobal("confirm", ask);
    render(<SplitEditor />);
    await waitFor(() => dayGroup("Legs"));
    fireEvent.click(within(dayItem("Legs")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByDisplayValue("Legs")).not.toBeInTheDocument());
    expect(ask).not.toHaveBeenCalled();
  });

  it("clearing the split states how many routines become unassigned and keeps them", async () => {
    const { pushA } = await seed();
    const ask = vi.fn(() => true);
    vi.stubGlobal("confirm", ask);
    render(<SplitEditor />);
    await within(await waitFor(() => dayGroup("Push"))).findByText("Push A");
    fireEvent.click(screen.getByRole("button", { name: "Clear split" }));
    expect(ask).toHaveBeenCalledWith("Clear this split? 1 routine will become unassigned. Nothing is deleted.");
    await screen.findByRole("button", { name: "Build my own" });
    await waitFor(async () => expect((await getRoutine(pushA))!.split_day_id).toBeNull());
    expect(await listRoutines()).toHaveLength(2);
  });

  it("keeps the existing day controls: rename, pick muscles, add day", async () => {
    await saveSplit(PPL);
    render(<SplitEditor />);
    const input = await screen.findByDisplayValue("Legs");
    fireEvent.change(input, { target: { value: "Leg day" } });
    await screen.findByDisplayValue("Leg day");
    fireEvent.click(within(dayItem("Leg day")).getByRole("button", { name: "Quads" }));
    fireEvent.click(within(dayItem("Leg day")).getByRole("button", { name: "Glutes" }));
    await waitFor(async () =>
      expect(((await db.meta.get("split"))!.value as Split).days[2].muscles).toEqual(["Quads", "Glutes"]),
    );
    fireEvent.click(screen.getByRole("button", { name: "+ Add day" }));
    await screen.findByDisplayValue("Day 4");
    const stored = (await db.meta.get("split"))!.value as Split;
    // The renamed day kept its id.
    expect(stored.days[2].id).toBe("legs");
    expect(stored.days[3].id).toBeTruthy();
  });
});
