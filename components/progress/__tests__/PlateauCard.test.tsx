// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import catalogueJson from "@/data/exercises.json";
import { db } from "@/lib/offline/db";
import { createRoutine, getRoutine } from "@/lib/routines";
import type { Exercise } from "@/lib/exercises";
import {
  FIX_KINDS as AI_FIX_KINDS,
  validateInput,
  type Fix as AiFix,
  type FixKind as AiFixKind,
} from "@/lib/ai/plateau-fix";
import {
  APPLIED_KEY,
  FIX_KINDS,
  MAX_ROUTINE_SETS,
  MSG_FAILED,
  MSG_OFFLINE,
  MSG_UNAVAILABLE,
  PlateauCard,
  PlateauFix,
  ROUTE,
  appliedMessage,
  applyFix,
  applyFixToRoutine,
  buildFixBody,
  dateKey,
  describeFix,
  loadFixBody,
  parseFix,
  type Fix,
  type FixBody,
  type FixKind,
} from "@/components/progress/PlateauCard";

// ---------- compile-time: local copies match lib/ai/plateau-fix.ts ----------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const fixSame: Equal<Fix, AiFix> = true;
const kindSame: Equal<FixKind, AiFixKind> = true;
void fixSame;
void kindSame;

// ---------- helpers ----------

const BENCH = "Barbell_Bench_Press_-_Medium_Grip";
const INCLINE = "Barbell_Incline_Bench_Press_-_Medium_Grip";
/** Real catalogue entries, so swapOptions in the card sees the full shape. */
const CATALOGUE = (catalogueJson as unknown as Exercise[]).filter((e) => e.id === BENCH || e.id === INCLINE);
const names: Record<string, string> = Object.fromEntries(CATALOGUE.map((e) => [e.id, e.name]));
const nameOf = (id: string) => names[id];

const DAY = 864e5;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const sets = (n: number, reps: number, weight: number) => Array.from({ length: n }, () => ({ reps, weight }));

/** Best at 35 days ago, nothing better since: a 4-week stall. */
const HISTORY = [
  { started_at: ago(35), sets: [{ reps: 10, weight: 40, is_warmup: true }, ...sets(3, 5, 100)] },
  { started_at: ago(28), sets: sets(3, 5, 95) },
  { started_at: ago(21), sets: sets(3, 5, 95) },
  { started_at: ago(14), sets: sets(3, 5, 95) },
  { started_at: ago(3), sets: sets(3, 5, 95) },
];

const fix = (over: Partial<Fix> = {}): Fix => ({
  kind: "rep_range",
  reason: "Five weeks at 5 reps with no progress; a new range should help.",
  rep_range: { min: 8, max: 12 },
  swap_exercise_id: null,
  extra_sets: null,
  deload_percent: null,
  deload_weight: null,
  duration_weeks: 4,
  ...over,
});

const okBody = (f: Partial<Fix> = {}, id = BENCH) => ({
  exercise_id: id,
  weeks: 4,
  best_e1rm: 116.7,
  last_e1rm: 110.8,
  sessions: 5,
  fix: fix(f),
  source: "ai",
  adjusted: 0,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(route: (init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/exercises.json")) return json(CATALOGUE);
    if (u === ROUTE) return route(init);
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const routeCalls = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls.filter((c) => String(c[0]) === ROUTE);

function setOnline(v: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v });
}

const BODY: FixBody = buildFixBody(BENCH, HISTORY, [], "strength")!;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  setOnline(true);
});
afterEach(() => vi.unstubAllGlobals());

// ---------- pure helpers ----------

describe("local copies", () => {
  it("FIX_KINDS matches the route", () => {
    expect([...FIX_KINDS]).toEqual([...AI_FIX_KINDS]);
  });
});

