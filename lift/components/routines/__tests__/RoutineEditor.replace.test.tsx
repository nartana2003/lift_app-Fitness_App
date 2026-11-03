// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import type { Exercise } from "@/lib/exercises";
import type { Equipment, MuscleGroup } from "@/lib/muscles";
import { resetSwapAi } from "@/components/workout/SwapSheet";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push, back: vi.fn() }),
  usePathname: () => "/routines/new",
  useSearchParams: () => new URLSearchParams(),
}));

import { RoutineEditor } from "@/components/routines/RoutineEditor";

const ex = (id: string, name: string, equipment: Equipment, muscle: MuscleGroup = "Biceps"): Exercise => ({
  id,
  name,
  muscle_groups: [muscle],
  secondary_groups: [],
  equipment,
  category: "strength",
  mechanic: "isolation",
  force: "pull",
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
});

const curl = ex("curl", "Barbell Curl", "Barbell");
const hammer = ex("hammer", "Hammer Curl", "Dumbbell");
const cable = ex("cable", "Cable Curl", "Machine/Cable");
const pushdown = ex("pushdown", "Triceps Pushdown", "Machine/Cable", "Triceps");
const CATALOGUE = [curl, hammer, cable, pushdown];

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
  push.mockReset();
  await Promise.all(db.tables.map((t) => t.clear()));
  resetSwapAi();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => Promise.resolve(url === "/exercises.json" ? jsonRes(200, CATALOGUE) : jsonRes(503, { unavailable: true }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const rows = [
  { exercise_id: "curl", target_sets: 4, target_reps: "6-8" },
  { exercise_id: "pushdown", target_sets: 3, target_reps: "10" },
];

describe("RoutineEditor: exercise options", () => {
  it("each exercise has an options button that opens the Replace menu", async () => {
    render(<RoutineEditor initialName="Arms" initialExercises={rows} initialSplitDayId="" />);
    const btn = await screen.findByRole("button", { name: "Options for Barbell Curl" });
    expect(screen.getByRole("button", { name: "Options for Triceps Pushdown" })).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.getByRole("dialog", { name: "Replace Barbell Curl" })).toBeInTheDocument();
  });

  it("replacing swaps that one exercise and keeps its sets, reps and place; the rest is untouched", async () => {
    render(<RoutineEditor initialName="Arms" initialExercises={rows} initialSplitDayId="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Options for Barbell Curl" }));
    const list = await screen.findByRole("list", { name: "Alternatives" });
    // The other row's exercise (Triceps Pushdown) is another muscle and never offered; same-muscle ones are.
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThan(0));
    fireEvent.click(within(list).getAllByRole("button", { name: /Hammer Curl|Cable Curl/ })[0]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    expect(screen.queryByText("Barbell Curl")).not.toBeInTheDocument();
    expect(screen.getByText("Triceps Pushdown")).toBeInTheDocument();
    const inputs = screen.getAllByRole("textbox").filter((i) => (i as HTMLInputElement).value === "6-8" || (i as HTMLInputElement).value === "4");
    expect(inputs.map((i) => (i as HTMLInputElement).value).sort()).toEqual(["4", "6-8"]);

    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const saved = (await db.routine_exercises.toArray()).sort((a, b) => a.position - b.position);
    expect(saved).toHaveLength(2);
    expect(["hammer", "cable"]).toContain(saved[0].exercise_id);
    expect(saved[0]).toMatchObject({ target_sets: 4, target_reps: "6-8", position: 0 });
    expect(saved[1]).toMatchObject({ exercise_id: "pushdown", target_sets: 3, target_reps: "10", position: 1 });
  });

  it("does not offer an exercise that is already in the routine", async () => {
    render(<RoutineEditor initialName="Arms" initialExercises={[{ exercise_id: "curl" }, { exercise_id: "hammer" }]} initialSplitDayId="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Options for Barbell Curl" }));
    const list = await screen.findByRole("list", { name: "Alternatives" });
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThan(0));
    expect(within(list).queryByRole("button", { name: /Hammer Curl/ })).not.toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /Cable Curl/ })).toBeInTheDocument();
  });

  it("Cancel leaves the routine as it was", async () => {
    render(<RoutineEditor initialName="Arms" initialExercises={rows} initialSplitDayId="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Options for Barbell Curl" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Barbell Curl")).toBeInTheDocument();
  });

  it("the existing controls still work: move, remove and add", async () => {
    render(<RoutineEditor initialName="Arms" initialExercises={rows} initialSplitDayId="" />);
    await screen.findByText("Barbell Curl");
    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]);
    const order = screen.getAllByRole("listitem").map((li) => li.querySelector("p.font-semibold")?.textContent);
    expect(order).toEqual(["Triceps Pushdown", "Barbell Curl"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(screen.queryByText("Triceps Pushdown")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add exercise" })).toBeInTheDocument();
  });
});
