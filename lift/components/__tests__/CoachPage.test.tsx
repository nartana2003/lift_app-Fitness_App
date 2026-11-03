// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { saveGoals } from "@/lib/goals";
import { db } from "@/lib/offline/db";
import { saveSplit } from "@/lib/splits";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/coach",
  useSearchParams: () => new URLSearchParams(),
}));

import CoachPage from "@/app/(tabs)/coach/page";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Coach page", () => {
  it("has the Coach heading and the Goals, Priorities and limits, Build a split, My split and Ask the coach cards, all collapsed", () => {
    render(<CoachPage />);
    expect(screen.getByRole("heading", { name: "Coach" })).toBeInTheDocument();
    for (const name of ["Goals", "Priorities and limits", "Build a split", "My split", "Ask the coach"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("summarises the saved goals and split while collapsed", async () => {
    await saveSplit({ name: "PPL", days: [{ name: "Push", muscles: ["Chest"] }, { name: "Pull", muscles: ["Back"] }] });
    render(<CoachPage />);
    expect(screen.getByRole("button", { name: /^Goals/ })).toHaveTextContent("Build muscle · 3×/week");
    await waitFor(() => expect(screen.getByRole("button", { name: /^My split/ })).toHaveTextContent("PPL · Push · Pull"));
  });

  it("Build a split holds the Set up with coach wizard, which is no longer inside Goals", () => {
    render(<CoachPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Goals/ }));
    expect(screen.queryByRole("button", { name: "Set up with coach" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Build a split/ }));
    fireEvent.click(screen.getByRole("button", { name: "Set up with coach" }));
    expect(screen.getByRole("region", { name: "Coach setup" })).toBeInTheDocument();
  });

  it("Priorities and limits opens the goal boxes, muscle priorities and limit chips, and summarises them", async () => {
    await saveGoals({ priorities: { Biceps: "high", "Abs/Core": "medium" }, limitations: ["Knee"] });
    render(<CoachPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Priorities and limits/ })).toHaveTextContent("1 high priority · Knee"));
    fireEvent.click(screen.getByRole("button", { name: /^Priorities and limits/ }));
    expect(screen.getByLabelText("Goal 1")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Knee" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("says the split is not set up when there is none", () => {
    render(<CoachPage />);
    expect(screen.getByRole("button", { name: /^My split/ })).toHaveTextContent("Not set up yet");
  });
});
