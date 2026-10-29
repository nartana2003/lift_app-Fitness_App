// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { DEFAULT_REMINDERS, localDateKey, REMINDERS_KEY, saveReminders } from "@/lib/reminders";
import { markGymDay, unmarkGymDay } from "@/lib/planner";
import { PUSH_UNAVAILABLE, ReminderSettings } from "@/components/ReminderSettings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/profile",
  useSearchParams: () => new URLSearchParams(),
}));

import ProfilePage from "@/app/(tabs)/profile/page";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
});

const stored = async () => (await db.meta.get(REMINDERS_KEY))?.value as typeof DEFAULT_REMINDERS | undefined;

describe("ReminderSettings", () => {
  it("lists seven days Monday first, none picked, and asks for a day", () => {
    render(<ReminderSettings />);
    const days = screen.getAllByRole("checkbox");
    expect(days.map((d) => d.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    for (const d of days) expect(d).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Pick at least one gym day to get reminders.")).toBeInTheDocument();
  });

  it("picking a day saves it and shows the next reminder", async () => {
    render(<ReminderSettings />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Wed" }));
    await waitFor(async () => expect((await stored())?.days).toEqual([3]));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Wed" })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText(/Next reminder/)).toBeInTheDocument();
  });

  it("saves the time, switches and snooze length", async () => {
    render(<ReminderSettings />);
    fireEvent.change(screen.getByLabelText("Reminder time"), { target: { value: "07:30" } });
    await waitFor(async () => expect((await stored())?.time).toBe("07:30"));
    fireEvent.click(screen.getByRole("switch", { name: "Smart reminders" }));
    await waitFor(async () => expect((await stored())?.smart).toBe(true));
    fireEvent.click(screen.getByRole("switch", { name: "You're behind nudge" }));
    await waitFor(async () => expect((await stored())?.behindNudge).toBe(false));
    fireEvent.change(screen.getByLabelText("Snooze length"), { target: { value: "30" } });
    await waitFor(async () => expect((await stored())?.snoozeMin).toBe(30));
    await waitFor(() => expect(screen.getByRole("button", { name: "Snooze 30 min" })).toBeInTheDocument());
  });

  it("skip today and snooze toggle and are saved", async () => {
    await saveReminders({ ...DEFAULT_REMINDERS, days: [0, 1, 2, 3, 4, 5, 6] });
    render(<ReminderSettings />);
    const skip = screen.getByRole("button", { name: "Skip today" });
    fireEvent.click(skip);
    await waitFor(() => expect(skip).toHaveAttribute("aria-pressed", "true"));
    expect((await stored())?.skipDate).not.toBeNull();
    const snooze = screen.getByRole("button", { name: "Snooze 1 h" });
    fireEvent.click(snooze);
    await waitFor(() => expect(snooze).toHaveAttribute("aria-pressed", "true"));
    expect(skip).toHaveAttribute("aria-pressed", "false");
    expect((await stored())?.snoozedUntil).not.toBeNull();
  });

  it("Enable notifications explains push is not available yet", () => {
    render(<ReminderSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
    expect(screen.getByRole("status")).toHaveTextContent(PUSH_UNAVAILABLE);
  });
});

describe("ReminderSettings with marked gym days", () => {
  const plusDays = (n: number) => {
    const d = new Date();
    return localDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
  };

  it("explains that reminders follow the This Week strip and describes weekdays as optional usual days", () => {
    render(<ReminderSettings />);
    expect(screen.getByText("Reminders follow the days you mark on the This Week strip.")).toBeInTheDocument();
    expect(screen.getByText(/Optional usual days/)).toBeInTheDocument();
    // The existing label is kept.
    expect(screen.getByText("Gym days")).toBeInTheDocument();
  });

  it("shows the next reminder from a marked date with no usual days, live", async () => {
    render(<ReminderSettings />);
    expect(screen.getByText("Pick at least one gym day to get reminders.")).toBeInTheDocument();
    await markGymDay(plusDays(2));
    await waitFor(() => expect(screen.getByText(/Next reminder/)).toBeInTheDocument());
    expect(screen.queryByText("Pick at least one gym day to get reminders.")).not.toBeInTheDocument();
    await unmarkGymDay(plusDays(2));
    await waitFor(() => expect(screen.getByText("Pick at least one gym day to get reminders.")).toBeInTheDocument());
  });

  it("ignores past marked dates", async () => {
    await markGymDay(plusDays(-3));
    render(<ReminderSettings />);
    await new Promise((res) => setTimeout(res, 50));
    expect(screen.getByText("Pick at least one gym day to get reminders.")).toBeInTheDocument();
  });

  it("stores nothing new in the reminder settings", async () => {
    await markGymDay(plusDays(1));
    render(<ReminderSettings />);
    await waitFor(() => expect(screen.getByText(/Next reminder/)).toBeInTheDocument());
    expect(await stored()).toBeUndefined();
  });
});

describe("Profile reminders section", () => {
  it("is collapsed, summarises the schedule and opens", async () => {
    await saveReminders({ ...DEFAULT_REMINDERS, days: [1, 5], time: "06:00" });
    render(<ProfilePage />);
    const header = screen.getByRole("button", { name: /^Reminders/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(header).toHaveTextContent("Mon, Fri at 06:00"));
    fireEvent.click(header);
    expect(screen.getByRole("button", { name: "Enable notifications" })).toBeInTheDocument();
  });

  it("keeps the existing Profile sections", () => {
    render(<ProfilePage />);
    for (const name of ["Personal information", "Body", "Preferences"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /^(Goals|My split|Ask the coach|Backup|Sync|Account|Import data)/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Goals and split are in Coach/ })).toHaveAttribute("href", "/coach");
  });
});

describe("ReminderSettings smart reminder time", () => {
  const addWorkouts = async (n: number, h: number, m = 0) => {
    const now = new Date();
    await db.workouts.bulkAdd(
      Array.from({ length: n }, (_, i) => ({
        id: `w-${i}`,
        started_at: new Date(now.getFullYear(), now.getMonth(), now.getDate() - i - 1, h, m).toISOString(),
        ended_at: null,
        notes: null,
        routine_id: null,
      })),
    );
  };

  it("offers nothing with fewer than 5 workouts", async () => {
    await addWorkouts(4, 6, 30);
    render(<ReminderSettings />);
    await new Promise((res) => setTimeout(res, 50));
    expect(screen.queryByText(/You usually start around/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Use / })).not.toBeInTheDocument();
  });

  it("suggests the usual start time and saves it only when tapped", async () => {
    await saveReminders({ ...DEFAULT_REMINDERS, days: [1] });
    await addWorkouts(5, 6, 30);
    render(<ReminderSettings />);
    const use = await screen.findByRole("button", { name: "Use 06:30" });
    expect(screen.getByText(/You usually start around/)).toBeInTheDocument();
    // Showing the suggestion does not change the saved time.
    expect((await stored())?.time).toBe("18:00");
    fireEvent.click(use);
    await waitFor(async () => expect((await stored())?.time).toBe("06:30"));
    await waitFor(() => expect(screen.getByLabelText("Reminder time")).toHaveValue("06:30"));
    // Once it matches, the suggestion goes away.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use 06:30" })).not.toBeInTheDocument());
    expect((await stored())?.days).toEqual([1]);
  });
});
