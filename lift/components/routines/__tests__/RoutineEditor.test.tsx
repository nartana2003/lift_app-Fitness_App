// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import type { Exercise } from "@/lib/exercises";
import { createRoutine, getRoutine, listRoutines, DEFAULT_REPS, DEFAULT_SETS } from "@/lib/routines";
import { saveSplit } from "@/lib/splits";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push, back: vi.fn() }),
  usePathname: () => "/routines/new",
  useSearchParams: () => new URLSearchParams(),
}));

const ex = (id: string, name: string, muscle: Exercise["muscle_groups"][number]): Exercise => ({
  id,
  name,
  muscle_groups: [muscle],
  secondary_groups: [],
  equipment: "Barbell",
  category: "strength",
  mechanic: null,
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
});
const CATALOGUE = [
  ex("bench", "Bench Press", "Chest"),
  ex("squat", "Back Squat", "Quads"),
  ex("row", "Barbell Row", "Back"),
];

// The catalogue normally fetches /exercises.json; serve a fixed list instead.
vi.mock("@/lib/catalogue", () => ({
  useCatalogue: () => ({
    loading: false,
    exercises: CATALOGUE,
    get: (id: string) => CATALOGUE.find((e) => e.id === id),
  }),
}));

// The picker has its own browse UI; stub it to "pick" squat then row.
vi.mock("@/components/workout/ExercisePicker", () => ({
  ExercisePicker: ({ onAdd, onClose }: { onAdd: (ids: string[]) => void; onClose: () => void }) => (
    <div>
      <p>picker-open</p>
      <button onClick={() => onAdd(["squat", "row"])}>Pick squat and row</button>
      <button onClick={onClose}>Cancel picker</button>
    </div>
  ),
}));

import { dayFromSearch, RoutineEditor } from "@/components/routines/RoutineEditor";

