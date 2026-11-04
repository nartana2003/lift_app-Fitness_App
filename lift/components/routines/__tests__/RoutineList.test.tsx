// @vitest-environment jsdom
// LINK-02: routines on Home grouped under their split day, Unassigned last.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db, type RoutineExerciseRow, type RoutineRow } from "@/lib/offline/db";
import { MUSCLE_GROUPS } from "@/lib/muscles";
import { saveSplit, type Split } from "@/lib/splits";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { groupRoutinesBySplit, RoutineList } from "@/components/routines/RoutineList";

const CATALOGUE = [
  {
    id: "pushup",
    name: "Push-Up",
    muscle_groups: ["Chest"],
    secondary_groups: [],
    equipment: "Bodyweight",
    category: "strength",
    mechanic: null,
    force: null,
    level: "beginner",
    instructions: [],
    image_urls: [],
    tiktok_url: "",
  },
];

function routine(id: string, name: string, created_at: string, over: Partial<RoutineRow> = {}): RoutineRow {
  return {
    id,
    name,
    day_label: null,
    source: "manual",
    kind: "routine",
    source_url: null,
    platform: null,
    thumbnail_url: null,
    creator: null,
    notes: null,
    created_at,
    ...over,
  };
}
const rex = (routineId: string): RoutineExerciseRow => ({
  id: `${routineId}-pushup`,
  routine_id: routineId,
  exercise_id: "pushup",
  position: 0,
  target_sets: 3,
  target_reps: "10",
});

