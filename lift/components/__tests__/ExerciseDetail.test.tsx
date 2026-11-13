// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { db, uuid } from "@/lib/offline/db";

const { ExerciseHistory, SessionLog } = await import("@/components/ExerciseHistory");
const { PrHistory } = await import("@/components/PrHistory");

const EX = "hip-abductor";

/** A finished session of EX with the given sets as [reps, weight, warmup?]. */
async function session(startedAt: string, sets: [number, number, boolean?][]) {
  const workout_id = uuid();
  const we = uuid();
  await db.workouts.add({ id: workout_id, started_at: startedAt, ended_at: startedAt, notes: null, routine_id: null });
  await db.workout_exercises.add({ id: we, workout_id, exercise_id: EX, position: 0 });
  await db.sets.bulkAdd(
    sets.map(([reps, weight, warm], i) => ({ id: uuid(), workout_exercise_id: we, set_no: i + 1, reps, weight, is_warmup: !!warm, rir: null, completed_at: startedAt })),
  );
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("ExerciseHistory", () => {
  it("says so when the exercise has never been logged", async () => {
    render(<ExerciseHistory exerciseId={EX} />);
    expect(await screen.findByText("You haven't logged this exercise yet.")).toBeInTheDocument();
  });

  it("does not repeat last time, heaviest or est. 1RM: the workout and Records already show them", async () => {
    await session("2026-11-10T09:00:00.000Z", [[5, 10, true], [8, 23], [9, 23], [10, 23]]);
    render(<ExerciseHistory exerciseId={EX} />);
    await screen.findByText("Progress");
    expect(screen.queryByText("Last time")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Sets last time" })).not.toBeInTheDocument();
    expect(screen.queryByText("Heaviest")).not.toBeInTheDocument();
    expect(screen.queryByText("Est. 1RM")).not.toBeInTheDocument();
  });

  it("asks for another session instead of drawing a one-point trend", async () => {
    await session("2026-11-10T09:00:00.000Z", [[10, 23]]);
    render(<ExerciseHistory exerciseId={EX} />);
    expect(await screen.findByText("Log one more session to see your trend.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("draws the est. 1RM trend from two sessions", async () => {
    await session("2026-11-03T09:00:00.000Z", [[10, 20]]);
    await session("2026-11-10T09:00:00.000Z", [[10, 23]]);
    render(<ExerciseHistory exerciseId={EX} />);
    expect(await screen.findByRole("img", { name: "Estimated 1RM went from 26.7 to 30.7 kg" })).toBeInTheDocument();
    expect(screen.queryByText("Log one more session to see your trend.")).not.toBeInTheDocument();
  });
});

describe("SessionLog", () => {
  it("renders nothing without sessions", async () => {
    const { container } = render(<SessionLog exerciseId={EX} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("says 1 session, not 1 sessions", async () => {
    await session("2026-11-10T09:00:00.000Z", [[10, 23]]);
    render(<SessionLog exerciseId={EX} />);
    expect(await screen.findByText("1 session")).toBeInTheDocument();
  });

  it("counts several sessions and lists them inside the collapsed details", async () => {
    await session("2026-11-03T09:00:00.000Z", [[10, 20]]);
    await session("2026-11-10T09:00:00.000Z", [[8, 23], [9, 23]]);
    const { container } = render(<SessionLog exerciseId={EX} />);
    expect(await screen.findByText("2 sessions")).toBeInTheDocument();
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText("8×23, 9×23")).toBeInTheDocument();
  });
});

describe("PrHistory", () => {
  it("shows the four records once, as a grid", async () => {
    await session("2026-11-10T09:00:00.000Z", [[8, 23], [9, 23], [10, 23]]);
    render(<PrHistory exerciseId={EX} />);
    await screen.findByText("Records");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(4);
    const text = (label: string) => items.find((li) => within(li).queryByText(label))!.textContent;
    expect(text("Heaviest")).toContain("23kg");
    expect(text("Heaviest")).toContain("8 reps");
    expect(text("Most reps")).toContain("10 reps");
    expect(text("Most reps")).toContain("at 23kg");
    expect(text("Best est. 1RM")).toContain("30.7kg");
    expect(text("Best est. 1RM")).toContain("23kg × 10");
    expect(text("Best volume")).toContain("621kg");
  });
});
