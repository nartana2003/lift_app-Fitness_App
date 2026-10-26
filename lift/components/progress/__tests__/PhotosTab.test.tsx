// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db, type MeasurementRow, type PhotoRow } from "@/lib/offline/db";
import type { WorkoutLite } from "@/lib/progress";
import {
  ALLOWED_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  validateInput,
  type MonthStats,
  type PhotoMediaType,
} from "@/lib/ai/photo-analysis";
import {
  ANALYSIS_MEDIA_TYPES,
  ANALYSIS_ROUTE,
  MAX_ANALYSIS_IMAGE_BYTES,
  MAX_ANALYSIS_TOTAL_BYTES,
  MSG_ANALYSIS_FAILED,
  MSG_ANALYSIS_NO_PHOTO,
  MSG_ANALYSIS_OFFLINE,
  MSG_ANALYSIS_UNAVAILABLE,
  COMPARE_MODES,
  CompareSlider,
  MonthlyAnalysis,
  PhotosTab,
  REVEAL_DEFAULT,
  REVEAL_LABEL,
  analysisKey,
  clampReveal,
  orderPair,
  revealAt,
  revealClip,
  blobToBase64,
  countPrs,
  monthStats,
  parseAnalysis,
  photoMonths,
  pickAnalysisPhotos,
  readSavedAnalysis,
  type AnalysisMediaType,
  type AnalysisStats,
} from "@/components/progress/PhotosTab";

// ---------- compile-time: local copies match lib/ai/photo-analysis.ts ----------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const statsSame: Equal<AnalysisStats, MonthStats> = true;
const mediaSame: Equal<AnalysisMediaType, PhotoMediaType> = true;

