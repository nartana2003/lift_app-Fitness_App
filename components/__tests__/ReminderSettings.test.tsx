// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { DEFAULT_REMINDERS, REMINDERS_KEY, saveReminders } from "@/lib/reminders";
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
    for (const name of ["Personal information", "Body", "Goals", "My split", "Preferences", "Backup", "Import data", "Account"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
  });
});