const SPLIT: Split = {
  name: "PPL",
  days: [
    { id: "push", name: "Push", muscles: ["Chest"] },
    { id: "pull", name: "Pull", muscles: ["Back"] },
    { id: "legs", name: "Legs", muscles: ["Quads"] },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/exercises.json")) return json(CATALOGUE);
      return json({ unavailable: true }, 503);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seed(rows: RoutineRow[]) {
  await db.routines.bulkPut(rows);
  await db.routine_exercises.bulkPut(rows.map((r) => rex(r.id)));
}

describe("groupRoutinesBySplit", () => {
  const rs = [
    routine("a", "Legs A", "2026-01-03", { split_day_id: "legs" }),
    routine("b", "Push A", "2026-01-02", { split_day_id: "push" }),
    routine("c", "Loose", "2026-01-01"),
    routine("d", "Orphan", "2026-01-04", { split_day_id: "removed" }),
    routine("e", "Push B", "2026-01-05", { split_day_id: "push" }),
  ];

  it("groups in split order, skips empty days, keeps input order, Unassigned last", () => {
    const g = groupRoutinesBySplit(rs, SPLIT)!;
    expect(g.map((x) => [x.title, x.routines.map((r) => r.id)])).toEqual([
      ["Push", ["b", "e"]],
      ["Legs", ["a"]],
      ["Unassigned", ["c", "d"]],
    ]);
  });

  it("is null when nothing is linked to a current day (list shown as before)", () => {
    expect(groupRoutinesBySplit(rs, { days: [] })).toBeNull();
    expect(groupRoutinesBySplit([rs[2], rs[3]], SPLIT)).toBeNull();
  });

  it("includes linked mini routines under their day", () => {
    const g = groupRoutinesBySplit([routine("m", "Mini", "2026-01-01", { kind: "mini", split_day_id: "pull" })], SPLIT)!;
    expect(g.map((x) => x.title)).toEqual(["Pull"]);
  });
});

describe("RoutineList menu and filters", () => {
  it("shows every muscle group chip, like the Exercises tab", async () => {
    await seed([routine("r1", "Push day", "2026-01-01")]);
    render(<RoutineList />);
    await screen.findByText("Push day");
    const chips = within(screen.getByRole("group", { name: "Filter by muscle" })).getAllByRole("button");
    expect(chips).toHaveLength(MUSCLE_GROUPS.length);
  });

  it("deletes a routine from the three dots menu after confirming", async () => {
    await seed([routine("r1", "Push day", "2026-01-01"), routine("r2", "Leg day", "2026-01-02")]);
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<RoutineList />);
    await screen.findByText("Push day");
    fireEvent.click(screen.getByRole("button", { name: "Options for Push day" }));
    expect(screen.getByRole("link", { name: "Edit routine" })).toHaveAttribute("href", "/routines/r1");
    fireEvent.click(screen.getByRole("button", { name: "Delete routine" }));
    await waitFor(() => expect(screen.queryByText("Push day")).not.toBeInTheDocument(), { timeout: 8000 });
    expect(screen.getByText("Leg day")).toBeInTheDocument();
    expect((await db.routines.toArray()).map((r) => r.id)).toEqual(["r2"]);
  });

  it("keeps the routine when delete is declined", async () => {
    await seed([routine("r1", "Push day", "2026-01-01")]);
    vi.stubGlobal("confirm", vi.fn(() => false));
    render(<RoutineList />);
    await screen.findByText("Push day");
    fireEvent.click(screen.getByRole("button", { name: "Options for Push day" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete routine" }));
    expect(await db.routines.count()).toBe(1);
  });
});

describe("RoutineList grouping", () => {
  it("with no split looks exactly as before: one list, no day headings", async () => {
    await seed([routine("r1", "Push day", "2026-01-01"), routine("r2", "Leg day", "2026-01-02")]);
    render(<RoutineList />);
    await screen.findByText("Push day");
    expect(screen.getByText("Leg day")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Unassigned" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("list")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "New routine" })).not.toBeInTheDocument();
    expect(screen.queryByText("Generate 3-day plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Save from link")).not.toBeInTheDocument();
  });

  it("with a split but no links stays ungrouped", async () => {
    await saveSplit(SPLIT);
    await seed([routine("r1", "Push day", "2026-01-01")]);
    render(<RoutineList />);
    await screen.findByText("Push day");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });

  it("groups routines under their split day headings with Unassigned last", async () => {
    await saveSplit(SPLIT);
    await seed([
      routine("r1", "Push A", "2026-01-01", { split_day_id: "push" }),
      routine("r2", "Legs A", "2026-01-02", { split_day_id: "legs" }),
      routine("r3", "Loose", "2026-01-03"),
    ]);
    render(<RoutineList />);
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Push", "Legs", "Unassigned"]),
    );
    expect(within(screen.getByRole("group", { name: "Push" })).getByText("Push A")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Legs" })).getByText("Legs A")).toBeInTheDocument();
    const rest = screen.getByRole("group", { name: "Unassigned" });
    expect(within(rest).getByText("Loose")).toBeInTheDocument();
    // Each card keeps its Start and Edit controls.
    expect(screen.getAllByRole("button", { name: "Start" })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /^Options for / })).toHaveLength(3);
    // No heading for a day with no routines.
    expect(screen.queryByRole("group", { name: "Pull" })).not.toBeInTheDocument();
  });
});

describe("RoutineList search and layout", () => {
  it("stacks routines in one vertical list, not a horizontal scroller", async () => {
    await seed([routine("r1", "Push day", "2026-01-01"), routine("r2", "Leg day", "2026-01-02")]);
    render(<RoutineList />);
    await screen.findByText("Push day");
    const list = screen.getByRole("list");
    expect(list.className).toContain("space-y-3");
    expect(list.className).not.toContain("overflow-x-auto");
  });

  it("filters by name, ignoring case and spaces around the query", async () => {
    await seed([routine("r1", "Push day", "2026-01-01"), routine("r2", "Leg day", "2026-01-02")]);
    render(<RoutineList />);
    await screen.findByText("Push day");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search routines" }), { target: { value: "  LEG " } });
    expect(screen.getByText("Leg day")).toBeInTheDocument();
    expect(screen.queryByText("Push day")).not.toBeInTheDocument();
  });

  it("shows a message with Clear filters when nothing matches, and clearing restores the list", async () => {
    await seed([routine("r1", "Push day", "2026-01-01")]);
    render(<RoutineList />);
    await screen.findByText("Push day");
    const box = screen.getByRole("searchbox", { name: "Search routines" });
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText("No routines match these filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Push day")).toBeInTheDocument();
    expect(box).toHaveValue("");
  });

  it("muscle filter uses muscle visuals and combines with search", async () => {
    await seed([routine("r1", "Push day", "2026-01-01"), routine("r2", "Push extra", "2026-01-02")]);
    render(<RoutineList />);
    await screen.findByText("Push day");
    const chest = await screen.findByRole("button", { name: /Chest/ });
    expect(chest.querySelector("svg, img")).not.toBeNull();
    fireEvent.click(chest);
    expect(chest).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search routines" }), { target: { value: "extra" } });
    expect(screen.getByText("Push extra")).toBeInTheDocument();
    expect(screen.queryByText("Push day")).not.toBeInTheDocument();
    fireEvent.click(chest);
    expect(chest).toHaveAttribute("aria-pressed", "false");
  });
});
