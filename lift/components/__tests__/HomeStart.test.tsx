// @vitest-environment jsdom
// Issue #4: Start Workout on Home offers the user's routines.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { createRoutine } from "@/lib/routines";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push, back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/planner/WeekStrip", () => ({ WeekStrip: () => <div>Week strip stub</div> }));
vi.mock("@/components/HistoryList", () => ({ HistoryList: () => <div>History stub</div> }));

import Home from "@/app/(tabs)/page";

beforeEach(async () => {
  push.mockReset();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("Home Start Workout", () => {
  it("starts an empty workout straight away when there are no routines", async () => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Start Workout" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workout"));
    const active = await db.active.get("active");
    expect(active?.routine_id).toBeNull();
    expect(active?.exercises).toHaveLength(0);
  });

  it("lists the routines and starts the chosen one", async () => {
    const id = await createRoutine({ name: "Push day", exercises: [{ exercise_id: "bench", target_sets: 4 }] });
    await createRoutine({ name: "Pull day", exercises: [{ exercise_id: "row" }] });
    render(<Home />);
    const start = await screen.findByRole("button", { name: "Start Workout" });
    await waitFor(() => expect(db.routines.count()).resolves.toBe(2));
    fireEvent.click(start);
    const list = await screen.findByRole("group", { name: "Start from" });
    expect(list).toHaveTextContent("Empty workout");
    expect(list).toHaveTextContent("Start Routine");
    expect(screen.queryByRole("button", { name: "Push day" })).not.toBeInTheDocument();
    expect(await db.active.get("active")).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Start Routine" }));
    expect(screen.getByRole("button", { name: "Pull day" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Push day" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workout"));
    const active = await db.active.get("active");
    expect(active?.routine_id).toBe(id);
    expect(active?.name).toBe("Push day");
    expect(active?.exercises.map((e) => e.exercise_id)).toEqual(["bench"]);
  });

  it("still starts an empty workout from the list", async () => {
    await createRoutine({ name: "Push day", exercises: [{ exercise_id: "bench" }] });
    render(<Home />);
    await waitFor(() => expect(db.routines.count()).resolves.toBe(1));
    // let the live query deliver the routine to the component before clicking
    await act(() => new Promise((r) => setTimeout(r, 100)));
    fireEvent.click(await screen.findByRole("button", { name: "Start Workout" }));
    fireEvent.click(await screen.findByRole("button", { name: "Empty workout" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workout"));
    expect((await db.active.get("active"))?.routine_id).toBeNull();
  });

  it("shows Resume workout instead when a workout is in progress", async () => {
    await createRoutine({ name: "Push day", exercises: [{ exercise_id: "bench" }] });
    await db.active.put({ key: "active", id: "w1", started_at: new Date().toISOString(), routine_id: null, name: null, exercises: [] });
    render(<Home />);
    expect(await screen.findByRole("link", { name: "Resume workout" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Workout" })).not.toBeInTheDocument();
  });

  it("renders the button as a floating pill with a play icon", async () => {
    render(<Home />);
    const button = await screen.findByRole("button", { name: "Start Workout" });
    expect(button).toHaveClass("rounded-full");
    expect(button).not.toHaveClass("w-full");
    expect(button.querySelector("svg")).not.toBeNull();
    const float = button.parentElement!;
    expect(float).toHaveClass("fixed", "z-30");
    expect(float.className).toContain("bottom-[calc(");
  });

  it("floats the Resume workout link the same way", async () => {
    await db.active.put({ key: "active", id: "w1", started_at: new Date().toISOString(), routine_id: null, name: null, exercises: [] });
    render(<Home />);
    const link = await screen.findByRole("link", { name: "Resume workout" });
    expect(link).toHaveClass("rounded-full");
    expect(link.parentElement).toHaveClass("fixed", "z-30");
    expect(link).toHaveAttribute("href", "/workout");
  });

  it("opens the routine list in the floating stack above the button", async () => {
    await createRoutine({ name: "Push day", exercises: [{ exercise_id: "bench" }] });
    render(<Home />);
    await waitFor(() => expect(db.routines.count()).resolves.toBe(1));
    await act(() => new Promise((r) => setTimeout(r, 100)));
    const start = await screen.findByRole("button", { name: "Start Workout" });
    fireEvent.click(start);
    const list = await screen.findByRole("group", { name: "Start from" });
    expect(list.parentElement).toBe(start.parentElement);
  });

  it("places Start Workout below Weekly Snapshot (issue #24)", async () => {
    render(<Home />);
    const button = await screen.findByRole("button", { name: "Start Workout" });
    const heading = screen.getByRole("heading", { name: "Weekly Snapshot" });
    expect(heading.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("starts the routine planned for today directly (issue #24)", async () => {
    const { planDay, dayKey } = await import("@/lib/planner");
    const id = await createRoutine({ name: "Push day", exercises: [{ exercise_id: "bench" }] });
    await createRoutine({ name: "Pull day", exercises: [{ exercise_id: "row" }] });
    await planDay(dayKey(new Date()), id);
    render(<Home />);
    await screen.findByText(/Planned today: Push day/);
    fireEvent.click(screen.getByRole("button", { name: "Start Workout" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workout"));
    expect((await db.active.get("active"))?.routine_id).toBe(id);
  });

  it("shows no change against an empty last week (issue #24)", async () => {
    render(<Home />);
    expect(await screen.findAllByLabelText("No change from last week")).toHaveLength(3);
  });
});
