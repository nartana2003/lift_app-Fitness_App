// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkoutLite } from "@/lib/progress";
import type { PeriodStats } from "@/lib/stats";
import {
  MAX_HIGHLIGHTS,
  MSG_FAILED,
  MSG_OFFLINE,
  MSG_UNAVAILABLE,
  ROUTE,
  RecapCard,
  buildHighlights,
  buildSummaryBody,
  parseSummary,
  toBaseStats,
} from "@/components/progress/RecapCard";

// ---------- helpers ----------

const FROM = new Date(2026, 9, 12); // Monday
const TO = new Date(2026, 9, 19);
const day = (d: number, h = 9) => new Date(2026, 9, d, h).toISOString();

type S = { reps: number; weight: number; is_warmup?: boolean };
const sets = (n: number, reps: number, weight: number): S[] => Array.from({ length: n }, () => ({ reps, weight }));

function workout(id: string, started: string, ex: [string, S[]][]): WorkoutLite {
  return { id, started_at: started, ended_at: started, notes: null, volume: 0, setCount: 0, exercises: ex.map(([exercise_id, s]) => ({ exercise_id, sets: s })) };
}

const stats = (over: Partial<PeriodStats> = {}): PeriodStats => ({
  sessions: 2,
  duration_sec: 7200,
  volume: 5400,
  sets_by_muscle: { Chest: 6 },
  workout_days: [],
  ...over,
});

const WORKOUTS = [
  workout("a", day(13), [["bench", [{ reps: 10, weight: 20, is_warmup: true }, ...sets(3, 10, 60)]]]),
  workout("b", day(15), [["bench", sets(3, 10, 60)]]),
];

