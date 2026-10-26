"use client";

// "Coach recap" inside the This week / This month card. On tap it sends the
// period's stats (the same numbers PeriodCard already shows, plus the most
// repeated set pattern per exercise) to POST /api/ai/summary and shows a short
// coach-style recap with progressive-overload advice. Nothing is fetched on
// render. Any failure (no key, offline, bad answer) shows a short plain
// message; the rule-based stats in PeriodCard are never changed.
import { useState } from "react";
import { MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import { loadCatalogue } from "@/lib/catalogue";
import type { SkipStats, WorkoutLite } from "@/lib/progress";
import { recapSkipFields, type PeriodStats, type SkipCounts } from "@/lib/stats";
import type { Unit } from "@/lib/units";

export const ROUTE = "/api/ai/summary";

export const MSG_UNAVAILABLE = "The coach recap is not available right now. Your stats above still apply.";
export const MSG_OFFLINE = "The coach recap is available when back online. Your stats above still apply.";
export const MSG_FAILED = "Could not get the coach recap. Your stats above still apply.";

/** Same bounds the route validates (lib/ai/summary.ts); values are clamped or dropped before sending. */
const MAX_SESSIONS = 62;
const MAX_DURATION_SEC = 31 * 86_400;
const MAX_VOLUME = 5_000_000;
const MAX_MUSCLE_SETS = 500;
export const MAX_HIGHLIGHTS = 8;
const MAX_HL_SETS = 20;
const MAX_HL_REPS = 100;
const MAX_HL_WEIGHT = 1_000;
const MAX_HL_TIMES = 31;
/** What the card keeps from the answer. */
const MAX_RECAP_LINES = 4;
const MAX_RECAP_LINE = 240;
const MAX_ADVICE = 3;
const MAX_ADVICE_TEXT = 200;

export type Period = "week" | "month";

export type Highlight = { exercise_id: string; sets: number; reps: number; weight: number; times: number };

type BaseStats = {
  sessions: number;
  duration_sec: number;
  volume: number;
  sets_by_muscle: Partial<Record<MuscleGroup, number>>;
  skipped: number;
  moved: number;
};

/** The current period may also carry skip reasons (route key current.skip_reasons). */
type CurrentBaseStats = BaseStats & { skip_reasons?: Record<string, number> };

export type SummaryBody = {
  period: Period;
  unit: Unit;
  current: CurrentBaseStats;
  previous: BaseStats | null;
  highlights: Highlight[];
};

export type Recap = { recap: string[]; advice: { exercise_id: string | null; text: string }[] };

const isMuscle = (v: unknown): v is MuscleGroup => typeof v === "string" && (MUSCLE_GROUPS as readonly string[]).includes(v);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The most repeated set pattern per exercise in [from, to). For each session,
 * the exercise's pattern is its most common working set (reps x weight, ties to
 * the heavier) and how many sets used it. `times` counts the sessions that did
 * that exact sets x reps x weight. Only ids `allow` accepts (the built-in
 * catalogue) are kept, out-of-range patterns are dropped, and the result is
 * sorted by times then workload and capped at MAX_HIGHLIGHTS.
 */
