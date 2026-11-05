// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { GoalsSection } from "@/components/goals/GoalsSection";
import { defaultTarget, normalizeGoals, type Goals } from "@/lib/goals";

// Issue #3: a changed weekly set target must stick, including quick repeated taps.
const stored = async () => (await db.meta.get("goals"))?.value as Goals | undefined;

beforeEach(async () => {
  cleanup();
  await Promise.all(db.tables.map((t) => t.clear()));
});

async function openTargets() {
  render(<GoalsSection />);
  fireEvent.click(screen.getByRole("button", { name: /Weekly set targets/ }));
  await screen.findByRole("button", { name: "More Chest sets" });
}

describe("GoalsSection weekly set targets", () => {
  it("saves a tapped target and keeps it after remounting", async () => {
    const base = defaultTarget("Chest", normalizeGoals(undefined));
    await openTargets();
    fireEvent.click(screen.getByRole("button", { name: "More Chest sets" }));
    await waitFor(async () => expect((await stored())?.targets.Chest).toBe(base + 1));

    cleanup();
    await openTargets();
    const row = screen.getByRole("button", { name: "More Chest sets" }).closest("li")!;
    await waitFor(() => expect(row).toHaveTextContent(String(base + 1)));
  });

  it("counts every tap when tapped several times in a row", async () => {
    const base = defaultTarget("Chest", normalizeGoals(undefined));
    await openTargets();
    const more = screen.getByRole("button", { name: "More Chest sets" });
    fireEvent.click(more);
    fireEvent.click(more);
    fireEvent.click(more);
    await waitFor(async () => expect((await stored())?.targets.Chest).toBe(base + 3));
  });

  it("reset clears the custom target", async () => {
    await openTargets();
    fireEvent.click(screen.getByRole("button", { name: "More Chest sets" }));
    await waitFor(async () => expect((await stored())?.targets.Chest).toBeDefined());
    fireEvent.click(screen.getAllByRole("button", { name: "reset" })[0]);
    await waitFor(async () => expect((await stored())?.targets.Chest).toBeUndefined());
  });
});