// ---------- fixtures ----------

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const seg = (marker: number, payload: number[]) => [0xff, marker, ...u16(payload.length + 2), ...payload];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Minimal JPEG the route's parser accepts (same shape as lib/ai/__tests__/photo-analysis.test.ts). */
function jpegBytes(w = 640, h = 800): Uint8Array<ArrayBuffer> {
  const out = [0xff, 0xd8];
  out.push(...seg(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  out.push(...seg(0xdb, [0, ...new Array(64).fill(1)]));
  out.push(...seg(0xc0, [8, ...u16(h), ...u16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  out.push(...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]));
  out.push(0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0xff, 0xd9);
  return Uint8Array.from(out);
}

const at = (month: number, d: number, h = 9) => new Date(2026, month - 1, d, h).toISOString();

function photo(id: string, taken_at: string, pose: PhotoRow["pose"] = "front", blob: Blob = new Blob([jpegBytes()], { type: "image/jpeg" })): PhotoRow {
  return { id, taken_at, pose, blob };
}

/** A blob that reports a size without allocating it. */
function sized(size: number, type = "image/jpeg"): Blob {
  const b = new Blob([jpegBytes()], { type });
  Object.defineProperty(b, "size", { value: size });
  return b;
}

const STATS: AnalysisStats = {
  sessions: 10,
  duration_sec: 36_000,
  volume: 42_000,
  sets_by_muscle: { Chest: 20, Back: 18 },
  pr_count: 3,
  bodyweight_start: 80,
  bodyweight_end: 79.2,
};

const okBody = () => ({
  month: "2026-09",
  comment: ["Shoulders look a little fuller than on the 2nd.", "Ten sessions and 42,000kg of volume this month."],
  comment_source: "ai",
  focus: [
    { muscle: "Glutes", text: "Keep glute volume up next month.", source: "ai" },
    { muscle: null, text: "Take the photos in the same light.", source: "rule" },
  ],
  adjusted: 0,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(route: (init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === ANALYSIS_ROUTE) return route(init);
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const bodyOf = (fn: ReturnType<typeof mockFetch>, i = 0) => JSON.parse(String((fn.mock.calls[i][1] as RequestInit).body));

function setOnline(v: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v });
}

const SEPT = [photo("p1", at(9, 2), "front"), photo("p2", at(9, 15), "side"), photo("p3", at(9, 29), "front")];

function renderCard(photos: PhotoRow[] = SEPT, loadStats = vi.fn(async () => STATS)) {
  render(<MonthlyAnalysis photos={photos} unit="kg" loadStats={loadStats} />);
  return loadStats;
}

const tap = () => fireEvent.click(screen.getByRole("button", { name: "Analyse month" }));

beforeEach(async () => {
  setOnline(true);
  await db.meta.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setOnline(true);
});

// ---------- pure helpers ----------

describe("local bounds", () => {
  it("match the route", () => {
    expect(statsSame && mediaSame).toBe(true);
    expect([...ANALYSIS_MEDIA_TYPES]).toEqual([...ALLOWED_MEDIA_TYPES]);
    expect(MAX_ANALYSIS_IMAGE_BYTES).toBe(MAX_IMAGE_BYTES);
    expect(MAX_ANALYSIS_TOTAL_BYTES).toBe(MAX_TOTAL_IMAGE_BYTES);
  });
});

describe("photoMonths", () => {
  it("lists months with photos, newest first", () => {
    expect(photoMonths([{ taken_at: at(8, 3) }, { taken_at: at(9, 1) }, { taken_at: at(8, 30) }])).toEqual(["2026-09", "2026-08"]);
  });
});

describe("pickAnalysisPhotos", () => {
  it("takes the last photo and the earliest one with the same pose, oldest first", () => {
    expect(pickAnalysisPhotos(SEPT, "2026-09").map((p) => p.id)).toEqual(["p1", "p3"]);
    const lastSide = [...SEPT, photo("p4", at(9, 30), "side")];
    expect(pickAnalysisPhotos(lastSide, "2026-09").map((p) => p.id)).toEqual(["p2", "p4"]);
  });

  it("falls back to the earliest photo when no pose matches or the last has none", () => {
    expect(pickAnalysisPhotos([photo("a", at(9, 1), "back"), photo("b", at(9, 20), null)], "2026-09").map((p) => p.id)).toEqual(["a", "b"]);
    expect(pickAnalysisPhotos([photo("a", at(9, 1), "back"), photo("b", at(9, 20), "front")], "2026-09").map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("ignores other months, unsupported types and oversized images", () => {
    const list = [
      photo("aug", at(8, 31)),
      photo("webp", at(9, 1), "front", new Blob([jpegBytes()], { type: "image/webp" })),
      photo("big", at(9, 2), "front", sized(MAX_ANALYSIS_IMAGE_BYTES + 1)),
      photo("ok", at(9, 10)),
    ];
    expect(pickAnalysisPhotos(list, "2026-09").map((p) => p.id)).toEqual(["ok"]);
    expect(pickAnalysisPhotos(list, "2026-10")).toEqual([]);
  });

  it("sends only the last photo when the pair is over the total cap", () => {
    const list = [photo("a", at(9, 1), "front", sized(1_400_000)), photo("b", at(9, 20), "front", sized(1_400_000))];
    expect(pickAnalysisPhotos(list, "2026-09").map((p) => p.id)).toEqual(["b"]);
  });
});

function workout(id: string, started: string, ex: [string, { reps: number; weight: number; is_warmup?: boolean }[]][]): WorkoutLite {
  const end = new Date(Date.parse(started) + 3600_000).toISOString();
  const volume = ex.reduce((a, [, s]) => a + s.filter((x) => !x.is_warmup).reduce((b, x) => b + x.reps * x.weight, 0), 0);
  return { id, started_at: started, ended_at: end, notes: null, volume, setCount: 0, exercises: ex.map(([exercise_id, sets]) => ({ exercise_id, sets })) };
}

describe("countPrs and monthStats", () => {
  const W = [
    workout("a", at(8, 20), [["bench", [{ reps: 5, weight: 80 }]], ["squat", [{ reps: 5, weight: 100 }]]]),
    workout("b", at(9, 5), [["bench", [{ reps: 5, weight: 82.5 }]], ["squat", [{ reps: 5, weight: 100 }]], ["row", [{ reps: 8, weight: 60 }]]]),
    workout("c", at(9, 19), [["bench", [{ reps: 8, weight: 82.5 }, { reps: 1, weight: 200, is_warmup: true }]]]),
    workout("d", at(10, 2), [["squat", [{ reps: 5, weight: 120 }]]]),
  ];
  const { from, to } = { from: new Date(2026, 8, 1), to: new Date(2026, 9, 1) };

  it("counts sessions that beat earlier weight or e1RM; first sessions and warm-ups do not count", () => {
    // b: bench weight PR; c: bench e1RM PR (warm-up ignored); row is new; squat equal.
    expect(countPrs(W, from, to)).toBe(2);
    expect(countPrs(W, new Date(2026, 9, 1), new Date(2026, 10, 1))).toBe(1);
  });

  it("builds clamped stats in the route's shape, with body weight from the month's first and last entry", () => {
    const m: MeasurementRow[] = [
      { id: "1", type: "body_weight", value: 81, date: "2026-09-03" },
      { id: "2", type: "body_weight", value: 80.2, date: "2026-09-28" },
      { id: "3", type: "body_weight", value: 70, date: "2026-08-28" },
      { id: "4", type: "body_fat", value: 15, date: "2026-09-10" },
    ];
    const muscleOf = (id: string) => ({ bench: ["Chest", "Triceps"], squat: ["Quads"], row: ["Back", "NotAMuscle"] })[id] ?? [];
    const s = monthStats(W, "2026-09", muscleOf, m);
    expect(s).toEqual({
      sessions: 2,
      duration_sec: 7200,
      volume: 412.5 + 500 + 480 + 660,
      sets_by_muscle: { Chest: 2, Triceps: 2, Quads: 1, Back: 1 },
      pr_count: 2,
      bodyweight_start: 81,
      bodyweight_end: 80.2,
    });
    expect(Object.keys(s).sort()).toEqual(["bodyweight_end", "bodyweight_start", "duration_sec", "pr_count", "sessions", "sets_by_muscle", "volume"]);
  });

  it("leaves body weight null with fewer than two entries or out-of-range values", () => {
    const one: MeasurementRow[] = [{ id: "1", type: "body_weight", value: 81, date: "2026-09-03" }];
    expect(monthStats([], "2026-09", () => [], one).bodyweight_start).toBeNull();
    const bad: MeasurementRow[] = [...one, { id: "2", type: "body_weight", value: 999, date: "2026-09-20" }];
    const s = monthStats([], "2026-09", () => [], bad);
    expect(s.bodyweight_start).toBe(81);
    expect(s.bodyweight_end).toBeNull();
  });
});

describe("parseAnalysis", () => {
  it("keeps plain, capped, de-duplicated lines and tip texts", () => {
    const r = parseAnalysis(
      {
        comment: ["  One\nline ", "One line", 5, "", "a", "b", "c", "d"],
        focus: [{ text: "x".repeat(500) }, null, { text: "Tip" }, { text: "Tip" }, { text: "More" }, { text: "Extra" }],
      },
      "2026-09",
    );
    expect(r?.comment).toEqual(["One line", "a", "b", "c"]);
    expect(r?.focus).toEqual(["x".repeat(200), "Tip", "More"]);
  });

  it("rejects bodies with no usable comment", () => {
    expect(parseAnalysis(null, "2026-09")).toBeNull();
    expect(parseAnalysis({ comment: "text" }, "2026-09")).toBeNull();
    expect(parseAnalysis({ comment: ["", 3] }, "2026-09")).toBeNull();
    expect(readSavedAnalysis({ month: "2026-08", comment: ["Hi"], focus: [] }, "2026-09")).toBeNull();
  });
});

describe("blobToBase64", () => {
  it("encodes the bytes without a data: prefix", async () => {
    const bytes = jpegBytes();
    expect(await blobToBase64(new Blob([bytes], { type: "image/jpeg" }))).toBe(Buffer.from(bytes).toString("base64"));
  });
});

// ---------- component ----------

describe("MonthlyAnalysis", () => {
  it("does not fetch on render and explains what is sent", () => {
    const fn = mockFetch(() => json(okBody()));
    const load = renderCard();
    expect(screen.getByRole("heading", { name: "Monthly analysis" })).toBeInTheDocument();
    expect(screen.getByText(/Only those two photos are sent/)).toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("sends the first and last photo with the month's stats and shows the comment", async () => {
    const fn = mockFetch(() => json(okBody()));
    const load = renderCard();
    tap();
    expect(await screen.findByText("Shoulders look a little fuller than on the 2nd.")).toBeInTheDocument();
    expect(screen.getByText("Keep glute volume up next month.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith("2026-09");

    const body = bodyOf(fn);
    expect(body.month).toBe("2026-09");
    expect(body.unit).toBe("kg");
    expect(body.stats).toEqual(STATS);
    expect(body.photos.map((p: { taken_on: string; pose: string }) => [p.taken_on, p.pose])).toEqual([
      ["2026-09-02", "front"],
      ["2026-09-29", "front"],
    ]);
    // The exact body the card sends passes the route's strict validation.
    expect(validateInput(body).ok).toBe(true);

    await waitFor(async () => expect((await db.meta.get(analysisKey("2026-09")))?.value).toMatchObject({ month: "2026-09" }));
  });

  it("shows a saved analysis for the month without fetching", async () => {
    await db.meta.put({ key: analysisKey("2026-09"), value: { month: "2026-09", comment: ["Saved note."], focus: [] } });
    const fn = mockFetch(() => json(okBody()));
    renderCard();
    expect(await screen.findByText("Saved note.")).toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
  });

  it("analyses the month picked in the selector", async () => {
    const fn = mockFetch(() => json({ ...okBody(), month: "2026-08" }));
    renderCard([...SEPT, photo("aug", at(8, 10))]);
    fireEvent.change(screen.getByLabelText("Analysis month"), { target: { value: "2026-08" } });
    tap();
    await screen.findByText("Shoulders look a little fuller than on the 2nd.");
    const body = bodyOf(fn);
    expect(body.month).toBe("2026-08");
    expect(body.photos).toHaveLength(1);
  });

  it("shows a plain message on 503 unavailable", async () => {
    mockFetch(() => json({ unavailable: true }, 503));
    renderCard();
    tap();
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_ANALYSIS_UNAVAILABLE);
    expect(screen.queryByLabelText("Analysis comment")).toBeNull();
    expect(await db.meta.get(analysisKey("2026-09"))).toBeUndefined();
  });

  it("shows a plain message on a server error, a bad answer or a network failure", async () => {
    for (const route of [() => json({ error: "error" }, 502), () => json({ comment: [] }), () => Promise.reject(new TypeError("network"))]) {
      mockFetch(route);
      const { unmount } = render(<MonthlyAnalysis photos={SEPT} unit="kg" loadStats={async () => STATS} />);
      tap();
      expect(await screen.findByRole("status")).toHaveTextContent(MSG_ANALYSIS_FAILED);
      unmount();
    }
  });

  it("shows a plain message when the stats cannot be loaded", async () => {
    const fn = mockFetch(() => json(okBody()));
    renderCard(SEPT, vi.fn(async () => Promise.reject(new Error("db"))));
    tap();
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_ANALYSIS_FAILED);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not send anything when offline", async () => {
    setOnline(false);
    const fn = mockFetch(() => json(okBody()));
    renderCard();
    tap();
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_ANALYSIS_OFFLINE);
    expect(fn).not.toHaveBeenCalled();
  });

  it("says so when no photo of the month can be sent", async () => {
    const fn = mockFetch(() => json(okBody()));
    renderCard([photo("w", at(9, 3), "front", new Blob([jpegBytes()], { type: "image/webp" }))]);
    tap();
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_ANALYSIS_NO_PHOTO);
    expect(fn).not.toHaveBeenCalled();
  });

  it("renders nothing without photos", () => {
    const { container } = render(<MonthlyAnalysis photos={[]} unit="kg" loadStats={async () => STATS} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// ---------- slider overlay compare ----------

describe("slider helpers", () => {
  it("clamps the reveal to a whole percentage", () => {
    expect(clampReveal(42.4)).toBe(42);
    expect(clampReveal(-5)).toBe(0);
    expect(clampReveal(250)).toBe(100);
    expect(clampReveal(Number.NaN)).toBe(REVEAL_DEFAULT);
    expect(clampReveal(Infinity)).toBe(REVEAL_DEFAULT);
  });

  it("builds the clip path from the reveal", () => {
    expect(revealClip(30)).toBe("inset(0 70% 0 0)");
    expect(revealClip(0)).toBe("inset(0 100% 0 0)");
    expect(revealClip(100)).toBe("inset(0 0% 0 0)");
  });

  it("maps a pointer position over the photos to a reveal", () => {
    expect(revealAt(150, 100, 200)).toBe(25);
    expect(revealAt(50, 100, 200)).toBe(0);
    expect(revealAt(400, 100, 200)).toBe(100);
    expect(revealAt(150, 100, 0)).toBe(REVEAL_DEFAULT);
  });

  it("orders the pair oldest first", () => {
    const early = photo("e", at(9, 1));
    const late = photo("l", at(9, 20));
    expect(orderPair(late, early).map((p) => p.id)).toEqual(["e", "l"]);
    expect(orderPair(early, late).map((p) => p.id)).toEqual(["e", "l"]);
  });

  it("offers side by side and slider, side by side first", () => {
    expect(COMPARE_MODES.map((m) => m.label)).toEqual(["Side by side", "Slider"]);
  });
});

describe("CompareSlider and the compare overlay", () => {
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  beforeEach(async () => {
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    await db.photos.clear();
  });
  afterEach(() => {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });

  const top = () => screen.getByTestId("compare-slider-top");

  it("starts at half, labelled, and moves with the range input", () => {
    render(<CompareSlider a={photo("l", at(9, 20))} b={photo("e", at(9, 1))} />);
    const range = screen.getByRole("slider", { name: REVEAL_LABEL });
    expect(range).toHaveValue(String(REVEAL_DEFAULT));
    expect(range).toHaveAttribute("min", "0");
    expect(range).toHaveAttribute("max", "100");
    expect(range.getAttribute("aria-valuetext")).toMatch(/^50% of .+ over .+$/);
    expect(top().style.clipPath).toBe("inset(0 50% 0 0)");

    fireEvent.change(range, { target: { value: "80" } });
    expect(range).toHaveValue("80");
    expect(top().style.clipPath).toBe("inset(0 20% 0 0)");
    expect(range.getAttribute("aria-valuetext")).toMatch(/^80% of /);
  });

  it("puts the later photo on top and labels both dates", () => {
    const early = photo("e", at(9, 1));
    const late = photo("l", at(9, 20));
    render(<CompareSlider a={late} b={early} />);
    const label = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    expect(screen.getByText(label(early.taken_at))).toBeInTheDocument();
    expect(screen.getByText(label(late.taken_at))).toBeInTheDocument();
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe(`50% of ${label(late.taken_at)} over ${label(early.taken_at)}`);
  });

  it("follows a pointer drag on the photos", () => {
    render(<CompareSlider a={photo("e", at(9, 1))} b={photo("l", at(9, 20))} />);
    const stage = screen.getByTestId("compare-slider-stage");
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 300, right: 200, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(stage, { clientX: 40, pointerId: 1 });
    expect(screen.getByRole("slider")).toHaveValue("20");
    fireEvent.pointerMove(stage, { clientX: 150, pointerId: 1 });
    expect(screen.getByRole("slider")).toHaveValue("75");
    fireEvent.pointerUp(stage, { pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 10, pointerId: 1 });
    expect(screen.getByRole("slider")).toHaveValue("75");
  });

  it("keeps side by side as the default compare and switches to the slider", async () => {
    await db.photos.bulkPut([photo("e", at(9, 1), "front"), photo("l", at(9, 20), "side")]);
    render(<PhotosTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Compare two photos" }));
    fireEvent.click(screen.getByRole("button", { name: /· front/ }));
    fireEvent.click(screen.getByRole("button", { name: /· side/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compare (2/2)" }));

    expect(screen.getByRole("heading", { name: "Compare" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Side by side" })).toBeInTheDocument();
    expect(screen.queryByRole("slider")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Slider" }));
    const range = screen.getByRole("slider", { name: REVEAL_LABEL });
    fireEvent.change(range, { target: { value: "10" } });
    expect(top().style.clipPath).toBe("inset(0 90% 0 0)");

    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
    expect(screen.queryByRole("slider")).toBeNull();

    // Closing resets to side by side for the next compare.
    fireEvent.click(screen.getByRole("button", { name: "Slider" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "Compare" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Compare two photos" }));
    fireEvent.click(screen.getByRole("button", { name: /· front/ }));
    fireEvent.click(screen.getByRole("button", { name: /· side/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compare (2/2)" }));
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
