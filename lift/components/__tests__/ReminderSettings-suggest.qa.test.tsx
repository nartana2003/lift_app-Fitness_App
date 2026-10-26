// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { DEFAULT_REMINDERS, REMINDERS_KEY, saveReminders } from "@/lib/reminders";
import { ReminderSettings } from "@/components/ReminderSettings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/profile",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
});

const stored = async () => (await db.meta.get(REMINDERS_KEY))?.value as typeof DEFAULT_REMINDERS | undefined;
const row = (id: string, d: Date) => ({ id, started_at: d.toISOString(), ended_at: null, notes: null, routine_id: null });
const seed = (n: number, h: number, m = 0) =>
  db.workouts.bulkAdd(Array.from({ length: n }, (_, i) => row(`w${i}`, new Date(2026, 9, 1 + i, h, m))));

describe("ReminderSettings suggestion QA", () => {
  it("no suggestion with 4 workouts, shows once a 5th arrives", async () => {
    await seed(4, 7, 30);
    render(<ReminderSettings />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/You usually start around/)).not.toBeInTheDocument();
    await db.workouts.add(row("w9", new Date(2026, 9, 20, 7, 30)));
    expect(await screen.findByRole("button", { name: "Use 07:30" })).toBeInTheDocument();
  });

  it("Use changes only the time, keeps other settings, hides suggestion; double click safe", async () => {
    await seed(6, 6, 45);
    await saveReminders({ ...DEFAULT_REMINDERS, days: [1, 3], smart: true, behindNudge: false, snoozeMin: 30 });
    render(<ReminderSettings />);
    const use = await screen.findByRole("button", { name: "Use 06:45" });
    fireEvent.click(use);
    fireEvent.click(use);
    await waitFor(async () => expect((await stored())?.time).toBe("06:45"));
    expect(await stored()).toMatchObject({ days: [1, 3], smart: true, behindNudge: false, snoozeMin: 30 });
    await waitFor(() => expect(screen.queryByText(/You usually start around/)).not.toBeInTheDocument());
    expect(screen.getByLabelText("Reminder time")).toHaveValue("06:45");
  });

  it("suggestion returns if the user edits the time away again", async () => {
    await seed(5, 8, 0);
    render(<ReminderSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Use 08:00" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use 08:00" })).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Reminder time"), { target: { value: "09:15" } });
    expect(await screen.findByRole("button", { name: "Use 08:00" })).toBeInTheDocument();
  });

  it("rendering the suggestion never writes settings", async () => {
    await seed(5, 8, 0);
    render(<ReminderSettings />);
    await screen.findByRole("button", { name: "Use 08:00" });
    expect(await stored()).toBeUndefined();
  });
});