describe("buildFixBody", () => {
  it("sorts oldest first, keeps warm-up flags and passes the route's own validator", () => {
    const body = buildFixBody(BENCH, [...HISTORY].reverse(), ["Barbell", "Dumbbell"], "strength")!;
    expect(body.sessions.map((s) => s.date)).toEqual(HISTORY.map((h) => dateKey(h.started_at)));
    expect(body.sessions[0].sets[0]).toEqual({ reps: 10, weight: 40, is_warmup: true });
    expect(body.sessions[1].sets[0]).toEqual({ reps: 5, weight: 95 });
    expect(Object.keys(body).sort()).toEqual(["equipment", "exercise_id", "goal_type", "sessions"]);
    const byId = new Map((catalogueJson as unknown as Exercise[]).map((e) => [e.id, e]));
    const checked = validateInput(JSON.parse(JSON.stringify(body)), byId);
    expect(checked.ok).toBe(true);
  });

  it("drops out-of-range sets and empty sessions, and needs 3 sessions", () => {
    const body = buildFixBody(
      BENCH,
      [
        { started_at: ago(10), sets: [{ reps: 5.5, weight: 50 }, { reps: 5, weight: 5000 }, { reps: 101, weight: 10 }] },
        { started_at: "not a date", sets: sets(3, 5, 50) },
        ...HISTORY.slice(0, 2),
      ],
      [],
      null,
    );
    expect(body).toBeNull();
  });

  it("caps sets per session (dropping warm-ups first) and sessions at 40", () => {
    const many = [...Array.from({ length: 5 }, () => ({ reps: 10, weight: 20, is_warmup: true })), ...sets(14, 5, 60)];
    const hist = Array.from({ length: 45 }, (_, i) => ({ started_at: ago(45 - i), sets: many }));
    const body = buildFixBody(BENCH, hist, [], null)!;
    expect(body.sessions).toHaveLength(40);
    expect(body.sessions[0].date).toBe(dateKey(ago(40)));
    expect(body.sessions[0].sets).toHaveLength(14);
    expect(body.sessions[0].sets.every((s) => !s.is_warmup)).toBe(true);
  });
});

describe("parseFix", () => {
  const known = (id: string) => id in names;

  it("keeps a valid fix of each kind", () => {
    expect(parseFix(okBody(), BENCH, known)).toEqual(fix());
    expect(parseFix(okBody({ kind: "swap", rep_range: null, swap_exercise_id: INCLINE }), BENCH, known)?.swap_exercise_id).toBe(INCLINE);
    expect(parseFix(okBody({ kind: "extra_set", rep_range: null, extra_sets: 2, duration_weeks: 3 }), BENCH, known)?.extra_sets).toBe(2);
    const d = parseFix(okBody({ kind: "deload", rep_range: null, deload_percent: 60, deload_weight: 57.5, duration_weeks: 1 }), BENCH, known)!;
    expect([d.deload_percent, d.deload_weight]).toEqual([60, 57.5]);
  });

  it("nulls the fields that do not belong to the kind", () => {
    const f = parseFix(okBody({ extra_sets: 2, swap_exercise_id: INCLINE }), BENCH, known)!;
    expect(f.extra_sets).toBeNull();
    expect(f.swap_exercise_id).toBeNull();
  });

  it("rejects unusable answers", () => {
    expect(parseFix(null, BENCH, known)).toBeNull();
    expect(parseFix(okBody({}, INCLINE), BENCH, known)).toBeNull();
    expect(parseFix(okBody({ kind: "nap" as FixKind }), BENCH, known)).toBeNull();
    expect(parseFix(okBody({ reason: "" }), BENCH, known)).toBeNull();
    expect(parseFix(okBody({ duration_weeks: 9 }), BENCH, known)).toBeNull();
    expect(parseFix(okBody({ rep_range: { min: 12, max: 8 } }), BENCH, known)).toBeNull();
    expect(parseFix(okBody({ kind: "swap", swap_exercise_id: "made_up" }), BENCH, known)).toBeNull();
    expect(parseFix(okBody({ kind: "swap", swap_exercise_id: BENCH }), BENCH, known)).toBeNull();
    expect(parseFix(okBody({ kind: "extra_set", extra_sets: 5 }), BENCH, known)).toBeNull();
    expect(parseFix(okBody({ kind: "deload", deload_percent: 10 }), BENCH, known)).toBeNull();
  });

  it("cleans the reason and drops a bad deload weight", () => {
    const f = parseFix(okBody({ kind: "deload", deload_percent: 60, deload_weight: -3, reason: "Rest\u0000 a  bit." }), BENCH, known)!;
    expect(f.reason).toBe("Rest a bit.");
    expect(f.deload_weight).toBeNull();
  });
});

describe("describeFix / appliedMessage", () => {
  it("describes each kind in plain words", () => {
    expect(describeFix(fix(), nameOf, "kg")).toBe("Work in 8-12 reps for 4 weeks");
    expect(describeFix(fix({ kind: "swap", swap_exercise_id: INCLINE }), nameOf, "kg")).toBe(
      "Swap to Barbell Incline Bench Press - Medium Grip for 4 weeks",
    );
    expect(describeFix(fix({ kind: "extra_set", extra_sets: 1, duration_weeks: 3 }), nameOf, "kg")).toBe("Add 1 set per session for 3 weeks");
    expect(describeFix(fix({ kind: "deload", deload_percent: 60, deload_weight: 57.5, duration_weeks: 1 }), nameOf, "kg")).toBe(
      "Lighter week: about 60% (57.5kg) of your usual weight for 1 week",
    );
  });

  it("says what was applied", () => {
    expect(appliedMessage(fix(), 2, "kg")).toBe("Updated 2 routines.");
    expect(appliedMessage(fix(), 0, "kg")).toBe("Saved. None of your routines has this lift yet.");
    expect(appliedMessage(fix({ kind: "deload", deload_percent: 60, deload_weight: null }), 0, "kg")).toMatch(/about 60% of your usual weight/);
  });
});

