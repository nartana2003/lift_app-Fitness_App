// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { createRoutine } from "@/lib/routines";
import { getDay, planDay } from "@/lib/planner";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push, back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { WeekStrip } from "@/components/planner/WeekStrip";

// "Today" is Wednesday 14 Oct 2026 (local). Week starts Monday (default), so the
// strip shows Mon 12 .. Sun 18; Mon and Tue are in the past.
const NOW = new Date(2026, 9, 14, 12, 0, 0);
const MON = "2026-10-12";
const WED = "2026-10-14";
const THU = "2026-10-15";
const FRI = "2026-10-16";
const SAT = "2026-10-17";
const SUN = "2026-10-18";
const IDX: Record<string, number> = { [MON]: 0, [WED]: 2, [THU]: 3, [FRI]: 4, [SAT]: 5, [SUN]: 6 };

// Same formatting the component uses, so the test is locale-independent.
const short = (key: string) => new Date(key + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });

let pushId = "";
let legsId = "";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  push.mockReset();
  await Promise.all(db.tables.map((t) => t.clear()));
  pushId = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench" }] });
  legsId = await createRoutine({ name: "Legs", exercises: [{ exercise_id: "squat" }] });
});

afterEach(() => {
  vi.useRealTimers();
});

const dayButtons = () => within(screen.getByRole("list")).getAllByRole("button");
const dayButton = (key: string) => dayButtons()[IDX[key]];

async function renderStrip() {
  render(<WeekStrip />);
  await waitFor(() => expect(dayButtons()).toHaveLength(7));
}

function openDay(key: string) {
  fireEvent.click(dayButton(key));
}

