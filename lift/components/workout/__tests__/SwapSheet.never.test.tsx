// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import type { Exercise } from "@/lib/exercises";
import type { Goals } from "@/lib/goals";
import { SWAP_REASONS } from "@/lib/swap";
import { SwapSheet, resetSwapAi } from "@/components/workout/SwapSheet";

const bench: Exercise = {
  id: "bench",
  name: "Bench Press",
  muscle_groups: ["Chest"],
  secondary_groups: [],
  equipment: "Barbell",
  category: "strength",
  mechanic: "compound",
  force: "push",
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
};
const press: Exercise = { ...bench, id: "db_press", name: "Dumbbell Press", equipment: "Dumbbell" };

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  resetSwapAi();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        url === "/exercises.json"
          ? new Response(JSON.stringify([bench, press]), { status: 200 })
          : new Response(JSON.stringify({ unavailable: true }), { status: 503 }),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SwapSheet: never suggest", () => {
  it("adds a Don't suggest this again action that saves the exercise to the never-suggest list", async () => {
    render(<SwapSheet current={bench} onPick={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Don't suggest this again" }));
    await waitFor(async () => expect(((await db.meta.get("goals"))?.value as Goals).dislikedIds).toEqual(["bench"]));
    const done = await screen.findByRole("button", { name: "Noted. It will not be suggested again." });
    expect(done).toBeDisabled();
  });

  it("keeps the live sheet's four reasons and its alternatives exactly as before", async () => {
    render(<SwapSheet current={bench} onPick={vi.fn()} onClose={vi.fn()} />);
    for (const r of SWAP_REASONS) expect(screen.getByRole("button", { name: r.label })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Too difficult" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Causes discomfort" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Dumbbell Press/ })).toBeInTheDocument();
  });
});