describe("applyFixToRoutine", () => {
  const list = [
    { exercise_id: BENCH, target_sets: 3, target_reps: "3-5" },
    { exercise_id: "Squat", target_sets: 4, target_reps: "5" },
  ];

  it("changes only the stalled lift", () => {
    expect(applyFixToRoutine(list, BENCH, fix())).toEqual([{ ...list[0], target_reps: "8-12" }, list[1]]);
    expect(applyFixToRoutine(list, BENCH, fix({ kind: "extra_set", extra_sets: 2 }))![0].target_sets).toBe(5);
    expect(applyFixToRoutine([{ ...list[0], target_sets: 9 }], BENCH, fix({ kind: "extra_set", extra_sets: 2 }))![0].target_sets).toBe(MAX_ROUTINE_SETS);
  });

  it("swaps keeping sets and reps, without duplicating", () => {
    expect(applyFixToRoutine(list, BENCH, fix({ kind: "swap", swap_exercise_id: INCLINE }))![0]).toEqual({ exercise_id: INCLINE, target_sets: 3, target_reps: "3-5" });
    const withIncline = [...list, { exercise_id: INCLINE, target_sets: 2, target_reps: "10" }];
    const out = applyFixToRoutine(withIncline, BENCH, fix({ kind: "swap", swap_exercise_id: INCLINE }))!;
    expect(out.map((e) => e.exercise_id)).toEqual([INCLINE, "Squat"]);
  });

  it("returns null for a deload or a routine without the lift", () => {
    expect(applyFixToRoutine(list, BENCH, fix({ kind: "deload", deload_percent: 60 }))).toBeNull();
    expect(applyFixToRoutine(list, INCLINE, fix())).toBeNull();
  });
});

describe("applyFix / loadFixBody (local store)", () => {
  it("updates routines with the lift and records the fix", async () => {
    const id = await createRoutine({ name: "Push", exercises: [{ exercise_id: BENCH, target_sets: 3, target_reps: "3-5" }] });
    await createRoutine({ name: "Legs", exercises: [{ exercise_id: "Squat" }] });
    const n = await applyFix(BENCH, fix(), "Work in 8-12 reps for 4 weeks", new Date("2026-10-22T10:00:00Z"));
    expect(n).toBe(1);
    expect((await getRoutine(id))!.exercises[0].target_reps).toBe("8-12");
    const rec = (await db.meta.get(APPLIED_KEY))!.value as Record<string, { headline: string; until: string }>;
    expect(rec[BENCH].headline).toBe("Work in 8-12 reps for 4 weeks");
    expect(rec[BENCH].until).toBe("2026-11-19T10:00:00.000Z");
  });

  it("reads history, equipment and goal from the store", async () => {
    await seedHistory();
    await db.meta.put({ key: "equipment", value: ["Barbell"] });
    await db.meta.put({ key: "goals", value: { goalType: "strength" } });
    const body = (await loadFixBody(BENCH))!;
    expect(body.sessions).toHaveLength(5);
    expect(body.equipment).toEqual(["Barbell"]);
    expect(body.goal_type).toBe("strength");
  });
});

// ---------- PlateauFix component ----------

function renderFix(apply = vi.fn(async () => 1)) {
  render(<PlateauFix exerciseId={BENCH} unit="kg" nameOf={nameOf} loadBody={async () => BODY} apply={apply} />);
  return apply;
}

