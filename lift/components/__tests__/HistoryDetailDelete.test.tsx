// @vitest-environment jsdom
import { Suspense } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import WorkoutDetailPage from "@/app/(tabs)/history/[id]/page";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, back: vi.fn() }),
  usePathname: () => "/history/w1",
}));

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ json: () => Promise.resolve([]) })));
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(async () => {
  replace.mockReset();
  await Promise.all(db.tables.map((t) => t.clear()));
  const start = new Date(Date.now() - 864e5);
  await db.workouts.put({
    id: "w1",
    started_at: start.toISOString(),
    ended_at: new Date(start.getTime() + 45 * 60e3).toISOString(),
    notes: "Push day",
    routine_id: null,
  });
});

async function open() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <WorkoutDetailPage params={Promise.resolve({ id: "w1" })} />
      </Suspense>,
    );
  });
  return screen.findByRole("button", { name: "Delete workout" });
}

describe("workout detail: Delete workout", () => {
  it("is a real bordered button with a trash icon", async () => {
    const btn = await open();
    expect(btn.className).toContain("border");
    expect(btn.className).toContain("rounded-xl");
    expect(btn.querySelector("svg")).not.toBeNull();
  });

  it("deletes the workout and returns home when confirmed", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.click(await open());
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(await db.workouts.get("w1")).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("keeps the workout when the confirmation is declined", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    fireEvent.click(await open());
    expect(replace).not.toHaveBeenCalled();
    expect(await db.workouts.get("w1")).toBeDefined();
    vi.unstubAllGlobals();
  });
});
