// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  it("has the Coach heading and the Goals, My split and Ask the coach cards, all collapsed", () => {
    render(<CoachPage />);
    expect(screen.getByRole("heading", { name: "Coach" })).toBeInTheDocument();
    for (const name of ["Goals", "My split", "Ask the coach"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("summarises the saved goals and split while collapsed", async () => {
    await saveSplit({ name: "PPL", days: [{ name: "Push", muscles: ["Chest"] }, { name: "Pull", muscles: ["Back"] }] });
    render(<CoachPage />);
    expect(screen.getByRole("button", { name: /^Goals/ })).toHaveTextContent("Build muscle · 3×/week");
    await waitFor(() => expect(screen.getByRole("button", { name: /^My split/ })).toHaveTextContent("PPL · Push · Pull"));
  });

  it("says the split is not set up when there is none", () => {
    render(<CoachPage />);
    expect(screen.getByRole("button", { name: /^My split/ })).toHaveTextContent("Not set up yet");
  });
});