export function buildHighlights(
  workouts: WorkoutLite[],
  from: Date,
  to: Date,
  allow: (exerciseId: string) => boolean,
): Highlight[] {
  const byExercise = new Map<string, Map<string, { h: Omit<Highlight, "times">; sessions: Set<string> }>>();
  for (const w of workouts) {
    const t = Date.parse(w.started_at);
    if (!(t >= from.getTime() && t < to.getTime())) continue;
    for (const e of w.exercises) {
      if (!allow(e.exercise_id)) continue;
      const counts = new Map<string, { reps: number; weight: number; n: number }>();
      for (const s of e.sets) {
        if (s.is_warmup || !(s.reps > 0) || !(s.weight >= 0)) continue;
        const weight = round2(s.weight);
        const key = `${s.reps}@${weight}`;
        const c = counts.get(key) ?? { reps: s.reps, weight, n: 0 };
        c.n++;
        counts.set(key, c);
      }
      const top = [...counts.values()].sort((a, b) => b.n - a.n || b.weight - a.weight || b.reps - a.reps)[0];
      if (!top) continue;
      const key = `${top.n}x${top.reps}@${top.weight}`;
      const patterns = byExercise.get(e.exercise_id) ?? new Map();
      const p = patterns.get(key) ?? { h: { exercise_id: e.exercise_id, sets: top.n, reps: top.reps, weight: top.weight }, sessions: new Set<string>() };
      p.sessions.add(w.id);
      patterns.set(key, p);
      byExercise.set(e.exercise_id, patterns);
    }
  }

  const out: Highlight[] = [];
  for (const patterns of byExercise.values()) {
    const best = [...patterns.values()]
      .map((p) => ({ ...p.h, times: p.sessions.size }))
      .filter(
        (h) =>
          Number.isInteger(h.sets) && h.sets >= 1 && h.sets <= MAX_HL_SETS &&
          Number.isInteger(h.reps) && h.reps >= 1 && h.reps <= MAX_HL_REPS &&
          h.weight >= 0 && h.weight <= MAX_HL_WEIGHT &&
          h.times >= 1 && h.times <= MAX_HL_TIMES,
      )
      .sort((a, b) => b.times - a.times || b.weight - a.weight || b.reps - a.reps)[0];
    if (best) out.push(best);
  }
  const load = (h: Highlight) => h.sets * h.reps * Math.max(h.weight, 1);
  return out.sort((a, b) => b.times - a.times || load(b) - load(a) || a.exercise_id.localeCompare(b.exercise_id)).slice(0, MAX_HIGHLIGHTS);
}

/**
 * PeriodStats in the route's shape, clamped to its bounds. Skipped/moved days are not tracked here, so 0.
 * When `skips` (lib/progress.ts skipStats for the same period) is given, its skipped and moved counts are used instead.
 */
export function toBaseStats(s: PeriodStats, skips?: SkipCounts | null): BaseStats {
  const clampInt = (n: number, max: number) => Math.max(0, Math.min(max, Math.round(Number.isFinite(n) ? n : 0)));
  const sets_by_muscle: Partial<Record<MuscleGroup, number>> = {};
  for (const [m, n] of Object.entries(s.sets_by_muscle)) if (isMuscle(m) && n > 0) sets_by_muscle[m] = clampInt(n, MAX_MUSCLE_SETS);
  return {
    sessions: clampInt(s.sessions, MAX_SESSIONS),
    duration_sec: clampInt(s.duration_sec, MAX_DURATION_SEC),
    volume: Math.max(0, Math.min(MAX_VOLUME, round2(Number.isFinite(s.volume) ? s.volume : 0))),
    sets_by_muscle,
    skipped: skips ? recapSkipFields(skips).skipped : 0,
    moved: skips ? recapSkipFields(skips).moved : 0,
  };
}

export function buildSummaryBody(
  period: Period,
  unit: Unit,
  current: PeriodStats,
  previous: PeriodStats | null,
  highlights: Highlight[],
  skips?: SkipCounts | null,
  previousSkips?: SkipCounts | null,
): SummaryBody {
  const cur: CurrentBaseStats = toBaseStats(current, skips);
  if (skips) {
    const reasons = recapSkipFields(skips).skip_reasons as Record<string, number>;
    if (Object.keys(reasons).length > 0) cur.skip_reasons = reasons;
  }
  return {
    period,
    unit,
    current: cur,
    previous: previous ? toBaseStats(previous, previousSkips) : null,
    highlights: highlights.slice(0, MAX_HIGHLIGHTS),
  };
}

