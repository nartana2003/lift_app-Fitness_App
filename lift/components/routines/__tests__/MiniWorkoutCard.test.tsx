// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db, type RoutineExerciseRow, type RoutineRow } from "@/lib/offline/db";
import { dayKey, getDay, planDay } from "@/lib/planner";
import { getRoutine, listRoutines } from "@/lib/routines";
import { finishWorkout, getActive, startWorkout, toggleSetDone, updateSet } from "@/lib/workout";
import { allWorkouts } from "@/lib/history";
import { periodStats } from "@/lib/progress";
import { addDays, goalProgress, startOfWeek } from "@/lib/stats";
import { createCustomExercise } from "@/lib/customExercises";
import ExerciseDetail from "@/app/(tabs)/exercises/[id]/page";
import {
  ADD_MESSAGES,
  MiniWorkoutCard,
  addMiniToToday,
  isTodayCopy,
  TODAY_COPY_NOTE,
  NO_FILTER,
  PLATFORMS,
  filterRoutines,
  musclesIn,
  platformLabel,
  platformsIn,
  safeHttpUrl,
  safeThumbnailUrl,
} from "@/components/routines/MiniWorkoutCard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { RoutineList } from "@/components/routines/RoutineList";

// ---------- helpers ----------

const ex = (id: string, name: string, muscle: string) => ({
  id,
  name,
  muscle_groups: [muscle],
  secondary_groups: [],
  equipment: "Bodyweight",
  category: "strength",
  mechanic: null,
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
});
const CATALOGUE = [ex("pushup", "Push-Up", "Chest"), ex("crunch", "Crunch", "Abs/Core"), ex("squat", "Bodyweight Squat", "Quads")];

const LINK = "https://www.tiktok.com/@coach/video/123";

function routine(id: string, name: string, over: Partial<RoutineRow> = {}): RoutineRow {
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
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}
const mini = (id: string, name: string, over: Partial<RoutineRow> = {}) =>
  routine(id, name, { source: "social", kind: "mini", source_url: LINK, platform: "tiktok", ...over });

const rex = (routineId: string, exerciseId: string, position = 0): RoutineExerciseRow => ({
  id: `${routineId}-${exerciseId}`,
  routine_id: routineId,
  exercise_id: exerciseId,
  position,
  target_sets: 3,
  target_reps: "10",
});

async function seed(rows: RoutineRow[], exercises: RoutineExerciseRow[]) {
  await db.routines.bulkPut(rows);
  await db.routine_exercises.bulkPut(exercises);
}

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

// ---------- pure helpers ----------

describe("platformLabel", () => {
  it("gives plain text names for each platform", () => {
    expect(platformLabel("tiktok")).toBe("TikTok");
    expect(platformLabel("instagram")).toBe("Instagram");
    expect(platformLabel("youtube")).toBe("YouTube");
    expect(PLATFORMS.map(platformLabel)).toEqual(["TikTok", "Instagram", "YouTube"]);
  });

  it("is null for none or an unknown value", () => {
    expect(platformLabel(null)).toBeNull();
    expect(platformLabel(undefined)).toBeNull();
    expect(platformLabel("vimeo")).toBeNull();
    expect(platformLabel("toString")).toBeNull();
  });
});