beforeEach(async () => {
  push.mockReset();
  await Promise.all(db.tables.map((t) => t.clear()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const nameInput = () => screen.getByPlaceholderText("Routine name (e.g. Push day)");
const rows = () => screen.queryAllByRole("listitem");
const rowNames = () => rows().map((li) => li.querySelector("p")?.textContent);
const rowInputs = (i: number) => within(rows()[i]).getAllByRole("textbox") as HTMLInputElement[];
const setsInput = (i: number) => rowInputs(i)[0];
const repsInput = (i: number) => rowInputs(i)[1];
const moveUp = (i: number) => fireEvent.click(within(rows()[i]).getByRole("button", { name: "Move up" }));
const moveDown = (i: number) => fireEvent.click(within(rows()[i]).getByRole("button", { name: "Move down" }));

function addSquatAndRow() {
  fireEvent.click(screen.getByRole("button", { name: "+ Add exercise" }));
  fireEvent.click(screen.getByRole("button", { name: "Pick squat and row" }));
}

async function seedPush() {
  return createRoutine({
    name: "Push",
    exercises: [
      { exercise_id: "bench", target_sets: 4, target_reps: "5-8" },
      { exercise_id: "squat", target_sets: 3, target_reps: "8-12" },
      { exercise_id: "row", target_sets: 2, target_reps: "10" },
    ],
  });
}

async function renderEdit(id: string) {
  const r = (await getRoutine(id))!;
  render(
    <RoutineEditor
      routineId={r.id}
      initialName={r.name}
      initialExercises={r.exercises.map((e) => ({
        exercise_id: e.exercise_id,
        target_sets: e.target_sets,
        target_reps: e.target_reps,
      }))}
    />,
  );
}

describe("RoutineEditor: create", () => {
  it("starts empty with Create disabled", () => {
    render(<RoutineEditor />);
    expect(screen.getByRole("heading", { name: "New routine" })).toBeInTheDocument();
    expect(nameInput()).toHaveValue("");
    expect(rows()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Create routine" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Delete routine" })).not.toBeInTheDocument();
  });

  it("needs both a non-blank name and at least one exercise", () => {
    render(<RoutineEditor />);
    const create = () => screen.getByRole("button", { name: "Create routine" });
    fireEvent.change(nameInput(), { target: { value: "   " } });
    addSquatAndRow();
    expect(create()).toBeDisabled();

    fireEvent.change(nameInput(), { target: { value: "Legs" } });
    expect(create()).toBeEnabled();

    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Remove" }));
    expect(rows()).toHaveLength(0);
    expect(create()).toBeDisabled();
  });

  it("adds picked exercises with default sets and reps and closes the picker", () => {
    render(<RoutineEditor />);
    addSquatAndRow();
    expect(screen.queryByText("picker-open")).not.toBeInTheDocument();
    expect(rowNames()).toEqual(["Back Squat", "Barbell Row"]);
    expect(within(rows()[0]).getByText("Quads")).toBeInTheDocument();
    expect(setsInput(0)).toHaveValue(String(DEFAULT_SETS));
    expect(repsInput(0)).toHaveValue(DEFAULT_REPS);
  });

  it("cancelling the picker adds nothing", () => {
    render(<RoutineEditor />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add exercise" }));
    expect(screen.getByText("picker-open")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel picker" }));
    expect(screen.queryByText("picker-open")).not.toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });

  it("creates the routine in Dexie with the chosen targets, then goes Home", async () => {
    render(<RoutineEditor />);
    fireEvent.change(nameInput(), { target: { value: "  Leg day  " } });
    addSquatAndRow();
    fireEvent.change(setsInput(0), { target: { value: "5" } });
    fireEvent.change(repsInput(0), { target: { value: "3-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    const all = await listRoutines();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Leg day");
    expect(all[0].exercises.map((e) => [e.exercise_id, e.position, e.target_sets, e.target_reps])).toEqual([
      ["squat", 0, 5, "3-5"],
      ["row", 1, DEFAULT_SETS, DEFAULT_REPS],
    ]);
    // Local-first: the write is queued for sync.
    expect((await db.outbox.toArray()).filter((o) => o.table === "routines")).toHaveLength(1);
  });

  it("clamps sets to 1..20", () => {
    render(<RoutineEditor />);
    addSquatAndRow();
    fireEvent.change(setsInput(0), { target: { value: "50" } });
    expect(setsInput(0)).toHaveValue("20");
    fireEvent.change(setsInput(0), { target: { value: "abc" } });
    expect(setsInput(0)).toHaveValue("1");
    fireEvent.change(setsInput(0), { target: { value: "0" } });
    expect(setsInput(0)).toHaveValue("1");
  });

  it("removes the right row", () => {
    render(<RoutineEditor />);
    addSquatAndRow();
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Remove" }));
    expect(rowNames()).toEqual(["Barbell Row"]);
  });

  it("shows the raw id when an exercise is missing from the catalogue", () => {
    render(<RoutineEditor initialName="Odd" initialExercises={[{ exercise_id: "gone-123" }]} />);
    expect(rowNames()).toEqual(["gone-123"]);
  });
});

describe("RoutineEditor: edit", () => {
  it("prefills the name and exercises with their targets", async () => {
    const id = await seedPush();
    await renderEdit(id);
    expect(screen.getByRole("heading", { name: "Edit routine" })).toBeInTheDocument();
    expect(nameInput()).toHaveValue("Push");
    expect(rowNames()).toEqual(["Bench Press", "Back Squat", "Barbell Row"]);
    expect(setsInput(0)).toHaveValue("4");
    expect(repsInput(0)).toHaveValue("5-8");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("saves name, target and list changes over the same routine", async () => {
    const id = await seedPush();
    await renderEdit(id);
    fireEvent.change(nameInput(), { target: { value: "Push A" } });
    fireEvent.change(repsInput(1), { target: { value: "6-10" } });
    fireEvent.click(within(rows()[2]).getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    const all = await listRoutines();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(id);
    expect(all[0].name).toBe("Push A");
    expect(all[0].exercises.map((e) => [e.exercise_id, e.position, e.target_sets, e.target_reps])).toEqual([
      ["bench", 0, 4, "5-8"],
      ["squat", 1, 3, "6-10"],
    ]);
    // Old exercise rows are replaced, not left behind.
    expect(await db.routine_exercises.where("routine_id").equals(id).count()).toBe(2);
  });

  it("adds more exercises to the end of an existing routine", async () => {
    const id = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench" }] });
    await renderEdit(id);
    addSquatAndRow();
    expect(rowNames()).toEqual(["Bench Press", "Back Squat", "Barbell Row"]);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect((await getRoutine(id))!.exercises.map((e) => e.exercise_id)).toEqual(["bench", "squat", "row"]);
  });

  it("deletes the routine after confirming", async () => {
    const id = await seedPush();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    await renderEdit(id);
    fireEvent.click(screen.getByRole("button", { name: "Delete routine" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await getRoutine(id)).toBeUndefined();
    expect(await db.routine_exercises.count()).toBe(0);
  });

  it("keeps the routine when delete is cancelled", async () => {
    const id = await seedPush();
    vi.stubGlobal("confirm", vi.fn(() => false));
    await renderEdit(id);
    fireEvent.click(screen.getByRole("button", { name: "Delete routine" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(push).not.toHaveBeenCalled();
    expect(await getRoutine(id)).toBeDefined();
  });
});

describe("RoutineEditor: reorder", () => {
  it("moves a row down and up, carrying its targets with it", async () => {
    const id = await seedPush();
    await renderEdit(id);
    moveDown(0);
    expect(rowNames()).toEqual(["Back Squat", "Bench Press", "Barbell Row"]);
    expect(setsInput(1)).toHaveValue("4");
    expect(repsInput(1)).toHaveValue("5-8");

    moveUp(2);
    expect(rowNames()).toEqual(["Back Squat", "Barbell Row", "Bench Press"]);
    expect(repsInput(1)).toHaveValue("10");
  });

  it("ignores Move up on the first row and Move down on the last row", async () => {
    const id = await seedPush();
    await renderEdit(id);
    moveUp(0);
    moveDown(2);
    expect(rowNames()).toEqual(["Bench Press", "Back Squat", "Barbell Row"]);
  });

  it("saves the new order as positions", async () => {
    const id = await seedPush();
    await renderEdit(id);
    moveDown(0); // squat, bench, row
    moveDown(1); // squat, row, bench
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    const r = (await getRoutine(id))!;
    expect(r.exercises.map((e) => [e.exercise_id, e.position, e.target_sets, e.target_reps])).toEqual([
      ["squat", 0, 3, "8-12"],
      ["row", 1, 2, "10"],
      ["bench", 2, 4, "5-8"],
    ]);
  });

  it("reorders before the first save of a new routine", async () => {
    render(<RoutineEditor />);
    fireEvent.change(nameInput(), { target: { value: "Pull" } });
    addSquatAndRow();
    moveUp(1);
    expect(rowNames()).toEqual(["Barbell Row", "Back Squat"]);
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    const [r] = await listRoutines();
    expect(r.exercises.map((e) => e.exercise_id)).toEqual(["row", "squat"]);
  });
});

describe("RoutineEditor: Belongs to (split day link)", () => {
  const SPLIT = {
    name: "PPL",
    days: [
      { id: "push", name: "Push", muscles: ["Chest", "Shoulders", "Triceps"] as Exercise["muscle_groups"] },
      { id: "legs", name: "Legs", muscles: [] as Exercise["muscle_groups"] },
    ],
  };
  const belongsTo = () => screen.getByRole("combobox", { name: "Belongs to" }) as HTMLSelectElement;

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("is hidden with no split", async () => {
    render(<RoutineEditor />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("combobox", { name: "Belongs to" })).not.toBeInTheDocument();
  });

  it("offers None plus each split day by name, defaulting to None", async () => {
    await saveSplit(SPLIT);
    render(<RoutineEditor />);
    await waitFor(() => belongsTo());
    expect(within(belongsTo()).getAllByRole("option").map((o) => o.textContent)).toEqual(["None", "Push", "Legs"]);
    expect(belongsTo().value).toBe("");
    expect(screen.queryByText(/Suggested focus/)).not.toBeInTheDocument();
  });

  it("a new routine from a split day pre-selects it and suggests its muscles without adding exercises", async () => {
    await saveSplit(SPLIT);
    window.history.replaceState(null, "", "/routines/new?day=push");
    render(<RoutineEditor />);
    await waitFor(() => expect(belongsTo().value).toBe("push"));
    expect(screen.getByText("Suggested focus: Chest, Shoulders, Triceps")).toBeInTheDocument();
    expect(rows()).toHaveLength(0);

    fireEvent.change(nameInput(), { target: { value: "Push A" } });
    addSquatAndRow();
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    const [r] = await listRoutines();
    expect(r.split_day_id).toBe("push");
  });

  it("ignores a ?day= that is not in the split", async () => {
    await saveSplit(SPLIT);
    window.history.replaceState(null, "", "/routines/new?day=gone");
    render(<RoutineEditor />);
    await waitFor(() => belongsTo());
    expect(belongsTo().value).toBe("");
    fireEvent.change(nameInput(), { target: { value: "X" } });
    addSquatAndRow();
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    const [r] = await listRoutines();
    expect(r.split_day_id).toBeUndefined();
  });

  it("creating with None writes no link", async () => {
    await saveSplit(SPLIT);
    render(<RoutineEditor />);
    await waitFor(() => belongsTo());
    fireEvent.change(nameInput(), { target: { value: "Free" } });
    addSquatAndRow();
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect((await listRoutines())[0].split_day_id).toBeUndefined();
  });

  it("editing shows the stored link and can move or clear it", async () => {
    await saveSplit(SPLIT);
    const id = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench" }], split_day_id: "push" });
    await renderEdit(id);
    await waitFor(() => expect(belongsTo().value).toBe("push"));
    fireEvent.change(belongsTo(), { target: { value: "legs" } });
    expect(screen.queryByText(/Suggested focus/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect((await getRoutine(id))!.split_day_id).toBe("legs");

    cleanup();
    push.mockReset();
    await renderEdit(id);
    await waitFor(() => expect(belongsTo().value).toBe("legs"));
    fireEvent.change(belongsTo(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    const r = (await getRoutine(id))!;
    expect(r.split_day_id).toBeNull();
    expect(r.exercises.map((e) => e.exercise_id)).toEqual(["bench"]);
  });

  it("saving other edits leaves the link alone", async () => {
    await saveSplit(SPLIT);
    const id = await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench" }], split_day_id: "push" });
    await renderEdit(id);
    await waitFor(() => expect(belongsTo().value).toBe("push"));
    fireEvent.change(nameInput(), { target: { value: "Push B" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    const r = (await getRoutine(id))!;
    expect(r.name).toBe("Push B");
    expect(r.split_day_id).toBe("push");
  });

  it("dayFromSearch reads ?day=", () => {
    expect(dayFromSearch("?day=abc")).toBe("abc");
    expect(dayFromSearch("?day=%20")).toBeNull();
    expect(dayFromSearch("")).toBeNull();
  });
});
