// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { createRoutine } from "@/lib/routines";
import { getDay, planDay } from "@/lib/planner";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { WeekStrip } from "@/components/planner/WeekStrip";

// DND-01: the week strip drag runs on @dnd-kit. Pointer drags are covered by
// WeekStripReschedule.test.tsx (unchanged); this file covers what dnd-kit adds:
// keyboard drag, Escape to cancel, and the refused non-primary button.
// "Today" is Wednesday 14 Oct 2026; the week is Mon 12 .. Sun 18.
const NOW = new Date(2026, 9, 14, 12, 0, 0);
const WEEK = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
const [, , WED, THU, FRI, SAT] = WEEK;

const short = (key: string) => new Date(key + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });

let pushId = "";
let legsId = "";
const realRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await Promise.all(db.tables.map((t) => t.clear()));
  pushId = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench" }] });
  legsId = await createRoutine({ name: "Legs", exercises: [{ exercise_id: "squat" }] });
  // jsdom has no layout: lay the seven 40px circles out 50px apart in a row.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const i = WEEK.indexOf(this.dataset.day ?? "");
    const left = i < 0 ? 0 : i * 50;
    const size = i < 0 ? 0 : 40;
    return { x: left, y: 0, left, top: 0, right: left + size, bottom: size, width: size, height: size, toJSON() {} } as DOMRect;
  };
});

afterEach(() => {
  vi.useRealTimers();
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

const dayButtons = () => within(screen.getByRole("list")).getAllByRole("button");
const dayButton = (key: string) => dayButtons()[WEEK.indexOf(key)];
const tick = () => act(() => new Promise((r) => setTimeout(r, 10)));

async function renderStrip() {
  render(<WeekStrip />);
  await waitFor(() => expect(dayButtons()).toHaveLength(7));
}

async function key(el: Element, code: string) {
  fireEvent.keyDown(el, { code, key: code === "Space" ? " " : code });
  await tick();
}

describe("WeekStrip keyboard drag (dnd-kit)", () => {
  it("Space picks up a planned day, arrows choose a free day, Space drops it there", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    await waitFor(() => expect(dayButton(WED).textContent).toContain("•"));
    const btn = dayButton(WED);
    btn.focus();
    await key(btn, "Space");
    expect(screen.getByText("Drop on a free day, or on a planned day to swap")).toBeInTheDocument();
    await key(btn, "ArrowRight");
    await key(btn, "ArrowRight");
    expect(await screen.findByText(`Drop to move to ${short(FRI)}`)).toBeInTheDocument();
    await key(btn, "Space");

    await waitFor(async () => expect(await getDay(FRI)).toMatchObject({ routine_id: pushId, status: "planned" }));
    await waitFor(async () => expect(await getDay(WED)).toBeUndefined());
    expect(await screen.findByText(`Moved Push to ${short(FRI)}.`)).toBeInTheDocument();
  });

  it("swaps with a planned day by keyboard", async () => {
    await planDay(WED, pushId);
    await planDay(THU, legsId);
    await renderStrip();
    await waitFor(() => expect(dayButton(THU).textContent).toContain("•"));
    const btn = dayButton(WED);
    btn.focus();
    await key(btn, "Space");
    await key(btn, "ArrowRight");
    expect(await screen.findByText(`Drop to swap with ${short(THU)}`)).toBeInTheDocument();
    await key(btn, "Enter");

    await waitFor(async () => expect(await getDay(THU)).toMatchObject({ routine_id: pushId }));
    await waitFor(async () => expect(await getDay(WED)).toMatchObject({ routine_id: legsId, status: "planned" }));
  });

  it("Escape cancels a keyboard drag and changes nothing", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    await waitFor(() => expect(dayButton(WED).textContent).toContain("•"));
    const btn = dayButton(WED);
    btn.focus();
    await key(btn, "Space");
    await key(btn, "ArrowRight");
    await key(btn, "ArrowRight");
    await key(btn, "Escape");
    expect(screen.queryByText("Drop on a free day, or on a planned day to swap")).not.toBeInTheDocument();
    expect(screen.getByText("Drag a planned day to move it.")).toBeInTheDocument();
    await tick();
    expect(await getDay(FRI)).toBeUndefined();
    expect(await getDay(WED)).toMatchObject({ routine_id: pushId, status: "planned" });
  });

  it("Enter does not start a drag (it stays the key that opens the day)", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    await waitFor(() => expect(dayButton(WED).textContent).toContain("•"));
    await key(dayButton(WED), "Enter");
    expect(screen.queryByText("Drop on a free day, or on a planned day to swap")).not.toBeInTheDocument();
  });

  it("a day with nothing planned cannot be picked up by keyboard", async () => {
    await renderStrip();
    await key(dayButton(SAT), "Space");
    expect(screen.queryByText("Drop on a free day, or on a planned day to swap")).not.toBeInTheDocument();
  });

  it("a right-button drag does nothing", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    await waitFor(() => expect(dayButton(WED).textContent).toContain("•"));
    const src = dayButton(WED);
    document.elementFromPoint = vi.fn(() => dayButton(FRI));
    fireEvent.pointerDown(src, { pointerId: 1, button: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(src, { pointerId: 1, clientX: 60, clientY: 10 });
    fireEvent.pointerUp(src, { pointerId: 1, clientX: 60, clientY: 10 });
    await tick();
    // @ts-expect-error test-only stub cleanup
    delete document.elementFromPoint;
    expect(await getDay(FRI)).toBeUndefined();
    expect(await getDay(WED)).toMatchObject({ routine_id: pushId });
  });

  it("only planned days carry the drag instructions", async () => {
    await planDay(WED, pushId);
    await renderStrip();
    await waitFor(() => expect(dayButton(WED)).toHaveAttribute("aria-describedby"));
    expect(dayButton(SAT)).not.toHaveAttribute("aria-describedby");
    // aria-pressed still means "gym day", not dnd-kit's "being dragged".
    expect(dayButton(WED)).toHaveAttribute("aria-pressed", "true");
    expect(dayButton(SAT)).toHaveAttribute("aria-pressed", "false");
  });
});
