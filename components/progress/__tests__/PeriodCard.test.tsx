// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { moveDay, planDay, skipDay } from "@/lib/planner";

vi.mock("@/lib/catalogue", () => ({
  useCatalogue: () => ({ loading: false, exercises: [], get: () => undefined }),
  loadCatalogue: async () => ({ list: [], byId: new Map() }),
}));

import { PeriodCard } from "@/components/progress/PeriodCard";

// "Today" is Wednesday 14 Oct 2026 (local); the week starts Monday.
const NOW = new Date(2026, 9, 14, 12, 0, 0);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await Promise.all(db.tables.map((t) => t.clear()));
});

afterEach(() => {
  vi.useRealTimers();
});

const renderCard = () => render(<PeriodCard workouts={[]} unit="kg" weekStart={1} />);
const skipped = () => screen.getByRole("region", { name: "Skipped workouts" });

describe("PeriodCard skip statistics", () => {
  it("keeps the existing snapshot and says when nothing was skipped", async () => {
    renderCard();
    expect(screen.getByRole("heading", { name: "This week" })).toBeInTheDocument();
    expect(screen.getByText("workouts")).toBeInTheDocument();
    expect(await screen.findByText("No skipped or moved workouts this week.")).toBeInTheDocument();
  });

  it("shows skipped and moved counts and the top reasons for the week", async () => {
    await planDay("2026-10-12", "r1");
    await skipDay("2026-10-12", "busy");
    await planDay("2026-10-13", "r2");
    await moveDay("2026-10-13", "2026-10-16", "busy");
    await planDay("2026-10-14", "r3");
    await skipDay("2026-10-14", "tired", "late night");
    // Last week: not in this week's snapshot.
    await skipDay("2026-10-05", "sick");

    renderCard();
    const reasons = await screen.findByRole("list", { name: "Top skip reasons" });
    const items = within(reasons).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Busy / work · 2", "Tired · 1"]);
    const box = skipped();
    expect(within(box).getByText("skipped").previousSibling?.textContent).toBe("2");
    expect(within(box).getByText("moved").previousSibling?.textContent).toBe("1");
  });

  it("switches to the month and counts the whole month", async () => {
    await skipDay("2026-10-05", "sick");
    await skipDay("2026-10-14", "sick");
    await skipDay("2026-09-30", "travel"); // previous month

    renderCard();
    await screen.findByRole("list", { name: "Top skip reasons" });
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(screen.getByRole("heading", { name: "This month" })).toBeInTheDocument();
    const reasons = await screen.findByRole("list", { name: "Top skip reasons" });
    expect(within(reasons).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Sick · 2"]);
    expect(within(skipped()).getByText("skipped").previousSibling?.textContent).toBe("2");
  });
});
