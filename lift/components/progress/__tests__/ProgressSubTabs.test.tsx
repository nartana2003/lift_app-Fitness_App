// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { db } from "@/lib/offline/db";

// The sub-tab bar on the Progress page. The panels are stubbed so this test
// only exercises switching; panels have their own coverage.
const replace = vi.fn();
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/progress",
  useSearchParams: () => search,
}));
vi.mock("@/components/progress/VolumeChart", () => ({ VolumeChart: () => <div>volume-chart</div> }));
vi.mock("@/components/progress/MonthCalendar", () => ({ MonthCalendar: () => <div>month-calendar</div> }));
vi.mock("@/components/progress/PeriodCard", () => ({ PeriodCard: () => <div>period-card</div> }));
vi.mock("@/components/goals/WeeklyGoalsCard", () => ({ WeeklyGoalsCard: () => <div>weekly-goals</div> }));
vi.mock("@/components/progress/PlateauCard", () => ({ PlateauCard: () => <div>plateau-card</div> }));
vi.mock("@/components/progress/ExercisesTab", () => ({ ExercisesTab: () => <div>exercises-tab</div> }));
vi.mock("@/components/progress/MeasurementsTab", () => ({ MeasurementsTab: () => <div>measurements-tab</div> }));
vi.mock("@/components/progress/PhotosTab", () => ({ PhotosTab: () => <div>photos-tab</div> }));

import ProgressPage from "@/app/(tabs)/progress/page";

const TAB_LABELS = ["Progress", "Exercises", "Measurements", "Photos"];
const tabButtons = () => screen.getAllByRole("button").filter((b) => TAB_LABELS.includes(b.textContent ?? ""));
const isActive = (name: string) => screen.getByRole("button", { name }).className.includes("border-accent");

function renderAt(tab?: string) {
  search = new URLSearchParams(tab ? { tab } : {});
  return render(<ProgressPage />);
}

beforeEach(async () => {
  replace.mockReset();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("Progress sub-tabs", () => {
  it("shows the four sub-tabs in order", async () => {
    renderAt();
    expect(await screen.findByRole("heading", { name: "Progress" })).toBeInTheDocument();
    expect(tabButtons().map((b) => b.textContent)).toEqual(TAB_LABELS);
  });

  it("defaults to the Progress sub-tab with chart, calendar and cards, and no heatmap", async () => {
    renderAt();
    expect(await screen.findByText("month-calendar")).toBeInTheDocument();
    for (const t of ["volume-chart", "period-card", "weekly-goals", "plateau-card"]) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    expect(isActive("Progress")).toBe(true);
    expect(isActive("Exercises")).toBe(false);
    expect(screen.queryByText("exercises-tab")).not.toBeInTheDocument();
    expect(document.body.textContent?.toLowerCase()).not.toContain("heatmap");
  });

  it.each([
    ["exercises", "Exercises", "exercises-tab"],
    ["measurements", "Measurements", "measurements-tab"],
    ["photos", "Photos", "photos-tab"],
  ])("?tab=%s opens the %s sub-tab", async (key, label, panel) => {
    renderAt(key);
    expect(await screen.findByText(panel)).toBeInTheDocument();
    expect(isActive(label)).toBe(true);
    expect(isActive("Progress")).toBe(false);
    expect(screen.queryByText("month-calendar")).not.toBeInTheDocument();
  });

  it("falls back to Progress for an unknown tab", async () => {
    renderAt("nonsense");
    expect(await screen.findByText("month-calendar")).toBeInTheDocument();
    expect(isActive("Progress")).toBe(true);
  });

  it("tapping a sub-tab replaces the URL without scrolling", async () => {
    renderAt();
    await screen.findByText("month-calendar");
    fireEvent.click(screen.getByRole("button", { name: "Measurements" }));
    expect(replace).toHaveBeenCalledWith("/progress?tab=measurements", { scroll: false });
    fireEvent.click(screen.getByRole("button", { name: "Exercises" }));
    expect(replace).toHaveBeenLastCalledWith("/progress?tab=exercises", { scroll: false });
    fireEvent.click(screen.getByRole("button", { name: "Photos" }));
    expect(replace).toHaveBeenLastCalledWith("/progress?tab=photos", { scroll: false });
  });

  it("tapping Progress goes back to the bare /progress URL", async () => {
    renderAt("photos");
    await screen.findByText("photos-tab");
    fireEvent.click(screen.getByRole("button", { name: "Progress" }));
    expect(replace).toHaveBeenCalledWith("/progress", { scroll: false });
  });
});
