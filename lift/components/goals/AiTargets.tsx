"use client";

// "Suggest weekly targets": asks POST /api/ai/goal-targets for a weekly set
// target per muscle (each with a one-line reason), lets the user tweak any
// number, and only saves on Accept. Any failure (no key, offline, bad answer)
// shows a short message; the rule-based targets in GoalsSection keep working.
import { useState } from "react";
import { MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import { defaultTarget, saveGoals, type Goals } from "@/lib/goals";
import type { Split } from "@/lib/splits";
import { addDays, startOfWeek } from "@/lib/stats";
import { periodStats, type WorkoutLite } from "@/lib/progress";
import { workoutsBetween } from "@/lib/history";
import { loadCatalogue } from "@/lib/catalogue";
import { db } from "@/lib/offline/db";

export const ROUTE = "/api/ai/goal-targets";
export const WEEKS = 4;
/** Same bounds the route uses for its targets and for user numbers. */
export const MIN_SETS = 4;
export const MAX_SETS = 24;
const MAX_USER_TARGET = 40;
const MAX_WEEK_SETS = 200;
const MAX_REASON = 200;

export const MSG_UNAVAILABLE = "AI suggestions are not available right now. Your current targets still apply.";
export const MSG_OFFLINE = "You are offline. Your current targets still apply.";
export const MSG_FAILED = "Could not get suggestions. Your current targets still apply.";

export type WeekSets = { week_start: string; sets: Partial<Record<MuscleGroup, number>> };
export type SuggestedTarget = { muscle: MuscleGroup; sets: number; reason: string };

const isMuscle = (v: unknown): v is MuscleGroup => typeof v === "string" && (MUSCLE_GROUPS as readonly string[]).includes(v);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Hard sets per muscle for each of the last `weeks` full weeks before the
 * current one, oldest first. Unknown muscle names are ignored.
 */
export function recentWeekSets(
  workouts: WorkoutLite[],
  muscleOf: (exerciseId: string) => string[],
  weekStart: 0 | 1 = 1,
  now = new Date(),
  weeks = WEEKS,
): WeekSets[] {
  const thisWeek = startOfWeek(now, weekStart);
  const out: WeekSets[] = [];
  for (let i = weeks; i >= 1; i--) {
    const from = addDays(thisWeek, -7 * i);
    const stats = periodStats(workouts, from, addDays(from, 7), muscleOf);
    const sets: Partial<Record<MuscleGroup, number>> = {};
    for (const [m, n] of Object.entries(stats.sets_by_muscle)) if (isMuscle(m) && n > 0) sets[m] = Math.min(MAX_WEEK_SETS, n);
    out.push({ week_start: ymd(from), sets });
  }
  return out;
}

/** Request body for the route. The split is left out when it has no trained day. */
export function buildRequestBody(goals: Goals, split: Split | null, recent_weeks: WeekSets[]) {
  const targets: Partial<Record<MuscleGroup, number>> = {};
  for (const [m, n] of Object.entries(goals.targets)) {
    if (isMuscle(m) && typeof n === "number" && Number.isFinite(n)) targets[m] = clamp(n, 0, MAX_USER_TARGET);
  }
  const hasSplit = !!split && split.days.some((d) => d.muscles.length > 0);
  return {
    goals: {
      goalType: goals.goalType,
      experience: goals.experience,
      sessionsPerWeek: clamp(goals.sessionsPerWeek, 1, 7),
      focusMuscles: goals.focusMuscles.filter(isMuscle),
      targets,
    },
    split: hasSplit ? { name: split!.name, days: split!.days.map((d) => ({ name: d.name, muscles: d.muscles })) } : null,
    recent_weeks,
  };
}

/** Plain one-line reason: control characters dropped, whitespace collapsed, length capped. */
function cleanReason(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
}

/**
 * Checks the route's 200 body and returns one row per muscle in MUSCLE_GROUPS
 * order, or null when the shape is unusable. Numbers are clamped; a muscle the
 * answer leaves out gets the rule-based default with a plain reason.
 */
export function parseTargets(json: unknown, goals: Goals): SuggestedTarget[] | null {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { targets?: unknown }).targets)) return null;
  const got = new Map<MuscleGroup, SuggestedTarget>();
  for (const item of (json as { targets: unknown[] }).targets) {
    if (typeof item !== "object" || item === null) continue;
    const { muscle, sets, reason } = item as Record<string, unknown>;
    if (!isMuscle(muscle) || got.has(muscle) || typeof sets !== "number" || !Number.isFinite(sets)) continue;
    got.set(muscle, { muscle, sets: clamp(sets, MIN_SETS, MAX_SETS), reason: cleanReason(reason) });
  }
  if (got.size === 0) return null;
  return MUSCLE_GROUPS.map(
    (m) => got.get(m) ?? { muscle: m, sets: defaultTarget(m, goals), reason: "Rule-based default for your goal." },
  );
}

/** Goals.targets to store on Accept: only numbers that differ from the rule default. */
export function acceptedTargets(rows: SuggestedTarget[], goals: Goals): Partial<Record<MuscleGroup, number>> {
  const out: Partial<Record<MuscleGroup, number>> = {};
  for (const r of rows) if (r.sets !== defaultTarget(r.muscle, goals)) out[r.muscle] = r.sets;
  return out;
}