describe("safeHttpUrl / safeThumbnailUrl", () => {
  it("keeps http(s) links", () => {
    expect(safeHttpUrl(LINK)).toBe(LINK);
    expect(safeHttpUrl(" https://youtu.be/xyz ")).toBe("https://youtu.be/xyz");
    expect(safeHttpUrl("http://example.com/a")).toBe("http://example.com/a");
  });

  it("drops other schemes, junk and empties", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpUrl("not a link")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });

  it("loads thumbnails over https only", () => {
    expect(safeThumbnailUrl("https://p16.example.com/t.jpg")).toBe("https://p16.example.com/t.jpg");
    expect(safeThumbnailUrl("http://p16.example.com/t.jpg")).toBeNull();
    expect(safeThumbnailUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("filterRoutines", () => {
  const list = [
    { id: "a", platform: null, m: ["Chest"] },
    { id: "b", platform: "tiktok" as const, m: ["Abs/Core"] },
    { id: "c", platform: "youtube" as const, m: ["Abs/Core", "Quads"] },
  ];
  const musclesOf = (r: (typeof list)[number]) => r.m;

  it("keeps everything with no filter, in order", () => {
    expect(filterRoutines(list, NO_FILTER, musclesOf).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("filters by platform, by muscle and by both", () => {
    expect(filterRoutines(list, { platform: "tiktok", muscle: null }, musclesOf).map((r) => r.id)).toEqual(["b"]);
    expect(filterRoutines(list, { platform: null, muscle: "Abs/Core" }, musclesOf).map((r) => r.id)).toEqual(["b", "c"]);
    expect(filterRoutines(list, { platform: "youtube", muscle: "Quads" }, musclesOf).map((r) => r.id)).toEqual(["c"]);
    expect(filterRoutines(list, { platform: "instagram", muscle: null }, musclesOf)).toEqual([]);
  });

  it("never changes the input", () => {
    const before = JSON.stringify(list);
    filterRoutines(list, { platform: "tiktok", muscle: "Chest" }, musclesOf);
    expect(JSON.stringify(list)).toBe(before);
  });

  it("lists present platforms in chip order and muscles sorted", () => {
    expect(platformsIn(list)).toEqual(["tiktok", "youtube"]);
    expect(platformsIn([{ platform: null }])).toEqual([]);
    expect(musclesIn(list, musclesOf)).toEqual(["Abs/Core", "Chest", "Quads"]);
  });
});

// ---------- card ----------

describe("MiniWorkoutCard", () => {
  it("shows the thumbnail, platform label, creator and an original link that opens in a new tab", () => {
    render(
      <MiniWorkoutCard
        routine={mini("m1", "Core 10", { thumbnail_url: "https://p16.example.com/t.jpg", creator: "@coach" })}
        exerciseCount={2}
        muscles={["Abs/Core"]}
      />,
    );
    const card = screen.getByRole("article", { name: "Mini workout: Core 10" });
    expect(within(card).getByRole("img", { name: "Core 10 video thumbnail" })).toHaveAttribute("src", "https://p16.example.com/t.jpg");
    expect(within(card).getByText("TikTok · @coach")).toBeInTheDocument();
    expect(within(card).getByText("2 exercises")).toBeInTheDocument();
    expect(within(card).getByText("Abs/Core")).toBeInTheDocument();
    const link = within(card).getByRole("link", { name: "Open original on TikTok" });
    expect(link).toHaveAttribute("href", LINK);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(within(card).getByRole("link", { name: "Edit routine" })).toHaveAttribute("href", "/routines/m1");
  });

  it("shows a plain placeholder with no thumbnail and no link for an unsafe url", () => {
    render(
      <MiniWorkoutCard
        routine={mini("m2", "Abs", { thumbnail_url: "javascript:alert(1)", source_url: "javascript:alert(1)", platform: null })}
        exerciseCount={1}
        muscles={[]}
      />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByTestId("mini-thumb-placeholder")).toHaveTextContent("Mini workout");
    expect(screen.queryByRole("link", { name: /Open original/ })).not.toBeInTheDocument();
    expect(screen.getByText("1 exercise")).toBeInTheDocument();
  });

  it("uses no emojis or brand artwork", () => {
    const { container } = render(
      <MiniWorkoutCard routine={mini("m3", "Core", { creator: "@coach" })} exerciseCount={1} muscles={["Abs/Core"]} onStart={() => {}} />,
    );
    expect(container.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("calls onStart and shows a busy state", () => {
    const onStart = vi.fn();
    const { rerender } = render(<MiniWorkoutCard routine={mini("m4", "Core")} exerciseCount={1} muscles={[]} onStart={onStart} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    rerender(<MiniWorkoutCard routine={mini("m4", "Core")} exerciseCount={1} muscles={[]} busy onStart={onStart} />);
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
  });
});

// ---------- routine list ----------

describe("RoutineList with mini workouts and filters", () => {
  async function seedMixed() {
    await seed(
      [
        routine("r1", "Push day"),
        mini("m1", "TikTok abs", { creator: "@coach" }),
        mini("m2", "YouTube legs", { platform: "youtube", source_url: "https://youtu.be/xyz" }),
      ],
      [rex("r1", "pushup"), rex("m1", "crunch"), rex("m2", "squat"), rex("m2", "crunch", 1)],
    );
  }

  it("renders mini routines as cards next to normal routines, with the existing controls unchanged", async () => {
    await seedMixed();
    render(<RoutineList />);
    expect(await screen.findByRole("article", { name: "Mini workout: TikTok abs" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Mini workout: YouTube legs" })).toBeInTheDocument();
    expect(screen.getByText("Push day")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Mini workout: Push day" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New routine" })).toHaveAttribute("href", "/routines/new");
    expect(screen.getByText("Generate 3-day plan")).toBeInTheDocument();
    expect(screen.getByText("Save from link")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Start" })).toHaveLength(3);
  });

  it("filters by platform and muscle without deleting or editing routines", async () => {
    await seedMixed();
    const before = await db.routines.toArray();
    const beforeEx = await db.routine_exercises.toArray();
    render(<RoutineList />);
    await screen.findByRole("article", { name: "Mini workout: TikTok abs" });

    const platforms = screen.getByRole("group", { name: "Filter by platform" });
    expect(within(platforms).getAllByRole("button").map((b) => b.textContent)).toEqual(["All sources", "TikTok", "YouTube"]);
    fireEvent.click(within(platforms).getByRole("button", { name: "TikTok" }));
    expect(within(platforms).getByRole("button", { name: "TikTok" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("article", { name: "Mini workout: TikTok abs" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Mini workout: YouTube legs" })).not.toBeInTheDocument();
    expect(screen.queryByText("Push day")).not.toBeInTheDocument();

    fireEvent.click(within(platforms).getByRole("button", { name: "All sources" }));
    const muscles = await screen.findByRole("group", { name: "Filter by muscle" });
    await waitFor(() => expect(within(muscles).getByRole("button", { name: "Quads" })).toBeInTheDocument());
    fireEvent.click(within(muscles).getByRole("button", { name: "Quads" }));
    expect(screen.getByRole("article", { name: "Mini workout: YouTube legs" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Mini workout: TikTok abs" })).not.toBeInTheDocument();
    expect(screen.queryByText("Push day")).not.toBeInTheDocument();

    // Tapping the chosen chip again clears it.
    fireEvent.click(within(muscles).getByRole("button", { name: "Quads" }));
    expect(screen.getByText("Push day")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);

    expect(await db.routines.toArray()).toEqual(before);
    expect(await db.routine_exercises.toArray()).toEqual(beforeEx);
  });

  it("shows a plain message and Clear filters when nothing matches", async () => {
    await seedMixed();
    render(<RoutineList />);
    await screen.findByRole("article", { name: "Mini workout: TikTok abs" });
    const muscles = screen.getByRole("group", { name: "Filter by muscle" });
    await waitFor(() => expect(within(muscles).getByRole("button", { name: "Chest" })).toBeInTheDocument());
    fireEvent.click(within(muscles).getByRole("button", { name: "Chest" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Filter by platform" })).getByRole("button", { name: "TikTok" }));
    expect(screen.getByText("No routines match these filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Push day")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("shows no platform chips when no routine came from a link", async () => {
    await seed([routine("r1", "Push day")], [rex("r1", "pushup")]);
    render(<RoutineList />);
    expect(await screen.findByText("Push day")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Filter by platform" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("shows no filters with no routines", async () => {
    render(<RoutineList />);
    expect(await screen.findByRole("link", { name: "New routine" })).toBeInTheDocument();
    expect(screen.queryByText("No routines yet.")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Filter by platform" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Filter by muscle" })).not.toBeInTheDocument();
  });
});

// ---------- SOC-05: start on its own, Add to today's workout ----------

const today = () => dayKey(new Date());

describe("addMiniToToday", () => {
  async function seedMini() {
    await seed([mini("m1", "Core 10")], [rex("m1", "crunch"), rex("m1", "pushup", 1)]);
  }

  it("appends the mini's exercises to the running workout, skipping ones already in it", async () => {
    await seedMini();
    await startWorkout({ name: "Push", exercises: [{ exercise_id: "pushup" }] });
    expect(await addMiniToToday("m1")).toBe(ADD_MESSAGES.workout);
    const w = (await getActive())!;
    expect(w.name).toBe("Push");
    expect(w.exercises.map((e) => e.exercise_id)).toEqual(["pushup", "crunch"]);
    expect(await addMiniToToday("m1")).toBe(ADD_MESSAGES.inWorkout);
    expect((await getActive())!.exercises).toHaveLength(2);
    expect(await getDay(today())).toBeUndefined();
  });

  it("plans the mini on today when nothing is planned and no workout is running", async () => {
    await seedMini();
    expect(await addMiniToToday("m1")).toBe(ADD_MESSAGES.planned);
    const day = (await getDay(today()))!;
    expect(day.routine_id).toBe("m1");
    expect(day.status).toBe("planned");
    expect(await addMiniToToday("m1")).toBe(ADD_MESSAGES.already);
  });

  it("appends to today's planned routine as a copy, leaving the saved routine unchanged", async () => {
    await seedMini();
    await seed([routine("r1", "Push day")], [rex("r1", "pushup"), rex("r1", "squat", 1)]);
    await planDay(today(), "r1");
    const before = await getRoutine("r1");

    expect(await addMiniToToday("m1")).toBe("Added to Push day today.");
    const day = (await getDay(today()))!;
    expect(day.routine_id).not.toBe("r1");
    const combined = (await getRoutine(day.routine_id!))!;
    expect(combined.name).toBe("Push day + Core 10");
    expect(combined.kind).toBe("routine");
    expect(combined.exercises.map((e) => e.exercise_id)).toEqual(["pushup", "squat", "crunch"]);
    expect(await getRoutine("r1")).toEqual(before);
    expect(await getRoutine("m1")).toBeTruthy();
  });

  it("leaves a finished or skipped day alone", async () => {
    await seedMini();
    await planDay(today(), "m1");
    const cur = (await getDay(today()))!;
    await db.planned_days.put({ ...cur, routine_id: null, status: "skipped", skip_reason: "busy" });
    expect(await addMiniToToday("m1")).toBe(ADD_MESSAGES.closed);
    expect((await getDay(today()))!.status).toBe("skipped");
  });

  it("leaves a moved day alone, with a message that covers done, skipped and moved", async () => {
    expect(ADD_MESSAGES.closed).toBe("Today's workout is already done, skipped or moved.");
    await seedMini();
    await seed([routine("r1", "Push day")], [rex("r1", "pushup")]);
    await planDay(today(), "r1");
    const cur = (await getDay(today()))!;
    await db.planned_days.put({ ...cur, status: "moved", skip_reason: "busy", moved_to: "2099-01-01" });
    const before = await db.planned_days.toArray();
    const routinesBefore = await db.routines.count();
    expect(await addMiniToToday("m1")).toBe("Today's workout is already done, skipped or moved.");
    expect(await db.planned_days.toArray()).toEqual(before);
    expect(await db.routines.count()).toBe(routinesBefore);
  });

  it("marks the copy and reuses it, so two minis on one day leave exactly one extra routine", async () => {
    await seed(
      [routine("r1", "Push day"), mini("m1", "Core 10"), mini("m2", "Abs")],
      [rex("r1", "pushup"), rex("m1", "crunch"), rex("m1", "pushup", 1), rex("m2", "squat"), rex("m2", "crunch", 1)],
    );
    await planDay(today(), "r1");
    const before = await getRoutine("r1");
    const count = (await listRoutines()).length;

    expect(await addMiniToToday("m1")).toBe("Added to Push day today.");
    const copyId = (await getDay(today()))!.routine_id!;
    const copy = (await getRoutine(copyId))!;
    expect(isTodayCopy(copy)).toBe(true);
    expect(copy.notes?.startsWith(TODAY_COPY_NOTE)).toBe(true);

    expect(await addMiniToToday("m2")).toBe("Added to Push day + Core 10 today.");
    expect((await listRoutines()).length).toBe(count + 1);
    expect((await getDay(today()))!.routine_id).toBe(copyId);
    const after = (await getRoutine(copyId))!;
    expect(after.name).toBe("Push day + Core 10 + Abs");
    expect(after.exercises.map((e) => e.exercise_id)).toEqual(["pushup", "crunch", "squat"]);
    expect(await getRoutine("r1")).toEqual(before);
    expect(isTodayCopy(before!)).toBe(false);

    // Adding the same mini again changes nothing.
    expect(await addMiniToToday("m2")).toBe(ADD_MESSAGES.already);
    expect((await listRoutines()).length).toBe(count + 1);
  });

  it("does nothing for a missing or empty mini workout", async () => {
    await seed([mini("m2", "Empty")], []);
    expect(await addMiniToToday("m2")).toBe(ADD_MESSAGES.empty);
    expect(await addMiniToToday("nope")).toBe(ADD_MESSAGES.empty);
    expect(await getDay(today())).toBeUndefined();
  });
});

describe("MiniWorkoutCard Add to today's workout", () => {
  it("adds to today and shows a plain message", async () => {
    await seed([mini("m1", "Core 10")], [rex("m1", "crunch")]);
    const { container } = render(<MiniWorkoutCard routine={mini("m1", "Core 10")} exerciseCount={1} muscles={["Abs/Core"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to today's workout" }));
    expect(await screen.findByText(ADD_MESSAGES.planned)).toHaveAttribute("role", "status");
    expect((await getDay(today()))!.routine_id).toBe("m1");
    expect(container.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("is disabled while the card is starting", () => {
    render(<MiniWorkoutCard routine={mini("m1", "Core 10")} exerciseCount={1} muscles={[]} busy onStart={() => {}} />);
    expect(screen.getByRole("button", { name: "Add to today's workout" })).toBeDisabled();
  });

  it("starts on its own from the routine list with the existing start flow", async () => {
    await seed([mini("m1", "Core 10")], [rex("m1", "crunch"), rex("m1", "pushup", 1)]);
    render(<RoutineList />);
    const card = await screen.findByRole("article", { name: "Mini workout: Core 10" });
    fireEvent.click(within(card).getByRole("button", { name: "Start" }));
    await waitFor(async () => expect(await getActive()).toBeTruthy());
    const w = (await getActive())!;
    expect(w.routine_id).toBe("m1");
    expect(w.name).toBe("Core 10");
    expect(w.exercises.map((e) => [e.exercise_id, e.sets.length, e.target_reps])).toEqual([
      ["crunch", 3, "10"],
      ["pushup", 3, "10"],
    ]);
  });
});

describe("mini workout sets and weekly muscle targets", () => {
  it("count like any other session", async () => {
    await seed([mini("m1", "Core 10")], [rex("m1", "crunch")]);
    const r = (await getRoutine("m1"))!;
    await startWorkout({
      name: r.name,
      routineId: r.id,
      exercises: r.exercises.map((e) => ({ exercise_id: e.exercise_id, target_sets: e.target_sets, target_reps: e.target_reps })),
    });
    const ex = (await getActive())!.exercises[0];
    for (const s of ex.sets) {
      await updateSet(ex.id, s.id, { reps: 15, weight: 0 });
      await toggleSetDone(ex.id, s.id);
    }
    await finishWorkout();

    const from = startOfWeek(new Date(), 1);
    const muscleOf = (id: string) => CATALOGUE.find((e) => e.id === id)?.muscle_groups ?? [];
    const stats = periodStats(await allWorkouts(), from, addDays(from, 7), muscleOf);
    expect(stats.sets_by_muscle["Abs/Core"]).toBe(3);
    const abs = goalProgress(stats.sets_by_muscle, { "Abs/Core": 10 }).find((g) => g.muscle === "Abs/Core")!;
    expect(abs).toMatchObject({ done: 3, remaining: 7, status: "partial" });
  });
});

describe("Watch original on custom exercises from a video link", () => {
  async function renderPage(id: string) {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <ExerciseDetail params={Promise.resolve({ id })} />
        </Suspense>,
      );
    });
  }

  it("shows a Watch original link that opens the video in a new tab", async () => {
    const ex = await createCustomExercise({ name: "Hollow hold", muscle_groups: ["Abs/Core"], video_url: LINK });
    await renderPage(ex.id);
    const link = await screen.findByRole("link", { name: /Watch original TikTok video/ });
    expect(link).toHaveAttribute("href", LINK);
    expect(screen.queryByRole("link", { name: /Watch on TikTok/ })).not.toBeInTheDocument();
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("names the platform on the original video link", async () => {
    const ex = await createCustomExercise({ name: "Dead hang", video_url: "https://www.youtube.com/watch?v=abc" });
    await renderPage(ex.id);
    expect(await screen.findByRole("link", { name: /Watch original YouTube video/ })).toBeInTheDocument();
  });

  it("deletes a custom exercise after confirming", async () => {
    const ex = await createCustomExercise({ name: "Hollow hold", muscle_groups: ["Abs/Core"] });
    await renderPage(ex.id);
    fireEvent.click(await screen.findByRole("button", { name: "Delete exercise" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    await waitFor(async () => expect(await db.custom_exercises.get(ex.id)).toBeUndefined());
  });

  it("shows no link for an unsafe video url", async () => {
    const bad = await createCustomExercise({ name: "Bad link", video_url: "javascript:alert(1)" });
    await renderPage(bad.id);
    expect(await screen.findByRole("heading", { name: "Bad link" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Watch the original video/ })).not.toBeInTheDocument();
  });
});