const okBody = () => ({
  period: "week",
  recap: ["Two sessions this week and 5,400kg of volume.", "Chest got most of the work."],
  recap_source: "ai",
  advice: [{ exercise_id: "bench", text: "You did 3x10 at 60kg twice, try 62.5kg next time.", source: "ai" }],
  adjusted: 0,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(route: (init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === ROUTE) return route(init);
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const bodyOf = (fn: ReturnType<typeof mockFetch>, i = 0) => JSON.parse(String((fn.mock.calls[i][1] as RequestInit).body));

function setOnline(v: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v });
}

const ids = async () => new Set(["bench", "squat"]);

function renderCard(over: Partial<Parameters<typeof RecapCard>[0]> = {}) {
  return render(
    <RecapCard
      period="week"
      unit="kg"
      current={stats()}
      previous={stats({ sessions: 1, volume: 2000 })}
      workouts={WORKOUTS}
      from={FROM}
      to={TO}
      loadIds={ids}
      {...over}
    />,
  );
}

beforeEach(() => setOnline(true));
afterEach(() => vi.unstubAllGlobals());

// ---------- pure helpers ----------

describe("buildHighlights", () => {
  const all = () => true;

  it("counts sessions that repeated the same sets x reps x weight, ignoring warm-ups", () => {
    expect(buildHighlights(WORKOUTS, FROM, TO, all)).toEqual([{ exercise_id: "bench", sets: 3, reps: 10, weight: 60, times: 2 }]);
  });

  it("ignores workouts outside the period and ids that are not allowed", () => {
    const ws = [
      ...WORKOUTS,
      workout("old", day(5), [["bench", sets(3, 10, 60)]]),
      workout("c", day(14), [["custom-1", sets(3, 8, 40)]]),
    ];
    const out = buildHighlights(ws, FROM, TO, (id) => id !== "custom-1");
    expect(out).toEqual([{ exercise_id: "bench", sets: 3, reps: 10, weight: 60, times: 2 }]);
  });

  it("uses each session's most common working set and keeps the most repeated pattern", () => {
    const ws = [
      workout("a", day(12), [["squat", [...sets(3, 5, 100), { reps: 3, weight: 110 }]]]),
      workout("b", day(14), [["squat", sets(3, 5, 100)]]),
      workout("c", day(16), [["squat", sets(2, 5, 105)]]),
    ];
    expect(buildHighlights(ws, FROM, TO, all)).toEqual([{ exercise_id: "squat", sets: 3, reps: 5, weight: 100, times: 2 }]);
  });

  it("keeps bodyweight lifts with weight 0 and drops out-of-range patterns", () => {
    const ws = [
      workout("a", day(12), [["pullup", sets(3, 8, 0)], ["huge", sets(3, 5, 5000)], ["many", sets(25, 5, 10)]]),
    ];
    expect(buildHighlights(ws, FROM, TO, all)).toEqual([{ exercise_id: "pullup", sets: 3, reps: 8, weight: 0, times: 1 }]);
  });

  it("caps the list and sorts by times first", () => {
    const ex: [string, S[]][] = Array.from({ length: 12 }, (_, i) => [`e${i}`, sets(3, 10, 10 + i)]);
    const ws = [workout("a", day(12), ex), workout("b", day(13), [["e0", sets(3, 10, 10)]])];
    const out = buildHighlights(ws, FROM, TO, all);
    expect(out).toHaveLength(MAX_HIGHLIGHTS);
    expect(out[0]).toEqual({ exercise_id: "e0", sets: 3, reps: 10, weight: 10, times: 2 });
    expect(out[1].exercise_id).toBe("e11");
  });
});

describe("toBaseStats / buildSummaryBody", () => {
  it("clamps to the route's bounds and drops unknown muscles", () => {
    const s = toBaseStats(stats({ sessions: 99, duration_sec: 1e9, volume: 9e9, sets_by_muscle: { Chest: 999, Nope: 3, Biceps: 4.4 } }));
    expect(s).toEqual({ sessions: 62, duration_sec: 31 * 86400, volume: 5_000_000, sets_by_muscle: { Chest: 500, Biceps: 4 }, skipped: 0, moved: 0 });
  });

  it("builds the route body with no extra keys", () => {
    const body = buildSummaryBody("month", "lb", stats(), null, []);
    expect(Object.keys(body).sort()).toEqual(["current", "highlights", "period", "previous", "unit"]);
    expect(body.period).toBe("month");
    expect(body.unit).toBe("lb");
    expect(body.previous).toBeNull();
    expect(Object.keys(body.current).sort()).toEqual(["duration_sec", "moved", "sessions", "sets_by_muscle", "skipped", "volume"]);
  });
});

describe("parseSummary", () => {
  it("keeps recap lines and advice", () => {
    expect(parseSummary(okBody())).toEqual({
      recap: okBody().recap,
      advice: [{ exercise_id: "bench", text: "You did 3x10 at 60kg twice, try 62.5kg next time." }],
    });
  });

  it("returns null for unusable shapes", () => {
    expect(parseSummary(null)).toBeNull();
    expect(parseSummary("x")).toBeNull();
    expect(parseSummary({ recap: "x", advice: [] })).toBeNull();
    expect(parseSummary({ recap: ["", 3, null], advice: [] })).toBeNull();
  });

  it("cleans, dedupes and caps lines and advice", () => {
    const out = parseSummary({
      recap: ["a\u0000b", "a b", "c", "d", "e", "f", "x".repeat(500)],
      advice: [{ text: "one" }, { text: "one" }, 5, { exercise_id: 3, text: "two" }, { text: "three" }, { text: "four" }],
    })!;
    expect(out.recap).toEqual(["a b", "c", "d", "e"]);
    expect(out.advice).toEqual([
      { exercise_id: null, text: "one" },
      { exercise_id: null, text: "two" },
      { exercise_id: null, text: "three" },
    ]);
  });
});

// ---------- component ----------

describe("RecapCard", () => {
  it("fetches nothing until asked", () => {
    const fn = mockFetch(() => json(okBody()));
    renderCard();
    expect(screen.getByRole("heading", { name: "Coach recap" })).toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
  });

  it("shows the recap and advice on success", async () => {
    const fn = mockFetch(() => json(okBody()));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Get recap" }));
    expect(await screen.findByText("Two sessions this week and 5,400kg of volume.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Overload advice" })).toHaveTextContent("try 62.5kg next time");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(fn).toHaveBeenCalledTimes(1);
    const body = bodyOf(fn);
    expect(body.period).toBe("week");
    expect(body.highlights).toEqual([{ exercise_id: "bench", sets: 3, reps: 10, weight: 60, times: 2 }]);
    expect(body.previous.sessions).toBe(1);
  });

  it("shows the unavailable message on 503", async () => {
    mockFetch(() => json({ unavailable: true }, 503));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Get recap" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_UNAVAILABLE);
    expect(screen.queryByRole("list", { name: "Overload advice" })).toBeNull();
  });

  it("shows the failure message on a server error, a bad answer or a network error", async () => {
    mockFetch(() => json({ error: "x" }, 500));
    const { unmount } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Get recap" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_FAILED);
    unmount();

    mockFetch(() => json({ recap: [] }));
    const r2 = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Get recap" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_FAILED);
    r2.unmount();

    mockFetch(() => Promise.reject(new TypeError("network")));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Get recap" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_FAILED);
  });

  it("shows the offline message without calling the route", async () => {
    setOnline(false);
    const fn = mockFetch(() => json(okBody()));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Get recap" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_OFFLINE);
    expect(fn).not.toHaveBeenCalled();
  });

  it("retries without highlights on a 400", async () => {
    const fn = mockFetch(() => (fn.mock.calls.length === 1 ? json({ error: "invalid" }, 400) : json(okBody())));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Get recap" }));
    expect(await screen.findByText("Chest got most of the work.")).toBeInTheDocument();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(bodyOf(fn, 1).highlights).toEqual([]);
  });

  it("sends no highlights when the catalogue cannot be loaded", async () => {
    const fn = mockFetch(() => json(okBody()));
    renderCard({ loadIds: () => Promise.reject(new Error("offline")) });
    fireEvent.click(screen.getByRole("button", { name: "Get recap" }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    expect(bodyOf(fn).highlights).toEqual([]);
    expect(await screen.findByText("Chest got most of the work.")).toBeInTheDocument();
  });
});
