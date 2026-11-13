// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Exercise } from "@/lib/exercises";
import { loadSwaps, swapKey } from "@/lib/catchUpSwaps";

const { CATALOGUE, state } = vi.hoisted(() => {
  const ex = (id: string, name: string, muscle: string) => ({
    id, name, muscle_groups: [muscle], secondary_groups: [], equipment: "Dumbbell", category: "strength",
    mechanic: null, force: null, level: "beginner", instructions: [], image_urls: [], tiktok_url: "",
  });
  return {
    CATALOGUE: [ex("curl", "Dumbbell Curl", "Biceps"), ex("hammer", "Hammer Curl", "Biceps"), ex("dip", "Bench Dip", "Triceps")] as unknown as Exercise[],
    state: { query: "" },
  };
});

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.query),
  usePathname: () => "/exercises",
}));
vi.mock("@/lib/catalogue", () => {
  const byId = new Map(CATALOGUE.map((e) => [e.id, e]));
  return { useCatalogue: () => ({ loading: false, exercises: CATALOGUE, get: (id: string) => byId.get(id) }) };
});

import ExercisesPage from "@/app/(tabs)/exercises/page";

beforeEach(() => {
  localStorage.clear();
  push.mockReset();
  replace.mockReset();
});

describe("Exercises tab in swap mode", () => {
  it("lists the muscle's exercises, saves the pick and returns to the plan", () => {
    state.query = "m=Biceps&swap=2026-10-17%7Ccurl&week=2026-10-12&back=%2Fprogress";
    render(<ExercisesPage />);
    expect(screen.getByRole("heading", { name: "Pick a replacement" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Choose an exercise to use instead of Dumbbell Curl on");
    expect(screen.queryByText("Bench Dip")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Hammer Curl"));
    expect(loadSwaps("2026-10-12")).toEqual({ [swapKey("2026-10-17", "curl")]: "hammer" });
    expect(push).toHaveBeenCalledWith("/progress");
  });

  it("only returns to a path inside the app", () => {
    state.query = "m=Biceps&swap=2026-10-17%7Ccurl&week=2026-10-12&back=%2F%2Fevil.example";
    render(<ExercisesPage />);
    fireEvent.click(screen.getByText("Hammer Curl"));
    expect(push).toHaveBeenCalledWith("/progress");
  });

  it("without swap params it is the normal browser: cards open the exercise", () => {
    state.query = "m=Biceps";
    render(<ExercisesPage />);
    expect(screen.getByRole("heading", { name: "Exercises" })).toBeInTheDocument();
    expect(screen.getByText("Hammer Curl").closest("a")).toHaveAttribute("href", "/exercises/hammer");
    expect(push).not.toHaveBeenCalled();
  });
});
