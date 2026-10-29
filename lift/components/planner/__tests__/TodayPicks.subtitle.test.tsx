// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import type { Exercise } from "@/lib/exercises";
import type { MuscleGroup } from "@/lib/muscles";
import { saveSplit, type Split } from "@/lib/splits";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const ex = (id: string, name: string, muscles: MuscleGroup[]): Exercise => ({
  id,
  name,
  muscle_groups: muscles,
  secondary_groups: [],
  equipment: "Dumbbell",
  category: "strength",
  mechanic: "isolation",
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
});

const CATALOGUE = [ex("fly", "Dumbbell Fly", ["Chest"]), ex("kick", "Triceps Kickback", ["Triceps"])];

vi.mock("@/lib/catalogue", () => ({
  useCatalogue: () => ({ loading: false, exercises: CATALOGUE, get: (id: string) => CATALOGUE.find((e) => e.id === id) }),
}));

import { TodayPicks, picksSubtitle } from "@/components/planner/TodayPicks";

const PUSH: Split = { name: "Push", days: [{ name: "Push", muscles: ["Chest", "Triceps"] }] };
const EMPTY_DAY: Split = { name: "Blank", days: [{ name: "Rest", muscles: [] }] };

describe("picksSubtitle", () => {
  it("hints at starring when every muscle has an empty pool", () => {
    expect(picksSubtitle("Push", 0, [0, 0])).toBe("Push · star exercises to get picks");
  });

  it("keeps the count when picks exist but are all unticked", () => {
    expect(picksSubtitle("Push", 0, [2, 0])).toBe("Push · 0 exercises");
  });

  it("keeps the count for a day with no muscles", () => {
    expect(picksSubtitle("Rest", 0, [])).toBe("Rest · 0 exercises");
  });

  it("counts ticked picks, singular and plural", () => {
    expect(picksSubtitle("Push", 1, [1, 0])).toBe("Push · 1 exercise");
    expect(picksSubtitle("Push", 3, [2, 1])).toBe("Push · 3 exercises");
  });
});

describe("TodayPicks subtitle", () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it("nothing starred: collapsed subtitle hints at starring", async () => {
    await saveSplit(PUSH);
    render(<TodayPicks />);
    expect(await screen.findByText("Push · star exercises to get picks")).toBeInTheDocument();
    expect(screen.queryByText("Push · 0 exercises")).toBeNull();
  });

  it("some starred: subtitle counts picks", async () => {
    await saveSplit(PUSH);
    await db.meta.put({ key: "favorites", value: ["fly"] });
    render(<TodayPicks />);
    expect(await screen.findByText("Push · 1 exercise")).toBeInTheDocument();
  });

  it("unticking every pick keeps the 0 exercises wording", async () => {
    await saveSplit(PUSH);
    await db.meta.put({ key: "favorites", value: ["fly", "kick"] });
    render(<TodayPicks />);
    const header = await screen.findByRole("button", { name: /Push · 2 exercises/ });
    fireEvent.click(header);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Dumbbell Fly" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Triceps Kickback" }));
    fireEvent.click(header);
    expect(await screen.findByText("Push · 0 exercises")).toBeInTheDocument();
    expect(screen.queryByText(/star exercises to get picks/)).toBeNull();
  });

  it("a day with no muscles keeps the 0 exercises wording", async () => {
    await saveSplit(EMPTY_DAY);
    render(<TodayPicks />);
    expect(await screen.findByText("Rest · 0 exercises")).toBeInTheDocument();
  });
});