describe("WeekStrip", () => {
  it("shows the seven days of this week starting Monday", async () => {
    await renderStrip();
    expect(screen.getByRole("heading", { name: "This Week" })).toBeInTheDocument();
    expect(dayButtons().map((b) => b.textContent)).toEqual(["M12", "T13", "W14", "T15", "F16", "S17", "S18"]);
  });

  it("asks for a routine first when none exist", async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    await renderStrip();
    openDay(WED);
    expect(await screen.findByText("Create a routine first, then plan it on a day.")).toBeInTheDocument();
  });

  it("plans a routine on a day", async () => {
    await renderStrip();
    openDay(WED);
    expect(await screen.findByText("Plan a routine")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Push" }));

    await waitFor(async () => expect(await getDay(WED)).toMatchObject({ routine_id: pushId, status: "planned" }));
    expect(await screen.findByText(/Planned:/)).toHaveTextContent("Planned: Push");
    await waitFor(() => expect(dayButton(WED).textContent).toContain("•"));
    // Today and planned: can start, skip, move or clear.
    for (const name of ["Start", "Skip", "Move", "Clear this day"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("does not offer Start on a past planned day", async () => {
    await planDay(MON, pushId);
    await renderStrip();
    openDay(MON);
    expect(await screen.findByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  });

  it("starts the planned routine and goes to the live workout", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    openDay(WED);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workout"));
    const active = await db.active.get("active");
    expect(active).toMatchObject({ routine_id: pushId, name: "Push" });
    expect(active?.exercises.map((e) => e.exercise_id)).toEqual(["bench"]);
  });

  it("skips a day with a reason and a note", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    openDay(WED);
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));

    expect(screen.getByText("Why skip?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sore" }));
    fireEvent.change(screen.getByPlaceholderText("Note (optional)"), { target: { value: "  legs wrecked  " } });
    fireEvent.click(screen.getByRole("button", { name: "Skip this day" }));

    await waitFor(async () =>
      expect(await getDay(WED)).toMatchObject({
        status: "skipped",
        skip_reason: "sore",
        skip_note: "legs wrecked",
        routine_id: pushId,
      }),
    );
    // Panel closes and the strip marks the day as skipped.
    await waitFor(() => expect(screen.queryByText("Why skip?")).not.toBeInTheDocument());
    await waitFor(() => expect(dayButton(WED).textContent).toContain("–"));

    openDay(WED);
    expect(await screen.findByText(/Skipped · Sore — legs wrecked/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  });

  it("Back leaves the skip form without changing the day", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    openDay(WED);
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByText("Why skip?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(await getDay(WED)).toMatchObject({ status: "planned" });
  });

  it("undoes a skip", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    openDay(WED);
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip this day" }));
    await waitFor(async () => expect(await getDay(WED)).toMatchObject({ status: "skipped", skip_reason: "busy" }));
    await waitFor(() => expect(screen.queryByText("Why skip?")).not.toBeInTheDocument());

    openDay(WED);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(async () =>
      expect(await getDay(WED)).toMatchObject({ status: "planned", skip_reason: null, routine_id: pushId }),
    );
    expect(await screen.findByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("moves a day only to free days later this week", async () => {
    await planDay(WED, pushId);
    await planDay(THU, legsId); // Thursday is taken
    await renderStrip();
    openDay(WED);
    fireEvent.click(await screen.findByRole("button", { name: "Move" }));

    expect(screen.getByText("Why move it?")).toBeInTheDocument();
    const moveLabels = screen.getAllByRole("button", { name: /^Move to / }).map((b) => b.textContent);
    // Past days (Mon, Tue), the day itself and the taken Thursday are not offered.
    expect(moveLabels).toEqual([FRI, SAT, SUN].map((k) => `Move to ${short(k)}`));

    fireEvent.click(screen.getByRole("button", { name: "Tired" }));
    fireEvent.click(screen.getByRole("button", { name: `Move to ${short(FRI)}` }));

    await waitFor(async () =>
      expect(await getDay(WED)).toMatchObject({ status: "moved", moved_to: FRI, skip_reason: "tired" }),
    );
    expect(await getDay(FRI)).toMatchObject({ status: "planned", routine_id: pushId, moved_from: WED });
    expect(await getDay(THU)).toMatchObject({ status: "planned", routine_id: legsId });
    await waitFor(() => expect(dayButton(WED).textContent).toContain("→"));
    await waitFor(() => expect(dayButton(FRI).textContent).toContain("•"));
    await waitFor(() => expect(screen.queryByText("Why move it?")).not.toBeInTheDocument());

    openDay(WED);
    expect(await screen.findByText(new RegExp(`Moved to ${short(FRI)} · Tired`))).toBeInTheDocument();
  });

  it("says so when there is no free day to move to", async () => {
    await planDay(WED, pushId);
    for (const k of [THU, FRI, SAT, SUN]) await planDay(k, legsId);
    await renderStrip();
    openDay(WED);
    fireEvent.click(await screen.findByRole("button", { name: "Move" }));
    expect(screen.getByText("No free days left this week.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move to / })).not.toBeInTheDocument();
  });

  it("undoes a move, restoring the day and removing the moved copy", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    openDay(WED);
    fireEvent.click(await screen.findByRole("button", { name: "Move" }));
    fireEvent.click(screen.getByRole("button", { name: `Move to ${short(FRI)}` }));
    await waitFor(async () => expect(await getDay(FRI)).toMatchObject({ moved_from: WED }));
    await waitFor(() => expect(screen.queryByText("Why move it?")).not.toBeInTheDocument());

    openDay(WED);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(async () =>
      expect(await getDay(WED)).toMatchObject({ status: "planned", moved_to: null, routine_id: pushId }),
    );
    expect(await getDay(FRI)).toBeUndefined();
    await waitFor(() => expect(dayButton(FRI).textContent).toBe("F16"));
  });

  it("clears a planned day", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    openDay(WED);
    fireEvent.click(await screen.findByRole("button", { name: "Clear this day" }));
    await waitFor(async () => expect(await getDay(WED)).toBeUndefined());
    expect(await screen.findByText("Plan a routine")).toBeInTheDocument();
    await waitFor(() => expect(dayButton(WED).textContent).toBe("W14"));
  });

  it("shows a finished day as trained with no Clear or Undo", async () => {
    await planDay(WED, pushId);
    await db.planned_days.update((await getDay(WED))!.id, { status: "done", workout_id: "w1" });
    await renderStrip();
    await waitFor(() => expect(dayButton(WED).textContent).toContain("✓"));
    openDay(WED);
    expect(await screen.findByText("Trained ✓")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear this day" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("Close hides the day panel", async () => {
    await renderStrip();
    openDay(WED);
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(screen.queryByText("Plan a routine")).not.toBeInTheDocument();
  });
});
