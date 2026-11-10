// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { db } from "../offline/db";
import { createRoutine } from "../routines";
import { toggleFavorite, usePreferred } from "../favorites";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("usePreferred", () => {
  it("is undefined until loaded, then empty for a new user", async () => {
    const { result } = renderHook(() => usePreferred());
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("returns stars first, then exercises in the user's routines, with no duplicates", async () => {
    await toggleFavorite("squat");
    await createRoutine({ name: "Push", favorite: false, exercises: [{ exercise_id: "bench" }, { exercise_id: "squat" }] });
    const { result } = renderHook(() => usePreferred());
    await waitFor(() => expect(result.current).toEqual(["squat", "bench"]));
  });

  it("counts routines that were never starred (older or synced from another device)", async () => {
    // Written straight to the table, the way a sync pull does: no favourites entry exists.
    await db.routines.put({ id: "r1", name: "Legs", day_label: null, source: "manual", kind: "routine", source_url: null, platform: null, thumbnail_url: null, creator: null, notes: null, created_at: "2026-01-01T00:00:00.000Z" });
    await db.routine_exercises.put({ id: "e1", routine_id: "r1", exercise_id: "leg-press", position: 0, target_sets: 3, target_reps: "8-12" });
    const { result } = renderHook(() => usePreferred());
    await waitFor(() => expect(result.current).toEqual(["leg-press"]));
  });

  it("ignores catch-up routines so the plan's own picks never feed back", async () => {
    await createRoutine({ name: "Catch up", source: "ai", favorite: false, exercises: [{ exercise_id: "a" }] });
    await createRoutine({ name: "Push + catch up", source: "ai", favorite: false, exercises: [{ exercise_id: "b" }, { exercise_id: "c" }] });
    await createRoutine({ name: "Push", exercises: [{ exercise_id: "bench" }] });
    const { result } = renderHook(() => usePreferred());
    await waitFor(() => expect(result.current).toEqual(["bench"]));
  });

  it("updates when a routine changes", async () => {
    const { result } = renderHook(() => usePreferred());
    await waitFor(() => expect(result.current).toEqual([]));
    await createRoutine({ name: "Pull", favorite: false, exercises: [{ exercise_id: "row" }] });
    await waitFor(() => expect(result.current).toEqual(["row"]));
  });
});