/** One plain line: control characters dropped, whitespace collapsed, capped. */
function plainLine(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** Checks the route's 200 body. Null when there is no usable recap line. */
export function parseSummary(json: unknown): Recap | null {
  if (typeof json !== "object" || json === null) return null;
  const { recap, advice } = json as { recap?: unknown; advice?: unknown };
  if (!Array.isArray(recap)) return null;
  const lines: string[] = [];
  for (const l of recap) {
    const s = plainLine(l, MAX_RECAP_LINE);
    if (s && !lines.includes(s) && lines.length < MAX_RECAP_LINES) lines.push(s);
  }
  if (lines.length === 0) return null;
  const tips: Recap["advice"] = [];
  if (Array.isArray(advice)) {
    for (const a of advice) {
      if (typeof a !== "object" || a === null || tips.length >= MAX_ADVICE) continue;
      const text = plainLine((a as { text?: unknown }).text, MAX_ADVICE_TEXT);
      const id = (a as { exercise_id?: unknown }).exercise_id;
      if (text && !tips.some((t) => t.text === text)) tips.push({ exercise_id: typeof id === "string" ? id : null, text });
    }
  }
  return { recap: lines, advice: tips };
}

/** Ids of the built-in catalogue (the route only accepts those). */
async function loadCatalogueIds(): Promise<Set<string>> {
  const cat = await loadCatalogue();
  return new Set(cat.byId.keys());
}

type State = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "done"; recap: Recap };

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

async function post(body: unknown): Promise<Response> {
  return fetch(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Coach-style recap for the shown week or month, fetched on demand. */
export function RecapCard({
  period,
  unit,
  current,
  previous,
  workouts,
  from,
  to,
  skips,
  previousSkips,
  loadIds = loadCatalogueIds,
}: {
  period: Period;
  unit: Unit;
  current: PeriodStats;
  previous: PeriodStats | null;
  workouts: WorkoutLite[];
  from: Date;
  to: Date;
  /** Skipped/moved planned days in this period (and the previous one), sent with the stats. */
  skips?: SkipStats | null;
  previousSkips?: SkipStats | null;
  loadIds?: () => Promise<Set<string>>;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });

  const run = async () => {
    if (offline()) {
      setState({ kind: "error", message: MSG_OFFLINE });
      return;
    }
    setState({ kind: "loading" });
    try {
      let ids: Set<string> | null = null;
      try {
        ids = await loadIds();
      } catch {
        ids = null; // catalogue not reachable: send stats without highlights
      }
      const highlights = ids ? buildHighlights(workouts, from, to, (id) => ids!.has(id)) : [];
      let res = await post(buildSummaryBody(period, unit, current, previous, highlights, skips, previousSkips));
      // A highlight the route will not accept should not block the recap.
      if (res.status === 400 && highlights.length) res = await post(buildSummaryBody(period, unit, current, previous, [], skips, previousSkips));
      if (res.status === 503) {
        setState({ kind: "error", message: MSG_UNAVAILABLE });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error", message: MSG_FAILED });
        return;
      }
      const recap = parseSummary(await res.json());
      setState(recap ? { kind: "done", recap } : { kind: "error", message: MSG_FAILED });
    } catch {
      setState({ kind: "error", message: offline() ? MSG_OFFLINE : MSG_FAILED });
    }
  };

  const label = period === "week" ? "weekly" : "monthly";

  return (
    <div className="mt-4 rounded-xl bg-surface-2 p-3" aria-label="Coach recap">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Coach recap</h3>
        <button type="button" className="btn-ghost text-sm" onClick={run} disabled={state.kind === "loading"}>
          {state.kind === "loading" ? "Writing..." : state.kind === "done" ? "Refresh" : "Get recap"}
        </button>
      </div>
      {state.kind === "idle" && (
        <p className="text-xs text-muted mt-1">A short {label} recap with what to try next time.</p>
      )}
      {state.kind === "error" && (
        <p role="status" className="text-sm text-muted mt-2">
          {state.message}
        </p>
      )}
      {state.kind === "done" && (
        <div className="mt-2 space-y-2">
          <div className="space-y-1 text-sm">
            {state.recap.recap.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
          {state.recap.advice.length > 0 && (
            <>
              <h4 className="text-xs font-semibold text-muted uppercase tracking-wide">Next time</h4>
              <ul aria-label="Overload advice" className="space-y-1 text-sm list-disc pl-5">
                {state.recap.advice.map((a) => (
                  <li key={a.text}>{a.text}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
