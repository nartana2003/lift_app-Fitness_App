// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { HistoryList } from "@/components/HistoryList";

const BENCH = {
  id: "bench",
  name: "Bench Press",
  muscle_groups: ["Chest"],
  secondary_groups: [],
  equipment: "barbell",
  category: "strength",
  mechanic: null,
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: ["https://img.test/bench.jpg"],
  tiktok_url: "",
};

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ json: () => Promise.resolve([BENCH]) })));
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

async function seed(id: string, daysAgo: number, notes: string, exercises: { exercise_id: string; weight: number; n: number }[]) {
  const start = new Date(Date.now() - daysAgo * 864e5);
  await db.workouts.put({
    id,
    started_at: start.toISOString(),
    ended_at: new Date(start.getTime() + 45 * 60e3).toISOString(),
    notes,
    routine_id: null,
  });
  for (const [i, e] of exercises.entries()) {
    const weId = `${id}-we${i}`;
    await db.workout_exercises.put({ id: weId, workout_id: id, exercise_id: e.exercise_id, position: i });
    for (let s = 0; s < e.n; s++)
      await db.sets.put({
        id: `${weId}-s${s}`,
        workout_exercise_id: weId,
        set_no: s + 1,
        reps: 8,
        weight: e.weight,
        is_warmup: false,
        rir: null,
        completed_at: start.toISOString(),
      });
  }
}

describe("HistoryList cards", () => {
  it("shows duration, volume, records and a thumbnail per exercise, and links to the detail", async () => {
    await seed("w1", 9, "Push A", [{ exercise_id: "bench", weight: 50, n: 3 }]);
    await seed("w2", 2, "Push B", [
      { exercise_id: "bench", weight: 60, n: 3 },
      { exercise_id: "mystery-move", weight: 20, n: 2 },
    ]);
    render(<HistoryList />);

    const card = (await screen.findByText("Push B")).closest("a")!;
    expect(card).toHaveAttribute("href", "/history/w2");
    const c = within(card);
    expect(c.getByText("Duration")).toBeInTheDocument();
    expect(c.getByText("45m")).toBeInTheDocument();
    expect(c.getByText("Volume")).toBeInTheDocument();
    expect(c.getByText("1,760kg")).toBeInTheDocument();
    expect(c.getByText("Records").nextElementSibling).toHaveTextContent("3");
    expect(await c.findByText("3 x Bench Press")).toBeInTheDocument();
    expect(c.getByRole("img", { name: "Bench Press" })).toHaveAttribute("src", "https://img.test/bench.jpg");
    // No catalogue entry: letter in a grey circle, caption uses the id.
    expect(c.getByText("2 x mystery-move")).toBeInTheDocument();
    expect(c.getByText("M")).toBeInTheDocument();

    const first = within((await screen.findByText("Push A")).closest("a")!);
    expect(first.getByText("Records").nextElementSibling).toHaveTextContent("0");
  });

  it("leaves workouts older than 400 days off the list but still counts them as bests", async () => {
    await seed("old", 500, "Old day", [{ exercise_id: "bench", weight: 100, n: 1 }]);
    await seed("new", 1, "New day", [{ exercise_id: "bench", weight: 60, n: 1 }]);
    render(<HistoryList />);
    const card = within((await screen.findByText("New day")).closest("a")!);
    expect(card.getByText("Records").nextElementSibling).toHaveTextContent("0");
    expect(screen.queryByText("Old day")).toBeNull();
  });
});