/** Hard sets per muscle over the last 4 full weeks, from the local store. */
export async function loadRecentWeeks(weekStart: 0 | 1 = 1, now = new Date()): Promise<WeekSets[]> {
  const from = addDays(startOfWeek(now, weekStart), -7 * WEEKS);
  const [workouts, custom] = await Promise.all([workoutsBetween(from, startOfWeek(now, weekStart)), db.custom_exercises.toArray()]);
  const byId = new Map<string, string[]>(custom.map((e) => [e.id, e.muscle_groups]));
  try {
    const cat = await loadCatalogue();
    for (const e of cat.list) if (!byId.has(e.id)) byId.set(e.id, e.muscle_groups);
  } catch {
    // Catalogue not reachable: count only custom exercises rather than fail.
  }
  return recentWeekSets(workouts, (id) => byId.get(id) ?? [], weekStart, now);
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review"; rows: SuggestedTarget[] }
  | { kind: "saved" };

async function post(body: unknown): Promise<Response> {
  return fetch(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Suggest weekly targets, review with reasons, tweak, then accept or discard. */
export function AiTargets({
  goals,
  split,
  weekStart = 1,
  loadWeeks = loadRecentWeeks,
}: {
  goals: Goals;
  split: Split | null;
  weekStart?: 0 | 1;
  loadWeeks?: (weekStart: 0 | 1) => Promise<WeekSets[]>;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });

  const suggest = async () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setState({ kind: "error", message: MSG_OFFLINE });
      return;
    }
    setState({ kind: "loading" });
    try {
      let weeks: WeekSets[] = [];
      try {
        weeks = await loadWeeks(weekStart);
      } catch {
        weeks = [];
      }
      let res = await post(buildRequestBody(goals, split, weeks));
      // A split name the route will not accept should not block the feature.
      if (res.status === 400 && split) res = await post(buildRequestBody(goals, null, weeks));
      if (res.status === 503) {
        setState({ kind: "error", message: MSG_UNAVAILABLE });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error", message: MSG_FAILED });
        return;
      }
      const rows = parseTargets(await res.json(), goals);
      setState(rows ? { kind: "review", rows } : { kind: "error", message: MSG_FAILED });
    } catch {
      setState({
        kind: "error",
        message: typeof navigator !== "undefined" && navigator.onLine === false ? MSG_OFFLINE : MSG_FAILED,
      });
    }
  };

  const tweak = (muscle: MuscleGroup, by: number) =>
    setState((s) =>
      s.kind === "review"
        ? { kind: "review", rows: s.rows.map((r) => (r.muscle === muscle ? { ...r, sets: clamp(r.sets + by, 0, MAX_USER_TARGET) } : r)) }
        : s,
    );

  const accept = async (rows: SuggestedTarget[]) => {
    try {
      await saveGoals({ targets: acceptedTargets(rows, goals) });
      setState({ kind: "saved" });
    } catch {
      setState({ kind: "error", message: "Could not save the targets. Try again." });
    }
  };

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <span>
          <span className="block text-sm font-semibold">Suggest weekly targets</span>
          <span className="block text-xs text-muted">From your goals, split and the last 4 weeks of training.</span>
        </span>
        {state.kind !== "review" && (
          <button type="button" className="chip text-xs shrink-0" onClick={suggest} disabled={state.kind === "loading"}>
            {state.kind === "loading" ? "Working..." : "Suggest"}
          </button>
        )}
      </div>

      {state.kind === "error" && (
        <p role="status" className="text-xs text-muted mt-2">
          {state.message}
        </p>
      )}
      {state.kind === "saved" && (
        <p role="status" className="text-xs text-muted mt-2">
          Targets saved.
        </p>
      )}

      {state.kind === "review" && (
        <>
          <p className="text-xs text-muted mt-2">Your weekly targets. Change any number, then accept to save.</p>
          <ul className="mt-2 space-y-2" aria-label="Suggested weekly targets">
            {state.rows.map((r) => (
              <li key={r.muscle} className="flex items-start gap-2">
                <span className="flex-1 min-w-0">
                  <span className="block text-sm truncate">
                    {r.muscle}
                    {goals.focusMuscles.includes(r.muscle) && <span className="text-xs text-muted"> · focus</span>}
                  </span>
                  {r.reason && <span className="block text-xs text-muted">{r.reason}</span>}
                </span>
                <button type="button" className="size-8 rounded-lg bg-surface-2 text-lg leading-none" onClick={() => tweak(r.muscle, -1)} aria-label={`Fewer suggested ${r.muscle} sets`}>
                  −
                </button>
                <span className="w-8 pt-1.5 text-center text-sm font-semibold tabular-nums" data-testid={`ai-target-${r.muscle}`}>
                  {r.sets}
                </span>
                <button type="button" className="size-8 rounded-lg bg-surface-2 text-lg leading-none" onClick={() => tweak(r.muscle, 1)} aria-label={`More suggested ${r.muscle} sets`}>
                  +
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2 mt-3">
            <button type="button" className="btn-primary flex-1" onClick={() => accept(state.rows)}>
              Accept targets
            </button>
            <button type="button" className="btn-ghost flex-1" onClick={() => setState({ kind: "idle" })}>
              Discard
            </button>
          </div>
        </>
      )}
    </div>
  );
}
