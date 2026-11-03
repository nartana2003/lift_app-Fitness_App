// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { goalsFingerprint, saveGoals } from "@/lib/goals";
import { saveSplit } from "@/lib/splits";
import { builtForSummary, CoachCard, OPEN_OPTIMISE, OPTIMISE_HREF } from "../CoachCard";

let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/coach",
  useSearchParams: () => search,
}));

import CoachPage from "@/app/(tabs)/coach/page";

// CO-08: Home Coach card. Default links to /coach; when the goals changed since the
// split was built it says what the split was built for and links to /coach in Optimise.

const days = [
  { id: "push", name: "Push", muscles: ["Chest" as const] },
  { id: "pull", name: "Pull", muscles: ["Lats" as const, "Biceps" as const] },
];

beforeEach(async () => {
  search = new URLSearchParams();
  await Promise.all(db.tables.map((t) => t.clear()));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("builtForSummary", () => {
  it("names goal, experience, sessions and high priorities", () => {
    const fp = goalsFingerprint({ goalType: "strength", experience: "advanced", sessionsPerWeek: 4, priorities: { Biceps: "high", Chest: "high", Lats: "low" } });
    expect(builtForSummary(fp)).toBe("Get stronger · Advanced · 4×/week · Chest, Biceps first");
  });

  it("matches the fingerprint e2e/coach-nudge seeds", () => {
    expect(goalsFingerprint({ sessionsPerWeek: 2 })).toBe(JSON.stringify(["build_muscle", "intermediate", 2, [], [], []]));
  });

  it("leaves out priorities when there are no high ones", () => {
    expect(builtForSummary(goalsFingerprint({}))).toBe("Build muscle · Intermediate · 3×/week");
  });

  it("returns null for missing, malformed or unknown fingerprints", () => {
    expect(builtForSummary(undefined)).toBeNull();
    expect(builtForSummary("")).toBeNull();
    expect(builtForSummary("not json")).toBeNull();
    expect(builtForSummary("{}")).toBeNull();
    expect(builtForSummary(JSON.stringify(["nope", "beginner", 3, [], [], []]))).toBeNull();
  });

  it("skips fields of the wrong type", () => {
    expect(builtForSummary(JSON.stringify(["fat_loss", 7, "x", [], "y", []]))).toBe("Lose fat");
  });
});

describe("CoachCard", () => {
  it("defaults to a Build or optimise your split link to /coach", async () => {
    render(<CoachCard />);
    const link = await screen.findByRole("link", { name: /Build or optimise your split/ });
    expect(link).toHaveAttribute("href", "/coach");
    expect(screen.queryByText("Your goals changed")).toBeNull();
  });

  it("stays default when the split has no builtFor", async () => {
    await saveSplit({ name: "PPL", days });
    await saveGoals({ sessionsPerWeek: 5 });
    render(<CoachCard />);
    expect(await screen.findByRole("link", { name: /Build or optimise your split/ })).toBeInTheDocument();
    expect(screen.queryByText("Your goals changed")).toBeNull();
  });

  it("stays default when the goals still match what the split was built for", async () => {
    await saveGoals({ sessionsPerWeek: 2 });
    await saveSplit({ name: "PPL", days, builtFor: goalsFingerprint({ sessionsPerWeek: 2 }) });
    render(<CoachCard />);
    expect(await screen.findByRole("link", { name: /Build or optimise your split/ })).toBeInTheDocument();
    expect(screen.queryByText("Your goals changed")).toBeNull();
  });

  it("nudges with what the split was built for and links to Optimise when the goals changed", async () => {
    await saveSplit({ name: "PPL", days, builtFor: goalsFingerprint({ sessionsPerWeek: 2 }) });
    await saveGoals({ sessionsPerWeek: 4 });
    render(<CoachCard />);
    expect(await screen.findByText("Your goals changed")).toBeInTheDocument();
    expect(screen.getByText("Your split was built for Build muscle · Intermediate · 2×/week.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Optimise for new goals" })).toHaveAttribute("href", OPTIMISE_HREF);
    expect(OPTIMISE_HREF).toBe("/coach?open=optimise");
    expect(screen.queryByRole("link", { name: /Build or optimise your split/ })).toBeNull();
  });

  it("falls back to a plain line when builtFor cannot be read", async () => {
    await saveSplit({ name: "PPL", days, builtFor: "garbage" });
    render(<CoachCard />);
    expect(await screen.findByText("Your split was built for your earlier goals.")).toBeInTheDocument();
  });
});

describe("Coach page open=optimise", () => {
  it("opens the Optimise card when the query asks for it", () => {
    search = new URLSearchParams({ open: OPEN_OPTIMISE });
    render(<CoachPage />);
    expect(screen.getByRole("button", { name: "Optimise" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Goals/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps Optimise collapsed without the query", () => {
    render(<CoachPage />);
    expect(screen.getByRole("button", { name: /^Optimise/ })).toHaveAttribute("aria-expanded", "false");
  });
});
