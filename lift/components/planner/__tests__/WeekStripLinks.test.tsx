// @vitest-environment jsdom
// LINK-03: the WeekStrip day panel and Auto-fill put a split day's linked routines first.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db, uuid } from "@/lib/offline/db";
import { createRoutine } from "@/lib/routines";
import { getDay } from "@/lib/planner";
import { saveSplit, type Split } from "@/lib/splits";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { WeekStrip, planChoices } from "@/components/planner/WeekStrip";

// "Today" is Wednesday 14 Oct 2026; the week is Mon 12 .. Sun 18.
const NOW = new Date(2026, 9, 14, 12, 0, 0);
const WEEK = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
const THU = WEEK[3];
const SAT = WEEK[5];
const short = (key: string) => new Date(key + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });

const r = (id: string, created_at: string, split_day_id?: string | null, kind: "routine" | "mini" = "routine") => ({
  id,
  name: id,
  created_at,
  kind,
  ...(split_day_id !== undefined ? { split_day_id } : {}),
});

/** Create routines one second apart so their created_at order is the call order. */
let tick = 0;
async function make(name: string, split_day_id?: string) {
  vi.setSystemTime(new Date(NOW.getTime() - 60_000 + tick++ * 1000));
  const id = await createRoutine({ name, exercises: [{ exercise_id: "bench" }], ...(split_day_id ? { split_day_id } : {}) });
  vi.setSystemTime(NOW);
  return id;
}

async function splitIds(split: Split) {
  await saveSplit(split);
  return ((await db.meta.get("split"))!.value as Split).days.map((d) => d.id!);
}

const PPL: Split = {
  name: "PPL",
  days: [
    { name: "Push", muscles: ["Chest"] },
    { name: "Pull", muscles: ["Back"] },
    { name: "Legs", muscles: ["Quads"] },
  ],
};

const dayButtons = () => within(screen.getByRole("list")).getAllByRole("button");

async function renderStrip() {
  render(<WeekStrip />);
  await waitFor(() => expect(dayButtons()).toHaveLength(7));
}

beforeEach(async () => {
  tick = 0;
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await Promise.all(db.tables.map((t) => t.clear()));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("planChoices", () => {
  const split = { days: [{ id: "push", name: "Push", muscles: [] }, { id: "pull", name: "", muscles: [] }, { name: "No id", muscles: [] }] };

  it("with no links: no groups and the list unchanged", () => {
    const list = [r("b", "2026-01-02"), r("a", "2026-01-01")];
    expect(planChoices(split, list)).toEqual({ groups: [], others: list });
  });

  it("groups linked routines by split day in split order, next routine first, others after", () => {
    const list = [r("loose", "2026-01-01"), r("pullA", "2026-01-02", "pull"), r("pushA", "2026-01-03", "push"), r("pushB", "2026-01-04", "push"), r("gone", "2026-01-05", "removed-day")];
    const lastDone = new Map([["pushA", "2026-02-10"], ["pushB", "2026-02-01"]]);
    const out = planChoices(split, list, lastDone);
    expect(out.groups.map((g) => [g.name, g.routines.map((x) => x.id)])).toEqual([
      ["Push", ["pushB", "pushA"]],
      ["Day 2", ["pullA"]],
    ]);
    expect(out.others.map((x) => x.id)).toEqual(["loose", "gone"]);
  });

  it("lists linked mini routines in their day group but after the next full routine", () => {
    const list = [r("mini", "2026-01-01", "push", "mini"), r("full", "2026-01-02", "push")];
    expect(planChoices(split, list).groups[0].routines.map((x) => x.id)).toEqual(["full", "mini"]);
  });
});

describe("WeekStrip day panel", () => {
  it("with no links shows the plain routine list as before", async () => {
    await make("Alpha");
    await make("Beta");
    await renderStrip();
    fireEvent.click(dayButtons()[3]);
    expect(await screen.findByText("Plan a routine")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Other routines" })).toBeNull();
    expect(screen.getByRole("button", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();
  });

  it("lists each split day's linked routines first, then the others, and plans the one tapped", async () => {
    const [push, pull] = await splitIds(PPL);
    await make("Loose");
    const pullId = await make("Back day", pull);
    await make("Chest day", push);
    await renderStrip();
    fireEvent.click(dayButtons()[3]);
    await screen.findByText("Plan a routine");
    const groups = await screen.findAllByRole("group", { name: / routines$/ });
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Push routines", "Pull routines", "Other routines"]);
    expect(within(groups[0]).getByRole("button", { name: "Chest day" })).toBeInTheDocument();
    expect(within(groups[1]).getByRole("button", { name: "Back day" })).toBeInTheDocument();
    expect(within(groups[2]).getByRole("button", { name: "Loose" })).toBeInTheDocument();
    fireEvent.click(within(groups[1]).getByRole("button", { name: "Back day" }));
    await waitFor(async () => expect(await getDay(THU)).toMatchObject({ routine_id: pullId }));
  });
});

describe("WeekStrip Auto-fill", () => {
  it("uses the linked routine done longest ago for each split day", async () => {
    const [push, pull] = await splitIds({ name: "PP", days: [PPL.days[0], PPL.days[1]] });
    const a = await make("Push A", push);
    const b = await make("Push B", push);
    const pullId = await make("Pull X", pull);
    // Push A was done more recently than Push B.
    await db.workouts.put({ id: uuid(), started_at: "2026-10-10T10:00:00.000Z", ended_at: "2026-10-10T11:00:00.000Z", notes: null, routine_id: a });
    await db.workouts.put({ id: uuid(), started_at: "2026-10-01T10:00:00.000Z", ended_at: "2026-10-01T11:00:00.000Z", notes: null, routine_id: b });
    await renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "Auto-fill from my split" }));
    expect(await screen.findByText("Order: Push B, Pull X")).toBeInTheDocument();
    // Pick Thu and Sat only.
    for (const k of WEEK) {
      const btn = screen.getByRole("button", { name: short(k) });
      const on = btn.getAttribute("aria-pressed") === "true";
      if (on !== (k === THU || k === SAT)) fireEvent.click(btn);
    }
    fireEvent.click(screen.getByRole("button", { name: "Fill 2 days" }));
    await waitFor(async () => expect(await getDay(SAT)).toMatchObject({ routine_id: pullId }));
    expect(await getDay(THU)).toMatchObject({ routine_id: b });
  });
});