describe("PlateauFix", () => {
  it("fetches nothing until asked", () => {
    const fn = mockFetch(() => json(okBody()));
    renderFix();
    expect(screen.getByRole("button", { name: "Get recommended fix" })).toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
  });

  it("shows the fix with apply and dismiss, and applies it", async () => {
    const fn = mockFetch(() => json(okBody()));
    const apply = renderFix();
    fireEvent.click(screen.getByRole("button", { name: "Get recommended fix" }));
    const box = await screen.findByLabelText("Recommended fix");
    expect(within(box).getByText("Work in 8-12 reps for 4 weeks")).toBeInTheDocument();
    expect(within(box).getByText(/a new range should help/)).toBeInTheDocument();
    expect(JSON.parse(String((routeCalls(fn)[0][1] as RequestInit).body))).toEqual(BODY);

    fireEvent.click(within(box).getByRole("button", { name: "Apply to routines" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Updated 1 routine.");
    expect(apply).toHaveBeenCalledWith(BENCH, expect.objectContaining({ kind: "rep_range" }), "Work in 8-12 reps for 4 weeks");
    expect(screen.queryByLabelText("Recommended fix")).toBeNull();
  });

  it("labels the deload action and dismisses back to the button", async () => {
    mockFetch(() => json(okBody({ kind: "deload", rep_range: null, deload_percent: 60, deload_weight: 57.5, duration_weeks: 1 })));
    const apply = renderFix();
    fireEvent.click(screen.getByRole("button", { name: "Get recommended fix" }));
    expect(await screen.findByRole("button", { name: "Start lighter week" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByLabelText("Recommended fix")).toBeNull();
    expect(screen.getByRole("button", { name: "Get recommended fix" })).toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
  });

  it("shows the unavailable message on 503", async () => {
    mockFetch(() => json({ unavailable: true }, 503));
    renderFix();
    fireEvent.click(screen.getByRole("button", { name: "Get recommended fix" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_UNAVAILABLE);
    expect(screen.queryByLabelText("Recommended fix")).toBeNull();
  });

  it("shows the failure message on a server error, a bad answer or a network error", async () => {
    for (const route of [
      () => json({ error: "x" }, 500),
      () => json(okBody({ kind: "swap", rep_range: null, swap_exercise_id: "made_up" })),
      () => Promise.reject(new TypeError("network")),
    ]) {
      mockFetch(route);
      const { unmount } = render(<PlateauFix exerciseId={BENCH} unit="kg" nameOf={nameOf} loadBody={async () => BODY} />);
      fireEvent.click(screen.getByRole("button", { name: "Get recommended fix" }));
      expect(await screen.findByRole("status")).toHaveTextContent(MSG_FAILED);
      expect(screen.queryByLabelText("Recommended fix")).toBeNull();
      unmount();
    }
  });

  it("shows the failure message without calling the route when there is too little history", async () => {
    const fn = mockFetch(() => json(okBody()));
    render(<PlateauFix exerciseId={BENCH} unit="kg" nameOf={nameOf} loadBody={async () => null} />);
    fireEvent.click(screen.getByRole("button", { name: "Get recommended fix" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_FAILED);
    expect(routeCalls(fn)).toHaveLength(0);
  });

  it("shows the offline message without calling the route", async () => {
    setOnline(false);
    const fn = mockFetch(() => json(okBody()));
    renderFix();
    fireEvent.click(screen.getByRole("button", { name: "Get recommended fix" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_OFFLINE);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ---------- PlateauCard with the local store ----------

async function seedHistory() {
  for (const [i, h] of HISTORY.entries()) {
    const w = `w${i}`;
    await db.workouts.put({ id: w, started_at: h.started_at, ended_at: h.started_at, notes: null, routine_id: null });
    await db.workout_exercises.put({ id: `we${i}`, workout_id: w, exercise_id: BENCH, position: 0 });
    for (const [n, s] of h.sets.entries()) {
      await db.sets.put({
        id: `s${i}-${n}`,
        workout_exercise_id: `we${i}`,
        set_no: n + 1,
        reps: s.reps,
        weight: s.weight,
        is_warmup: "is_warmup" in s ? Boolean(s.is_warmup) : false,
        rir: null,
        completed_at: h.started_at,
      });
    }
  }
}

describe("PlateauCard", () => {
  it("keeps the rule-based card unchanged when the fix is unavailable", async () => {
    await seedHistory();
    mockFetch(() => json({ unavailable: true }, 503));
    render(<PlateauCard />);
    expect(await screen.findByText("Barbell Bench Press - Medium Grip")).toBeInTheDocument();
    const advice = "Try a different rep range, or swap in a close variation for a few weeks.";
    expect(screen.getByText(advice)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Get recommended fix" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_UNAVAILABLE);
    expect(screen.getByText(advice)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show variations to try" })).toBeInTheDocument();
  });

  it("applies a swap to the routine and shows the recorded fix", async () => {
    await seedHistory();
    const id = await createRoutine({ name: "Push", exercises: [{ exercise_id: BENCH, target_sets: 3, target_reps: "5" }] });
    const fn = mockFetch(() => json(okBody({ kind: "swap", rep_range: null, swap_exercise_id: INCLINE })));
    render(<PlateauCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Get recommended fix" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply to routines" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Updated 1 routine.");
    await waitFor(async () => expect((await getRoutine(id))!.exercises[0].exercise_id).toBe(INCLINE));
    expect(await screen.findByText(/Fix applied .*: Swap to Barbell Incline Bench Press - Medium Grip for 4 weeks/)).toBeInTheDocument();
    expect(routeCalls(fn)).toHaveLength(1);
  });
});
