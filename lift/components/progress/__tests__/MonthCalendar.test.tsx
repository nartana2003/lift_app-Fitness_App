// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MonthCalendar } from "@/components/progress/MonthCalendar";
import type { WorkoutDetail } from "@/lib/history";
import { dayKey, monthGrid } from "@/lib/progress";
import { formatDuration } from "@/lib/stats";
import { fmtVolume } from "@/lib/units";

// "Today" is Friday 16 Oct 2026 (local), so the calendar opens on October 2026.
const NOW = new Date(2026, 9, 16, 12, 0, 0);

/** A finished workout starting at a local date/time, lasting `minutes`. */
function workout(id: string, start: Date, minutes: number, over: Partial<WorkoutDetail> = {}): WorkoutDetail {
  return {
    id,
    started_at: start.toISOString(),
    ended_at: new Date(start.getTime() + minutes * 60_000).toISOString(),
    notes: null,
    routine_id: null,
    exercises: [],
    volume: 0,
    setCount: 0,
    ...over,
  };
}

const OCT_5_AM = workout("w-oct5", new Date(2026, 9, 5, 8, 0), 45, { volume: 3200, setCount: 12 });
const OCT_14_PM = workout("w-oct14", new Date(2026, 9, 14, 18, 30), 75, { notes: "Push day", volume: 5400, setCount: 18 });
const OCT_14_AM = workout("w-oct14b", new Date(2026, 9, 14, 7, 0), 20, { volume: 800, setCount: 4 });
const SEP_30 = workout("w-sep30", new Date(2026, 8, 30, 13, 0), 60, { volume: 2500, setCount: 10 });
const ALL = [OCT_5_AM, OCT_14_PM, OCT_14_AM, SEP_30];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

const monthTitle = (y: number, m: number) =>
  new Date(y, m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

/** Day buttons in grid order (everything except the two month arrows). */
const dayButtons = () =>
  screen.getAllByRole("button").filter((b) => !["Previous month", "Next month"].includes(b.getAttribute("aria-label") ?? ""));

/**
 * The button for a local date, located through the same grid the component
 * draws. `shown` is the month on screen (defaults to the date's own month).
 */
function dayButton(y: number, m: number, d: number, shown: { y: number; m: number } = { y, m }, weekStart: 0 | 1 = 1) {
  const idx = monthGrid(shown.y, shown.m, weekStart).findIndex((x) => dayKey(x) === dayKey(new Date(y, m, d)));
  expect(idx).toBeGreaterThanOrEqual(0);
  return dayButtons()[idx];
}

const details = () => screen.queryByRole("list");

describe("MonthCalendar", () => {
  it("opens on the current month and counts the days trained", () => {
    render(<MonthCalendar workouts={ALL} unit="kg" weekStart={1} />);
    expect(screen.getByRole("heading", { name: monthTitle(2026, 9) })).toBeInTheDocument();
    // Two workouts on the 14th count as one day; 30 Sep is not October.
    expect(screen.getByText("2 days trained")).toBeInTheDocument();
    expect(dayButtons()).toHaveLength(monthGrid(2026, 9, 1).length);
  });

  it("uses the singular for one day trained", () => {
    render(<MonthCalendar workouts={[OCT_5_AM]} unit="kg" weekStart={1} />);
    expect(screen.getByText("1 day trained")).toBeInTheDocument();
  });

  it("orders weekday labels by the week-start setting", () => {
    const { unmount } = render(<MonthCalendar workouts={[]} unit="kg" weekStart={1} />);
    expect(screen.getByText("Mon").parentElement?.textContent).toBe("MonTueWedThuFriSatSun");
    unmount();
    render(<MonthCalendar workouts={[]} unit="kg" weekStart={0} />);
    expect(screen.getByText("Sun").parentElement?.textContent).toBe("SunMonTueWedThuFriSat");
  });

  it("only lets days with a workout be tapped, including spill-over days from the next/previous month", () => {
    render(<MonthCalendar workouts={ALL} unit="kg" weekStart={1} />);
    expect(dayButton(2026, 9, 5)).toBeEnabled();
    expect(dayButton(2026, 9, 14)).toBeEnabled();
    expect(dayButton(2026, 9, 6)).toBeDisabled();
    expect(dayButton(2026, 9, 16)).toBeDisabled(); // today, nothing logged
    // 30 Sep is drawn in October's first row (week starts Monday 28 Sep).
    const OCT = { y: 2026, m: 9 };
    expect(dayButton(2026, 8, 30, OCT)).toBeEnabled();
    expect(dayButton(2026, 8, 30, OCT)).toHaveTextContent("30");
    expect(dayButton(2026, 8, 29, OCT)).toBeDisabled();

    fireEvent.click(dayButton(2026, 8, 30, OCT));
    expect(within(screen.getByRole("list")).getByRole("link")).toHaveAttribute("href", "/history/w-sep30");
  });

  it("tapping a trained day shows its name, duration, volume and sets, linking to the workout", () => {
    render(<MonthCalendar workouts={ALL} unit="kg" weekStart={1} />);
    expect(details()).not.toBeInTheDocument();

    fireEvent.click(dayButton(2026, 9, 5));
    const list = details()!;
    const link = within(list).getByRole("link");
    expect(link).toHaveAttribute("href", "/history/w-oct5");
    expect(within(link).getByText("Morning workout")).toBeInTheDocument();
    expect(within(link).getByText(`${formatDuration(45 * 60)} · ${fmtVolume(3200, "kg")} · 12 sets`)).toBeInTheDocument();
    expect(formatDuration(45 * 60)).toBe("45m");
  });

  it("lists every workout on a day with two sessions, using the workout name when set", () => {
    render(<MonthCalendar workouts={ALL} unit="kg" weekStart={1} />);
    fireEvent.click(dayButton(2026, 9, 14));
    const links = within(details()!).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href")).sort()).toEqual(["/history/w-oct14", "/history/w-oct14b"]);
    expect(screen.getByText("Push day")).toBeInTheDocument();
    expect(screen.getByText("Morning workout")).toBeInTheDocument();
    expect(screen.getByText(`${formatDuration(75 * 60)} · ${fmtVolume(5400, "kg")} · 18 sets`)).toBeInTheDocument();
    expect(formatDuration(75 * 60)).toBe("1h 15m");
  });

  it("shows volume in the user's unit", () => {
    render(<MonthCalendar workouts={ALL} unit="lb" weekStart={1} />);
    fireEvent.click(dayButton(2026, 9, 5));
    expect(screen.getByText(new RegExp(fmtVolume(3200, "lb").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    expect(fmtVolume(3200, "lb")).toMatch(/lb$/);
  });

  it("tapping the same day again hides the details; tapping another day switches", () => {
    render(<MonthCalendar workouts={ALL} unit="kg" weekStart={1} />);
    fireEvent.click(dayButton(2026, 9, 5));
    expect(screen.getByText("Morning workout")).toBeInTheDocument();
    fireEvent.click(dayButton(2026, 9, 14));
    expect(screen.getByText("Push day")).toBeInTheDocument();
    expect(within(details()!).getAllByRole("link")).toHaveLength(2);
    fireEvent.click(dayButton(2026, 9, 14));
    expect(details()).not.toBeInTheDocument();
  });

  it("marks the tapped day as selected", () => {
    render(<MonthCalendar workouts={ALL} unit="kg" weekStart={1} />);
    expect(dayButton(2026, 9, 5)).not.toHaveClass("ring-2");
    fireEvent.click(dayButton(2026, 9, 5));
    expect(dayButton(2026, 9, 5)).toHaveClass("ring-2");
    expect(dayButton(2026, 9, 14)).not.toHaveClass("ring-2");
  });

  it("tapping a disabled day does nothing", () => {
    render(<MonthCalendar workouts={ALL} unit="kg" weekStart={1} />);
    fireEvent.click(dayButton(2026, 9, 6));
    expect(details()).not.toBeInTheDocument();
  });

  it("month arrows change the month and clear the selection", () => {
    render(<MonthCalendar workouts={ALL} unit="kg" weekStart={1} />);
    fireEvent.click(dayButton(2026, 9, 5));
    expect(details()).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("heading", { name: monthTitle(2026, 8) })).toBeInTheDocument();
    expect(details()).not.toBeInTheDocument();
    // September: only the 30th. The grid ends Sun 4 Oct, so no October workout shows.
    expect(screen.getByText("1 day trained")).toBeInTheDocument();
    fireEvent.click(dayButton(2026, 8, 30));
    expect(within(details()!).getByRole("link")).toHaveAttribute("href", "/history/w-sep30");
    expect(screen.getByText("Afternoon workout")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { name: monthTitle(2026, 10) })).toBeInTheDocument();
    expect(details()).not.toBeInTheDocument();
    expect(screen.getByText("0 days trained")).toBeInTheDocument();
  });

  it("crosses the year boundary", () => {
    vi.setSystemTime(new Date(2026, 0, 10, 12, 0));
    render(<MonthCalendar workouts={[]} unit="kg" weekStart={1} />);
    expect(screen.getByRole("heading", { name: monthTitle(2026, 0) })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("heading", { name: monthTitle(2025, 11) })).toBeInTheDocument();
  });

  it("shows no list when there are no workouts at all", () => {
    render(<MonthCalendar workouts={[]} unit="kg" weekStart={1} />);
    expect(screen.getByText("0 days trained")).toBeInTheDocument();
    expect(dayButtons().every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});
